import sharp, { type Metadata } from "sharp";
import { ApiError } from "./errors.js";

// Limits decoded size, not file size: a tiny file can declare enormous dimensions.
export const MAX_INPUT_PIXELS = 50_000_000;

export const SOURCE_FORMATS = ["jpeg", "png", "webp", "avif", "gif", "tiff"] as const;

type SourceFormat = (typeof SOURCE_FORMATS)[number];

function detectSourceFormat(metadata: Metadata): SourceFormat {
  // libheif reports AVIF as "heif" with AV1 compression.
  const detected =
    metadata.format === "heif" && metadata.compression === "av1" ? "avif" : metadata.format;

  const format = SOURCE_FORMATS.find((supported) => supported === detected);
  if (!format) {
    throw new ApiError(
      "UNSUPPORTED_SOURCE",
      `Source image format "${detected}" is not supported; expected one of: ${SOURCE_FORMATS.join(", ")}`,
    );
  }
  return format;
}

export async function transformImage(input: Buffer) {
  const metadata = await readMetadata(input);
  const sourceFormat = detectSourceFormat(metadata);
  assertWithinPixelLimit(metadata);

  const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS });
}

// The pixel limit is off here so oversized images reach our own 413 check; this only parses the header.
async function readMetadata(input: Buffer): Promise<Metadata> {
  try {
    return await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    throw new ApiError("UNSUPPORTED_SOURCE", "Source could not be read as an image");
  }
}

function assertWithinPixelLimit({ width, height }: Metadata): void {
  const pixels = width * height;
  if (pixels > MAX_INPUT_PIXELS) {
    throw new ApiError(
      "SOURCE_TOO_LARGE",
      `Source image is ${(pixels / 1_000_000).toFixed(1)} megapixels; the limit is ${MAX_INPUT_PIXELS / 1_000_000}`,
    );
  }
}
