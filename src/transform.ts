import sharp, { type FitEnum, type Metadata } from "sharp";
import { ApiError } from "./errors.js";
import {
  DEFAULT_CROP_MODE,
  OUTPUT_FORMATS,
  QUALITY_FORMAT_ERROR,
  type ProcessQuery,
} from "./validation.js";

// Limits decoded size, not file size: a tiny file can declare enormous dimensions.
export const MAX_INPUT_PIXELS = 50_000_000;

export const SOURCE_FORMATS = ["jpeg", "png", "webp", "avif", "gif", "tiff"] as const;

type SourceFormat = (typeof SOURCE_FORMATS)[number];
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type TransformOptions = Omit<ProcessQuery, "url">;

export type TransformResult = {
  data: Buffer;
  format: OutputFormat;
};

const FIT_BY_CROP = {
  fit: "inside",
  fill: "cover",
  scale: "fill",
} as const satisfies Record<NonNullable<ProcessQuery["crop"]>, keyof FitEnum>;

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

export async function transformImage(
  input: Buffer,
  options: TransformOptions,
): Promise<TransformResult> {
  const metadata = await readMetadata(input);
  const sourceFormat = detectSourceFormat(metadata);
  assertWithinPixelLimit(metadata);

  const outputFormat = options.format ?? defaultOutputFormat(sourceFormat);
  assertQualitySupported(outputFormat, options.quality);

  // Orient first so width and height apply to the image as it is displayed.
  const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).autoOrient();

  if (options.width !== undefined || options.height !== undefined) {
    image.resize({
      width: options.width,
      height: options.height,
      fit: FIT_BY_CROP[options.crop ?? DEFAULT_CROP_MODE],
    });
  }

  try {
    const data = await image.toFormat(outputFormat, { quality: options.quality }).toBuffer();
    return { data, format: outputFormat };
  } catch (error) {
    // Pixels are only decoded here, so a truncated body passes the header check and fails now.
    // Options are validated by this point, but log the cause in case the failure is ours.
    console.error("Image processing failed:", error);
    throw new ApiError("UNSUPPORTED_SOURCE", "Source image is corrupt or incomplete");
  }
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

// gif and tiff can be read but not written; png keeps their transparency losslessly.
function defaultOutputFormat(source: SourceFormat): OutputFormat {
  return OUTPUT_FORMATS.find((output) => output === source) ?? "png";
}

// Validation rejects format=png&quality=N; this catches png chosen from the source instead.
function assertQualitySupported(format: OutputFormat, quality: number | undefined): void {
  if (format === "png" && quality !== undefined) {
    throw new ApiError("INVALID_PARAMETERS", "Invalid query parameters", [
      { param: "quality", message: QUALITY_FORMAT_ERROR },
    ]);
  }
}
