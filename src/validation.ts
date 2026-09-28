import { z } from "zod";
import { ApiError, type ErrorDetail } from "./errors.js";

export const MAX_DIMENSION = 5000;
export const OUTPUT_FORMATS = ["jpeg", "png", "webp", "avif"] as const;
export const CROP_MODES = ["fit", "fill", "scale"] as const;
export const DEFAULT_CROP_MODE = "fit";

const sourceUrl = z.httpUrl({
  normalize: true,
  error: (issue) =>
    issue.input === undefined
      ? "url is required"
      : "url must be an absolute http(s) URL with a domain name",
});

// Query params always arrive as strings, so coerce to a number before validating.
const dimension = (name: string) =>
  z.coerce
    .number({ error: `${name} must be an integer between 1 and ${MAX_DIMENSION}` })
    .int()
    .min(1)
    .max(MAX_DIMENSION)
    .optional();

const formatError = `format must be one of: ${OUTPUT_FORMATS.join(", ")} (jpg is accepted as jpeg)`;

const outputFormat = z
  .string({ error: formatError })
  .trim()
  .toLowerCase()
  .transform((value) => (value === "jpg" ? "jpeg" : value))
  .pipe(z.enum(OUTPUT_FORMATS, { error: formatError }))
  .optional();

const cropError = `crop must be one of: ${CROP_MODES.join(", ")}`;

const crop = z
  .string({ error: cropError })
  .trim()
  .toLowerCase()
  .pipe(z.enum(CROP_MODES, { error: cropError }))
  .optional();

export const QUALITY_FORMAT_ERROR = "quality only applies to jpeg, webp and avif output; set format to one of them";

const quality = z.coerce
  .number({ error: "quality must be an integer between 1 and 100" })
  .int()
  .min(1)
  .max(100)
  .optional();

export const processQuerySchema = z
  .strictObject({
    url: sourceUrl,
    width: dimension("width"),
    height: dimension("height"),
    crop,
    format: outputFormat,
    quality,
  })
  .refine((query) => query.crop === undefined || (query.width !== undefined && query.height !== undefined), {
    error: "crop requires both width and height",
    path: ["crop"],
  })
  .refine((query) => !(query.format === "png" && query.quality !== undefined), {
    error: QUALITY_FORMAT_ERROR,
    path: ["quality"],
  });

export type ProcessQuery = z.infer<typeof processQuerySchema>;

export function parseProcessQuery(query: unknown): ProcessQuery {
  const result = processQuerySchema.safeParse(query);
  if (result.success) return result.data;

  const details: ErrorDetail[] = result.error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => ({ param: key, message: `unknown parameter: ${key}` }))
      : [{ param: issue.path.join("."), message: issue.message }],
  );
  throw new ApiError("INVALID_PARAMETERS", "Invalid query parameters", details);
}
