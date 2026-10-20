import { z } from "zod";
import { ERROR_CODES } from "./errors.ts";
import { preferencePatchSchema, preferencesRecordSchema } from "./preferences.ts";

export const RECORD_TYPES = ["preferences", "sync_probe"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const MAX_PUSH_OPERATIONS = 100;
export const MAX_PULL_LIMIT = 500;

/**
 * Diagnostic record used in Stage 1 to prove create/update/delete sync and tombstones
 * before domain records exist (docs/DECISIONS.md T-011). Not a product feature.
 */
export const syncProbeFieldsSchema = z.object({
  text: z.string().trim().min(1).max(500),
});

export const syncProbeRecordSchema = syncProbeFieldsSchema.extend({
  id: z.uuid(),
  revision: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

export type SyncProbeRecord = z.infer<typeof syncProbeRecordSchema>;

const opBase = { opId: z.uuid() };

export const preferencesUpdateOpSchema = z.object({
  ...opBase,
  kind: z.literal("preferences.update"),
  baseRevision: z.number().int().min(1),
  payload: preferencePatchSchema,
});

export const syncProbeCreateOpSchema = z.object({
  ...opBase,
  kind: z.literal("sync_probe.create"),
  recordId: z.uuid(),
  payload: syncProbeFieldsSchema,
});

export const syncProbeUpdateOpSchema = z.object({
  ...opBase,
  kind: z.literal("sync_probe.update"),
  recordId: z.uuid(),
  baseRevision: z.number().int().min(1),
  payload: syncProbeFieldsSchema,
});

export const syncProbeDeleteOpSchema = z.object({
  ...opBase,
  kind: z.literal("sync_probe.delete"),
  recordId: z.uuid(),
  baseRevision: z.number().int().min(1),
});

export const syncOperationSchema = z.discriminatedUnion("kind", [
  preferencesUpdateOpSchema,
  syncProbeCreateOpSchema,
  syncProbeUpdateOpSchema,
  syncProbeDeleteOpSchema,
]);

export type SyncOperation = z.infer<typeof syncOperationSchema>;
export type SyncOperationKind = SyncOperation["kind"];

/** Envelope is validated loosely so one malformed operation is reported per-operation. */
export const pushRequestSchema = z.object({
  operations: z.array(z.unknown()).min(1).max(MAX_PUSH_OPERATIONS),
});

export const syncRecordSchema = z.union([preferencesRecordSchema, syncProbeRecordSchema]);

export const operationResultSchema = z.discriminatedUnion("status", [
  z.object({
    index: z.number().int(),
    opId: z.uuid(),
    status: z.literal("applied"),
    recordType: z.enum(RECORD_TYPES),
    recordId: z.uuid(),
    revision: z.number().int(),
    record: z.unknown(),
    replayed: z.boolean(),
  }),
  z.object({
    index: z.number().int(),
    opId: z.uuid(),
    status: z.literal("conflict"),
    recordType: z.enum(RECORD_TYPES),
    recordId: z.uuid(),
    /** Current server record; for sync_probe it may carry `deletedAt` (a tombstone). */
    current: z.unknown(),
    submitted: z.unknown(),
  }),
  z.object({
    index: z.number().int(),
    opId: z.uuid().nullable(),
    status: z.literal("rejected"),
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string(),
      fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
    }),
  }),
]);

export type OperationResult = z.infer<typeof operationResultSchema>;

export const pushResponseSchema = z.object({ results: z.array(operationResultSchema) });
export type PushResponse = z.infer<typeof pushResponseSchema>;

export const changeSchema = z.object({
  recordType: z.enum(RECORD_TYPES),
  recordId: z.uuid(),
  revision: z.number().int(),
  deleted: z.boolean(),
  data: z.unknown(),
  changedAt: z.string(),
  /** Device that produced the change, so a client can recognise its own echoes. */
  deviceId: z.uuid().nullable(),
});

export type Change = z.infer<typeof changeSchema>;

export const pullResponseSchema = z.object({
  changes: z.array(changeSchema),
  nextCursor: z.string(),
  hasMore: z.boolean(),
});

export type PullResponse = z.infer<typeof pullResponseSchema>;
