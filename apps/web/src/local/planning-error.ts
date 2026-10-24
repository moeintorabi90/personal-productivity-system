import type { LocalDb } from "./db.ts";
import { getSharedPreferences } from "./settings.ts";

/** A planning write that was refused (Stage 3); nothing was changed. */
export type PlanningErrorCode = "NO_TIME_ZONE" | "DST_GAP" | "INVALID_DURATION" | "NOT_FOUND";

export class PlanningError extends Error {
  readonly code: PlanningErrorCode;
  constructor(code: PlanningErrorCode, message: string) {
    super(message);
    this.name = "PlanningError";
    this.code = code;
  }
}

/** The configured zone; planning data is never written without one (T-028). */
export async function requireZone(db: LocalDb): Promise<string> {
  const zone = (await getSharedPreferences(db)).timeZone;
  if (!zone) throw new PlanningError("NO_TIME_ZONE", "set a time zone before planning");
  return zone;
}
