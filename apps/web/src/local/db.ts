import { DEFAULT_PREFERENCES, type Language, type PreferenceFields, type SyncOperationKind, type Theme } from "@pps/shared";
import { Dexie, type Table } from "dexie";
import { type Envelope, makeEnvelope, type Tombstone } from "../backup/envelope.ts";
import { SHARED_PREFERENCES_ID } from "../backup/limits.ts";
import { DEFAULT_SHARED_PREFERENCES } from "../backup/registry.ts";

export interface MetaRow {
  key: string;
  value: unknown;
}

export interface DeviceIdentity {
  id: string;
  name: string;
}

export interface StoredSession {
  token: string;
  expiresAt: string;
  ownerId: string;
  email: string;
}

export interface PreferencesRow {
  key: "self";
  data: PreferenceFields;
  /** Last server revision this device has seen; 0 = never synced. */
  serverRevision: number;
  updatedAt: string;
}

export interface ProbeRow {
  id: string;
  text: string;
  serverRevision: number;
  createdAt: string;
  updatedAt: string;
}

export type OutboxStatus = "pending" | "inflight" | "failed";

export interface OutboxRow {
  seq?: number;
  opId: string;
  kind: SyncOperationKind;
  /** Record key used for coalescing; the owner's singleton preferences use "preferences". */
  recordKey: string;
  recordId: string | null;
  /** 0 means "not yet known" (record created on this device and not yet acknowledged). */
  baseRevision: number;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

export interface ConflictRow {
  opId: string;
  recordType: "preferences" | "sync_probe";
  recordKey: string;
  current: unknown;
  submitted: unknown;
  createdAt: string;
}

export const PREFERENCES_KEY = "preferences";

/* ---------- v1 product data (Stage 1B, docs/BACKUP_FORMAT.md) ---------- */

/** A product record: the backup envelope plus its record type. Primary key [type+id]. */
export interface RecordRow extends Envelope {
  type: string;
  /**
   * Device-local "(copy)" marker set by the "keep both" choice: the ID of the item it was copied
   * beside. Not part of the backup envelope (format version 1), so it is not exported.
   */
  copyOf?: string;
}

/** One version of an item: a live record or a deletion. */
export type VersionEntry = { deleted: false; envelope: Envelope } | { deleted: true; tombstone: Tombstone };

export type ConflictKind = "edit" | "deletedHere" | "deletedInBackup" | "history";

export interface ConflictSource {
  backupId: string;
  deviceId: string;
  deviceName: string;
  exportedAt: string;
}

/** An undecided import conflict. Both versions are kept until the user chooses (D-015). */
export interface PendingConflictRow {
  conflictId: string;
  kind: ConflictKind;
  type: string;
  id: string;
  /**
   * Snapshot of the version on the detecting device (`detectedOn`) when the conflict was found.
   * NOT "this device now": a carried conflict may come from another device, and the record may
   * have changed since. The UI shows the current version separately; resolutions use it.
   */
  local: VersionEntry | null;
  incoming: VersionEntry;
  source: ConflictSource;
  detectedAt: string;
  /**
   * Device where the conflict was found (and whose version `local` is). Absent on rows stored,
   * or files written, by the first Stage 1B build: that device is unknown and is never guessed.
   */
  detectedOn?: { deviceId: string; deviceName: string };
  /** For a running session in `incoming`: the minute its effective pause began, carried by the backup (T-173). */
  incomingPausedFrom?: string;
}

/** A version replaced by a user's choice, kept so the choice can be undone. */
export interface ReplacedVersionRow {
  replacedId: string;
  type: string;
  id: string;
  entry: VersionEntry;
  replacedAt: string;
  reason: string;
  /** For a running session version: the minute its effective pause began (T-173). */
  pausedFrom?: string;
}

export interface ImportLogRow {
  importId: string;
  backupId: string;
  fileCreatedAt: string;
  sourceDevice: { id: string; name: string };
  importedAt: string;
  counts: Record<string, number>;
}

/** Device-local display settings (D-017): never merged, never changed automatically by imports. */
export interface DeviceSettings {
  language: Language;
  theme: Theme;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = { language: "en", theme: "system" };

/** Local-first store. Every user-visible change is written here before any network call. */
export class LocalDb extends Dexie {
  meta!: Table<MetaRow, string>;
  /** Frozen sync code only (D-016). v1 reads preferences from `records` and `meta.deviceSettings`. */
  preferences!: Table<PreferencesRow, string>;
  probes!: Table<ProbeRow, string>;
  outbox!: Table<OutboxRow, number>;
  conflicts!: Table<ConflictRow, string>;
  records!: Table<RecordRow, [string, string]>;
  tombstones!: Table<Tombstone, [string, string]>;
  pendingConflicts!: Table<PendingConflictRow, string>;
  replacedVersions!: Table<ReplacedVersionRow, string>;
  importLog!: Table<ImportLogRow, string>;

  /** `options` lets tests supply an isolated IndexedDB implementation (fake-indexeddb). */
  constructor(name = "pps-local", options?: { indexedDB: IDBFactory; IDBKeyRange: typeof IDBKeyRange }) {
    super(name, options);
    this.version(1).stores({
      meta: "key",
      preferences: "key",
      probes: "id, createdAt",
      outbox: "++seq, opId, recordKey, status",
      conflicts: "opId, recordKey",
    });
    this.version(2)
      .stores({
        records: "[type+id], type",
        tombstones: "[type+id], type",
        pendingConflicts: "conflictId, [type+id]",
        replacedVersions: "replacedId, [type+id], replacedAt",
        importLog: "importId, backupId, importedAt",
      })
      .upgrade((tx) => migratePreferencesV1toV2(tx));
  }
}

/**
 * Stage 1B migration (D-017, docs/BACKUP_FORMAT.md "Migration in Stage 1B"): split the legacy
 * `preferences["self"]` row into the shared-preferences envelope (reserved ID) and device-local
 * settings. The legacy row is left untouched for the frozen sync code; v1 no longer reads it.
 */
async function migratePreferencesV1toV2(tx: import("dexie").Transaction): Promise<void> {
  const meta = tx.table<MetaRow, string>("meta");
  const legacy = await tx.table<PreferencesRow, string>("preferences").get("self");
  let device = (await meta.get("device"))?.value as DeviceIdentity | undefined;
  if (!device) {
    device = { id: crypto.randomUUID(), name: "This device" };
    await meta.put({ key: "device", value: device });
  }
  const data: PreferenceFields = { ...DEFAULT_PREFERENCES, ...legacy?.data };
  const shared = { timeZone: data.timeZone, weekStart: data.weekStart, calendarDisplay: data.calendarDisplay };
  const changed =
    shared.timeZone !== DEFAULT_SHARED_PREFERENCES.timeZone ||
    shared.weekStart !== DEFAULT_SHARED_PREFERENCES.weekStart ||
    shared.calendarDisplay !== DEFAULT_SHARED_PREFERENCES.calendarDisplay;
  const at = legacy?.updatedAt ?? new Date().toISOString();
  // Values that differ from the defaults count as this device's first edit; untouched defaults
  // keep an empty version vector so any imported version is "newer in backup", not a conflict.
  const envelope = makeEnvelope(SHARED_PREFERENCES_ID, shared, changed ? { [device.id]: 1 } : {}, at);
  await tx.table<RecordRow, [string, string]>("records").put({ type: "preferences", ...envelope });
  if (!(await meta.get("deviceSettings"))) {
    const settings: DeviceSettings = { language: data.language, theme: data.theme };
    await meta.put({ key: "deviceSettings", value: settings });
  }
}

export async function getMeta<T>(db: LocalDb, key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}

export async function setMeta(db: LocalDb, key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}
