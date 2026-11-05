import type { DeviceSettings, ImportLogRow, LocalDb, PendingConflictRow, ReplacedVersionRow, VersionEntry } from "../local/db.ts";
import { deviceIdentity, getDeviceSettings, toEnvelope } from "../local/records.ts";
import { ensureSharedPreferences } from "../local/settings.ts";
import { importedMarkOf, markImportedSessions, pauseOfVersion } from "../local/work.ts";
import { type Envelope, envelopeFits, type EnvelopeLimit, envelopeLimitProblem, makeEnvelope, nowIso, type Tombstone } from "./envelope.ts";
import { BackupError } from "./errors.ts";
import type { BackupHeader, BackupPayload } from "./format.ts";
import {
  APP_USE_DAYS,
  type DataLookup,
  GOAL_WEEK_PLANS,
  GOALS,
  type GoalWeekPlanData,
  linkTargets,
  OUTPUT_RECORDS,
  outputsMisfittingGoal,
  type Registry,
  SESSIONS,
} from "./registry.ts";
import { compareVersions, isContainedIn, mergeVersions, bumpVersion } from "./versions.ts";
import { conflictDates, mergePlans } from "../insights/plan-merge.ts";
import { newPlanIntegrityProblem } from "../insights/plan-integrity.ts";

/** Preview categories (docs/BACKUP_FORMAT.md, "Import flow"). */
export type ItemCategory =
  | "new"
  | "newTombstone"
  | "alreadyHere"
  | "olderCopy"
  | "newerInBackup"
  | "conflict"
  | "deletedHere"
  | "deletedInBackup"
  | "history"
  | "alreadyPending"
  /** A weekly plan already here, newer or concurrent: merged date by date with "Apply updates" (T-227, T-229). */
  | "planMerge";

export interface PreviewItem {
  type: string;
  id: string;
  category: ItemCategory;
  incoming: VersionEntry;
  local: VersionEntry | null;
  /**
   * For "planMerge": the merged data (null when it cannot be merged, so nothing changes: an
   * integrity issue, or a written envelope that would break a per-record limit, `limit`: more than
   * 32 devices in its version vector, this device's counter past its maximum, or more than 256 KiB)
   * and how many dates would newly need the owner's decision.
   */
  planMerge?: { data: GoalWeekPlanData | null; decisions: number; limit?: EnvelopeLimit };
  /**
   * A new weekly plan with a data-integrity issue: entries that cover one another in a cycle, or a
   * `seen` claim no entry of its date bears out. It is counted with the plans that have one and is
   * not imported.
   */
  planIntegrity?: true;
}

/**
 * The envelope a weekly plan merge writes, exactly: the merged data with this record's ID and
 * `createdAt`, `at` as `updatedAt`, the combined version vector raised for this device, and the
 * content hash; when the content does not change, only the versions are combined. The preview and
 * the write both measure this against the per-record limits (32 devices, 256 KiB).
 */
function planMergeEnvelope(local: Envelope, incoming: Envelope, merged: GoalWeekPlanData, thisDevice: string, at: string): Envelope {
  const version = mergeVersions(local.version, incoming.version);
  const next = makeEnvelope(local.id, merged as unknown as Record<string, unknown>, version, local.createdAt, at);
  // Nothing new for this device: only the versions are combined, its counter is not raised.
  return next.contentHash === local.contentHash ? { ...local, version } : { ...next, version: bumpVersion(version, thisDevice) };
}

/**
 * The merge of a weekly plan, or null when it has a data-integrity issue: the same device and
 * counter with different content, a backup record that has a coverage cycle or a `seen` claim no
 * entry of its date bears out, or a merge that brings such a problem in, such as a cycle that only
 * the merge creates. A problem already stored here (from before these checks) and left as it is
 * does not block the merge, so a date with an older cycle still takes entries that add no new
 * one, and the owner can settle it; a new cycle on that date is refused like any other.
 */
function mergeWeekPlan(here: GoalWeekPlanData, incoming: GoalWeekPlanData): GoalWeekPlanData | null {
  if (newPlanIntegrityProblem(undefined, incoming)) return null;
  const merged = mergePlans(here, incoming);
  if (!merged) return null;
  return newPlanIntegrityProblem(here, merged) ? null : merged;
}

/**
 * Preview counts. Weekly plans to merge, the dates they would leave to the owner, and plans with an
 * integrity issue have counts of their own; new app-use dates are counted apart from other new
 * records (T-204); `planDecisions` also counts undecided dates arriving in new plans (T-228).
 */
export type PreviewCounts = Record<
  ItemCategory | "carriedConflicts" | "carriedReplaced" | "planDecisions" | "planIntegrity" | "planTooLarge" | "planTooManyDevices" | "planVersionCounter" | "appUseDates",
  number
>;

export interface ImportPreview {
  header: BackupHeader;
  items: PreviewItem[];
  counts: PreviewCounts;
  /** When this exact backup was imported before, if ever. */
  previouslyImportedAt: string | null;
  sourceDeviceSettings: DeviceSettings;
  displaySettingsDiffer: boolean;
  /**
   * Outputs on this device that a newer goal version in the backup would not fit (T-112, T-137).
   * When not empty, the import is refused if the updates are applied; without them it can proceed.
   */
  updatesBlockedBy: string[];
}

export interface ImportChoices {
  /** Apply the "newer in backup" items (D-015: only after the user confirms). */
  applyUpdates: boolean;
  /** Use the source device's language/theme on this device (D-017: optional, off by default). */
  applyDisplaySettings: boolean;
}

export interface ImportResult {
  counts: PreviewCounts;
  appliedUpdates: number;
  skippedUpdates: number;
  importId: string;
}

const CONFLICT_CATEGORIES: ReadonlySet<ItemCategory> = new Set(["conflict", "deletedHere", "deletedInBackup", "history"]);

function emptyCounts(): PreviewCounts {
  return {
    new: 0,
    newTombstone: 0,
    alreadyHere: 0,
    olderCopy: 0,
    newerInBackup: 0,
    conflict: 0,
    deletedHere: 0,
    deletedInBackup: 0,
    history: 0,
    alreadyPending: 0,
    planMerge: 0,
    carriedConflicts: 0,
    carriedReplaced: 0,
    planDecisions: 0,
    planIntegrity: 0,
    planTooLarge: 0,
    planTooManyDevices: 0,
    planVersionCounter: 0,
    appUseDates: 0,
  };
}

export function entryVersion(entry: VersionEntry) {
  return entry.deleted ? entry.tombstone.version : entry.envelope.version;
}

function sameEntry(a: VersionEntry, b: VersionEntry): boolean {
  if (a.deleted !== b.deleted) return false;
  if (compareVersions(entryVersion(a), entryVersion(b)) !== "equal") return false;
  return a.deleted || (b as { envelope: Envelope }).envelope.contentHash === a.envelope.contentHash;
}

interface LocalState {
  record: Envelope | null;
  tombstone: Tombstone | null;
  pending: PendingConflictRow[];
}

async function loadLocal(db: LocalDb, keys: [string, string][]): Promise<Map<string, LocalState>> {
  const [records, tombstones, pending] = await Promise.all([
    db.records.bulkGet(keys),
    db.tombstones.bulkGet(keys),
    db.pendingConflicts.toArray(),
  ]);
  const pendingByKey = new Map<string, PendingConflictRow[]>();
  for (const row of pending) {
    const key = `${row.type}/${row.id}`;
    pendingByKey.set(key, [...(pendingByKey.get(key) ?? []), row]);
  }
  const out = new Map<string, LocalState>();
  keys.forEach(([type, id], i) => {
    const row = records[i];
    out.set(`${type}/${id}`, {
      record: row ? toEnvelope(row) : null,
      tombstone: tombstones[i] ?? null,
      pending: pendingByKey.get(`${type}/${id}`) ?? [],
    });
  });
  return out;
}

/** Classifies one incoming record version against this device's state. */
function classifyRecord(incoming: Envelope, local: LocalState, appendOnly: boolean, mergeByDate = false): ItemCategory {
  const entry: VersionEntry = { deleted: false, envelope: incoming };
  if (local.pending.some((p) => sameEntry(p.incoming, entry))) return "alreadyPending";
  if (local.record) {
    if (local.record.contentHash === incoming.contentHash) return "alreadyHere";
    const order = compareVersions(incoming.version, local.record.version);
    if (order === "before") return "olderCopy";
    if (appendOnly) return "history"; // history data never changes: a difference is an integrity issue
    if (mergeByDate) return "planMerge"; // weekly plans: never a whole-record conflict (T-227)
    if (order === "after") return "newerInBackup";
    return "conflict"; // concurrent, or equal versions with different content
  }
  if (local.tombstone) {
    // The deletion here already saw this version: the backup holds an older copy.
    return isContainedIn(incoming.version, local.tombstone.version) ? "olderCopy" : "deletedHere";
  }
  return "new";
}

/** Classifies one incoming tombstone against this device's state. */
function classifyTombstone(incoming: Tombstone, local: LocalState): ItemCategory {
  const entry: VersionEntry = { deleted: true, tombstone: incoming };
  if (local.pending.some((p) => sameEntry(p.incoming, entry))) return "alreadyPending";
  if (local.tombstone) return "alreadyHere";
  if (local.record) {
    // Edited here after (or including) the version that was deleted elsewhere: older news.
    return isContainedIn(incoming.version, local.record.version) ? "olderCopy" : "deletedInBackup";
  }
  return "newTombstone";
}

function localEntry(local: LocalState): VersionEntry | null {
  if (local.record) return { deleted: false, envelope: local.record };
  if (local.tombstone) return { deleted: true, tombstone: local.tombstone };
  return null;
}

/** Link targets of one record version as `type/id` keys (null/absent links are allowed). */
function linkKeys(registry: Registry, type: string, data: Record<string, unknown>, where: string): string[] {
  const keys: string[] = [];
  for (const link of registry.get(type)?.links ?? []) {
    for (const target of linkTargets(link, data)) {
      if (typeof target !== "string") throw new BackupError("UNRESOLVED_REFERENCE", `${where}.${link.field}`);
      keys.push(`${link.target}/${target}`);
    }
  }
  return keys;
}

/**
 * Step 9a: EVERY record version in the file — active records, both versions of carried
 * conflicts, and archived (replaced) versions — may only link to IDs known somewhere: in the
 * file (record, tombstone, conflict or archive version) or on this device (record or tombstone).
 * Conflict and archive versions are history, so their targets may be deleted; an unknown ID
 * means a corrupted or foreign file. Runs inside the preview/apply transaction.
 */
async function checkFileReferences(db: LocalDb, payload: BackupPayload, registry: Registry): Promise<void> {
  const known = new Set<string>();
  const versions: { type: string; id: string; data: Record<string, unknown>; where: string }[] = [];
  for (const [type, list] of Object.entries(payload.records)) {
    for (const e of list) {
      known.add(`${type}/${e.id}`);
      versions.push({ type, id: e.id, data: e.data, where: `records.${type}/${e.id}` });
    }
  }
  for (const t of payload.tombstones) known.add(`${t.type}/${t.id}`);
  const addEntry = (type: string, id: string, entry: VersionEntry | null, where: string) => {
    known.add(`${type}/${id}`);
    if (entry && !entry.deleted) versions.push({ type, id, data: entry.envelope.data, where });
  };
  for (const c of payload.pendingConflicts) {
    addEntry(c.type, c.id, c.local, `pendingConflicts.${c.conflictId}.local`);
    addEntry(c.type, c.id, c.incoming, `pendingConflicts.${c.conflictId}.incoming`);
  }
  for (const r of payload.replacedVersions) addEntry(r.type, r.id, r.entry, `replacedVersions.${r.replacedId}`);

  for (const v of versions) {
    for (const key of linkKeys(registry, v.type, v.data, v.where)) {
      if (known.has(key)) continue;
      const slash = key.indexOf("/");
      const pk: [string, string] = [key.slice(0, slash), key.slice(slash + 1)];
      if ((await db.records.get(pk)) || (await db.tombstones.get(pk))) continue;
      throw new BackupError("UNRESOLVED_REFERENCE", `${v.where} → ${key}`);
    }
  }
  await checkFileRelationships(db, versions, registry);
}

/** Every data version of the given record keys known on this device (record, conflicts, archive). */
async function deviceVersions(db: LocalDb, keys: Set<string>): Promise<Map<string, Record<string, unknown>[]>> {
  const out = new Map<string, Record<string, unknown>[]>();
  const add = (type: string, id: string, entry: VersionEntry | null | undefined) => {
    const key = `${type}/${id}`;
    if (!keys.has(key) || !entry || entry.deleted) return;
    out.set(key, [...(out.get(key) ?? []), entry.envelope.data]);
  };
  const pks = [...keys].map((key): [string, string] => [key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)]);
  for (const row of await db.records.bulkGet(pks)) {
    if (row) add(row.type, row.id, { deleted: false, envelope: toEnvelope(row) });
  }
  for (const c of await db.pendingConflicts.toArray()) {
    add(c.type, c.id, c.local);
    add(c.type, c.id, c.incoming);
  }
  for (const r of await db.replacedVersions.toArray()) add(r.type, r.id, r.entry);
  return out;
}

/**
 * Step 9c (Stage 2): relationship rules for every version in the file. (1) Immutable fields
 * (a workstream's project) must agree across all versions of one ID, in the file and on this
 * device; a disagreement means a corrupted or foreign file. (2) Each version must satisfy its
 * type's rule (a task's workstream belongs to the task's project), looked up in any known version
 * of the target — safe for immutable fields; a rule that reads a set-once field (a goal's
 * `definitionId`) gets every known version and accepts the target if one of them satisfies it.
 */
async function checkFileRelationships(
  db: LocalDb,
  versions: { type: string; id: string; data: Record<string, unknown>; where: string }[],
  registry: Registry,
): Promise<void> {
  const fileData = new Map<string, Record<string, unknown>[]>();
  for (const v of versions) fileData.set(`${v.type}/${v.id}`, [...(fileData.get(`${v.type}/${v.id}`) ?? []), v.data]);
  // Device versions are needed for IDs in the file and for every link target of a rule.
  const wanted = new Set(fileData.keys());
  for (const v of versions) for (const key of linkKeys(registry, v.type, v.data, v.where)) wanted.add(key);
  const onDevice = await deviceVersions(db, wanted);
  const allData = (key: string) => [...(fileData.get(key) ?? []), ...(onDevice.get(key) ?? [])];

  for (const key of fileData.keys()) {
    const type = key.slice(0, key.indexOf("/"));
    for (const field of registry.get(type)?.immutableFields ?? []) {
      const values = new Set(allData(key).map((data) => JSON.stringify(data[field])));
      if (values.size > 1) throw new BackupError("INVALID_RELATIONSHIP", `${key}: ${field} differs between versions`);
    }
  }
  const lookup: DataLookup = (type, id) => allData(`${type}/${id}`)[0];
  const lookupAll = (type: string, id: string) => allData(`${type}/${id}`);
  for (const v of versions) {
    const problem = registry.get(v.type)?.rule?.(v.data, lookup, lookupAll);
    if (problem) throw new BackupError("INVALID_RELATIONSHIP", `${v.where}: ${problem}`);
  }
}

/**
 * Step 9b: records this import makes ACTIVE ("new", and "newer in backup" when applied) must
 * link to records that are live after the import: already live on this device or activated by
 * the same import. Checked inside the transaction, so a target deleted after the preview makes
 * the import fail as a whole instead of writing a broken link.
 */
async function checkActiveLinks(db: LocalDb, items: PreviewItem[], registry: Registry, includeUpdates: boolean): Promise<void> {
  const activated = items.filter(
    (item) => !item.incoming.deleted && (item.category === "new" || (includeUpdates && item.category === "newerInBackup")),
  );
  const liveAfter = new Set(activated.map((item) => `${item.type}/${item.id}`));
  for (const item of activated) {
    if (item.incoming.deleted) continue;
    for (const key of linkKeys(registry, item.type, item.incoming.envelope.data, `${item.type}/${item.id}`)) {
      if (liveAfter.has(key)) continue;
      const slash = key.indexOf("/");
      if (await db.records.get([key.slice(0, slash), key.slice(slash + 1)])) continue;
      throw new BackupError("UNRESOLVED_REFERENCE", `${item.type}/${item.id} → ${key} is not on this device`);
    }
  }
  // Relationship rules against what is live after the import (activated data, else this device's).
  const activatedData = new Map<string, Record<string, unknown>>();
  for (const item of activated) if (!item.incoming.deleted) activatedData.set(`${item.type}/${item.id}`, item.incoming.envelope.data);
  const liveTargets = new Map<string, Record<string, unknown> | undefined>();
  for (const item of activated) {
    if (item.incoming.deleted) continue;
    for (const key of linkKeys(registry, item.type, item.incoming.envelope.data, `${item.type}/${item.id}`)) {
      if (activatedData.has(key) || liveTargets.has(key)) continue;
      const slash = key.indexOf("/");
      liveTargets.set(key, (await db.records.get([key.slice(0, slash), key.slice(slash + 1)]))?.data);
    }
  }
  const lookup: DataLookup = (type, id) => activatedData.get(`${type}/${id}`) ?? liveTargets.get(`${type}/${id}`);
  for (const item of activated) {
    if (item.incoming.deleted) continue;
    const problem = registry.get(item.type)?.rule?.(item.incoming.envelope.data, lookup);
    if (problem) throw new BackupError("INVALID_RELATIONSHIP", `${item.type}/${item.id}: ${problem}`);
  }
  // A goal version made current must still fit every output on this device that counts toward it,
  // in the trash or not, as it will be after the import (T-112, T-137). Otherwise the whole import
  // is refused; attributions are never changed automatically.
  const goals = activated.filter((item) => item.type === GOALS && !item.incoming.deleted);
  if (goals.length > 0) {
    const outputs = (await db.records.where("type").equals(OUTPUT_RECORDS).toArray()).map((o) => ({
      id: o.id,
      data: activatedData.get(`${OUTPUT_RECORDS}/${o.id}`) ?? o.data,
    }));
    const misfits = new Set<string>();
    for (const goal of goals) {
      for (const id of outputsMisfittingGoal(goal.id, activatedData.get(`${GOALS}/${goal.id}`)!, outputs)) misfits.add(id);
    }
    if (misfits.size > 0) {
      const ids = [...misfits].sort();
      throw new BackupError(
        "LINKED_ITEMS_MISMATCH",
        `outputs here count toward a goal whose backup version tracks another definition: ${ids.join(", ")}`,
        ids.map((id) => ({ type: OUTPUT_RECORDS, id })),
      );
    }
  }
}

async function classifyAll(db: LocalDb, payload: BackupPayload, registry: Registry): Promise<PreviewItem[]> {
  const keys: [string, string][] = [];
  for (const [type, list] of Object.entries(payload.records)) for (const e of list) keys.push([type, e.id]);
  for (const t of payload.tombstones) keys.push([t.type, t.id]);
  const local = await loadLocal(db, keys);
  // A singleton that was never stored compares as its untouched default (empty version vector),
  // so an imported version is "newer in backup", not "new". Nothing is written here.
  for (const [type, id] of keys) {
    const def = registry.get(type)!;
    const state = local.get(`${type}/${id}`)!;
    if (def.singletonId && def.singletonDefault && !state.record && !state.tombstone) {
      state.record = makeEnvelope(id, { ...def.singletonDefault }, {}, nowIso());
    }
  }

  const thisDevice = (await deviceIdentity(db)).id;
  const at = nowIso();
  const items: PreviewItem[] = [];
  for (const [type, list] of Object.entries(payload.records)) {
    const appendOnly = !!registry.get(type)!.appendOnly;
    for (const envelope of list) {
      const state = local.get(`${type}/${envelope.id}`)!;
      const item: PreviewItem = {
        type,
        id: envelope.id,
        category: classifyRecord(envelope, state, appendOnly, type === GOAL_WEEK_PLANS),
        incoming: { deleted: false, envelope },
        local: localEntry(state),
      };
      if (item.category === "planMerge") {
        const here = state.record!.data as GoalWeekPlanData;
        const merged = mergeWeekPlan(here, envelope.data as GoalWeekPlanData);
        const before = new Set(conflictDates(here));
        const limit = merged ? envelopeLimitProblem(planMergeEnvelope(state.record!, envelope, merged, thisDevice, at)) : null;
        if (limit) {
          // Past a per-record limit as one record: shown on its own, and this device's version stays as it is.
          item.planMerge = { data: null, decisions: 0, limit };
        } else {
          item.planMerge = { data: merged, decisions: merged ? conflictDates(merged).filter((d) => !before.has(d)).length : 0 };
        }
      }
      if (item.category === "new" && type === GOAL_WEEK_PLANS && newPlanIntegrityProblem(undefined, envelope.data as GoalWeekPlanData)) item.planIntegrity = true;
      items.push(item);
    }
  }
  for (const tombstone of payload.tombstones) {
    const state = local.get(`${tombstone.type}/${tombstone.id}`)!;
    items.push({
      type: tombstone.type,
      id: tombstone.id,
      category: classifyTombstone(tombstone, state),
      incoming: { deleted: true, tombstone },
      local: localEntry(state),
    });
  }
  return items;
}

async function carriedCounts(db: LocalDb, payload: BackupPayload): Promise<{ conflicts: PendingConflictRow[]; replaced: ReplacedVersionRow[] }> {
  const conflicts: PendingConflictRow[] = [];
  const existingConflicts = await db.pendingConflicts.bulkGet(payload.pendingConflicts.map((c) => c.conflictId));
  for (const [i, carried] of payload.pendingConflicts.entries()) {
    if (existingConflicts[i]) continue;
    // Moot if this device already has that version (or a later one).
    const current = (await db.records.get([carried.type, carried.id])) ?? (await db.tombstones.get([carried.type, carried.id]));
    if (current && isContainedIn(entryVersion(carried.incoming), current.version)) continue;
    const samePending = (await db.pendingConflicts.where("[type+id]").equals([carried.type, carried.id]).toArray()).some((p) =>
      sameEntry(p.incoming, carried.incoming),
    );
    if (!samePending) conflicts.push(carried);
  }
  const existingReplaced = await db.replacedVersions.bulkGet(payload.replacedVersions.map((r) => r.replacedId));
  const replaced = payload.replacedVersions.filter((_, i) => !existingReplaced[i]);
  return { conflicts, replaced };
}

function countItems(items: PreviewItem[], carried: { conflicts: unknown[]; replaced: unknown[] }): PreviewCounts {
  const counts = emptyCounts();
  for (const item of items) {
    if (item.category === "new" && item.type === APP_USE_DAYS) counts.appUseDates += 1;
    else if (item.category === "planMerge" && item.planMerge?.limit === "size") counts.planTooLarge += 1;
    else if (item.category === "planMerge" && item.planMerge?.limit === "devices") counts.planTooManyDevices += 1;
    else if (item.category === "planMerge" && item.planMerge?.limit === "versionCounter") counts.planVersionCounter += 1;
    else if ((item.category === "planMerge" && item.planMerge?.data === null) || item.planIntegrity) counts.planIntegrity += 1;
    else counts[item.category] += 1;
    if (item.planMerge) counts.planDecisions += item.planMerge.decisions;
    if (item.category === "new" && item.type === GOAL_WEEK_PLANS && !item.incoming.deleted && !item.planIntegrity) {
      counts.planDecisions += conflictDates(item.incoming.envelope.data as GoalWeekPlanData).length;
    }
  }
  counts.carriedConflicts = carried.conflicts.length;
  counts.carriedReplaced = carried.replaced.length;
  return counts;
}

/**
 * Steps 9–10: reference check and classification. Read-only: nothing is written.
 */
export async function previewImport(
  db: LocalDb,
  opened: { header: BackupHeader; payload: BackupPayload },
  registry: Registry,
): Promise<ImportPreview> {
  return db.transaction("r", [db.records, db.tombstones, db.pendingConflicts, db.replacedVersions, db.importLog, db.meta], async () => {
    await checkFileReferences(db, opened.payload, registry);
    const items = await classifyAll(db, opened.payload, registry);
    // New items must pass in any case. Preview also assumes the updates will be confirmed, so a
    // file whose newer versions would break links is refused before the user is asked, except a
    // goal update that outputs here would not fit: that is reported, and the user may import
    // without the updates (applyImport refuses it only when the updates are applied).
    await checkActiveLinks(db, items, registry, false);
    let updatesBlockedBy: string[] = [];
    try {
      await checkActiveLinks(db, items, registry, true);
    } catch (e) {
      if (!(e instanceof BackupError && e.code === "LINKED_ITEMS_MISMATCH")) throw e;
      updatesBlockedBy = e.linkedItems.map((item) => item.id);
    }
    const carried = await carriedCounts(db, opened.payload);
    const previous = await db.importLog.where("backupId").equals(opened.header.backupId).sortBy("importedAt");
    const device = await getDeviceSettings(db);
    const source = opened.payload.sourceDeviceSettings;
    return {
      header: opened.header,
      items,
      counts: countItems(items, carried),
      previouslyImportedAt: previous.at(-1)?.importedAt ?? null,
      sourceDeviceSettings: source,
      displaySettingsDiffer: source.language !== device.language || source.theme !== device.theme,
      updatesBlockedBy,
    };
  });
}

/**
 * Applies an import in ONE IndexedDB transaction (all or nothing). The classification is
 * recomputed inside the transaction, so a change made after the preview cannot be overwritten.
 * Only "new" items are written without a choice; updates need `applyUpdates`; conflicts and
 * deletions are stored as pending conflicts with both versions (D-015).
 */
export async function applyImport(
  db: LocalDb,
  opened: { header: BackupHeader; payload: BackupPayload },
  registry: Registry,
  choices: ImportChoices,
): Promise<ImportResult> {
  const tables = [db.records, db.tombstones, db.pendingConflicts, db.replacedVersions, db.importLog, db.meta];
  return db.transaction("rw", tables, async () => {
    // Inside the import transaction: written only if the whole import succeeds.
    await ensureSharedPreferences(db);
    await checkFileReferences(db, opened.payload, registry);
    const items = await classifyAll(db, opened.payload, registry);
    await checkActiveLinks(db, items, registry, choices.applyUpdates);
    const carried = await carriedCounts(db, opened.payload);
    const thisDevice = await deviceIdentity(db);
    const header = opened.header;
    const source = {
      backupId: header.backupId,
      deviceId: header.sourceDevice.id,
      deviceName: header.sourceDevice.name,
      exportedAt: header.createdAt,
    };
    const at = nowIso();
    let appliedUpdates = 0;
    let skippedUpdates = 0;
    const written: { type: string; id: string; data: Record<string, unknown> }[] = [];
    const carriedPauses = new Map((opened.payload.importedSessionPauses ?? []).map((p) => [p.sessionId, p.pausedFrom]));

    for (const item of items) {
      const incoming = item.incoming;
      switch (item.category) {
        case "new":
          if (!incoming.deleted && !item.planIntegrity) {
            await db.records.put({ type: item.type, ...incoming.envelope });
            written.push({ type: item.type, id: item.id, data: incoming.envelope.data });
          }
          break;
        case "newTombstone":
          if (incoming.deleted) await db.tombstones.put(incoming.tombstone);
          break;
        case "newerInBackup":
          if (!choices.applyUpdates || incoming.deleted) {
            skippedUpdates++;
            break;
          }
          if (item.local) {
            const pausedFrom = pauseOfVersion(item.type, item.local, await importedMarkOf(db, item.id));
            await db.replacedVersions.put({
              replacedId: crypto.randomUUID(),
              type: item.type,
              id: item.id,
              entry: item.local,
              replacedAt: at,
              reason: "updatedFromBackup",
              ...(pausedFrom ? { pausedFrom } : {}),
            });
          }
          await db.records.put({ type: item.type, ...incoming.envelope });
          written.push({ type: item.type, id: item.id, data: incoming.envelope.data });
          appliedUpdates++;
          break;
        case "planMerge": {
          // Merged only with "Apply updates" (T-229); otherwise nothing of the incoming plan is written.
          if (!choices.applyUpdates || incoming.deleted || !item.local || item.local.deleted) {
            skippedUpdates++;
            break;
          }
          const merged = item.planMerge?.data;
          if (!merged) break; // integrity issue or past a per-record limit: shown, nothing changes
          const local = item.local.envelope;
          const next = planMergeEnvelope(local, incoming.envelope, merged, thisDevice.id, at);
          // Measured again on exactly what is written now, with this device's current version: nothing breaks a limit.
          if (!envelopeFits(next)) break;
          if (next.contentHash === local.contentHash) {
            await db.records.put({ type: item.type, ...next });
          } else {
            registry.get(item.type)!.schema.parse(merged);
            await db.records.put({ type: item.type, ...next });
            written.push({ type: item.type, id: item.id, data: next.data });
            appliedUpdates++;
          }
          break;
        }
        default:
          if (CONFLICT_CATEGORIES.has(item.category)) {
            await db.pendingConflicts.put({
              conflictId: crypto.randomUUID(),
              kind: item.category === "conflict" ? "edit" : (item.category as PendingConflictRow["kind"]),
              type: item.type,
              id: item.id,
              local: item.local,
              incoming,
              source,
              detectedAt: at,
              detectedOn: { deviceId: thisDevice.id, deviceName: thisDevice.name.slice(0, 80) },
              // The backup's version may become current later: keep when its pause began (T-173).
              ...(item.type === SESSIONS && carriedPauses.has(item.id) ? { incomingPausedFrom: carriedPauses.get(item.id)! } : {}),
            });
          }
      }
    }
    // Running sessions from the backup are treated as paused here from its creation time (T-152).
    await markImportedSessions(db, written, header.createdAt, carriedPauses);
    for (const conflict of carried.conflicts) await db.pendingConflicts.put(conflict);
    for (const replaced of carried.replaced) {
      // A running version without a kept pause was really running on the source: as for an active
      // session, it counts as paused from this backup's time here (version 7, T-173).
      const pausedFrom = replaced.pausedFrom ?? (header.app.dataSchemaVersion >= 7 ? pauseOfVersion(replaced.type, replaced.entry, header.createdAt) : null);
      await db.replacedVersions.put({ ...replaced, ...(pausedFrom ? { pausedFrom } : {}) });
    }
    if (choices.applyDisplaySettings) {
      await db.meta.put({ key: "deviceSettings", value: { ...opened.payload.sourceDeviceSettings } });
    }
    const counts = countItems(items, carried);
    const importId = crypto.randomUUID();
    const log: ImportLogRow = {
      importId,
      backupId: header.backupId,
      fileCreatedAt: header.createdAt,
      sourceDevice: { ...header.sourceDevice },
      importedAt: at,
      counts: { ...counts, appliedUpdates, skippedUpdates },
    };
    await db.importLog.put(log);
    return { counts, appliedUpdates, skippedUpdates, importId };
  });
}
