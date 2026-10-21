import type { LocalDb, PendingConflictRow, VersionEntry } from "../local/db.ts";
import { deviceIdentity, toEnvelope } from "../local/records.ts";
import { type Envelope, makeEnvelope, nowIso, type Tombstone } from "./envelope.ts";
import { canonicalize } from "./jcs.ts";
import type { Registry } from "./registry.ts";
import { mergeAndBump, type VersionVector } from "./versions.ts";

/** Choices (docs/BACKUP_FORMAT.md, "Showing and resolving conflicts", D-015). */
export type Resolution =
  | "keepDevice" // keep what this device has now (a record, or nothing)
  | "useBackup" // make the backup's version current
  | "keepBoth" // independent types only: add the backup's version as a copy with a new ID
  | "restore" // deleted here: bring the backup's version back
  | "keepDeleted" // deleted here: stay deleted
  | "deleteHere" // deleted in backup: delete on this device too
  | "keepHere"; // deleted in backup: keep it on this device

export class ResolutionError extends Error {
  readonly code: "NOT_ALLOWED" | "HAS_LINKED_ITEMS" | "BROKEN_LINK" | "NOT_FOUND" | "STALE";
  constructor(code: ResolutionError["code"], message: string) {
    super(message);
    this.name = "ResolutionError";
    this.code = code;
  }
}

function versionOf(entry: VersionEntry): VersionVector {
  return entry.deleted ? entry.tombstone.version : entry.envelope.version;
}

/**
 * Identifies one exact version (or "nothing"). The UI passes the token of the current version it
 * displayed; a resolution is refused as STALE if the device's version changed since (Issue: a
 * choice must be based on the versions actually shown).
 */
export function entryToken(entry: VersionEntry | null): string {
  if (!entry) return "none";
  return entry.deleted
    ? `deleted:${canonicalize(entry.tombstone.version)}`
    : `record:${entry.envelope.contentHash}:${canonicalize(entry.envelope.version)}`;
}

export async function currentEntry(db: LocalDb, type: string, id: string): Promise<VersionEntry | null> {
  const record = await db.records.get([type, id]);
  if (record) return { deleted: false, envelope: toEnvelope(record) };
  const tombstone = await db.tombstones.get([type, id]);
  return tombstone ? { deleted: true, tombstone } : null;
}

/**
 * Choices follow what this device has NOW (not the snapshot taken when the conflict was found):
 * a record vs a backup record → keep / use (/ keep both); deleted here vs a backup record →
 * restore / keep deleted; a record vs a backup deletion → delete here / keep; nothing here →
 * use the backup's version / keep nothing. Append-only history is never replaced.
 */
export function availableResolutions(
  conflict: Pick<PendingConflictRow, "type" | "incoming">,
  current: VersionEntry | null,
  registry: Registry,
): Resolution[] {
  const appendOnly = !!registry.get(conflict.type)?.appendOnly;
  const incoming = conflict.incoming;
  if (incoming.deleted) {
    return current && !current.deleted ? ["deleteHere", "keepHere"] : ["keepDevice"];
  }
  if (!current) return ["useBackup", "keepDevice"];
  if (current.deleted) return ["restore", "keepDeleted"];
  if (appendOnly) return ["keepDevice"];
  return registry.allowsKeepBoth(conflict.type) ? ["keepDevice", "useBackup", "keepBoth"] : ["keepDevice", "useBackup"];
}

export interface ConflictView {
  conflict: PendingConflictRow;
  /** What this device has now — shown as "On this device". */
  current: VersionEntry | null;
  /** Token of `current`; pass it back when resolving. */
  token: string;
  /** The snapshot taken when the conflict was found differs from `current` (and from the backup). */
  snapshotDiffers: boolean;
  options: Resolution[];
}

function snapshotDiffers(conflict: PendingConflictRow, current: VersionEntry | null): boolean {
  if (!conflict.local) return false;
  const snap = entryToken(conflict.local);
  return snap !== entryToken(current) && snap !== entryToken(conflict.incoming);
}

export async function loadConflictViews(db: LocalDb, registry: Registry): Promise<ConflictView[]> {
  return db.transaction("r", [db.pendingConflicts, db.records, db.tombstones], async () => {
    const conflicts = (await db.pendingConflicts.toArray()).sort(
      (a, b) => a.detectedAt.localeCompare(b.detectedAt) || a.conflictId.localeCompare(b.conflictId),
    );
    const views: ConflictView[] = [];
    for (const conflict of conflicts) {
      const current = await currentEntry(db, conflict.type, conflict.id);
      views.push({
        conflict,
        current,
        token: entryToken(current),
        snapshotDiffers: snapshotDiffers(conflict, current),
        options: availableResolutions(conflict, current, registry),
      });
    }
    return views;
  });
}

async function archive(db: LocalDb, type: string, id: string, entry: VersionEntry, reason: string): Promise<void> {
  await db.replacedVersions.put({ replacedId: crypto.randomUUID(), type, id, entry, replacedAt: nowIso(), reason });
}

/** Refuses to delete a record that other live records link to (restrict, never cascade). */
async function assertNoLinkedItems(db: LocalDb, registry: Registry, type: string, id: string): Promise<void> {
  for (const def of registry.types.values()) {
    for (const link of def.links) {
      if (link.target !== type) continue;
      const children = await db.records.where("type").equals(def.type).filter((r) => r.data[link.field] === id).count();
      if (children > 0) throw new ResolutionError("HAS_LINKED_ITEMS", `${type}/${id} still has linked ${def.type} items`);
    }
  }
}

/**
 * A version may become ACTIVE only if every link resolves to a live record now (checked inside
 * the resolution transaction, so a change after the preview cannot leave a broken link).
 */
export async function assertLinksLive(db: LocalDb, registry: Registry, type: string, data: Record<string, unknown>): Promise<void> {
  for (const link of registry.get(type)?.links ?? []) {
    const target = data[link.field];
    if (target === null || target === undefined) continue;
    if (typeof target !== "string" || !(await db.records.get([link.target, target]))) {
      throw new ResolutionError("BROKEN_LINK", `${type}.${link.field} → ${link.target}/${String(target)} is not on this device`);
    }
  }
}

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
 * Applies one decision in the caller's transaction. Refused (no change) if the device's version
 * differs from the one the user saw (`expected`), if the choice is not offered for the current
 * state, or if a version to activate has a broken link. Every outcome gets a version vector that
 * dominates every version involved, so the same backup does not raise the conflict again. Every
 * version that is not kept — the backup's, the replaced current one, and the snapshot from when
 * the conflict was found if it differs from both — goes to the replaced-versions archive (undo).
 */
async function resolveInTx(
  db: LocalDb,
  registry: Registry,
  conflict: PendingConflictRow,
  resolution: Resolution,
  expected: string,
): Promise<void> {
  const { type, id, incoming } = conflict;
  const current = await currentEntry(db, type, id);
  if (entryToken(current) !== expected) {
    throw new ResolutionError("STALE", `${type}/${id} changed on this device; review the updated comparison`);
  }
  if (!availableResolutions(conflict, current, registry).includes(resolution)) {
    throw new ResolutionError("NOT_ALLOWED", `${resolution} is not available for ${type}/${id} now`);
  }
  const device = await deviceIdentity(db);
  let merged = mergeAndBump(current ? versionOf(current) : {}, versionOf(incoming), device.id);
  if (conflict.local) merged = mergeAndBump(merged, versionOf(conflict.local), device.id);

  switch (resolution) {
    case "keepDevice":
    case "keepDeleted":
    case "keepHere": {
      if (current && !current.deleted) await writeRecord(db, type, id, current.envelope.data, current.envelope.createdAt, merged);
      else await writeTombstone(db, type, id, merged); // keeps "nothing here", recording the decision
      await archive(db, type, id, incoming, "notChosen");
      break;
    }
    case "useBackup":
    case "restore": {
      if (incoming.deleted) throw new ResolutionError("NOT_ALLOWED", "backup version is a deletion");
      await assertLinksLive(db, registry, type, incoming.envelope.data);
      if (current) await archive(db, type, id, current, "replacedByBackup");
      await writeRecord(db, type, id, incoming.envelope.data, incoming.envelope.createdAt, merged);
      break;
    }
    case "deleteHere": {
      if (!current || current.deleted) throw new ResolutionError("NOT_ALLOWED", "nothing to delete");
      await assertNoLinkedItems(db, registry, type, id);
      await archive(db, type, id, current, "deletedFromBackup");
      await writeTombstone(db, type, id, merged);
      break;
    }
    case "keepBoth": {
      if (incoming.deleted || !current || current.deleted) throw new ResolutionError("NOT_ALLOWED", "keep both needs two records");
      await assertLinksLive(db, registry, type, incoming.envelope.data);
      await writeRecord(db, type, id, current.envelope.data, current.envelope.createdAt, merged);
      const copy: Envelope = makeEnvelope(crypto.randomUUID(), incoming.envelope.data, { [device.id]: 1 }, nowIso());
      await db.records.put({ type, ...copy, copyOf: id });
      break;
    }
  }
  if (snapshotDiffers(conflict, current)) await archive(db, type, id, conflict.local!, "earlierVersion");
  await db.pendingConflicts.delete(conflict.conflictId);
}

const conflictTables = (db: LocalDb) => [db.records, db.tombstones, db.pendingConflicts, db.replacedVersions, db.meta];

/** `expected` is the token of the current version that was shown to the user (ConflictView.token). */
export async function resolveConflict(
  db: LocalDb,
  registry: Registry,
  conflictId: string,
  resolution: Resolution,
  expected: string,
): Promise<void> {
  await db.transaction("rw", conflictTables(db), async () => {
    const conflict = await db.pendingConflicts.get(conflictId);
    if (!conflict) throw new ResolutionError("NOT_FOUND", "conflict no longer exists");
    await resolveInTx(db, registry, conflict, resolution, expected);
  });
}

/**
 * Bulk action (D-015): the caller first shows and confirms the count. Applies the choice to each
 * listed conflict whose device version is still the one shown and where the choice is offered;
 * all others stay pending. One transaction. Returns how many were resolved.
 */
export async function resolveConflicts(
  db: LocalDb,
  registry: Registry,
  shown: { conflictId: string; expected: string }[],
  resolution: Resolution,
): Promise<number> {
  return db.transaction("rw", conflictTables(db), async () => {
    let resolved = 0;
    for (const { conflictId, expected } of shown) {
      const conflict = await db.pendingConflicts.get(conflictId);
      if (!conflict) continue;
      const current = await currentEntry(db, conflict.type, conflict.id);
      if (entryToken(current) !== expected || !availableResolutions(conflict, current, registry).includes(resolution)) continue;
      await resolveInTx(db, registry, conflict, resolution, expected);
      resolved++;
    }
    return resolved;
  });
}

/**
 * Undo: puts an archived version back as current; the version it replaces is archived in turn.
 * A record version must have live link targets; a deletion must not orphan linked records.
 */
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
      await assertLinksLive(db, registry, row.type, row.entry.envelope.data);
      if (current) await archive(db, row.type, row.id, current, "undo");
      await writeRecord(db, row.type, row.id, row.entry.envelope.data, row.entry.envelope.createdAt, merged);
    }
    await db.replacedVersions.delete(replacedId);
  });
}
