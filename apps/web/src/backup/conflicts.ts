import type { LocalDb, PendingConflictRow, VersionEntry } from "../local/db.ts";
import { deviceIdentity, toEnvelope } from "../local/records.ts";
import { type Envelope, makeEnvelope, nowIso, type Tombstone } from "./envelope.ts";
import type { Registry } from "./registry.ts";
import { mergeAndBump, type VersionVector } from "./versions.ts";

/** Choices per conflict kind (docs/BACKUP_FORMAT.md, "Showing and resolving conflicts", D-015). */
export type Resolution =
  | "keepDevice" // edit / history: keep this device's version
  | "useBackup" // edit: use the backup's version
  | "keepBoth" // edit, independent types only: add the backup's version as a copy with a new ID
  | "restore" // deleted here: bring the backup's version back
  | "keepDeleted" // deleted here: stay deleted
  | "deleteHere" // deleted in backup: delete on this device too
  | "keepHere"; // deleted in backup: keep it on this device

export function availableResolutions(conflict: Pick<PendingConflictRow, "kind" | "type">, registry: Registry): Resolution[] {
  switch (conflict.kind) {
    case "edit":
      return registry.allowsKeepBoth(conflict.type) ? ["keepDevice", "useBackup", "keepBoth"] : ["keepDevice", "useBackup"];
    case "deletedHere":
      return ["restore", "keepDeleted"];
    case "deletedInBackup":
      return ["deleteHere", "keepHere"];
    case "history":
      // Append-only history is never changed automatically or by import (integrity warning).
      return ["keepDevice"];
  }
}

export class ResolutionError extends Error {
  readonly code: "NOT_ALLOWED" | "HAS_LINKED_ITEMS" | "NOT_FOUND";
  constructor(code: ResolutionError["code"], message: string) {
    super(message);
    this.name = "ResolutionError";
    this.code = code;
  }
}

function versionOf(entry: VersionEntry): VersionVector {
  return entry.deleted ? entry.tombstone.version : entry.envelope.version;
}

async function currentEntry(db: LocalDb, type: string, id: string): Promise<VersionEntry | null> {
  const record = await db.records.get([type, id]);
  if (record) return { deleted: false, envelope: toEnvelope(record) };
  const tombstone = await db.tombstones.get([type, id]);
  return tombstone ? { deleted: true, tombstone } : null;
}

async function archive(db: LocalDb, type: string, id: string, entry: VersionEntry, reason: string): Promise<void> {
  await db.replacedVersions.put({ replacedId: crypto.randomUUID(), type, id, entry, replacedAt: nowIso(), reason });
}

/** Refuses to delete a record that other records still link to (restrict, never cascade). */
async function assertNoLinkedItems(db: LocalDb, registry: Registry, type: string, id: string): Promise<void> {
  for (const def of registry.types.values()) {
    for (const link of def.links) {
      if (link.target !== type) continue;
      const children = await db.records.where("type").equals(def.type).filter((r) => r.data[link.field] === id).count();
      if (children > 0) throw new ResolutionError("HAS_LINKED_ITEMS", `${type}/${id} still has linked ${def.type} items`);
    }
  }
}

/** Writes `data` as the live record with a version that dominates `versions` (a local decision). */
async function writeRecord(db: LocalDb, type: string, id: string, data: Record<string, unknown>, createdAt: string, version: VersionVector) {
  await db.tombstones.delete([type, id]);
  await db.records.put({ type, ...makeEnvelope(id, data, version, createdAt, nowIso()) });
}

async function writeTombstone(db: LocalDb, type: string, id: string, version: VersionVector) {
  await db.records.delete([type, id]);
  const tombstone: Tombstone = { type, id, deletedAt: nowIso(), version };
  await db.tombstones.put(tombstone);
}

/**
 * Applies one user decision in a single transaction. Every outcome gets a version vector that
 * dominates both versions, so re-importing the same backup later does not raise the conflict
 * again; the version that is not kept goes to the replaced-versions archive (undo).
 */
async function resolveInTx(db: LocalDb, registry: Registry, conflict: PendingConflictRow, resolution: Resolution): Promise<void> {
  if (!availableResolutions(conflict, registry).includes(resolution)) {
    throw new ResolutionError("NOT_ALLOWED", `${resolution} is not available for ${conflict.kind} on ${conflict.type}`);
  }
  const device = await deviceIdentity(db);
  const { type, id, incoming } = conflict;
  const current = await currentEntry(db, type, id);
  const merged = mergeAndBump(current ? versionOf(current) : {}, versionOf(incoming), device.id);

  switch (resolution) {
    case "keepDevice":
    case "keepDeleted":
    case "keepHere": {
      if (current?.deleted) await writeTombstone(db, type, id, merged);
      else if (current) await writeRecord(db, type, id, current.envelope.data, current.envelope.createdAt, merged);
      await archive(db, type, id, incoming, "notChosen");
      break;
    }
    case "useBackup":
    case "restore": {
      if (incoming.deleted) throw new ResolutionError("NOT_ALLOWED", "backup version is a deletion");
      if (current) await archive(db, type, id, current, "replacedByBackup");
      await writeRecord(db, type, id, incoming.envelope.data, incoming.envelope.createdAt, merged);
      break;
    }
    case "deleteHere": {
      if (!current || current.deleted) break;
      await assertNoLinkedItems(db, registry, type, id);
      await archive(db, type, id, current, "deletedFromBackup");
      await writeTombstone(db, type, id, merged);
      break;
    }
    case "keepBoth": {
      if (incoming.deleted) throw new ResolutionError("NOT_ALLOWED", "backup version is a deletion");
      if (current && !current.deleted) {
        await writeRecord(db, type, id, current.envelope.data, current.envelope.createdAt, merged);
      }
      const copy: Envelope = makeEnvelope(crypto.randomUUID(), incoming.envelope.data, { [device.id]: 1 }, nowIso());
      await db.records.put({ type, ...copy, copyOf: id });
      break;
    }
  }
  await db.pendingConflicts.delete(conflict.conflictId);
}

const conflictTables = (db: LocalDb) => [db.records, db.tombstones, db.pendingConflicts, db.replacedVersions, db.meta];

export async function resolveConflict(db: LocalDb, registry: Registry, conflictId: string, resolution: Resolution): Promise<void> {
  await db.transaction("rw", conflictTables(db), async () => {
    const conflict = await db.pendingConflicts.get(conflictId);
    if (!conflict) throw new ResolutionError("NOT_FOUND", "conflict no longer exists");
    await resolveInTx(db, registry, conflict, resolution);
  });
}

/**
 * Bulk action (D-015): the caller must first show and confirm `conflictIds.length`. Applies the
 * same choice to every listed conflict where it is available, in one transaction; others stay
 * pending. Returns how many were resolved.
 */
export async function resolveConflicts(db: LocalDb, registry: Registry, conflictIds: string[], resolution: Resolution): Promise<number> {
  return db.transaction("rw", conflictTables(db), async () => {
    let resolved = 0;
    for (const conflictId of conflictIds) {
      const conflict = await db.pendingConflicts.get(conflictId);
      if (!conflict || !availableResolutions(conflict, registry).includes(resolution)) continue;
      await resolveInTx(db, registry, conflict, resolution);
      resolved++;
    }
    return resolved;
  });
}

/** Undo: puts an archived version back as current; the version it replaces is archived in turn. */
export async function restoreReplacedVersion(db: LocalDb, registry: Registry, replacedId: string): Promise<void> {
  await db.transaction("rw", conflictTables(db), async () => {
    const row = await db.replacedVersions.get(replacedId);
    if (!row) throw new ResolutionError("NOT_FOUND", "version no longer exists");
    const device = await deviceIdentity(db);
    const current = await currentEntry(db, row.type, row.id);
    const merged = mergeAndBump(current ? versionOf(current) : {}, versionOf(row.entry), device.id);
    if (row.entry.deleted) {
      if (current && !current.deleted) await assertNoLinkedItems(db, registry, row.type, row.id);
      if (current) await archive(db, row.type, row.id, current, "undo");
      await writeTombstone(db, row.type, row.id, merged);
    } else {
      if (current) await archive(db, row.type, row.id, current, "undo");
      await writeRecord(db, row.type, row.id, row.entry.envelope.data, row.entry.envelope.createdAt, merged);
    }
    await db.replacedVersions.delete(replacedId);
  });
}
