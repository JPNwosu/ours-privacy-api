import type { ErrorRequestHandler, RequestHandler } from "express";

const STATUS_BY_CODE = {
  INVALID_PARAMETERS: 400,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof STATUS_BY_CODE;

export type ErrorDetail = {
  param: string;
  message: string;
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[] | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export const notFoundHandler: RequestHandler = (req) => {
  throw new ApiError("NOT_FOUND", `No route for ${req.method} ${req.path}`);
};

// Express only treats a middleware as an error handler if it declares all four parameters.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  console.error(err);
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
  });
};
