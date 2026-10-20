import type { NextFunction, Request, Response } from "express";
import type { Db } from "../db/types.ts";
import { ApiError } from "../http/errors.ts";
import { hashToken } from "./crypto.ts";

/** Owner context derived only from the bearer token, never from request payloads. */
export interface AuthContext {
  userId: string;
  email: string;
  deviceId: string;
  deviceName: string;
  sessionId: string;
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
  return req.auth;
}

export function requireOwner(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const header = req.get("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header);
    if (!match) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");

    const { rows } = await db.query<{
      session_id: string;
      user_id: string;
      email: string;
      device_id: string;
      device_name: string;
    }>(
      `SELECT s.id AS session_id, s.user_id, u.email, s.device_id, d.name AS device_name
         FROM auth_session s
         JOIN sync_device d ON d.user_id = s.user_id AND d.id = s.device_id
         JOIN app_user u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND d.revoked_at IS NULL`,
      [hashToken(match[1]!)],
    );
    const row = rows[0];
    if (!row) throw new ApiError(401, "UNAUTHENTICATED", "Your session has ended. Sign in again.");

    await db.query(
      `UPDATE sync_device SET last_seen_at = now()
        WHERE user_id = $1 AND id = $2
          AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')`,
      [row.user_id, row.device_id],
    );

    req.auth = {
      userId: row.user_id,
      email: row.email,
      deviceId: row.device_id,
      deviceName: row.device_name,
      sessionId: row.session_id,
    };
    next();
  };
}
