import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteRecord, putRecord } from "../local/records.ts";
import { loadConflictViews, resolveConflicts, restoreReplacedVersion } from "./conflicts.ts";
import { openBackupFile } from "./read.ts";
import { applyImport, previewImport } from "./merge.ts";
import { createTestDevice, HISTORY_REGISTRY, TEST_REGISTRY, type TestDevice } from "./test-fixtures.ts";
import { blobOf, decide, exportFrom, importInto, snapshot, viewOf } from "./test-helpers.ts";

const devices: TestDevice[] = [];
async function device(label: string) {
  const d = await createTestDevice(label);
  devices.push(d);
  return d;
}
afterEach(() => {
  for (const d of devices.splice(0)) d.db.close();
});

const note = (text: string) => ({ text });
const id = () => crypto.randomUUID();

describe("backup round-trip and merge (docs/TESTING.md backup tests 1–7)", () => {
  it("1. round-trip: export from A, import into empty B reproduces records and tombstones", async () => {
    const a = await device("A");
    const b = await device("B");
    const parent = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", id(), note("one"));
    await putRecord(a.db, TEST_REGISTRY, "fixtureParent", parent, { name: "P" });
    await putRecord(a.db, TEST_REGISTRY, "fixtureChild", id(), { name: "C", parentId: parent });
    const gone = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", gone, note("deleted"));
    await deleteRecord(a.db, "fixtureNote", gone);

    const file = await exportFrom(a);
    const { result } = await importInto(b, file.text);
    expect(result.counts.new).toBe(3);
    expect(result.counts.newTombstone).toBe(1);

    const sa = await snapshot(a.db);
    const sb = await snapshot(b.db);
    expect(sb.records.filter((r) => !r.startsWith("preferences/"))).toEqual(sa.records.filter((r) => !r.startsWith("preferences/")));
    expect(sb.tombstones).toEqual(sa.tombstones);
  });

  it("2. merge without loss: B keeps all its own items; nothing is deleted", async () => {
    const a = await device("A");
    const b = await device("B");
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", id(), note("from A"));
    const own = id();
    await putRecord(b.db, TEST_REGISTRY, "fixtureNote", own, note("from B"));
    const before = await snapshot(b.db);

    await importInto(b, (await exportFrom(a)).text);
    const after = await snapshot(b.db);
    for (const row of before.records.filter((r) => !r.startsWith("preferences/"))) expect(after.records).toContain(row);
    expect(after.records.filter((r) => r.startsWith("fixtureNote/"))).toHaveLength(2);
    expect(after.tombstones).toEqual([]);
  });

  it("3. idempotent: importing the same file twice changes nothing the second time", async () => {
    const a = await device("A");
    const b = await device("B");
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", id(), note("x"));
    await putRecord(b.db, TEST_REGISTRY, "fixtureNote", id(), note("y"));
    const file = (await exportFrom(a)).text;
    await importInto(b, file);
    const once = await snapshot(b.db);
    const second = await importInto(b, file);
    expect(second.preview.previouslyImportedAt).toEqual(expect.any(String));
    expect(second.result.counts.new).toBe(0);
    expect(second.result.counts.alreadyHere).toBeGreaterThan(0);
    expect(await snapshot(b.db)).toEqual(once);
  });

  it("4. older copy: re-importing an old export does not undo newer local edits", async () => {
    const a = await device("A");
    const item = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("v1"));
    const old = (await exportFrom(a)).text;
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("v2"));
    const { result } = await importInto(a, old);
    expect(result.counts.olderCopy).toBe(1);
    expect(result.counts.conflict).toBe(0);
    expect((await a.db.records.get(["fixtureNote", item]))?.data).toEqual(note("v2"));
  });

  it("5. newer in backup: listed, not applied without confirmation; applied (and archived) with it", async () => {
    const a = await device("A");
    const b = await device("B");
    const item = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("v1"));
    await importInto(b, (await exportFrom(a)).text);
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("v2"));
    const newer = (await exportFrom(a)).text;

    const declined = await importInto(b, newer, { applyUpdates: false });
    expect(declined.preview.counts.newerInBackup).toBe(1);
    expect(declined.result.skippedUpdates).toBe(1);
    expect((await b.db.records.get(["fixtureNote", item]))?.data).toEqual(note("v1"));

    const accepted = await importInto(b, newer, { applyUpdates: true });
    expect(accepted.result.appliedUpdates).toBe(1);
    expect((await b.db.records.get(["fixtureNote", item]))?.data).toEqual(note("v2"));
    const archived = await b.db.replacedVersions.toArray();
    expect(archived).toHaveLength(1);
    expect(archived[0]!.entry).toMatchObject({ deleted: false, envelope: { data: note("v1") } });
  });

  it("6a. true conflict: both versions kept, survive restart; each resolution behaves as specified", async () => {
    const a = await device("A");
    const b = await device("B");
    const item = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("base"));
    await importInto(b, (await exportFrom(a)).text);
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("edited on A"));
    await putRecord(b.db, TEST_REGISTRY, "fixtureNote", item, note("edited on B"));
    const fromA = (await exportFrom(a)).text;

    const { result } = await importInto(b, fromA);
    expect(result.counts.conflict).toBe(1);
    expect((await b.db.records.get(["fixtureNote", item]))?.data).toEqual(note("edited on B"));

    await b.restart();
    const [conflict] = await b.db.pendingConflicts.toArray();
    expect(conflict).toMatchObject({ kind: "edit", type: "fixtureNote", id: item });
    expect(conflict!.incoming).toMatchObject({ envelope: { data: note("edited on A") } });
    expect((await viewOf(b.db, conflict!.conflictId)).options).toEqual(["keepDevice", "useBackup", "keepBoth"]);

    // keepBoth (independent type): the backup version becomes a copy with a new ID.
    await decide(b.db, conflict!.conflictId, "keepBoth");
    const notes = await b.db.records.where("type").equals("fixtureNote").toArray();
    expect(notes.map((n) => n.data.text).sort()).toEqual(["edited on A", "edited on B"]);
    expect(notes.find((n) => n.id !== item)?.copyOf).toBe(item);

    // The decision dominates both versions: importing the same file again raises nothing.
    const again = await importInto(b, fromA);
    expect(again.result.counts.conflict).toBe(0);
    expect(await b.db.pendingConflicts.count()).toBe(0);
  });

  it("6b. useBackup / keepDevice, with undo restoring the replaced version", async () => {
    const a = await device("A");
    const b = await device("B");
    const item = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("base"));
    await importInto(b, (await exportFrom(a)).text);
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("A"));
    await putRecord(b.db, TEST_REGISTRY, "fixtureNote", item, note("B"));
    await importInto(b, (await exportFrom(a)).text);

    const [c1] = await b.db.pendingConflicts.toArray();
    await decide(b.db, c1!.conflictId, "useBackup");
    expect((await b.db.records.get(["fixtureNote", item]))?.data).toEqual(note("A"));
    const [archived] = await b.db.replacedVersions.toArray();
    expect(archived!.entry).toMatchObject({ envelope: { data: note("B") } });

    await restoreReplacedVersion(b.db, TEST_REGISTRY, archived!.replacedId);
    expect((await b.db.records.get(["fixtureNote", item]))?.data).toEqual(note("B"));
    expect((await b.db.replacedVersions.toArray()).map((r) => (r.entry as { envelope: { data: unknown } }).envelope.data)).toEqual([
      note("A"),
    ]);
  });

  it("6c. linked records: no 'keep both'; choosing a version keeps the ID so children stay attached", async () => {
    const a = await device("A");
    const b = await device("B");
    const parent = id();
    const child = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureParent", parent, { name: "P0" });
    await putRecord(a.db, TEST_REGISTRY, "fixtureChild", child, { name: "C", parentId: parent });
    await importInto(b, (await exportFrom(a)).text);
    await putRecord(a.db, TEST_REGISTRY, "fixtureParent", parent, { name: "P-A" });
    await putRecord(b.db, TEST_REGISTRY, "fixtureParent", parent, { name: "P-B" });
    await importInto(b, (await exportFrom(a)).text);

    const [conflict] = await b.db.pendingConflicts.toArray();
    expect(conflict!.type).toBe("fixtureParent");
    expect((await viewOf(b.db, conflict!.conflictId)).options).toEqual(["keepDevice", "useBackup"]);
    await expect(decide(b.db, conflict!.conflictId, "keepBoth")).rejects.toMatchObject({
      code: "NOT_ALLOWED",
    });
    await decide(b.db, conflict!.conflictId, "useBackup");
    expect((await b.db.records.get(["fixtureParent", parent]))?.data).toEqual({ name: "P-A" });
    expect((await b.db.records.get(["fixtureChild", child]))?.data.parentId).toBe(parent);
    expect(await b.db.records.where("type").equals("fixtureParent").count()).toBe(1);
  });

  it("7. deletions in either direction become pending conflicts, never automatic deletes or resurrections", async () => {
    const a = await device("A");
    const b = await device("B");
    const deletedOnA = id();
    const deletedOnB = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", deletedOnA, note("a"));
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", deletedOnB, note("b"));
    await importInto(b, (await exportFrom(a)).text);
    await deleteRecord(a.db, "fixtureNote", deletedOnA);
    await deleteRecord(b.db, "fixtureNote", deletedOnB);
    // B edits the one A deleted, after its last import: the deletion is not "older news".
    await putRecord(b.db, TEST_REGISTRY, "fixtureNote", deletedOnA, note("a edited on B"));
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", deletedOnB, note("b edited on A"));

    const { result } = await importInto(b, (await exportFrom(a)).text);
    expect(result.counts.deletedInBackup).toBe(1);
    expect(result.counts.deletedHere).toBe(1);
    expect((await b.db.records.get(["fixtureNote", deletedOnA]))?.data).toEqual(note("a edited on B"));
    expect(await b.db.records.get(["fixtureNote", deletedOnB])).toBeUndefined();
    expect(await b.db.tombstones.get(["fixtureNote", deletedOnB])).toBeDefined();

    const conflicts = await b.db.pendingConflicts.toArray();
    const inBackup = conflicts.find((c) => c.kind === "deletedInBackup")!;
    const here = conflicts.find((c) => c.kind === "deletedHere")!;
    expect((await viewOf(b.db, inBackup.conflictId)).options).toEqual(["deleteHere", "keepHere"]);
    expect((await viewOf(b.db, here.conflictId)).options).toEqual(["restore", "keepDeleted"]);

    await decide(b.db, here.conflictId, "restore");
    expect((await b.db.records.get(["fixtureNote", deletedOnB]))?.data).toEqual(note("b edited on A"));
    expect(await b.db.tombstones.get(["fixtureNote", deletedOnB])).toBeUndefined();
    await decide(b.db, inBackup.conflictId, "deleteHere");
    expect(await b.db.records.get(["fixtureNote", deletedOnA])).toBeUndefined();
    expect(await b.db.tombstones.get(["fixtureNote", deletedOnA])).toBeDefined();
  });

  it("7b. an old backup does not resurrect an item deleted later; deleting a linked parent is refused", async () => {
    const a = await device("A");
    const item = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("x"));
    const old = (await exportFrom(a)).text;
    await deleteRecord(a.db, "fixtureNote", item);
    const { result } = await importInto(a, old);
    expect(result.counts.olderCopy).toBe(1);
    expect(await a.db.records.get(["fixtureNote", item])).toBeUndefined();

    const b = await device("B");
    const parent = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureParent", parent, { name: "P" });
    await importInto(b, (await exportFrom(a)).text);
    await putRecord(b.db, TEST_REGISTRY, "fixtureChild", id(), { name: "kid", parentId: parent });
    await putRecord(b.db, TEST_REGISTRY, "fixtureParent", parent, { name: "P edited on B" });
    await deleteRecord(a.db, "fixtureParent", parent);
    await importInto(b, (await exportFrom(a)).text);
    const [conflict] = await b.db.pendingConflicts.toArray();
    expect(conflict!.kind).toBe("deletedInBackup");
    await expect(decide(b.db, conflict!.conflictId, "deleteHere")).rejects.toMatchObject({
      code: "HAS_LINKED_ITEMS",
    });
    expect(await b.db.records.get(["fixtureParent", parent])).toBeDefined();
    expect(await b.db.pendingConflicts.count()).toBe(1);
  });
});

describe("history, identity, preview, bulk, atomicity (items 8, 14, 15, 17)", () => {
  it("8. append-only history: same ID with different content is an integrity warning; nothing changes", async () => {
    const a = await device("A");
    const b = await device("B");
    const event = id();
    await putRecord(a.db, HISTORY_REGISTRY, "fixtureNote", event, note("original"));
    // Simulate an inconsistent copy on B (should never happen in practice).
    await putRecord(b.db, HISTORY_REGISTRY, "fixtureNote", event, note("different"));
    const correction = id();
    await putRecord(a.db, HISTORY_REGISTRY, "fixtureNote", correction, note("correction of original"));

    const { result } = await importInto(b, (await exportFrom(a, {}, HISTORY_REGISTRY)).text, { registry: HISTORY_REGISTRY });
    expect(result.counts.history).toBe(1);
    expect(result.counts.new).toBe(1); // the correction is appended as its own record
    expect((await b.db.records.get(["fixtureNote", event]))?.data).toEqual(note("different"));
    const [warning] = await b.db.pendingConflicts.toArray();
    expect(warning!.kind).toBe("history");
    expect((await viewOf(b.db, warning!.conflictId, HISTORY_REGISTRY)).options).toEqual(["keepDevice"]);
    await expect(putRecord(b.db, HISTORY_REGISTRY, "fixtureNote", event, note("edit"))).rejects.toThrow(/Append-only/);
  });

  it("14. preview counts equal what is applied", async () => {
    const a = await device("A");
    const b = await device("B");
    const shared = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", shared, note("s"));
    await importInto(b, (await exportFrom(a)).text);
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", shared, note("s-A"));
    await putRecord(b.db, TEST_REGISTRY, "fixtureNote", shared, note("s-B"));
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", id(), note("new"));
    const opened = await openBackupFile(blobOf((await exportFrom(a)).text), TEST_REGISTRY);
    const preview = await previewImport(b.db, opened, TEST_REGISTRY);
    const result = await applyImport(b.db, opened, TEST_REGISTRY, { applyUpdates: false, applyDisplaySettings: false });
    expect(result.counts).toEqual(preview.counts);
    expect(preview.counts).toMatchObject({ new: 1, conflict: 1 });
  });

  it("15. identity is the UUID: identical content with different IDs is kept twice", async () => {
    const a = await device("A");
    const b = await device("B");
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", id(), note("same text"));
    await putRecord(b.db, TEST_REGISTRY, "fixtureNote", id(), note("same text"));
    const { result } = await importInto(b, (await exportFrom(a)).text);
    expect(result.counts.new).toBe(1);
    expect(await b.db.records.where("type").equals("fixtureNote").count()).toBe(2);
  });

  it("17. bulk action applies one choice to the listed conflicts and reports the count", async () => {
    const a = await device("A");
    const b = await device("B");
    const ids = [id(), id(), id()];
    for (const i of ids) await putRecord(a.db, TEST_REGISTRY, "fixtureNote", i, note("base"));
    await importInto(b, (await exportFrom(a)).text);
    for (const i of ids) {
      await putRecord(a.db, TEST_REGISTRY, "fixtureNote", i, note("A"));
      await putRecord(b.db, TEST_REGISTRY, "fixtureNote", i, note("B"));
    }
    await importInto(b, (await exportFrom(a)).text);
    const shown = (await loadConflictViews(b.db, TEST_REGISTRY)).map((v) => ({ conflictId: v.conflict.conflictId, expected: v.token }));
    expect(shown).toHaveLength(3);
    expect(await resolveConflicts(b.db, TEST_REGISTRY, shown, "keepDevice")).toBe(3);
    expect(await b.db.pendingConflicts.count()).toBe(0);
    expect(await b.db.replacedVersions.count()).toBe(3);
    for (const i of ids) expect((await b.db.records.get(["fixtureNote", i]))?.data).toEqual(note("B"));
  });

  it("an import that fails while applying changes nothing (one transaction)", async () => {
    const a = await device("A");
    const b = await device("B");
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", id(), note("x"));
    await putRecord(a.db, TEST_REGISTRY, "fixtureParent", id(), { name: "p" });
    const opened = await openBackupFile(blobOf((await exportFrom(a)).text), TEST_REGISTRY);
    await previewImport(b.db, opened, TEST_REGISTRY);
    const before = await snapshot(b.db);
    const spy = vi.spyOn(b.db.importLog, "put").mockRejectedValueOnce(new Error("disk full"));
    await expect(applyImport(b.db, opened, TEST_REGISTRY, { applyUpdates: true, applyDisplaySettings: true })).rejects.toThrow(
      "disk full",
    );
    spy.mockRestore();
    expect(await snapshot(b.db)).toEqual(before);
  });

  it("carries pending conflicts and replaced versions to another device, without duplicates", async () => {
    const a = await device("A");
    const b = await device("B");
    const c = await device("C");
    const item = id();
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("base"));
    await importInto(b, (await exportFrom(a)).text);
    await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("A"));
    await putRecord(b.db, TEST_REGISTRY, "fixtureNote", item, note("B"));
    await importInto(b, (await exportFrom(a)).text);
    expect(await b.db.pendingConflicts.count()).toBe(1);

    const fromB = (await exportFrom(b)).text;
    const first = await importInto(c, fromB);
    expect(first.result.counts.carriedConflicts).toBe(1);
    const second = await importInto(c, fromB);
    expect(second.result.counts.carriedConflicts).toBe(0);
    expect(await c.db.pendingConflicts.count()).toBe(1);
    expect((await c.db.records.get(["fixtureNote", item]))?.data).toEqual(note("B"));
  });
});
