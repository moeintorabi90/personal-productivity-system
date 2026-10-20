import type { PreferenceFields, SyncOperationKind } from "@pps/shared";
import { Dexie, type Table } from "dexie";

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

/** Local-first store. Every user-visible change is written here before any network call. */
export class LocalDb extends Dexie {
  meta!: Table<MetaRow, string>;
  preferences!: Table<PreferencesRow, string>;
  probes!: Table<ProbeRow, string>;
  outbox!: Table<OutboxRow, number>;
  conflicts!: Table<ConflictRow, string>;

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
  }
}

export async function getMeta<T>(db: LocalDb, key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}

export async function setMeta(db: LocalDb, key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}
