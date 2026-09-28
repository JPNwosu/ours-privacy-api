import dns from "node:dns";
import net, { type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, buildConnector, type Dispatcher, fetch } from "undici";
import { ApiError } from "./errors.js";

export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const VIDEO_FETCH_TIMEOUT_MS = 30_000;

function isPublicAddress(address: string): boolean {
  return ipaddr.process(address).range() === "unicast";
}

function blockedUrl() {
  return new ApiError("BLOCKED_URL", "url resolves to a private or reserved network address");
}

// Validating inside the connection's own DNS lookup means the IP we check is the IP we
// connect to (no DNS-rebinding gap).
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "");

    if (!addresses.every(({ address }) => isPublicAddress(address))) {
      return callback(blockedUrl(), "");
    }

    if (options.all) return callback(null, addresses);
    const [first] = addresses;
    if (!first) return callback(new Error(`No addresses found for ${hostname}`), "");
    callback(null, first.address, first.family);
  });
};

const connectWithPublicLookup = buildConnector({ lookup: publicOnlyLookup });

// Node skips the DNS lookup for IP literals, so check those here. Every connection,
// including each redirect hop, goes through this connector.
const connectPublicOnly: buildConnector.connector = (options, callback) => {
  if (net.isIP(options.hostname) && !isPublicAddress(options.hostname)) {
    return callback(blockedUrl(), null);
  }
  connectWithPublicLookup(options, callback);
};

const publicOnlyAgent = new Agent({ connect: connectPublicOnly });

export type SourceFetcherOptions = {
  dispatcher?: Dispatcher;
  timeoutMs?: number;
  maxBytes?: number;
};

export function createSourceFetcher({
  dispatcher = publicOnlyAgent,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_SOURCE_BYTES,
}: SourceFetcherOptions = {}) {
  return async function fetchSource(url: string): Promise<Buffer> {
    try {
      const response = await fetch(url, {
        dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new ApiError("UPSTREAM_ERROR", `Source server responded with ${response.status}`);
      }

      const declaredSize = Number(response.headers.get("content-length"));
      if (declaredSize > maxBytes) throw sourceTooLarge(maxBytes);

      return await readBodyWithLimit(response.body, maxBytes);
    } catch (error) {
      throw toApiError(error, timeoutMs);
    }
  };
}

export const fetchImage = createSourceFetcher();
export const fetchVideo = createSourceFetcher({
  maxBytes: MAX_VIDEO_BYTES,
  timeoutMs: VIDEO_FETCH_TIMEOUT_MS,
});

// Content-Length is optional and describes the compressed size, so count the real bytes.
async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of body) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) throw sourceTooLarge(maxBytes);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function toApiError(error: unknown, timeoutMs: number): ApiError {
  if (error instanceof ApiError) return error;

  if (error instanceof Error) {
    if (error.name === "TimeoutError") {
      return new ApiError(
        "UPSTREAM_TIMEOUT",
        `Source was not received within ${timeoutMs / 1000} seconds`,
      );
    }
    // fetch wraps network failures, including our connector's BLOCKED_URL, in `cause`.
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

function sourceTooLarge(maxBytes: number) {
  return new ApiError(
    "SOURCE_TOO_LARGE",
    `Source exceeds the ${maxBytes / 1024 / 1024} MB limit`,
  );
}
