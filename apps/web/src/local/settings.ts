import { type PreferenceFields } from "@pps/shared";
import { makeEnvelope, nowIso } from "../backup/envelope.ts";
import { SHARED_PREFERENCES_ID } from "../backup/limits.ts";
import {
  DEFAULT_SHARED_PREFERENCES,
  PRODUCT_REGISTRY,
  type SharedPreferences,
  sharedPreferencesSchema,
} from "../backup/registry.ts";
import type { LocalDb, RecordRow } from "./db.ts";
import { getDeviceSettings, putRecord } from "./records.ts";

const KEY: [string, string] = ["preferences", SHARED_PREFERENCES_ID];

/**
 * Returns the shared-preferences record, creating the untouched default (empty version vector)
 * if it does not exist yet. Must run inside a transaction that includes `records`, or alone.
 */
export async function ensureSharedPreferences(db: LocalDb): Promise<RecordRow> {
  const existing = await db.records.get(KEY);
  if (existing) return existing;
  const row: RecordRow = {
    type: "preferences",
    ...makeEnvelope(SHARED_PREFERENCES_ID, { ...DEFAULT_SHARED_PREFERENCES }, {}, nowIso()),
  };
  await db.records.put(row);
  return row;
}

export async function getSharedPreferences(db: LocalDb): Promise<SharedPreferences> {
  const row = await db.records.get(KEY);
  return row ? sharedPreferencesSchema.parse(row.data) : { ...DEFAULT_SHARED_PREFERENCES };
}

/**
 * A local edit of shared preferences (time zone, week start, calendar display, daily capacity).
 * `dailyCapacityMinutes: null` removes the capacity (the field is absent when not set, never
 * null, T-025). Changing the time zone writes no block (D-022).
 */
export async function updateSharedPreferences(
  db: LocalDb,
  patch: Partial<Omit<SharedPreferences, "dailyCapacityMinutes">> & { dailyCapacityMinutes?: number | null },
): Promise<void> {
  await db.transaction("rw", [db.records, db.tombstones, db.meta], async () => {
    const current = await ensureSharedPreferences(db);
    const { dailyCapacityMinutes, ...rest } = patch;
    const next: Record<string, unknown> = { ...current.data, ...rest };
    if (dailyCapacityMinutes === null) delete next.dailyCapacityMinutes;
    else if (dailyCapacityMinutes !== undefined) next.dailyCapacityMinutes = dailyCapacityMinutes;
    await putRecord(db, PRODUCT_REGISTRY, "preferences", SHARED_PREFERENCES_ID, next);
  });
}

/** Combined view used by the UI: shared preferences plus this device's display settings. */
export async function loadEffectivePreferences(db: LocalDb): Promise<PreferenceFields> {
  const [shared, device] = await Promise.all([getSharedPreferences(db), getDeviceSettings(db)]);
  return { ...shared, ...device };
}
