import type { ErrorCode } from "@pps/shared";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly fieldErrors: Record<string, string[]> | undefined;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    extra: { details?: unknown; fieldErrors?: Record<string, string[]> } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = extra.details;
    this.fieldErrors = extra.fieldErrors;
  }
}

export function fieldErrorsFrom(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/** Parses a request body/query with a Zod schema or throws a 400 with field errors. */
export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, "VALIDATION_FAILED", "The request is invalid.", {
      fieldErrors: fieldErrorsFrom(result.error),
    });
  }
  return result.data;
}

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(new ApiError(404, "NOT_FOUND", "Route not found."));
}

/** Converts every error into the stable `{ error: { code, message } }` shape; never leaks stacks. */
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof ApiError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    });
    return;
  }
  const type = (error as { type?: string } | null)?.type;
  if (type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "VALIDATION_FAILED", message: "Malformed JSON body." } });
    return;
  }
  if (type === "entity.too.large") {
    res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." } });
    return;
  }
  // Structured diagnostic without request bodies, credentials, or private notes.
  console.error(
    JSON.stringify({
      level: "error",
      msg: "unhandled request error",
      method: req.method,
      path: req.path,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    }),
  );
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong on the server." } });
}
