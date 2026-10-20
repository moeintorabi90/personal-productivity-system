import {
  DEFAULT_PREFERENCES,
  type PreferenceFields,
  type PreferencesRecord,
  type RecordType,
  type SyncProbeRecord,
} from "@pps/shared";
import { type Queryable, toInt, toIso, toIsoOrNull } from "../db/types.ts";

interface PreferenceRow {
  language: PreferenceFields["language"];
  theme: PreferenceFields["theme"];
  calendar_display: PreferenceFields["calendarDisplay"];
  week_start: number;
  time_zone: string | null;
  revision: number;
  updated_at: unknown;
}

const PREFERENCE_COLUMNS = "language, theme, calendar_display, week_start, time_zone, revision, updated_at";

function toPreferencesRecord(row: PreferenceRow): PreferencesRecord {
  return {
    language: row.language,
    theme: row.theme,
    calendarDisplay: row.calendar_display,
    weekStart: toInt(row.week_start),
    timeZone: row.time_zone,
    revision: toInt(row.revision),
    updatedAt: toIso(row.updated_at),
  };
}

export async function getPreferences(q: Queryable, userId: string, forUpdate = false): Promise<PreferencesRecord> {
  const { rows } = await q.query<PreferenceRow>(
    `SELECT ${PREFERENCE_COLUMNS} FROM user_preference WHERE user_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [userId],
  );
  if (!rows[0]) throw new Error("Owner has no preference row");
  return toPreferencesRecord(rows[0]);
}

export async function insertInitialPreferences(
  q: Queryable,
  userId: string,
  initial: Partial<PreferenceFields> = {},
): Promise<PreferencesRecord> {
  const p = { ...DEFAULT_PREFERENCES, ...initial };
  const { rows } = await q.query<PreferenceRow>(
    `INSERT INTO user_preference (user_id, language, theme, calendar_display, week_start, time_zone, revision)
     VALUES ($1, $2, $3, $4, $5, $6, 1)
     RETURNING ${PREFERENCE_COLUMNS}`,
    [userId, p.language, p.theme, p.calendarDisplay, p.weekStart, p.timeZone],
  );
  return toPreferencesRecord(rows[0]!);
}

export async function writePreferences(
  q: Queryable,
  userId: string,
  fields: PreferenceFields,
  revision: number,
): Promise<PreferencesRecord> {
  const { rows } = await q.query<PreferenceRow>(
    `UPDATE user_preference
        SET language = $2, theme = $3, calendar_display = $4, week_start = $5, time_zone = $6,
            revision = $7, updated_at = now()
      WHERE user_id = $1
      RETURNING ${PREFERENCE_COLUMNS}`,
    [userId, fields.language, fields.theme, fields.calendarDisplay, fields.weekStart, fields.timeZone, revision],
  );
  return toPreferencesRecord(rows[0]!);
}

interface ProbeRow {
  id: string;
  text: string;
  revision: number;
  created_at: unknown;
  updated_at: unknown;
  deleted_at: unknown;
}

const PROBE_COLUMNS = "id, text, revision, created_at, updated_at, deleted_at";

function toProbeRecord(row: ProbeRow): SyncProbeRecord {
  return {
    id: row.id,
    text: row.text,
    revision: toInt(row.revision),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: toIsoOrNull(row.deleted_at),
  };
}

export async function findProbe(q: Queryable, userId: string, id: string): Promise<SyncProbeRecord | null> {
  const { rows } = await q.query<ProbeRow>(
    `SELECT ${PROBE_COLUMNS} FROM sync_probe WHERE user_id = $1 AND id = $2 FOR UPDATE`,
    [userId, id],
  );
  return rows[0] ? toProbeRecord(rows[0]) : null;
}

export async function insertProbe(q: Queryable, userId: string, id: string, text: string): Promise<SyncProbeRecord> {
  const { rows } = await q.query<ProbeRow>(
    `INSERT INTO sync_probe (user_id, id, text, revision) VALUES ($1, $2, $3, 1) RETURNING ${PROBE_COLUMNS}`,
    [userId, id, text],
  );
  return toProbeRecord(rows[0]!);
}

export async function updateProbe(
  q: Queryable,
  userId: string,
  id: string,
  text: string,
  revision: number,
): Promise<SyncProbeRecord> {
  const { rows } = await q.query<ProbeRow>(
    `UPDATE sync_probe SET text = $3, revision = $4, updated_at = now()
      WHERE user_id = $1 AND id = $2 RETURNING ${PROBE_COLUMNS}`,
    [userId, id, text, revision],
  );
  return toProbeRecord(rows[0]!);
}

export async function tombstoneProbe(
  q: Queryable,
  userId: string,
  id: string,
  revision: number,
): Promise<SyncProbeRecord> {
  const { rows } = await q.query<ProbeRow>(
    `UPDATE sync_probe SET revision = $3, updated_at = now(), deleted_at = now()
      WHERE user_id = $1 AND id = $2 RETURNING ${PROBE_COLUMNS}`,
    [userId, id, revision],
  );
  return toProbeRecord(rows[0]!);
}

export interface ChangeInput {
  userId: string;
  recordType: RecordType;
  recordId: string;
  revision: number;
  deleted: boolean;
  data: unknown;
  deviceId: string | null;
  opId: string | null;
}

export async function appendChange(q: Queryable, change: ChangeInput): Promise<void> {
  await q.query(
    `INSERT INTO change_log (user_id, record_type, record_id, revision, deleted, data, device_id, op_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      change.userId,
      change.recordType,
      change.recordId,
      change.revision,
      change.deleted,
      JSON.stringify(change.data),
      change.deviceId,
      change.opId,
    ],
  );
}

/**
 * Serializes all writes of one owner (DECISIONS T-012): change_log sequence numbers for an
 * owner are then committed in order, so a pull cursor never skips a change.
 */
export async function lockOwner(q: Queryable, userId: string): Promise<void> {
  await q.query("SELECT id FROM app_user WHERE id = $1 FOR UPDATE", [userId]);
}
