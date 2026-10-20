import {
  DEFAULT_PREFERENCES,
  type PreferenceFields,
  type PreferencePatch,
  type PreferencesRecord,
  type SyncOperationKind,
  type SyncProbeRecord,
} from "@pps/shared";
import {
  type ConflictRow,
  type DeviceIdentity,
  getMeta,
  type LocalDb,
  type OutboxRow,
  PREFERENCES_KEY,
  type PreferencesRow,
  setMeta,
  type StoredSession,
} from "./db.ts";

const nowIso = () => new Date().toISOString();

export async function getDevice(db: LocalDb): Promise<DeviceIdentity> {
  const existing = await getMeta<DeviceIdentity>(db, "device");
  if (existing) return existing;
  const device = { id: crypto.randomUUID(), name: "This device" };
  await setMeta(db, "device", device);
  return device;
}

export async function renameDevice(db: LocalDb, name: string): Promise<void> {
  const device = await getDevice(db);
  await setMeta(db, "device", { ...device, name });
}

export async function getSession(db: LocalDb): Promise<StoredSession | undefined> {
  return getMeta<StoredSession>(db, "session");
}

export async function loadPreferences(db: LocalDb): Promise<PreferencesRow> {
  return (
    (await db.preferences.get("self")) ?? {
      key: "self",
      data: { ...DEFAULT_PREFERENCES },
      serverRevision: 0,
      updatedAt: nowIso(),
    }
  );
}

interface NewOp {
  kind: SyncOperationKind;
  recordKey: string;
  recordId: string | null;
  baseRevision: number;
  payload: unknown;
}

/**
 * Adds an operation to the durable outbox, coalescing with a not-yet-sent operation for the
 * same record so each record has at most one pending operation (plus possibly one in flight).
 * Must be called inside a Dexie transaction that includes `outbox`.
 */
async function enqueue(db: LocalDb, op: NewOp): Promise<void> {
  const pending = await db.outbox
    .where("recordKey")
    .equals(op.recordKey)
    .filter((row) => row.status === "pending")
    .first();

  if (pending) {
    const merged = coalesce(pending, op);
    if (merged === "drop-both") {
      await db.outbox.delete(pending.seq!);
      return;
    }
    await db.outbox.put({ ...pending, ...merged });
    return;
  }

  await db.outbox.add({
    opId: crypto.randomUUID(),
    ...op,
    status: "pending",
    attempts: 0,
    lastError: null,
    createdAt: nowIso(),
  });
}

function coalesce(pending: OutboxRow, next: NewOp): Partial<OutboxRow> | "drop-both" {
  const isDelete = next.kind === "sync_probe.delete";
  if (pending.kind === "sync_probe.create") {
    // Created and deleted before the server ever saw it: nothing to send.
    if (isDelete) return "drop-both";
    return { payload: next.payload };
  }
  if (isDelete) return { kind: next.kind, payload: undefined };
  if (pending.kind === "preferences.update") {
    return { payload: { ...(pending.payload as object), ...(next.payload as object) } };
  }
  return { payload: next.payload };
}

/** Saves a preference change locally and, when signed in, queues it for sync. */
export async function updatePreferences(db: LocalDb, patch: PreferencePatch): Promise<void> {
  await db.transaction("rw", [db.preferences, db.outbox, db.meta], async () => {
    const current = await loadPreferences(db);
    const updated: PreferencesRow = { ...current, data: { ...current.data, ...patch }, updatedAt: nowIso() };
    await db.preferences.put(updated);
    // Before sign-in there is no server copy; the setup request carries local preferences instead.
    if (current.serverRevision > 0 && (await getSession(db))) {
      await enqueue(db, {
        kind: "preferences.update",
        recordKey: PREFERENCES_KEY,
        recordId: null,
        baseRevision: current.serverRevision,
        payload: patch,
      });
    }
  });
}

export async function addProbe(db: LocalDb, text: string): Promise<string> {
  const id = crypto.randomUUID();
  const trimmed = text.trim();
  await db.transaction("rw", [db.probes, db.outbox], async () => {
    const at = nowIso();
    await db.probes.add({ id, text: trimmed, serverRevision: 0, createdAt: at, updatedAt: at });
    await enqueue(db, {
      kind: "sync_probe.create",
      recordKey: id,
      recordId: id,
      baseRevision: 0,
      payload: { text: trimmed },
    });
  });
  return id;
}

export async function editProbe(db: LocalDb, id: string, text: string): Promise<void> {
  const trimmed = text.trim();
  await db.transaction("rw", [db.probes, db.outbox], async () => {
    const probe = await db.probes.get(id);
    if (!probe) return;
    await db.probes.put({ ...probe, text: trimmed, updatedAt: nowIso() });
    await enqueue(db, {
      kind: "sync_probe.update",
      recordKey: id,
      recordId: id,
      baseRevision: probe.serverRevision,
      payload: { text: trimmed },
    });
  });
}

export async function deleteProbe(db: LocalDb, id: string): Promise<void> {
  await db.transaction("rw", [db.probes, db.outbox], async () => {
    const probe = await db.probes.get(id);
    if (!probe) return;
    await db.probes.delete(id);
    await enqueue(db, {
      kind: "sync_probe.delete",
      recordKey: id,
      recordId: id,
      baseRevision: probe.serverRevision,
      payload: undefined,
    });
  });
}

/** Stores a new session; the account's server preferences become this device's preferences. */
export async function storeSession(
  db: LocalDb,
  session: StoredSession,
  preferences: PreferencesRecord,
): Promise<void> {
  await db.transaction("rw", [db.meta, db.preferences, db.outbox], async () => {
    await setMeta(db, "session", session);
    await setMeta(db, "cursor", null);
    const { revision, updatedAt, ...fields } = preferences;
    await db.preferences.put({ key: "self", data: fields, serverRevision: revision, updatedAt });
    await db.outbox.where("recordKey").equals(PREFERENCES_KEY).delete();
  });
}

export async function clearSession(db: LocalDb): Promise<void> {
  await db.meta.delete("session");
}

/* ---------- conflict resolution ---------- */

function preferenceFields(record: PreferencesRecord): PreferenceFields {
  const { revision: _r, updatedAt: _u, ...fields } = record;
  return fields;
}

/** Accept the other device's version: local copy becomes the server's current record. */
export async function resolveKeepServer(db: LocalDb, conflict: ConflictRow): Promise<void> {
  await db.transaction("rw", [db.preferences, db.probes, db.conflicts], async () => {
    if (conflict.recordType === "preferences") {
      const current = conflict.current as PreferencesRecord;
      await db.preferences.put({
        key: "self",
        data: preferenceFields(current),
        serverRevision: current.revision,
        updatedAt: current.updatedAt,
      });
    } else {
      const current = conflict.current as SyncProbeRecord;
      if (current.deletedAt) await db.probes.delete(current.id);
      else await db.probes.put(probeRowFrom(current));
    }
    await db.conflicts.delete(conflict.opId);
  });
}

/** Keep this device's version: re-submit it against the server's current revision. */
export async function resolveKeepMine(db: LocalDb, conflict: ConflictRow): Promise<void> {
  await db.transaction("rw", [db.preferences, db.probes, db.outbox, db.conflicts], async () => {
    if (conflict.recordType === "preferences") {
      const current = conflict.current as PreferencesRecord;
      const submitted = conflict.submitted as PreferencePatch;
      await db.preferences.put({
        key: "self",
        data: { ...preferenceFields(current), ...submitted },
        serverRevision: current.revision,
        updatedAt: nowIso(),
      });
      await enqueue(db, {
        kind: "preferences.update",
        recordKey: PREFERENCES_KEY,
        recordId: null,
        baseRevision: current.revision,
        payload: submitted,
      });
    } else {
      const current = conflict.current as SyncProbeRecord;
      const submitted = conflict.submitted as { text?: string; delete?: boolean };
      if (submitted.delete) {
        await db.probes.delete(current.id);
        if (!current.deletedAt) {
          await enqueue(db, {
            kind: "sync_probe.delete",
            recordKey: current.id,
            recordId: current.id,
            baseRevision: current.revision,
            payload: undefined,
          });
        }
      } else if (current.deletedAt) {
        // The other device deleted it: keep this text as a new note instead of resurrecting the old one.
        await db.probes.delete(current.id);
        const id = crypto.randomUUID();
        const at = nowIso();
        await db.probes.add({ id, text: submitted.text ?? "", serverRevision: 0, createdAt: at, updatedAt: at });
        await enqueue(db, {
          kind: "sync_probe.create",
          recordKey: id,
          recordId: id,
          baseRevision: 0,
          payload: { text: submitted.text },
        });
      } else {
        await db.probes.put({ ...probeRowFrom(current), text: submitted.text ?? current.text, updatedAt: nowIso() });
        await enqueue(db, {
          kind: "sync_probe.update",
          recordKey: current.id,
          recordId: current.id,
          baseRevision: current.revision,
          payload: { text: submitted.text },
        });
      }
    }
    await db.conflicts.delete(conflict.opId);
  });
}

export function probeRowFrom(record: SyncProbeRecord) {
  return {
    id: record.id,
    text: record.text,
    serverRevision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
