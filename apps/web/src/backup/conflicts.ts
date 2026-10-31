import { getMeta, type LocalDb, type PendingConflictRow, setMeta, type VersionEntry } from "../local/db.ts";
import { deviceIdentity, toEnvelope } from "../local/records.ts";
import { importedMarkOf, markImportedSessions, markRestoredSession, pauseOfVersion } from "../local/work.ts";
import { type Envelope, makeEnvelope, nowIso, type Tombstone } from "./envelope.ts";
import { canonicalize } from "./jcs.ts";
import { CALENDAR_BLOCKS, GOALS, linkTargets, OUTPUT_RECORDS, outputsMisfittingGoal, type Registry, SESSIONS } from "./registry.ts";
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

/** A live record on this device that still links to a record whose deletion was asked for. */
export interface LinkedItem {
  type: string;
  id: string;
  /** Its own pending "deleted in the backup" decision, if any: decide that one first. */
  conflictId: string | null;
}

export class ResolutionError extends Error {
  readonly code:
    | "NOT_ALLOWED"
    | "HAS_LINKED_ITEMS"
    | "LINKED_ITEMS_MISMATCH"
    | "BROKEN_LINK"
    | "INVALID_RELATIONSHIP"
    | "IMMUTABLE_FIELD"
    | "INCONSISTENT_HISTORY"
    | "NOT_FOUND"
    | "STALE";
  /** HAS_LINKED_ITEMS: the records that still block the deletion; LINKED_ITEMS_MISMATCH: those that would no longer fit. */
  readonly linkedItems: LinkedItem[];
  constructor(code: ResolutionError["code"], message: string, linkedItems: LinkedItem[] = []) {
    super(message);
    this.name = "ResolutionError";
    this.code = code;
    this.linkedItems = linkedItems;
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
  /** When "Delete it here too" is offered: the live records that still link to this one (restrict). */
  blockedBy: LinkedItem[];
}

function snapshotDiffers(conflict: PendingConflictRow, current: VersionEntry | null): boolean {
  if (!conflict.local) return false;
  const snap = entryToken(conflict.local);
  return snap !== entryToken(current) && snap !== entryToken(conflict.incoming);
}

/**
 * The list order: by detection, except that a deletion decision comes after the pending deletion
 * decisions of the records that block it (a correction before its output, an output before its
 * session), so deciding from top to bottom never meets a refusal that a later item explains.
 */
function blockersFirst(views: ConflictView[]): ConflictView[] {
  const byId = new Map(views.map((v) => [v.conflict.conflictId, v]));
  const placed = new Set<string>();
  const ordered: ConflictView[] = [];
  const place = (view: ConflictView) => {
    const id = view.conflict.conflictId;
    if (placed.has(id)) return;
    placed.add(id); // before its blockers, so a link cycle cannot loop
    for (const item of view.blockedBy) {
      const blocker = item.conflictId ? byId.get(item.conflictId) : undefined;
      if (blocker) place(blocker);
    }
    ordered.push(view);
  };
  for (const view of views) place(view);
  return ordered;
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
        blockedBy: [],
      });
    }
    const deletable = views.filter((v) => v.options.includes("deleteHere")).map((v) => v.conflict);
    const linked = await linkedItems(db, registry, deletable, conflicts);
    for (const view of views) view.blockedBy = linked.get(`${view.conflict.type}/${view.conflict.id}`) ?? [];
    return blockersFirst(views);
  });
}

async function archive(db: LocalDb, type: string, id: string, entry: VersionEntry, reason: string, mark?: string): Promise<void> {
  const pausedFrom = pauseOfVersion(type, entry, mark);
  await db.replacedVersions.put({ replacedId: crypto.randomUUID(), type, id, entry, replacedAt: nowIso(), reason, ...(pausedFrom ? { pausedFrom } : {}) });
}

/**
 * For each target ("type/id" key), the live records that link to it, each with its own pending
 * "deleted in the backup" decision if any. One read per linking type; the matching is done in
 * memory (no other awaits inside the caller's transaction).
 */
async function linkedItems(
  db: LocalDb,
  registry: Registry,
  targets: { type: string; id: string }[],
  pending: PendingConflictRow[],
): Promise<Map<string, LinkedItem[]>> {
  const result = new Map<string, LinkedItem[]>();
  const wanted = new Set(targets.map((t) => `${t.type}/${t.id}`));
  const targetTypes = new Set(targets.map((t) => t.type));
  const deletionOf = new Map<string, string>();
  for (const c of pending) if (c.incoming.deleted) deletionOf.set(`${c.type}/${c.id}`, c.conflictId);
  for (const def of registry.types.values()) {
    const links = def.links.filter((link) => targetTypes.has(link.target));
    if (links.length === 0) continue;
    const children = await db.records.where("type").equals(def.type).toArray();
    for (const child of children) {
      for (const link of links) {
        for (const target of linkTargets(link, child.data)) {
          const key = `${link.target}/${String(target)}`;
          if (!wanted.has(key)) continue;
          const items = result.get(key) ?? [];
          if (!items.some((i) => i.type === child.type && i.id === child.id)) {
            items.push({ type: child.type, id: child.id, conflictId: deletionOf.get(`${child.type}/${child.id}`) ?? null });
          }
          result.set(key, items);
        }
      }
    }
  }
  for (const items of result.values()) items.sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  return result;
}

/** Refuses to delete a record that other live records link to (restrict, never cascade), naming them. */
async function assertNoLinkedItems(db: LocalDb, registry: Registry, type: string, id: string): Promise<void> {
  const pending = await db.pendingConflicts.toArray();
  const items = (await linkedItems(db, registry, [{ type, id }], pending)).get(`${type}/${id}`) ?? [];
  if (items.length > 0) {
    const names = items.map((i) => `${i.type}/${i.id}`).join(", ");
    throw new ResolutionError("HAS_LINKED_ITEMS", `${type}/${id} still has linked items: ${names}`, items);
  }
}

/**
 * A version may become ACTIVE only if every link resolves to a live record now (checked inside
 * the resolution transaction, so a change after the preview cannot leave a broken link).
 */
export async function assertLinksLive(db: LocalDb, registry: Registry, type: string, data: Record<string, unknown>): Promise<void> {
  const live = new Map<string, Record<string, unknown>>();
  for (const link of registry.get(type)?.links ?? []) {
    for (const target of linkTargets(link, data)) {
      const row = typeof target === "string" ? await db.records.get([link.target, target]) : undefined;
      if (!row) {
        throw new ResolutionError("BROKEN_LINK", `${type}.${link.field} → ${link.target}/${String(target)} is not on this device`);
      }
      live.set(`${link.target}/${target}`, row.data);
    }
  }
  // The version must also satisfy its relationship rule against the live targets.
  const problem = registry.get(type)?.rule?.(data, (targetType, id) => live.get(`${targetType}/${id}`));
  if (problem) throw new ResolutionError("INVALID_RELATIONSHIP", `${type}: ${problem}`);
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
 * A version may become current only if it keeps the type's immutable fields (a block's task, a
 * workstream's project, …): against the live record (IMMUTABLE_FIELD), and against every other
 * version of the record known on this device — both versions of each pending conflict and every
 * archived version (INCONSISTENT_HISTORY). Imports already refuse files whose versions disagree;
 * this covers versions stored on this device before a field became immutable (T-171), also when
 * the record is deleted here or missing. Nothing is activated or removed: those versions stay.
 */
async function assertImmutableKept(
  db: LocalDb,
  registry: Registry,
  type: string,
  id: string,
  current: VersionEntry | null,
  data: Record<string, unknown>,
): Promise<void> {
  const fields = registry.get(type)?.immutableFields ?? [];
  if (fields.length === 0) return;
  const differs = (other: Record<string, unknown>) => fields.some((f) => JSON.stringify(data[f]) !== JSON.stringify(other[f]));
  if (current && !current.deleted && differs(current.envelope.data)) {
    throw new ResolutionError("IMMUTABLE_FIELD", `${type}/${id}: ${fields.join(", ")} cannot change`);
  }
  const known: VersionEntry[] = [];
  for (const c of await db.pendingConflicts.where("[type+id]").equals([type, id]).toArray()) {
    known.push(c.incoming);
    if (c.local) known.push(c.local);
  }
  for (const r of await db.replacedVersions.where("[type+id]").equals([type, id]).toArray()) known.push(r.entry);
  if (known.some((entry) => !entry.deleted && differs(entry.envelope.data))) {
    throw new ResolutionError("INCONSISTENT_HISTORY", `${type}/${id}: known versions disagree on ${fields.join(", ")}; settle it first (T-172)`);
  }
}

/**
 * A goal version may become current only if every output on this device that counts toward the
 * goal tracks that version's definition (T-112, T-137). Choosing another version never reassigns
 * an output: the owner first changes or removes those attributions. Outputs in the trash count
 * too, so restoring them later cannot fail on this goal.
 */
async function assertOutputsFitGoal(db: LocalDb, type: string, id: string, data: Record<string, unknown>): Promise<void> {
  if (type !== GOALS) return;
  const outputs = await db.records.where("type").equals(OUTPUT_RECORDS).toArray();
  const misfits = outputsMisfittingGoal(id, data, outputs);
  if (misfits.length > 0) {
    throw new ResolutionError(
      "LINKED_ITEMS_MISMATCH",
      `${type}/${id}: outputs count toward it with another definition: ${misfits.join(", ")}`,
      misfits.map((outputId): LinkedItem => ({ type: OUTPUT_RECORDS, id: outputId, conflictId: null })),
    );
  }
}

/**
 * Every check that can refuse a decision, before anything is written: a refused decision never
 * leaves part of itself applied, and in a bulk action the other decisions still apply.
 */
async function checkResolution(
  db: LocalDb,
  registry: Registry,
  conflict: PendingConflictRow,
  resolution: Resolution,
  expected: string,
): Promise<VersionEntry | null> {
  const { type, id, incoming } = conflict;
  const current = await currentEntry(db, type, id);
  if (entryToken(current) !== expected) {
    throw new ResolutionError("STALE", `${type}/${id} changed on this device; review the updated comparison`);
  }
  if (!availableResolutions(conflict, current, registry).includes(resolution)) {
    throw new ResolutionError("NOT_ALLOWED", `${resolution} is not available for ${type}/${id} now`);
  }
  if (resolution === "useBackup" || resolution === "restore" || resolution === "keepBoth") {
    if (incoming.deleted) throw new ResolutionError("NOT_ALLOWED", "backup version is a deletion");
    await assertLinksLive(db, registry, type, incoming.envelope.data);
    if (resolution !== "keepBoth") {
      await assertImmutableKept(db, registry, type, id, current, incoming.envelope.data);
      await assertOutputsFitGoal(db, type, id, incoming.envelope.data);
    }
  }
  if (resolution === "deleteHere") await assertNoLinkedItems(db, registry, type, id);
  return current;
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
  const current = await checkResolution(db, registry, conflict, resolution, expected);
  const device = await deviceIdentity(db);
  const mark = await importedMarkOf(db, id); // before any choice changes it: kept with what is archived (T-173)
  let merged = mergeAndBump(current ? versionOf(current) : {}, versionOf(incoming), device.id);
  if (conflict.local) merged = mergeAndBump(merged, versionOf(conflict.local), device.id);

  switch (resolution) {
    case "keepDevice":
    case "keepDeleted":
    case "keepHere": {
      if (current && !current.deleted) await writeRecord(db, type, id, current.envelope.data, current.envelope.createdAt, merged);
      else await writeTombstone(db, type, id, merged); // keeps "nothing here", recording the decision
      await archive(db, type, id, incoming, "notChosen", conflict.incomingPausedFrom ?? conflict.source.exportedAt);
      break;
    }
    case "useBackup":
    case "restore": {
      if (incoming.deleted) throw new ResolutionError("NOT_ALLOWED", "backup version is a deletion");
      if (current) await archive(db, type, id, current, "replacedByBackup", mark);
      await writeRecord(db, type, id, incoming.envelope.data, incoming.envelope.createdAt, merged);
      await markImportedSessions(db, [{ type, id, data: incoming.envelope.data }], conflict.incomingPausedFrom ?? conflict.source.exportedAt);
      break;
    }
    case "deleteHere": {
      if (!current || current.deleted) throw new ResolutionError("NOT_ALLOWED", "nothing to delete");
      await archive(db, type, id, current, "deletedFromBackup", mark);
      await writeTombstone(db, type, id, merged);
      break;
    }
    case "keepBoth": {
      if (incoming.deleted || !current || current.deleted) throw new ResolutionError("NOT_ALLOWED", "keep both needs two records");
      await writeRecord(db, type, id, current.envelope.data, current.envelope.createdAt, merged);
      const copy: Envelope = makeEnvelope(crypto.randomUUID(), incoming.envelope.data, { [device.id]: 1 }, nowIso());
      await db.records.put({ type, ...copy, copyOf: id });
      break;
    }
  }
  if (snapshotDiffers(conflict, current)) await archive(db, type, id, conflict.local!, "earlierVersion", mark);
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

export interface BulkResult {
  resolved: number;
  /** Decisions left pending, with the reason (STALE, NOT_ALLOWED, HAS_LINKED_ITEMS, …). */
  skipped: { conflictId: string; error: ResolutionError }[];
}

/**
 * Bulk action (D-015): the caller first shows and confirms the count. Applies the choice, in the
 * order given, to each listed conflict whose device version is still the one shown, where the
 * choice is offered, and that passes its checks; every other one stays pending with its reason
 * and does not stop the rest. One transaction.
 */
export async function resolveConflicts(
  db: LocalDb,
  registry: Registry,
  shown: { conflictId: string; expected: string }[],
  resolution: Resolution,
): Promise<BulkResult> {
  return db.transaction("rw", conflictTables(db), async () => {
    const result: BulkResult = { resolved: 0, skipped: [] };
    for (const { conflictId, expected } of shown) {
      const conflict = await db.pendingConflicts.get(conflictId);
      if (!conflict) continue;
      try {
        await checkResolution(db, registry, conflict, resolution, expected);
      } catch (e) {
        if (!(e instanceof ResolutionError)) throw e;
        result.skipped.push({ conflictId, error: e });
        continue;
      }
      await resolveInTx(db, registry, conflict, resolution, expected);
      result.resolved++;
    }
    return result;
  });
}

/* ---------- versions that disagree on an immutable field (T-171, T-172) ---------- */

/** A version set aside by the owner's choice: kept on this device only, never made current, never exported. */
export interface SetAsideVersion {
  setAsideId: string;
  type: string;
  id: string;
  entry: VersionEntry;
  setAsideAt: string;
  /** Where it was: the archive, a pending decision's backup version, or that decision's earlier snapshot. */
  from: "archive" | "pendingBackup" | "pendingSnapshot";
}

const SET_ASIDE_KEY = "setAsideVersions";

export async function loadSetAsideVersions(db: LocalDb): Promise<SetAsideVersion[]> {
  return (await getMeta<SetAsideVersion[]>(db, SET_ASIDE_KEY)) ?? [];
}

/** One answer to "what does this record belong to?": the immutable values shared by some of its versions. */
export interface HistoryChoice {
  /** Canonical key of `values`; pass it to settleHistory. */
  key: string;
  values: Record<string, unknown>;
  /** One version's data, to name the choice (e.g. a block's task title in its snapshot). */
  sample: Record<string, unknown>;
  versions: number;
  /** The live record has these values: the only choice that can be made (its identity never changes). */
  live: boolean;
}

export interface InconsistentHistory {
  type: string;
  id: string;
  fields: readonly string[];
  /** Whether the record is live here (else deleted here, or not on this device). */
  live: boolean;
  choices: HistoryChoice[];
}

const immutableValues = (fields: readonly string[], data: Record<string, unknown>) => Object.fromEntries(fields.map((f) => [f, data[f] ?? null]));

/** Every record version known on this device for one record, with where it is. */
async function knownVersions(db: LocalDb, type: string, id: string) {
  const out: { data: Record<string, unknown>; live: boolean }[] = [];
  const record = await db.records.get([type, id]);
  if (record) out.push({ data: record.data, live: true });
  for (const c of await db.pendingConflicts.where("[type+id]").equals([type, id]).toArray()) {
    for (const entry of [c.incoming, c.local]) if (entry && !entry.deleted) out.push({ data: entry.envelope.data, live: false });
  }
  for (const r of await db.replacedVersions.where("[type+id]").equals([type, id]).toArray()) {
    if (!r.entry.deleted) out.push({ data: r.entry.envelope.data, live: false });
  }
  return out;
}

/**
 * T-172 covers only a planned block's task. Versions of other types that disagree on an immutable
 * field are never offered for settling: they keep the protective refusals (IMMUTABLE_FIELD,
 * INCONSISTENT_HISTORY), and nothing is set aside or decided for them.
 */
const SETTLEABLE: { type: string; fields: readonly string[] } = { type: CALENDAR_BLOCKS, fields: ["taskId"] };

async function historyOf(db: LocalDb, registry: Registry, type: string, id: string): Promise<InconsistentHistory | null> {
  if (type !== SETTLEABLE.type || !(registry.get(type)?.immutableFields ?? []).includes("taskId")) return null;
  const fields = SETTLEABLE.fields;
  const versions = await knownVersions(db, type, id);
  const choices = new Map<string, HistoryChoice>();
  for (const v of versions) {
    const values = immutableValues(fields, v.data);
    const key = canonicalize(values);
    const choice = choices.get(key) ?? { key, values, sample: v.data, versions: 0, live: false };
    choice.versions++;
    if (v.live) {
      choice.live = true;
      choice.sample = v.data;
    }
    choices.set(key, choice);
  }
  if (choices.size < 2) return null;
  return {
    type,
    id,
    fields,
    live: versions.some((v) => v.live),
    choices: [...choices.values()].sort((a, b) => Number(b.live) - Number(a.live) || b.versions - a.versions || a.key.localeCompare(b.key)),
  };
}

/**
 * Planned blocks whose versions on this device disagree on their task — possible only with data
 * stored before T-171 or from a file this app did not make. Other types are not listed (T-172). Until the
 * owner settles one (T-172), none of its other versions can become current, and a backup made on
 * this device is refused when imported (export itself does not compare versions).
 */
export async function loadInconsistentHistories(db: LocalDb, registry: Registry): Promise<InconsistentHistory[]> {
  return db.transaction("r", [db.records, db.pendingConflicts, db.replacedVersions], async () => {
    const keys = new Map<string, [string, string]>();
    const consider = (type: string, id: string) => {
      if (type === SETTLEABLE.type) keys.set(`${type}/${id}`, [type, id]);
    };
    for (const c of await db.pendingConflicts.toArray()) consider(c.type, c.id);
    for (const r of await db.replacedVersions.toArray()) consider(r.type, r.id);
    const out: InconsistentHistory[] = [];
    for (const [type, id] of [...keys.values()].sort((a, b) => a.join("/").localeCompare(b.join("/")))) {
      const history = await historyOf(db, registry, type, id);
      if (history) out.push(history);
    }
    return out;
  });
}

/**
 * The owner's choice (T-172): the record belongs to `choiceKey`. Every version that disagrees is
 * set aside — removed from the archive and from pending decisions, kept on this device in the
 * set-aside list, never deleted. A pending decision whose backup version is set aside is decided
 * as "keep" (this device's version, or the deletion here); its own version vectors make sure the
 * same backup does not raise it again. A live record's identity never changes, so with a live
 * record only its own values can be chosen. One transaction: refused choices change nothing.
 */
export async function settleHistory(db: LocalDb, registry: Registry, type: string, id: string, choiceKey: string): Promise<void> {
  if (type !== SETTLEABLE.type) throw new ResolutionError("NOT_ALLOWED", `${type}: only a planned block's task can be settled (T-172)`);
  await db.transaction("rw", conflictTables(db), async () => {
    const history = await historyOf(db, registry, type, id);
    if (!history) throw new ResolutionError("NOT_FOUND", `${type}/${id}: its versions already agree`);
    const choice = history.choices.find((c) => c.key === choiceKey);
    if (!choice) throw new ResolutionError("NOT_ALLOWED", `${type}/${id}: no version has these values`);
    if (history.live && !choice.live) throw new ResolutionError("IMMUTABLE_FIELD", `${type}/${id}: the record here keeps its own values`);
    const fits = (entry: VersionEntry | null) => !entry || entry.deleted || canonicalize(immutableValues(history.fields, entry.envelope.data)) === choiceKey;
    const setAside = await loadSetAsideVersions(db);
    const at = nowIso();
    const put = (entry: VersionEntry, from: SetAsideVersion["from"]) =>
      setAside.push({ setAsideId: crypto.randomUUID(), type, id, entry, setAsideAt: at, from });

    for (const conflict of await db.pendingConflicts.where("[type+id]").equals([type, id]).toArray()) {
      if (!fits(conflict.local)) {
        put(conflict.local!, "pendingSnapshot");
        conflict.local = null;
        await db.pendingConflicts.put(conflict);
      }
      if (fits(conflict.incoming)) continue;
      put(conflict.incoming, "pendingBackup");
      const current = await currentEntry(db, type, id);
      const keep = availableResolutions(conflict, current, registry).find((r) => r === "keepDevice" || r === "keepDeleted" || r === "keepHere");
      if (!keep) throw new ResolutionError("NOT_ALLOWED", `${type}/${id}: this decision cannot be kept`);
      // Archives the backup's version as "not chosen"; the sweep below moves it to the set-aside list.
      await resolveInTx(db, registry, conflict, keep, entryToken(current));
    }
    for (const row of await db.replacedVersions.where("[type+id]").equals([type, id]).toArray()) {
      if (fits(row.entry)) continue;
      if (!setAside.some((s) => s.entry === row.entry || canonicalize(s.entry) === canonicalize(row.entry))) put(row.entry, "archive");
      await db.replacedVersions.delete(row.replacedId);
    }
    await setMeta(db, SET_ASIDE_KEY, setAside);
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
    const mark = await importedMarkOf(db, row.id);
    if (row.entry.deleted) {
      if (current && !current.deleted) await assertNoLinkedItems(db, registry, row.type, row.id);
      if (current) await archive(db, row.type, row.id, current, "undo", mark);
      await writeTombstone(db, row.type, row.id, merged);
    } else {
      await assertLinksLive(db, registry, row.type, row.entry.envelope.data);
      await assertImmutableKept(db, registry, row.type, row.id, current, row.entry.envelope.data);
      await assertOutputsFitGoal(db, row.type, row.id, row.entry.envelope.data);
      if (current) await archive(db, row.type, row.id, current, "undo", mark);
      await writeRecord(db, row.type, row.id, row.entry.envelope.data, row.entry.envelope.createdAt, merged);
      if (row.type === SESSIONS) await markRestoredSession(db, row.id, row.entry.envelope.data, row.pausedFrom);
    }
    await db.replacedVersions.delete(replacedId);
  });
}
