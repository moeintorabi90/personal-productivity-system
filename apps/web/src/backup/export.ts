import type { LocalDb } from "../local/db.ts";
import { deviceIdentity, getDeviceSettings, toEnvelope } from "../local/records.ts";
import { ensureSharedPreferences } from "../local/settings.ts";
import { IMPORTED_PAUSED_KEY } from "../local/work.ts";
import { APP_VERSION } from "../version.ts";
import { importedPauseForExport, type SessionTimes } from "../work/session-time.ts";
import { encryptPayload, prepareEncryption } from "./crypto.ts";
import type { Envelope } from "./envelope.ts";
import { BackupError } from "./errors.ts";
import type { BackupHeader, BackupPayload } from "./format.ts";
import { canonicalBytes } from "./jcs.ts";
import {
  BACKUP_FORMAT,
  DATA_SCHEMA_VERSION,
  FORMAT_VERSION,
  MAX_ENTRIES,
  MAX_ENVELOPE_BYTES,
  MAX_FILE_BYTES,
  MAX_PLAINTEXT_BYTES,
} from "./limits.ts";
import { openBackupFile } from "./read.ts";
import { type Registry, SESSIONS } from "./registry.ts";
import { sha256HexAsync } from "./sha256.ts";

export interface ExportOptions {
  /** Optional per-export password (D-014). Undefined or empty: unencrypted file. */
  password?: string;
  /** Write the device name into the (always readable) header. Default true. */
  includeDeviceName?: boolean;
  now?: Date;
  /** Fixed values for reproducible sample files in tests. */
  backupId?: string;
}

export interface ExportResult {
  fileName: string;
  text: string;
  backupId: string;
  encrypted: boolean;
  recordCount: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `pps-backup-YYYY-MM-DD-HHmm.json` in local time. */
export function backupFileName(date: Date): string {
  return `pps-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;
}

/** Collects every exported product record. Types outside the registry (e.g. `sync_probe`) are never read. */
async function collectPayload(db: LocalDb, registry: Registry): Promise<BackupPayload> {
  await db.transaction("rw", [db.records, db.meta], () => ensureSharedPreferences(db));
  return db.transaction("r", [db.records, db.tombstones, db.pendingConflicts, db.replacedVersions, db.meta], async () => {
    const records: Record<string, Envelope[]> = {};
    for (const type of registry.types.keys()) {
      const rows = await db.records.where("type").equals(type).toArray();
      if (rows.length) records[type] = rows.map(toEnvelope);
    }
    const known = (type: string) => registry.types.has(type);
    const tombstones = (await db.tombstones.toArray()).filter((t) => known(t.type));
    const pendingConflicts = (await db.pendingConflicts.toArray()).filter((c) => known(c.type));
    const replacedVersions = (await db.replacedVersions.toArray()).filter((r) => known(r.type));
    const sourceDeviceSettings = await getDeviceSettings(db);
    // Sessions treated here as paused since an import: the next device must know when that began (T-173).
    const marks = ((await db.meta.get(IMPORTED_PAUSED_KEY))?.value ?? {}) as Record<string, string>;
    const importedSessionPauses = (records[SESSIONS] ?? []).flatMap((session) => {
      const mark = marks[session.id];
      const pausedFrom = mark ? importedPauseForExport(session.data as unknown as SessionTimes, mark) : null;
      return pausedFrom ? [{ sessionId: session.id, pausedFrom }] : [];
    });
    return {
      records,
      tombstones,
      pendingConflicts,
      replacedVersions,
      sourceDeviceSettings,
      ...(importedSessionPauses.length > 0 ? { importedSessionPauses } : {}),
    };
  });
}

function checkExportLimits(payload: BackupPayload): number {
  const recordCount = Object.values(payload.records).reduce((sum, list) => sum + list.length, 0);
  const total = recordCount + payload.tombstones.length + payload.pendingConflicts.length + payload.replacedVersions.length;
  if (total > MAX_ENTRIES) throw new BackupError("EXPORT_TOO_LARGE", `${total} entries`);
  for (const list of Object.values(payload.records)) {
    for (const envelope of list) {
      if (canonicalBytes(envelope).length > MAX_ENVELOPE_BYTES) throw new BackupError("EXPORT_TOO_LARGE", envelope.id);
    }
  }
  return recordCount;
}

/**
 * Builds a backup file. Enforces the import limits, so this app can always read what it writes,
 * and verifies the written text by opening it again (with the password, if any) before success
 * is reported (docs/BACKUP_FORMAT.md, "Protection", implementation safeguard).
 */
export async function createBackup(db: LocalDb, registry: Registry, options: ExportOptions = {}): Promise<ExportResult> {
  const now = options.now ?? new Date();
  const payload = await collectPayload(db, registry);
  const recordCount = checkExportLimits(payload);
  const device = await db.transaction("rw", db.meta, () => deviceIdentity(db));
  const password = options.password || undefined;
  const backupId = options.backupId ?? crypto.randomUUID();

  const baseHeader = {
    format: BACKUP_FORMAT,
    formatVersion: FORMAT_VERSION,
    backupId,
    createdAt: now.toISOString(),
    app: { version: APP_VERSION, dataSchemaVersion: DATA_SCHEMA_VERSION },
    sourceDevice: { id: device.id, name: options.includeDeviceName === false ? "" : device.name.slice(0, 80) },
  } as const;

  let header: BackupHeader;
  let filePayload: unknown;
  const plaintext = canonicalBytes(payload) as Uint8Array<ArrayBuffer>;
  if (password) {
    if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new BackupError("EXPORT_TOO_LARGE", "payload");
    const prepared = await prepareEncryption(password);
    header = { ...baseHeader, encryption: prepared.encryption };
    filePayload = { ciphertext: await encryptPayload(prepared, plaintext, canonicalBytes(header) as Uint8Array<ArrayBuffer>) };
  } else {
    header = { ...baseHeader, encryption: null };
    filePayload = payload;
  }

  const doc: Record<string, unknown> = { ...header, payload: filePayload };
  const hash = await sha256HexAsync(canonicalBytes(doc));
  doc.integrity = { algorithm: "SHA-256", canonicalization: "JCS-RFC8785", hash };
  const text = JSON.stringify(doc, null, 2);
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) throw new BackupError("EXPORT_TOO_LARGE", "file");

  // Re-open the exact bytes that will be saved, exactly as an import would.
  try {
    const reopened = await openBackupFile(new Blob([text]), registry, password);
    const count = Object.values(reopened.payload.records).reduce((sum, list) => sum + list.length, 0);
    if (count !== recordCount || reopened.header.backupId !== backupId) throw new Error("mismatch");
  } catch (error) {
    throw new BackupError("EXPORT_VERIFICATION_FAILED", error instanceof Error ? error.message : String(error));
  }

  return { fileName: backupFileName(now), text, backupId, encrypted: !!password, recordCount };
}

/** Records a completed export for the "last backup" indicator. */
export async function markBackupExported(db: LocalDb, at = new Date()): Promise<void> {
  await db.meta.put({ key: "lastBackupAt", value: at.toISOString() });
}

export async function getLastBackupAt(db: LocalDb): Promise<string | null> {
  return ((await db.meta.get("lastBackupAt"))?.value as string | undefined) ?? null;
}
