import type { DeviceSettings, ImportLogRow, LocalDb, PendingConflictRow, ReplacedVersionRow, VersionEntry } from "../local/db.ts";
import { deviceIdentity, getDeviceSettings, toEnvelope } from "../local/records.ts";
import { ensureSharedPreferences } from "../local/settings.ts";
import { markImportedSessions } from "../local/work.ts";
import { type Envelope, makeEnvelope, nowIso, type Tombstone } from "./envelope.ts";
import { BackupError } from "./errors.ts";
import type { BackupHeader, BackupPayload } from "./format.ts";
import { type DataLookup, GOALS, linkTargets, OUTPUT_RECORDS, outputsMisfittingGoal, type Registry } from "./registry.ts";
import { compareVersions, isContainedIn } from "./versions.ts";

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
  | "alreadyPending";

export interface PreviewItem {
  type: string;
  id: string;
  category: ItemCategory;
  incoming: VersionEntry;
  local: VersionEntry | null;
}

export type PreviewCounts = Record<ItemCategory | "carriedConflicts" | "carriedReplaced", number>;

export interface ImportPreview {
  header: BackupHeader;
  items: PreviewItem[];
  counts: PreviewCounts;
  /** When this exact backup was imported before, if ever. */
  previouslyImportedAt: string | null;
  sourceDeviceSettings: DeviceSettings;
  displaySettingsDiffer: boolean;
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
    carriedConflicts: 0,
    carriedReplaced: 0,
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
function classifyRecord(incoming: Envelope, local: LocalState, appendOnly: boolean): ItemCategory {
  const entry: VersionEntry = { deleted: false, envelope: incoming };
  if (local.pending.some((p) => sameEntry(p.incoming, entry))) return "alreadyPending";
  if (local.record) {
    if (local.record.contentHash === incoming.contentHash) return "alreadyHere";
    const order = compareVersions(incoming.version, local.record.version);
    if (order === "before") return "olderCopy";
    if (appendOnly) return "history"; // history data never changes: a difference is an integrity issue
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

  const items: PreviewItem[] = [];
  for (const [type, list] of Object.entries(payload.records)) {
    const appendOnly = !!registry.get(type)!.appendOnly;
    for (const envelope of list) {
      const state = local.get(`${type}/${envelope.id}`)!;
      items.push({
        type,
        id: envelope.id,
        category: classifyRecord(envelope, state, appendOnly),
        incoming: { deleted: false, envelope },
        local: localEntry(state),
      });
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
  for (const item of items) counts[item.category] += 1;
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
    // Preview assumes the updates will be confirmed, so a file whose newer versions would
    // break links is refused before the user is asked.
    await checkActiveLinks(db, items, registry, true);
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

    for (const item of items) {
      const incoming = item.incoming;
      switch (item.category) {
        case "new":
          if (!incoming.deleted) {
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
            await db.replacedVersions.put({
              replacedId: crypto.randomUUID(),
              type: item.type,
              id: item.id,
              entry: item.local,
              replacedAt: at,
              reason: "updatedFromBackup",
            });
          }
          await db.records.put({ type: item.type, ...incoming.envelope });
          written.push({ type: item.type, id: item.id, data: incoming.envelope.data });
          appliedUpdates++;
          break;
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
            });
          }
      }
    }
    // Running sessions from the backup are treated as paused here from its creation time (T-152).
    await markImportedSessions(db, written, header.createdAt);
    for (const conflict of carried.conflicts) await db.pendingConflicts.put(conflict);
    for (const replaced of carried.replaced) await db.replacedVersions.put(replaced);
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
