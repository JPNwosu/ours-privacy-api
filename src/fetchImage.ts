import dns from "node:dns";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch } from "undici";
import { ApiError } from "./errors.js";

export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;

// Validating inside the connection's own DNS lookup means the IP we check is the IP we
// connect to (no DNS-rebinding gap), and every redirect hop is checked too.
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "");

    const isPublic = addresses.every(
      ({ address }) => ipaddr.process(address).range() === "unicast",
    );
    if (!isPublic) {
      return callback(
        new ApiError("BLOCKED_URL", "url resolves to a private or reserved network address"),
        "",
      );
    }

    if (options.all) return callback(null, addresses);
    const [first] = addresses;
    if (!first) return callback(new Error(`No addresses found for ${hostname}`), "");
    callback(null, first.address, first.family);
  });
};

const agent = new Agent({ connect: { lookup: publicOnlyLookup } });

export async function fetchImage(url: string): Promise<Buffer> {
  try {
    const response = await fetch(url, {
      dispatcher: agent,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new ApiError("UPSTREAM_ERROR", `Source server responded with ${response.status}`);
    }

    const declaredSize = Number(response.headers.get("content-length"));
    if (declaredSize > MAX_SOURCE_BYTES) throw sourceTooLarge();

    return await readBodyWithLimit(response.body);
  } catch (error) {
    throw toApiError(error);
  }
}

// Content-Length is optional and describes the compressed size, so count the real bytes.
async function readBodyWithLimit(body: ReadableStream<Uint8Array> | null): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of body) {
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_SOURCE_BYTES) throw sourceTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  if (error instanceof Error) {
    if (error.name === "TimeoutError") {
      return new ApiError(
        "UPSTREAM_TIMEOUT",
        `Source image was not received within ${FETCH_TIMEOUT_MS / 1000} seconds`,
      );
    }
    // fetch wraps network failures, including our lookup's BLOCKED_URL, in `cause`.
    if (error.cause instanceof ApiError) return error.cause;
    if (hasErrorCode(error.cause, "ENOTFOUND")) {
      return new ApiError("UPSTREAM_ERROR", "Could not resolve the url's hostname");
    }
  }

  return new ApiError("UPSTREAM_ERROR", "Could not connect to the source server");
}

function hasErrorCode(value: unknown, code: string): boolean {
  return value instanceof Error && "code" in value && value.code === code;
}

function sourceTooLarge() {
  return new ApiError(
    "SOURCE_TOO_LARGE",
    `Source image exceeds the ${MAX_SOURCE_BYTES / 1024 / 1024} MB limit`,
  );
}
