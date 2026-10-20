import { createHash } from "node:crypto";
import type { OperationResult, PreferencePatch, SyncOperation } from "@pps/shared";
import type { AuthContext } from "../auth/middleware.ts";
import type { Db, Queryable } from "../db/types.ts";
import {
  appendChange,
  findProbe,
  getPreferences,
  insertProbe,
  lockOwner,
  tombstoneProbe,
  updateProbe,
  writePreferences,
} from "./records.ts";

type Outcome = DistributiveOmit<OperationResult, "index">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(op: SyncOperation): string {
  return createHash("sha256").update(stableStringify(op)).digest("hex");
}

/**
 * Applies one validated operation in its own transaction. A retried operation (same opId and
 * same content) returns the stored result without applying anything again.
 */
export async function applyOperation(
  db: Db,
  auth: AuthContext,
  op: SyncOperation,
  index: number,
): Promise<OperationResult> {
  const hash = requestHash(op);
  return db.transaction(async (tx) => {
    await lockOwner(tx, auth.userId);

    const prior = await tx.query<{ request_hash: string; result: Outcome | string }>(
      "SELECT request_hash, result FROM sync_operation WHERE user_id = $1 AND op_id = $2",
      [auth.userId, op.opId],
    );
    const priorRow = prior.rows[0];
    if (priorRow) {
      if (priorRow.request_hash !== hash) {
        return {
          index,
          opId: op.opId,
          status: "rejected",
          error: {
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "This operation ID was already used for a different change.",
          },
        };
      }
      const stored = (typeof priorRow.result === "string" ? JSON.parse(priorRow.result) : priorRow.result) as Outcome;
      return { ...stored, index, ...(stored.status === "applied" ? { replayed: true } : {}) } as OperationResult;
    }

    const outcome = await execute(tx, auth, op);
    if (outcome.status === "applied") {
      await tx.query(
        `INSERT INTO sync_operation (user_id, op_id, device_id, request_hash, result)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [auth.userId, op.opId, auth.deviceId, hash, JSON.stringify(outcome)],
      );
    }
    return { ...outcome, index } as OperationResult;
  });
}

async function execute(tx: Queryable, auth: AuthContext, op: SyncOperation): Promise<Outcome> {
  switch (op.kind) {
    case "preferences.update":
      return updatePreferencesInTx(tx, auth, op.baseRevision, op.payload, op.opId);

    case "sync_probe.create": {
      const existing = await findProbe(tx, auth.userId, op.recordId);
      if (existing) {
        return conflict(op, "sync_probe", op.recordId, existing, op.payload);
      }
      const record = await insertProbe(tx, auth.userId, op.recordId, op.payload.text);
      await appendChange(tx, change(auth, op.opId, "sync_probe", record.id, record.revision, false, record));
      return applied(op.opId, "sync_probe", record.id, record.revision, record);
    }

    case "sync_probe.update": {
      const existing = await findProbe(tx, auth.userId, op.recordId);
      if (!existing) return notFound(op.opId);
      if (existing.deletedAt || existing.revision !== op.baseRevision) {
        return conflict(op, "sync_probe", op.recordId, existing, op.payload);
      }
      const record = await updateProbe(tx, auth.userId, op.recordId, op.payload.text, existing.revision + 1);
      await appendChange(tx, change(auth, op.opId, "sync_probe", record.id, record.revision, false, record));
      return applied(op.opId, "sync_probe", record.id, record.revision, record);
    }

    case "sync_probe.delete": {
      const existing = await findProbe(tx, auth.userId, op.recordId);
      if (!existing) return notFound(op.opId);
      if (existing.deletedAt || existing.revision !== op.baseRevision) {
        return conflict(op, "sync_probe", op.recordId, existing, { delete: true });
      }
      const record = await tombstoneProbe(tx, auth.userId, op.recordId, existing.revision + 1);
      await appendChange(tx, change(auth, op.opId, "sync_probe", record.id, record.revision, true, record));
      return applied(op.opId, "sync_probe", record.id, record.revision, record);
    }
  }
}

/** Shared by the sync push and `PATCH /v1/preferences`; the caller must hold a transaction. */
export async function updatePreferencesInTx(
  tx: Queryable,
  auth: AuthContext,
  baseRevision: number,
  patch: PreferencePatch,
  opId: string,
): Promise<Outcome> {
  await lockOwner(tx, auth.userId);
  const current = await getPreferences(tx, auth.userId, true);
  if (current.revision !== baseRevision) {
    return {
      opId,
      status: "conflict",
      recordType: "preferences",
      recordId: auth.userId,
      current,
      submitted: patch,
    };
  }
  const { revision: _r, updatedAt: _u, ...fields } = current;
  const record = await writePreferences(tx, auth.userId, { ...fields, ...patch }, current.revision + 1);
  await appendChange(tx, change(auth, opId, "preferences", auth.userId, record.revision, false, record));
  return applied(opId, "preferences", auth.userId, record.revision, record);
}

function change(
  auth: AuthContext,
  opId: string,
  recordType: "preferences" | "sync_probe",
  recordId: string,
  revision: number,
  deleted: boolean,
  data: unknown,
) {
  return { userId: auth.userId, recordType, recordId, revision, deleted, data, deviceId: auth.deviceId, opId };
}

function applied(
  opId: string,
  recordType: "preferences" | "sync_probe",
  recordId: string,
  revision: number,
  record: unknown,
): Outcome {
  return { opId, status: "applied", recordType, recordId, revision, record, replayed: false };
}

function conflict(
  op: SyncOperation,
  recordType: "preferences" | "sync_probe",
  recordId: string,
  current: unknown,
  submitted: unknown,
): Outcome {
  return { opId: op.opId, status: "conflict", recordType, recordId, current, submitted };
}

function notFound(opId: string): Outcome {
  // Same answer whether the record never existed or belongs to someone else: no existence leak.
  return { opId, status: "rejected", error: { code: "NOT_FOUND", message: "Record not found." } };
}
