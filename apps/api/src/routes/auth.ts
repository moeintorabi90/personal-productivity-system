import { randomUUID } from "node:crypto";
import {
  loginRequestSchema,
  setupRequestSchema,
  type PreferencesRecord,
  type SessionResponse,
} from "@pps/shared";
import { Router, type Request } from "express";
import { dummyPasswordHash, generateToken, hashPassword, hashToken, safeEqualStrings, verifyPassword } from "../auth/crypto.ts";
import { getAuth, requireOwner } from "../auth/middleware.ts";
import { FailureLimiter } from "../auth/rate-limit.ts";
import type { Config } from "../config.ts";
import { type Db, type Queryable, isUniqueViolation, toIso, toIsoOrNull } from "../db/types.ts";
import { appendChange, getPreferences, insertInitialPreferences } from "../domain/records.ts";
import { ApiError, parseOrThrow } from "../http/errors.ts";

async function issueSession(
  tx: Queryable,
  config: Config,
  userId: string,
  deviceId: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = generateToken();
  const { rows } = await tx.query<{ expires_at: unknown }>(
    `INSERT INTO auth_session (id, user_id, device_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5::int))
     RETURNING expires_at`,
    [randomUUID(), userId, deviceId, hashToken(token), config.sessionTtlDays],
  );
  return { token, expiresAt: toIso(rows[0]!.expires_at) };
}

async function enrollDevice(tx: Queryable, userId: string, device: { id: string; name: string }): Promise<void> {
  // Signing in again with the password re-enrolls a previously revoked device ID.
  await tx.query(
    `INSERT INTO sync_device (user_id, id, name, last_seen_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, id) DO UPDATE SET name = EXCLUDED.name, revoked_at = NULL, last_seen_at = now()`,
    [userId, device.id, device.name],
  );
}

function clientKey(req: Request): string {
  return req.ip ?? "unknown";
}

export function authRoutes(db: Db, config: Config): Router {
  const router = Router();
  const limiter = new FailureLimiter();

  router.get("/setup/status", async (_req, res) => {
    const { rows } = await db.query("SELECT 1 FROM app_installation");
    res.json({ setupCompleted: rows.length > 0 });
  });

  router.post("/setup", async (req, res) => {
    const key = `setup:${clientKey(req)}`;
    if (limiter.isBlocked(key)) throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Try again later.");

    if (config.setupToken) {
      const provided = req.get("x-setup-token") ?? "";
      if (!safeEqualStrings(provided, config.setupToken)) {
        limiter.recordFailure(key);
        throw new ApiError(403, "SETUP_TOKEN_INVALID", "The setup token is missing or incorrect.");
      }
    }

    const body = parseOrThrow(setupRequestSchema, req.body);
    const existing = await db.query("SELECT 1 FROM app_installation");
    if (existing.rows.length) throw new ApiError(409, "SETUP_ALREADY_COMPLETED", "This server already has an owner.");

    const passwordHash = await hashPassword(body.password);
    const userId = randomUUID();
    try {
      const result = await db.transaction(async (tx) => {
        await tx.query("INSERT INTO app_user (id, email, password_hash) VALUES ($1, $2, $3)", [
          userId,
          body.email,
          passwordHash,
        ]);
        await tx.query("INSERT INTO app_installation (owner_id) VALUES ($1)", [userId]);
        await enrollDevice(tx, userId, body.device);
        const preferences = await insertInitialPreferences(tx, userId, body.preferences);
        await appendChange(tx, {
          userId,
          recordType: "preferences",
          recordId: userId,
          revision: preferences.revision,
          deleted: false,
          data: preferences,
          deviceId: body.device.id,
          opId: null,
        });
        const session = await issueSession(tx, config, userId, body.device.id);
        return { session, preferences };
      });
      limiter.clear(key);
      const response: SessionResponse = {
        ...result.session,
        owner: { id: userId, email: body.email },
        device: body.device,
        preferences: result.preferences,
      };
      res.status(201).json(response);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "SETUP_ALREADY_COMPLETED", "This server already has an owner.");
      }
      throw error;
    }
  });

  router.post("/auth/session", async (req, res) => {
    const key = `login:${clientKey(req)}`;
    if (limiter.isBlocked(key)) throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Try again later.");

    const body = parseOrThrow(loginRequestSchema, req.body);
    const { rows } = await db.query<{ id: string; email: string; password_hash: string }>(
      "SELECT id, email, password_hash FROM app_user WHERE lower(email) = $1",
      [body.email],
    );
    const user = rows[0];
    const ok = await verifyPassword(body.password, user?.password_hash ?? (await dummyPasswordHash()));
    if (!user || !ok) {
      limiter.recordFailure(key);
      throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    }
    limiter.clear(key);

    const result = await db.transaction(async (tx) => {
      await enrollDevice(tx, user.id, body.device);
      const session = await issueSession(tx, config, user.id, body.device.id);
      const preferences: PreferencesRecord = await getPreferences(tx, user.id);
      return { session, preferences };
    });
    const response: SessionResponse = {
      ...result.session,
      owner: { id: user.id, email: user.email },
      device: body.device,
      preferences: result.preferences,
    };
    res.status(201).json(response);
  });

  const owner = requireOwner(db);

  router.delete("/auth/session", owner, async (req, res) => {
    const auth = getAuth(req);
    await db.query("UPDATE auth_session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [auth.sessionId]);
    res.status(204).end();
  });

  router.get("/me", owner, (req, res) => {
    const auth = getAuth(req);
    res.json({
      owner: { id: auth.userId, email: auth.email },
      device: { id: auth.deviceId, name: auth.deviceName },
    });
  });

  router.get("/devices", owner, async (req, res) => {
    const auth = getAuth(req);
    const { rows } = await db.query<{
      id: string;
      name: string;
      created_at: unknown;
      last_seen_at: unknown;
      revoked_at: unknown;
    }>(
      "SELECT id, name, created_at, last_seen_at, revoked_at FROM sync_device WHERE user_id = $1 ORDER BY created_at",
      [auth.userId],
    );
    res.json({
      devices: rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: toIso(row.created_at),
        lastSeenAt: toIsoOrNull(row.last_seen_at),
        revokedAt: toIsoOrNull(row.revoked_at),
        current: row.id === auth.deviceId,
      })),
    });
  });

  router.post("/devices/:id/revoke", owner, async (req, res) => {
    const auth = getAuth(req);
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, "NOT_FOUND", "Device not found.");
    const revoked = await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        "UPDATE sync_device SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND id = $2 RETURNING id",
        [auth.userId, id],
      );
      if (!rows.length) return false;
      await tx.query(
        "UPDATE auth_session SET revoked_at = now() WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL",
        [auth.userId, id],
      );
      return true;
    });
    if (!revoked) throw new ApiError(404, "NOT_FOUND", "Device not found.");
    res.status(204).end();
  });

  return router;
}
