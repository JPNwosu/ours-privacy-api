import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { parseProcessQuery, parseVideoThumbnailQuery } from "../src/validation.js";

const url = "https://example.com/cat.png";

function parseError(
  query: Record<string, unknown>,
  parse: (query: unknown) => unknown = parseProcessQuery,
): ApiError {
  try {
    parse(query);
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("Expected parsing to throw");
}

describe("parseProcessQuery", () => {
  it("accepts a url on its own", () => {
    expect(parseProcessQuery({ url })).toEqual({ url });
  });

  it("coerces numeric strings, since query params always arrive as strings", () => {
    const query = parseProcessQuery({
      url,
      width: "500",
      height: "300",
      quality: "80",
      format: "webp",
    });

    expect(query).toMatchObject({ width: 500, height: 300, quality: 80 });
  });

  it("normalizes format and crop case, and treats jpg as jpeg", () => {
    const query = parseProcessQuery({
      url,
      width: "100",
      height: "100",
      format: " JPG ",
      crop: "Fill",
    });

    expect(query).toMatchObject({ format: "jpeg", crop: "fill" });
  });

  it.each([
    ["url is missing", {}, "url", "url is required"],
    [
      "url is not http(s)",
      { url: "ftp://example.com/cat.png" },
      "url",
      "url must be an absolute http(s) URL with a domain name",
    ],
    [
      "url is relative",
      { url: "cat.png" },
      "url",
      "url must be an absolute http(s) URL with a domain name",
    ],
    [
      "url has several problems",
      { url: "ftp://x" },
      "url",
      "url must be an absolute http(s) URL with a domain name",
    ],
    ["width is 0", { url, width: "0" }, "width", "width must be an integer between 1 and 5000"],
    [
      "width is over the limit",
      { url, width: "5001" },
      "width",
      "width must be an integer between 1 and 5000",
    ],
    [
      "width is fractional",
      { url, width: "12.5" },
      "width",
      "width must be an integer between 1 and 5000",
    ],
    [
      "width is not a number",
      { url, width: "abc" },
      "width",
      "width must be an integer between 1 and 5000",
    ],
    [
      "width is repeated",
      { url, width: ["100", "200"] },
      "width",
      "width must be an integer between 1 and 5000",
    ],
    [
      "width is hexadecimal",
      { url, width: "0x10" },
      "width",
      "width must be an integer between 1 and 5000",
    ],
    [
      "width uses an exponent",
      { url, width: "1e3" },
      "width",
      "width must be an integer between 1 and 5000",
    ],
    ["width is empty", { url, width: "" }, "width", "width must be an integer between 1 and 5000"],
    [
      "quality is over 100",
      { url, quality: "101" },
      "quality",
      "quality must be an integer between 1 and 100",
    ],
    [
      "format is unsupported",
      { url, format: "gif" },
      "format",
      "format must be one of: jpeg, png, webp, avif (jpg is accepted as jpeg)",
    ],
    [
      "crop is unknown",
      { url, width: "1", height: "1", crop: "stretch" },
      "crop",
      "crop must be one of: fit, fill, scale",
    ],
    [
      "crop lacks a height",
      { url, width: "1", crop: "fill" },
      "crop",
      "crop requires both width and height",
    ],
    [
      "quality is set for png",
      { url, format: "png", quality: "80" },
      "quality",
      "quality only applies to jpeg, webp and avif output; set format to one of them",
    ],
    ["a parameter is unknown", { url, widht: "100" }, "widht", "unknown parameter: widht"],
  ])("rejects the request when %s", (_case, query, param, message) => {
    const error = parseError(query);

    expect(error.status).toBe(400);
    expect(error.code).toBe("INVALID_PARAMETERS");
    expect(error.details).toEqual([{ param, message }]);
  });

  it("reports every invalid parameter at once, not just the first", () => {
    const error = parseError({ url, width: "0", format: "gif" });

    expect(error.details?.map((detail) => detail.param)).toEqual(["width", "format"]);
  });
});

describe("parseVideoThumbnailQuery", () => {
  it("accepts time in seconds, including fractions, alongside the image options", () => {
    expect(parseVideoThumbnailQuery({ url, time: "1.5", width: "200", format: "webp" })).toEqual({
      url,
      time: 1.5,
      width: 200,
      format: "webp",
    });
  });

  it.each([
    [
      "time is negative",
      { url, time: "-1" },
      "time",
      "time must be a number of seconds from 0 to 86400",
    ],
    [
      "time is not a number",
      { url, time: "15s" },
      "time",
      "time must be a number of seconds from 0 to 86400",
    ],
    [
      "time is over 24 hours",
      { url, time: "86401" },
      "time",
      "time must be a number of seconds from 0 to 86400",
    ],
    [
      "time uses an exponent",
      { url, time: "1e21" },
      "time",
      "time must be a number of seconds from 0 to 86400",
    ],
    [
      "crop lacks a height",
      { url, width: "1", crop: "fill" },
      "crop",
      "crop requires both width and height",
    ],
    ["a parameter is unknown", { url, seconds: "15" }, "seconds", "unknown parameter: seconds"],
  ])("rejects the request when %s", (_case, query, param, message) => {
    const error = parseError(query, parseVideoThumbnailQuery);

    expect(error.status).toBe(400);
    expect(error.details).toEqual([{ param, message }]);
  });
});
