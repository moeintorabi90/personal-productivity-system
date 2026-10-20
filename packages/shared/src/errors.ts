import { z } from "zod";

/** Stable error codes returned by the API. Clients branch on these, never on messages. */
export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "NOT_FOUND",
  "CONFLICT",
  "SETUP_ALREADY_COMPLETED",
  "SETUP_TOKEN_INVALID",
  "INVALID_CREDENTIALS",
  "IDEMPOTENCY_KEY_REUSED",
  "RATE_LIMITED",
  "PAYLOAD_TOO_LARGE",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
    details: z.unknown().optional(),
  }),
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;
