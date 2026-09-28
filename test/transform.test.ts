import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { MAX_INPUT_PIXELS, transformImage } from "../src/transform.js";

type ImageFormat = "jpeg" | "png" | "webp" | "avif" | "gif" | "tiff";

function solidImage(width: number, height: number, format: ImageFormat = "png"): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "blue" } })
    .toFormat(format)
    .toBuffer();
}

// Detailed content compresses realistically, so quality settings make a measurable difference.
function noisyJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "black",
      noise: { type: "gaussian", mean: 128, sigma: 50 },
    },
  })
    .jpeg()
    .toBuffer();
}

async function describeImage(data: Buffer) {
  const { width, height, format, exif, orientation } = await sharp(data).metadata();
  return { width, height, format, exif, orientation };
}

async function topLeftColor(data: Buffer): Promise<"red" | "blue" | "other"> {
  const [red = 0, green = 0, blue = 0] = await sharp(data)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  if (red > 200 && green < 50 && blue < 50) return "red";
  if (blue > 200 && red < 50 && green < 50) return "blue";
  return "other";
}

describe("transformImage", () => {
  describe("resizing", () => {
    it("returns the image unchanged in size and format when no options are given", async () => {
      const { data, format } = await transformImage(await solidImage(400, 200), {});

      expect(format).toBe("png");
      expect(await describeImage(data)).toMatchObject({ width: 400, height: 200, format: "png" });
    });

    it.each([
      ["fit", { width: 100, height: 50 }],
      ["fill", { width: 100, height: 100 }],
      ["scale", { width: 100, height: 100 }],
    ] as const)("crop=%s produces %o from a 400x200 source", async (crop, expected) => {
      const { data } = await transformImage(await solidImage(400, 200), {
        width: 100,
        height: 100,
        crop,
      });

      expect(await describeImage(data)).toMatchObject(expected);
    });

    it("defaults to crop=fit when both dimensions are given", async () => {
      const { data } = await transformImage(await solidImage(400, 200), {
        width: 100,
        height: 100,
      });

      expect(await describeImage(data)).toMatchObject({ width: 100, height: 50 });
    });

    it("crops the overflow with fill but keeps it (stretched) with scale", async () => {
      // A 400x200 blue image with a red stripe down its left quarter.
      const striped = await sharp(await solidImage(400, 200))
        .composite([
          {
            input: { create: { width: 100, height: 200, channels: 3, background: "red" } },
            left: 0,
            top: 0,
          },
        ])
        .png()
        .toBuffer();
      const box = { width: 100, height: 100 };

      const filled = await transformImage(striped, { ...box, crop: "fill" });
      const scaled = await transformImage(striped, { ...box, crop: "scale" });

      expect(await topLeftColor(filled.data)).toBe("blue");
      expect(await topLeftColor(scaled.data)).toBe("red");
    });

    it.each([
      ["width", { width: 100 }, { width: 100, height: 50 }],
      ["height", { height: 50 }, { width: 100, height: 50 }],
    ])("keeps the aspect ratio when only %s is given", async (_name, options, expected) => {
      const { data } = await transformImage(await solidImage(400, 200), options);

      expect(await describeImage(data)).toMatchObject(expected);
    });

    it("applies EXIF orientation before resizing, so phone photos come out upright", async () => {
      // Stored as 200x100 with orientation 6 ("rotate 90°"), so it displays as 100x200.
      const rotated = await sharp(await solidImage(200, 100, "jpeg"))
        .withMetadata({ orientation: 6 })
        .toBuffer();

      const { data } = await transformImage(rotated, { width: 50 });

      expect(await describeImage(data)).toMatchObject({
        width: 50,
        height: 100,
        orientation: undefined,
      });
    });
  });

  describe("output format", () => {
    it("converts to the requested format", async () => {
      const { data, format } = await transformImage(await solidImage(10, 10, "png"), {
        format: "webp",
      });

      expect(format).toBe("webp");
      expect((await describeImage(data)).format).toBe("webp");
    });

    it("passes quality through to the encoder", async () => {
      const source = await noisyJpeg(200, 200);

      const low = await transformImage(source, { format: "jpeg", quality: 10 });
      const high = await transformImage(source, { format: "jpeg", quality: 90 });

      expect(low.data.length).toBeLessThan(high.data.length);
    });

    it("keeps an AVIF source as AVIF, even though sharp reports it as heif", async () => {
      const { format } = await transformImage(await solidImage(10, 10, "avif"), {});

      expect(format).toBe("avif");
    });

    it.each(["gif", "tiff"] as const)("falls back to png for a %s source", async (source) => {
      const { data, format } = await transformImage(await solidImage(10, 10, source), {});

      expect(format).toBe("png");
      expect((await describeImage(data)).format).toBe("png");
    });

    it("strips EXIF metadata such as camera details and location", async () => {
      const withExif = await sharp(await solidImage(10, 10, "jpeg"))
        .withExif({ IFD0: { Artist: "Jane Doe", Copyright: "Private" } })
        .toBuffer();
      expect((await describeImage(withExif)).exif).toBeDefined();

      const { data } = await transformImage(withExif, { width: 5 });

      expect((await describeImage(data)).exif).toBeUndefined();
    });
  });

  describe("errors", () => {
    it("rejects bytes that are not an image with 415", async () => {
      await expect(
        transformImage(Buffer.from("<!doctype html><p>Please log in</p>"), {}),
      ).rejects.toMatchObject({ status: 415, code: "UNSUPPORTED_SOURCE" });
    });

    it("rejects image formats outside the allowlist, naming the format", async () => {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');

      await expect(transformImage(svg, {})).rejects.toMatchObject({
        status: 415,
        code: "UNSUPPORTED_SOURCE",
        message: expect.stringContaining('"svg"'),
      });
    });

    it("rejects images over the pixel limit with 413 before decoding them", async () => {
      const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 1;

      await expect(transformImage(await solidImage(side, side), {})).rejects.toMatchObject({
        status: 413,
        code: "SOURCE_TOO_LARGE",
      });
    });

    it("rejects quality when the output format is png because the source is", async () => {
      await expect(
        transformImage(await solidImage(10, 10, "gif"), { quality: 80 }),
      ).rejects.toMatchObject({
        status: 400,
        code: "INVALID_PARAMETERS",
        details: [{ param: "quality", message: expect.stringContaining("set format") }],
      });
    });

    it("rejects a truncated image whose header is intact with 415", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const complete = await noisyJpeg(400, 400);
      const truncated = complete.subarray(0, complete.length / 2);

      await expect(transformImage(truncated, { width: 100 })).rejects.toMatchObject({
        status: 415,
        code: "UNSUPPORTED_SOURCE",
        message: "Source image is corrupt or incomplete",
      });
      expect(consoleError).toHaveBeenCalledOnce();

      consoleError.mockRestore();
    });
  });
});
