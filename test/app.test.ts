import sharp from "sharp";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { ApiError } from "../src/errors.js";

let sourcePng: Buffer;

beforeAll(async () => {
  sourcePng = await sharp({ create: { width: 400, height: 200, channels: 3, background: "blue" } })
    .png()
    .toBuffer();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function appServing(fetchImage: (url: string) => Promise<Buffer>) {
  return createApp({ fetchImage });
}

describe("GET /health", () => {
  it("reports that the service is up", async () => {
    const response = await request(appServing(async () => sourcePng)).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});

describe("GET /process", () => {
  it("returns the transformed image with a matching Content-Type", async () => {
    const response = await request(appServing(async () => sourcePng))
      .get("/process")
      .query({ url: "https://example.com/cat.png", width: 100, format: "webp" });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
    const { width, height, format } = await sharp(response.body).metadata();
    expect({ width, height, format }).toEqual({ width: 100, height: 50, format: "webp" });
  });

  it("fetches the url from the query string", async () => {
    const fetchImage = vi.fn(async () => sourcePng);

    await request(appServing(fetchImage))
      .get("/process")
      .query({ url: "https://example.com/cat.png" });

    expect(fetchImage).toHaveBeenCalledExactlyOnceWith("https://example.com/cat.png");
  });

  it("returns 400 with details for invalid parameters, without fetching anything", async () => {
    const fetchImage = vi.fn(async () => sourcePng);

    const response = await request(appServing(fetchImage))
      .get("/process")
      .query({ url: "https://example.com/cat.png", width: "0" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "INVALID_PARAMETERS",
        message: "Invalid query parameters",
        details: [{ param: "width", message: "width must be an integer between 1 and 5000" }],
      },
    });
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("passes fetch errors through with their status and code", async () => {
    const app = appServing(async () => {
      throw new ApiError("UPSTREAM_ERROR", "Source server responded with 404");
    });

    const response = await request(app).get("/process").query({ url: "https://example.com/gone.png" });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      error: { code: "UPSTREAM_ERROR", message: "Source server responded with 404" },
    });
  });

  it("returns 415 when the url does not point to an image", async () => {
    const app = appServing(async () => Buffer.from("<!doctype html><p>Please log in</p>"));

    const response = await request(app).get("/process").query({ url: "https://example.com/login" });

    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe("UNSUPPORTED_SOURCE");
  });

  it("hides unexpected errors behind a generic 500 and logs them", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = appServing(async () => {
      throw new Error("database password is hunter2");
    });

    const response = await request(app).get("/process").query({ url: "https://example.com/cat.png" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
    });
    expect(consoleError).toHaveBeenCalledOnce();
  });
});

describe("unknown routes", () => {
  it("return 404 in the same JSON error format", async () => {
    const response = await request(appServing(async () => sourcePng)).get("/resize");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: "NOT_FOUND", message: "No route for GET /resize" },
    });
  });
});
