import http from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSourceFetcher, fetchImage } from "../src/fetchSource.js";

const MAX_BYTES = 1000;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    switch (req.url) {
      case "/image":
        return res.end("image bytes");
      case "/redirect":
        res.writeHead(302, { location: "/image" });
        return res.end();
      case "/missing":
        res.writeHead(404);
        return res.end();
      case "/declared-too-large":
        res.writeHead(200, { "content-length": String(MAX_BYTES + 1) });
        return res.end(Buffer.alloc(MAX_BYTES + 1));
      case "/streamed-too-large":
        // No Content-Length, so only counting the received bytes can catch this.
        res.write(Buffer.alloc(MAX_BYTES));
        return res.end(Buffer.alloc(1));
      case "/cut-short":
        res.writeHead(200, { "content-length": "500" });
        res.write(Buffer.alloc(100));
        return res.socket?.destroy();
      case "/slow":
        return; // Never responds.
      default:
        res.writeHead(500);
        return res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("fetchImage SSRF protection", () => {
  it.each([
    ["a hostname that resolves to loopback", () => baseUrl.replace("127.0.0.1", "localhost")],
    // Validation rejects IP literals, but a redirect can still point at one.
    ["an IPv4 literal", () => baseUrl],
    ["an IPv6 literal", () => "http://[::1]/"],
    ["an IPv4-mapped IPv6 literal", () => "http://[::ffff:127.0.0.1]/"],
    ["the cloud metadata address", () => "http://169.254.169.254/latest/meta-data/"],
  ])("refuses to connect to %s", async (_name, url) => {
    await expect(fetchImage(url())).rejects.toMatchObject({ status: 400, code: "BLOCKED_URL" });
  });
});

// A plain Agent bypasses the SSRF guard so these tests can use the local server.
describe("createSourceFetcher", () => {
  const fetchLocal = createSourceFetcher({
    dispatcher: new Agent(),
    timeoutMs: 200,
    maxBytes: MAX_BYTES,
  });

  it("returns the response body", async () => {
    const body = await fetchLocal(`${baseUrl}/image`);

    expect(body.toString()).toBe("image bytes");
  });

  it("follows redirects", async () => {
    const body = await fetchLocal(`${baseUrl}/redirect`);

    expect(body.toString()).toBe("image bytes");
  });

  it("reports the upstream status when the source server returns an error", async () => {
    await expect(fetchLocal(`${baseUrl}/missing`)).rejects.toMatchObject({
      status: 502,
      code: "UPSTREAM_ERROR",
      message: "Source server responded with 404",
    });
  });

  it.each(["/declared-too-large", "/streamed-too-large"])(
    "rejects bodies over the size limit (%s)",
    async (path) => {
      await expect(fetchLocal(`${baseUrl}${path}`)).rejects.toMatchObject({
        status: 413,
        code: "SOURCE_TOO_LARGE",
      });
    },
  );

  it("fails with 502 when the connection closes before the full body arrives", async () => {
    await expect(fetchLocal(`${baseUrl}/cut-short`)).rejects.toMatchObject({
      status: 502,
      code: "UPSTREAM_ERROR",
    });
  });

  it("gives up with 504 when the source server is too slow", async () => {
    await expect(fetchLocal(`${baseUrl}/slow`)).rejects.toMatchObject({
      status: 504,
      code: "UPSTREAM_TIMEOUT",
      message: "Source was not received within 0.2 seconds",
    });
  });

  it("reports hostnames that do not resolve", async () => {
    // .invalid is reserved and never resolves (RFC 2606).
    await expect(fetchLocal("http://no-such-host.invalid/")).rejects.toMatchObject({
      status: 502,
      message: "Could not resolve the url's hostname",
    });
  });
});
