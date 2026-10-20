import { randomUUID } from "node:crypto";
import {
  MAX_PULL_LIMIT,
  type Change,
  type OperationResult,
  type PullResponse,
  pushRequestSchema,
  syncOperationSchema,
  updatePreferencesRequestSchema,
} from "@pps/shared";
import { Router } from "express";
import { z } from "zod";
import { getAuth, requireOwner } from "../auth/middleware.ts";
import { type Db, toInt, toIso } from "../db/types.ts";
import { applyOperation, updatePreferencesInTx } from "../domain/operations.ts";
import { getPreferences } from "../domain/records.ts";
import { ApiError, fieldErrorsFrom, parseOrThrow } from "../http/errors.ts";

const CURSOR_PREFIX = "v1:";

/** Cursors are opaque to clients; the encoding may change without breaking them. */
export function encodeCursor(seq: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${seq}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const seq = raw.startsWith(CURSOR_PREFIX) ? Number(raw.slice(CURSOR_PREFIX.length)) : NaN;
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new ApiError(400, "VALIDATION_FAILED", "Invalid sync cursor.", { fieldErrors: { cursor: ["Invalid cursor"] } });
  }
  return seq;
}

const pullQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PULL_LIMIT).default(200),
});

export function syncRoutes(db: Db): Router {
  const router = Router();
  const owner = requireOwner(db);

  router.get("/preferences", owner, async (req, res) => {
    const auth = getAuth(req);
    res.json(await getPreferences(db, auth.userId));
  });

  router.patch("/preferences", owner, async (req, res) => {
    const auth = getAuth(req);
    const body = parseOrThrow(updatePreferencesRequestSchema, req.body);
    const outcome = await db.transaction((tx) =>
      updatePreferencesInTx(tx, auth, body.baseRevision, body.changes, randomUUID()),
    );
    if (outcome.status === "conflict") {
      throw new ApiError(409, "CONFLICT", "Preferences changed on another device.", {
        details: { current: outcome.current, submitted: outcome.submitted },
      });
    }
    if (outcome.status !== "applied") throw new Error("Unexpected preference update outcome");
    res.json(outcome.record);
  });

  router.post("/sync/push", owner, async (req, res) => {
    const auth = getAuth(req);
    const { operations } = parseOrThrow(pushRequestSchema, req.body);
    const results: OperationResult[] = [];
    // Ordered: later operations may depend on earlier ones. Each runs in its own transaction,
    // so a rejected operation never rolls back (or claims) another one.
    for (const [index, raw] of operations.entries()) {
      const parsed = syncOperationSchema.safeParse(raw);
      if (!parsed.success) {
        const opId = z.object({ opId: z.uuid() }).safeParse(raw);
        results.push({
          index,
          opId: opId.success ? opId.data.opId : null,
          status: "rejected",
          error: {
            code: "VALIDATION_FAILED",
            message: "The operation is invalid.",
            fieldErrors: fieldErrorsFrom(parsed.error),
          },
        });
        continue;
      }
      results.push(await applyOperation(db, auth, parsed.data, index));
    }
    res.json({ results });
  });

  router.get("/sync/pull", owner, async (req, res) => {
    const auth = getAuth(req);
    const query = parseOrThrow(pullQuerySchema, req.query);
    const after = decodeCursor(query.cursor);
    const { rows } = await db.query<{
      seq: unknown;
      record_type: Change["recordType"];
      record_id: string;
      revision: number;
      deleted: boolean;
      data: unknown;
      device_id: string | null;
      changed_at: unknown;
    }>(
      `SELECT seq, record_type, record_id, revision, deleted, data, device_id, changed_at
         FROM change_log
        WHERE user_id = $1 AND seq > $2
        ORDER BY seq
        LIMIT $3`,
      [auth.userId, after, query.limit + 1],
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const response: PullResponse = {
      changes: page.map((row) => ({
        recordType: row.record_type,
        recordId: row.record_id,
        revision: toInt(row.revision),
        deleted: row.deleted,
        data: typeof row.data === "string" ? JSON.parse(row.data) : row.data,
        changedAt: toIso(row.changed_at),
        deviceId: row.device_id,
      })),
      nextCursor: encodeCursor(last ? toInt(last.seq) : after),
      hasMore: rows.length > query.limit,
    };
    res.json(response);
  });

  return router;
}
