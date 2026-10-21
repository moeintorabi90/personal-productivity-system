/**
 * Codex review of Stage 1B: (1) conflicts must compare against — and resolve on — the version
 * that is on this device now, keep every version that is not chosen, and refuse stale choices;
 * (2) links in every record version (records, carried conflicts, archive) are checked, and no
 * version with a broken link becomes active.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { PendingConflictRow, VersionEntry } from "../local/db.ts";
import { deleteRecord, putRecord } from "../local/records.ts";
import { loadConflictViews, resolveConflict, restoreReplacedVersion } from "./conflicts.ts";
import { makeEnvelope, nowIso } from "./envelope.ts";
import { applyImport, previewImport } from "./merge.ts";
import { openBackupFile } from "./read.ts";
import { createTestDevice, TEST_REGISTRY, type TestDevice } from "./test-fixtures.ts";
import { blobOf, decide, exportFrom, importInto, mutate, snapshot, viewOf } from "./test-helpers.ts";

const devices: TestDevice[] = [];
async function device(label: string) {
  const d = await createTestDevice(label);
  devices.push(d);
  return d;
}
afterEach(() => {
  for (const d of devices.splice(0)) d.db.close();
});

const id = () => crypto.randomUUID();
const note = (text: string) => ({ text });
const archivedTexts = async (d: TestDevice) =>
  (await d.db.replacedVersions.toArray())
    .map((r) => (r.entry.deleted ? "(deleted)" : String(r.entry.envelope.data.text ?? r.entry.envelope.data.name)))
    .sort();

/** A on "A1", B on "B1" (both from a shared base) → one edit conflict on B. */
async function conflictOnB() {
  const a = await device("A");
  const b = await device("B");
  const item = id();
  await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("base"));
  await importInto(b, (await exportFrom(a)).text);
  await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("A1"));
  await putRecord(b.db, TEST_REGISTRY, "fixtureNote", item, note("B1"));
  await importInto(b, (await exportFrom(a)).text);
  const [conflict] = await b.db.pendingConflicts.toArray();
  return { a, b, item, conflictId: conflict!.conflictId };
}

describe("Issue 1, scenario 1: a local edit after the conflict was found", () => {
  it("shows the new version, refuses the choice made on the old comparison, and keeps every version", async () => {
    const { b, item, conflictId } = await conflictOnB();
    const shownBefore = await viewOf(b.db, conflictId);
    expect(shownBefore.current).toMatchObject({ envelope: { data: note("B1") } });

    await putRecord(b.db, TEST_REGISTRY, "fixtureNote", item, note("B2 (edited after the conflict)"));
    const before = await snapshot(b.db);
    await expect(resolveConflict(b.db, TEST_REGISTRY, conflictId, "useBackup", shownBefore.token)).rejects.toMatchObject({
      code: "STALE",
    });
    expect(await snapshot(b.db)).toEqual(before);

    const view = await viewOf(b.db, conflictId);
    expect(view.current).toMatchObject({ envelope: { data: note("B2 (edited after the conflict)") } });
    expect(view.snapshotDiffers).toBe(true);
    expect(view.conflict.local).toMatchObject({ envelope: { data: note("B1") } });
    expect(view.conflict.detectedOn.deviceName).toBe("B");
  });

  for (const [resolution, expectedCurrent, expectedArchive] of [
    ["useBackup", "A1", ["B1", "B2"]],
    ["keepDevice", "B2", ["A1", "B1"]],
    ["keepBoth", "B2", ["B1"]],
  ] as const) {
    it(`${resolution} after the edit acts on the shown versions and archives the rest`, async () => {
      const { b, item, conflictId } = await conflictOnB();
      await putRecord(b.db, TEST_REGISTRY, "fixtureNote", item, note("B2"));
      await decide(b.db, conflictId, resolution);
      expect((await b.db.records.get(["fixtureNote", item]))?.data).toEqual(note(expectedCurrent));
      expect(await archivedTexts(b)).toEqual([...expectedArchive].sort());
      if (resolution === "keepBoth") {
        const copy = (await b.db.records.where("type").equals("fixtureNote").toArray()).find((r) => r.id !== item);
        expect(copy?.data).toEqual(note("A1"));
      }
      expect(await b.db.pendingConflicts.count()).toBe(0);
    });
  }
});

describe("Issue 1, scenario 2: a conflict carried from another device", () => {
  it("labels the snapshot with the device that found it and compares with this device's own version", async () => {
    const a = await device("A");
    const b = await device("B");
    const c = await device("C");
    const item = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("base"));
    const base = (await exportFrom(a)).text;
    await importInto(b, base);
    await importInto(c, base); // C has only the base …
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("A1"));
    await putRecord(b.db, TEST_REGISTRY, "fixtureNote", item, note("B1"));
    await putRecord(c.db, TEST_REGISTRY, "fixtureNote", item, note("C1")); // … and edits it
    await importInto(b, (await exportFrom(a)).text); // conflict on B: B1 vs A1
    await importInto(c, (await exportFrom(b)).text); // brings B1 (conflict on C) + B's conflict

    const views = await loadConflictViews(c.db, TEST_REGISTRY);
    const carried = views.find((v) => v.conflict.detectedOn.deviceName === "B")!;
    expect(carried).toBeDefined();
    expect(carried.current).toMatchObject({ envelope: { data: note("C1") } }); // not B's snapshot
    expect(carried.conflict.local).toMatchObject({ envelope: { data: note("B1") } });
    expect(carried.snapshotDiffers).toBe(true);
    const own = views.find((v) => v.conflict.detectedOn.deviceName === "C")!;
    expect(own.conflict.local).toMatchObject({ envelope: { data: note("C1") } });

    await decide(c.db, carried.conflict.conflictId, "keepDevice");
    expect((await c.db.records.get(["fixtureNote", item]))?.data).toEqual(note("C1"));
    // B's version is not lost: it is archived; the incoming A1 too.
    expect(await archivedTexts(c)).toEqual(["A1", "B1"]);
  });
});

describe("Issue 1, scenario 3: the current record is deleted or missing when resolving", () => {
  it("deleted after detection: options follow the current state; no version is dropped", async () => {
    const { b, item, conflictId } = await conflictOnB();
    await deleteRecord(b.db, "fixtureNote", item);
    const view = await viewOf(b.db, conflictId);
    expect(view.current?.deleted).toBe(true);
    expect(view.options).toEqual(["restore", "keepDeleted"]);
    await decide(b.db, conflictId, "keepDeleted");
    expect(await b.db.records.get(["fixtureNote", item])).toBeUndefined();
    expect(await b.db.tombstones.get(["fixtureNote", item])).toBeDefined();
    expect(await archivedTexts(b)).toEqual(["A1", "B1"]); // backup version and the earlier snapshot
  });

  async function deviceWithOrphanConflict() {
    const d = await device("D");
    const item = id();
    const at = nowIso();
    const entry = (text: string, dev: string): VersionEntry => ({
      deleted: false,
      envelope: makeEnvelope(item, note(text), { [dev]: 1 }, at),
    });
    const conflict: PendingConflictRow = {
      conflictId: id(),
      kind: "edit",
      type: "fixtureNote",
      id: item,
      local: entry("snapshot from X", crypto.randomUUID()),
      incoming: entry("incoming", crypto.randomUUID()),
      source: { backupId: id(), deviceId: id(), deviceName: "Y", exportedAt: at },
      detectedAt: at,
      detectedOn: { deviceId: id(), deviceName: "X" },
    };
    await d.db.pendingConflicts.put(conflict);
    return { d, item, conflictId: conflict.conflictId };
  }

  it("missing on this device: 'keep this device' records the absence and archives both versions", async () => {
    const { d, item, conflictId } = await deviceWithOrphanConflict();
    const view = await viewOf(d.db, conflictId);
    expect(view.current).toBeNull();
    expect(view.options).toEqual(["useBackup", "keepDevice"]);
    await decide(d.db, conflictId, "keepDevice");
    expect(await d.db.records.get(["fixtureNote", item])).toBeUndefined();
    expect(await archivedTexts(d)).toEqual(["incoming", "snapshot from X"]);
  });

  it("missing on this device: 'use the backup's version' activates it and archives the snapshot", async () => {
    const { d, item, conflictId } = await deviceWithOrphanConflict();
    await decide(d.db, conflictId, "useBackup");
    expect((await d.db.records.get(["fixtureNote", item]))?.data).toEqual(note("incoming"));
    expect(await archivedTexts(d)).toEqual(["snapshot from X"]);
  });
});

describe("Issue 2, scenario 4: links in every version", () => {
  async function baseFile() {
    const a = await device("A");
    const parent = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureParent", parent, { name: "P" });
    return { a, parent, text: (await exportFrom(a)).text };
  }

  function childEntry(parentId: string, childId = id()) {
    return { deleted: false, envelope: makeEnvelope(childId, { name: "kid", parentId }, { [id()]: 1 }, nowIso()) };
  }

  it("refuses a carried conflict or an archived version that links to an unknown ID, changing nothing", async () => {
    const { text } = await baseFile();
    const b = await device("B");
    const before = await snapshot(b.db);
    const unknownParent = id();
    const withConflict = mutate(text, (d) => {
      const entry = childEntry(unknownParent);
      d.payload.pendingConflicts.push({
        conflictId: id(),
        kind: "edit",
        type: "fixtureChild",
        id: entry.envelope.id,
        local: null,
        incoming: entry,
        source: { backupId: id(), deviceId: id(), deviceName: "X", exportedAt: nowIso() },
        detectedAt: nowIso(),
        detectedOn: { deviceId: id(), deviceName: "X" },
      });
    });
    const withArchive = mutate(text, (d) => {
      const entry = childEntry(unknownParent);
      d.payload.replacedVersions.push({ replacedId: id(), type: "fixtureChild", id: entry.envelope.id, entry, replacedAt: nowIso(), reason: "x" });
    });
    for (const file of [withConflict, withArchive]) {
      await expect(importInto(b, file)).rejects.toMatchObject({ code: "UNRESOLVED_REFERENCE" });
    }
    expect(await snapshot(b.db)).toEqual(before);
  });

  it("accepts an archived version whose target is deleted (history), but undo refuses to activate it", async () => {
    const { a, parent } = await baseFile();
    const childId = id();
    const archivedChild = childEntry(parent, childId);
    await deleteRecord(a.db, "fixtureParent", parent);
    const file = mutate((await exportFrom(a)).text, (d) => {
      d.payload.replacedVersions.push({ replacedId: id(), type: "fixtureChild", id: childId, entry: archivedChild, replacedAt: nowIso(), reason: "x" });
    });
    const b = await device("B");
    await importInto(b, file); // parent is known (tombstone in the file): allowed as history
    const [row] = await b.db.replacedVersions.toArray();
    const before = await snapshot(b.db);
    await expect(restoreReplacedVersion(b.db, TEST_REGISTRY, row!.replacedId)).rejects.toMatchObject({ code: "BROKEN_LINK" });
    expect(await snapshot(b.db)).toEqual(before);
  });

  it("refuses to activate a conflict's backup version whose parent was deleted here, changing nothing", async () => {
    const a = await device("A");
    const b = await device("B");
    const parent = id();
    const child = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureParent", parent, { name: "P" });
    await putRecord(a.db, TEST_REGISTRY, "fixtureChild", child, { name: "c0", parentId: parent });
    await importInto(b, (await exportFrom(a)).text);
    await putRecord(a.db, TEST_REGISTRY, "fixtureChild", child, { name: "cA", parentId: parent });
    await putRecord(b.db, TEST_REGISTRY, "fixtureChild", child, { name: "cB", parentId: parent });
    await importInto(b, (await exportFrom(a)).text);
    const [conflict] = await b.db.pendingConflicts.toArray();
    // Make the child's parent disappear on B (child first, so the parent has no live children).
    await deleteRecord(b.db, "fixtureChild", child);
    await deleteRecord(b.db, "fixtureParent", parent);
    const before = await snapshot(b.db);
    await expect(decide(b.db, conflict!.conflictId, "restore")).rejects.toMatchObject({ code: "BROKEN_LINK" });
    expect(await snapshot(b.db)).toEqual(before);
  });
});

describe("Issue 2, scenario 5: a link target changes between preview and apply", () => {
  it("apply re-checks links inside its transaction and fails as a whole", async () => {
    const a = await device("A");
    const b = await device("B");
    const parent = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureParent", parent, { name: "P" });
    await importInto(b, (await exportFrom(a)).text); // B has the parent
    await putRecord(a.db, TEST_REGISTRY, "fixtureChild", id(), { name: "new child", parentId: parent });
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", id(), note("unrelated new item"));
    // A's file has the parent too; drop it so the child relies on B's copy only.
    const file = mutate((await exportFrom(a)).text, (d) => delete d.payload.records.fixtureParent);
    const opened = await openBackupFile(blobOf(file), TEST_REGISTRY);
    const preview = await previewImport(b.db, opened, TEST_REGISTRY);
    expect(preview.counts.new).toBe(2);

    await deleteRecord(b.db, "fixtureParent", parent); // changed after the preview
    const before = await snapshot(b.db);
    await expect(applyImport(b.db, opened, TEST_REGISTRY, { applyUpdates: false, applyDisplaySettings: false })).rejects.toMatchObject({
      code: "UNRESOLVED_REFERENCE",
    });
    expect(await snapshot(b.db)).toEqual(before);
    expect(await b.db.importLog.count()).toBe(1); // only the first import
  });

  it("a new child may link to a parent added by the same import; not to one deleted here", async () => {
    const a = await device("A");
    const b = await device("B");
    const parent = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureParent", parent, { name: "P" });
    await putRecord(a.db, TEST_REGISTRY, "fixtureChild", id(), { name: "kid", parentId: parent });
    const both = (await exportFrom(a)).text;
    const { result } = await importInto(b, both);
    expect(result.counts.new).toBe(2);

    const c = await device("C");
    await importInto(c, (await exportFrom(a)).text);
    const extraChild = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureChild", extraChild, { name: "kid 2", parentId: parent });
    await putRecord(a.db, TEST_REGISTRY, "fixtureParent", parent, { name: "P edited on A" });
    for (const r of await c.db.records.where("type").equals("fixtureChild").toArray()) await deleteRecord(c.db, "fixtureChild", r.id);
    await deleteRecord(c.db, "fixtureParent", parent); // C deleted the parent; A's edit makes it "deleted here"
    const before = await snapshot(c.db);
    await expect(importInto(c, (await exportFrom(a)).text)).rejects.toMatchObject({ code: "UNRESOLVED_REFERENCE" });
    expect(await snapshot(c.db)).toEqual(before);
  });
});
