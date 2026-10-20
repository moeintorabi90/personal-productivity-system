import { z } from "zod";
import { preferenceFieldsSchema, preferencesRecordSchema } from "./preferences.ts";

export const PASSWORD_MIN_LENGTH = 12;

export const deviceSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
});

export type DeviceInput = z.infer<typeof deviceSchema>;

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(200);

export const setupRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  device: deviceSchema,
  preferences: preferenceFieldsSchema.partial().optional(),
});

export type SetupRequest = z.input<typeof setupRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  device: deviceSchema,
});

export type LoginRequest = z.input<typeof loginRequestSchema>;

export const ownerSchema = z.object({ id: z.uuid(), email: z.string() });

export const sessionResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  owner: ownerSchema,
  device: deviceSchema,
  preferences: preferencesRecordSchema,
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const meResponseSchema = z.object({
  owner: ownerSchema,
  device: deviceSchema,
});

export const deviceListResponseSchema = z.object({
  devices: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      createdAt: z.string(),
      lastSeenAt: z.string().nullable(),
      revokedAt: z.string().nullable(),
      current: z.boolean(),
    }),
  ),
});

export const setupStatusResponseSchema = z.object({ setupCompleted: z.boolean() });
