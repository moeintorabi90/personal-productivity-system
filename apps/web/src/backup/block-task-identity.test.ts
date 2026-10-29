/**
 * A planned block's task is fixed (DECISIONS T-171): sessions linked to a block belong to its
 * task (T-094, T-135), so no write, import, conflict choice, or undo may give a block another
 * task — also not for sessions in the trash. Every refusal leaves the data unchanged. Fabricated
 * data only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTask } from "../local/organization.ts";
import { createBlock, updateBlock } from "../local/planning.ts";
import { putRecord } from "../local/records.ts";
import { updateSharedPreferences } from "../local/settings.ts";
import { deleteSession, endSession, startSession } from "../local/work.ts";
import { loadConflictViews, restoreReplacedVersion } from "./conflicts.ts";
import { contentHashOf, makeEnvelope, nowIso } from "./envelope.ts";
import { CALENDAR_BLOCKS, PRODUCT_REGISTRY, SESSIONS } from "./registry.ts";
import { createTestDevice, type TestDevice } from "./test-fixtures.ts";
import { decide, exportFrom, importInto, mutate, snapshot } from "./test-helpers.ts";

const registry = PRODUCT_REGISTRY;
const product = { registry };
const T0 = Date.parse("2026-11-02T06:00:00Z");
const MIN = 60_000;
const devices: TestDevice[] = [];
afterEach(() => {
  for (const d of devices.splice(0)) d.db.close();
});
async function device(label: string) {
  const d = await createTestDevice(label);
  devices.push(d);
  await updateSharedPreferences(d.db, { timeZone: "Asia/Tehran" });
  return d;
}
const exportText = async (d: TestDevice) => (await exportFrom(d, {}, registry)).text;
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

/** Device A: two tasks, a block of the first, a session started from it, and another one in the trash; B has imported it all. */
async function setup() {
  const a = await device("A");
  const write = await createTask(a.db, { title: "Write" });
  const read = await createTask(a.db, { title: "Read" });
  const block = await createBlock(a.db, { taskId: write, date: "2026-11-02", startTime: "10:00", durationMinutes: 60 });
  const session = await startSession(a.db, { blockId: block }, T0);
  await endSession(a.db, session, {}, T0 + 30 * MIN);
  const trashed = await startSession(a.db, { blockId: block }, T0 + 40 * MIN);
  await endSession(a.db, trashed, {}, T0 + 50 * MIN);
  await deleteSession(a.db, trashed, T0 + 55 * MIN);
  const b = await device("B");
  await importInto(b, await exportText(a), product);
  return { a, b, write, read, block, session, trashed };
}

const blockOf = async (d: TestDevice, id: string) => (await d.db.records.get([CALENDAR_BLOCKS, id]))!.data as { taskId: string };
const sessionsStillLinked = async (d: TestDevice, ids: string[], block: string, task: string) => {
  for (const id of ids) {
    const data = (await d.db.records.get([SESSIONS, id]))!.data as { blockId: string | null; taskId: string | null };
    expect(data.blockId).toBe(block);
    expect(data.taskId).toBe(task);
  }
  expect((await blockOf(d, block)).taskId).toBe(task);
};

describe("a planned block's task is fixed (T-171)", () => {
  it("a record write that gives a block another task is refused", async () => {
    const s = await setup();
    const before = await snapshot(s.b.db);
    const current = (await s.b.db.records.get([CALENDAR_BLOCKS, s.block]))!.data;
    expect(await codeOf(putRecord(s.b.db, registry, CALENDAR_BLOCKS, s.block, { ...current, taskId: s.read }))).toBe("IMMUTABLE_FIELD");
    expect(await snapshot(s.b.db)).toEqual(before);
  });

  it("an import is refused whole when a block's versions disagree on its task: a newer version, or one in the file's history", async () => {
    const s = await setup();
    const text = await exportText(s.a);
    // A "newer" block version (its version contains this device's) for the other task.
    const newer = mutate(text, (doc) => {
      const env = doc.payload.records[CALENDAR_BLOCKS].find((e: { id: string }) => e.id === s.block);
      env.data.taskId = s.read;
      env.contentHash = contentHashOf(env.data);
      env.version = { ...env.version, [crypto.randomUUID()]: 1 };
    });
    // An archived version for the other task, next to the unchanged record.
    const inHistory = mutate(text, (doc) => {
      const env = doc.payload.records[CALENDAR_BLOCKS].find((e: { id: string }) => e.id === s.block);
      const entry = { deleted: false, envelope: makeEnvelope(s.block, { ...env.data, taskId: s.read }, { [crypto.randomUUID()]: 1 }, nowIso()) };
      doc.payload.replacedVersions.push({ replacedId: crypto.randomUUID(), type: CALENDAR_BLOCKS, id: s.block, entry, replacedAt: nowIso(), reason: "x" });
    });
    const before = await snapshot(s.b.db);
    for (const file of [newer, inHistory]) {
      expect(await codeOf(importInto(s.b, file, { ...product, applyUpdates: true }))).toBe("INVALID_RELATIONSHIP");
      expect(await snapshot(s.b.db)).toEqual(before);
    }
    await sessionsStillLinked(s.b, [s.session, s.trashed], s.block, s.write);
    // On a fresh device, too: the file's own versions disagree.
    const c = await device("C");
    const empty = await snapshot(c.db);
    expect(await codeOf(importInto(c, inHistory, product))).toBe("INVALID_RELATIONSHIP");
    expect(await snapshot(c.db)).toEqual(empty);
  });

  /** A real block conflict on B whose backup version is then given the other task, as an older build could have stored it. */
  async function blockConflict() {
    const s = await setup();
    await updateBlock(s.a.db, s.block, { date: "2026-11-02", startTime: "11:00", durationMinutes: 60 });
    await updateBlock(s.b.db, s.block, { date: "2026-11-02", startTime: "12:00", durationMinutes: 60 });
    await importInto(s.b, await exportText(s.a), product);
    const [view] = await loadConflictViews(s.b.db, registry);
    expect(view!.conflict.type).toBe(CALENDAR_BLOCKS);
    return { ...s, conflictId: view!.conflict.conflictId };
  }

  it("a conflict choice of a block version for another task is refused; nothing changes", async () => {
    const s = await blockConflict();
    const row = (await s.b.db.pendingConflicts.get(s.conflictId))!;
    if (row.incoming.deleted) throw new Error("expected a record version");
    const data = { ...row.incoming.envelope.data, taskId: s.read };
    await s.b.db.pendingConflicts.put({ ...row, incoming: { deleted: false, envelope: { ...row.incoming.envelope, data, contentHash: contentHashOf(data) } } });
    const before = await snapshot(s.b.db);
    expect(await codeOf(decide(s.b.db, s.conflictId, "useBackup", registry))).toBe("IMMUTABLE_FIELD");
    expect(await snapshot(s.b.db)).toEqual(before);
    await sessionsStillLinked(s.b, [s.session, s.trashed], s.block, s.write);
    // This device's version can still be kept.
    expect(await codeOf(decide(s.b.db, s.conflictId, "keepDevice", registry))).toBe("OK");
  });

  it("restoring an archived block version for another task is refused; nothing changes", async () => {
    const s = await blockConflict();
    await decide(s.b.db, s.conflictId, "keepDevice", registry); // the backup's version goes to the archive
    const archived = (await s.b.db.replacedVersions.toArray()).find((r) => r.type === CALENDAR_BLOCKS && r.id === s.block)!;
    if (archived.entry.deleted) throw new Error("expected a record version");
    const data = { ...archived.entry.envelope.data, taskId: s.read };
    await s.b.db.replacedVersions.put({ ...archived, entry: { deleted: false, envelope: { ...archived.entry.envelope, data, contentHash: contentHashOf(data) } } });
    const before = await snapshot(s.b.db);
    expect(await codeOf(restoreReplacedVersion(s.b.db, registry, archived.replacedId))).toBe("IMMUTABLE_FIELD");
    expect(await snapshot(s.b.db)).toEqual(before);
    expect(await s.b.db.replacedVersions.get(archived.replacedId)).toBeDefined();
    await sessionsStillLinked(s.b, [s.session, s.trashed], s.block, s.write);
  });

  /** A second block of the first task, without sessions, on both devices. */
  async function spareBlock() {
    const s = await setup();
    const spare = await createBlock(s.a.db, { taskId: s.write, date: "2026-11-03", startTime: "09:00", durationMinutes: 30 });
    await importInto(s.b, await exportText(s.a), product);
    return { ...s, spare };
  }
  /** Deletes the block on B as a deletion arriving earlier would have (a tombstone with a newer version). */
  async function deleteOnB(d: TestDevice, id: string) {
    const row = (await d.db.records.get([CALENDAR_BLOCKS, id]))!;
    await d.db.transaction("rw", [d.db.records, d.db.tombstones], async () => {
      await d.db.records.delete([CALENDAR_BLOCKS, id]);
      await d.db.tombstones.put({ type: CALENDAR_BLOCKS, id, deletedAt: nowIso(), version: { ...row.version, [crypto.randomUUID()]: 1 } });
    });
  }
  /** An archived version for another task, as a backup made before T-171 could have left on this device. */
  async function archiveForOtherTask(d: TestDevice, id: string, data: Record<string, unknown>, taskId: string) {
    const entry = { deleted: false as const, envelope: makeEnvelope(id, { ...data, taskId }, { [crypto.randomUUID()]: 1 }, nowIso()) };
    const replacedId = crypto.randomUUID();
    await d.db.replacedVersions.put({ replacedId, type: CALENDAR_BLOCKS, id, entry, replacedAt: nowIso(), reason: "notChosen" });
    return replacedId;
  }

  /** B: the spare block's backup version archived (this device's kept), then the block deleted here. */
  async function deletedWithArchive() {
    const s = await spareBlock();
    await updateBlock(s.a.db, s.spare, { date: "2026-11-03", startTime: "10:00", durationMinutes: 30 });
    await updateBlock(s.b.db, s.spare, { date: "2026-11-03", startTime: "11:00", durationMinutes: 30 });
    await importInto(s.b, await exportText(s.a), product);
    const [view] = await loadConflictViews(s.b.db, registry);
    await decide(s.b.db, view!.conflict.conflictId, "keepDevice", registry);
    const archived = (await s.b.db.replacedVersions.toArray()).find((r) => r.type === CALENDAR_BLOCKS && r.id === s.spare)!;
    if (archived.entry.deleted) throw new Error("expected a record version");
    await deleteOnB(s.b, s.spare);
    return { ...s, archived: archived.replacedId, data: archived.entry.envelope.data };
  }

  it("a deleted block whose archived versions name different tasks: no version is restored, and every version stays", async () => {
    const s = await deletedWithArchive();
    const other = await archiveForOtherTask(s.b, s.spare, s.data, s.read);
    const before = await snapshot(s.b.db);
    for (const replacedId of [s.archived, other]) {
      expect(await codeOf(restoreReplacedVersion(s.b.db, registry, replacedId))).toBe("INCONSISTENT_HISTORY");
      expect(await snapshot(s.b.db)).toEqual(before);
    }
    expect(await s.b.db.records.get([CALENDAR_BLOCKS, s.spare])).toBeUndefined();
    expect(await s.b.db.tombstones.get([CALENDAR_BLOCKS, s.spare])).toBeDefined();
    expect(await s.b.db.replacedVersions.where("[type+id]").equals([CALENDAR_BLOCKS, s.spare]).count()).toBe(2);
  });

  it("control: a deleted block whose archived versions agree is restored with its own task", async () => {
    const s = await deletedWithArchive();
    expect(await codeOf(restoreReplacedVersion(s.b.db, registry, s.archived))).toBe("OK");
    expect((await blockOf(s.b, s.spare)).taskId).toBe(s.write);
  });

  /** B deleted the spare block; A edited it, so B's import holds a pending "deleted here" decision. */
  async function deletedWithPendingRestore() {
    const s = await spareBlock();
    await deleteOnB(s.b, s.spare);
    await updateBlock(s.a.db, s.spare, { date: "2026-11-03", startTime: "10:00", durationMinutes: 30 });
    await importInto(s.b, await exportText(s.a), product);
    const [view] = await loadConflictViews(s.b.db, registry);
    expect(view!.conflict.type).toBe(CALENDAR_BLOCKS);
    expect(view!.options).toEqual(["restore", "keepDeleted"]);
    const incoming = view!.conflict.incoming;
    if (incoming.deleted) throw new Error("expected a record version");
    return { ...s, conflictId: view!.conflict.conflictId, data: incoming.envelope.data };
  }

  it("a pending restore of a deleted block whose archive names another task is refused; it can stay deleted", async () => {
    const s = await deletedWithPendingRestore();
    await archiveForOtherTask(s.b, s.spare, s.data, s.read);
    const before = await snapshot(s.b.db);
    expect(await codeOf(decide(s.b.db, s.conflictId, "restore", registry))).toBe("INCONSISTENT_HISTORY");
    expect(await snapshot(s.b.db)).toEqual(before);
    expect(await s.b.db.records.get([CALENDAR_BLOCKS, s.spare])).toBeUndefined();
    expect(await codeOf(decide(s.b.db, s.conflictId, "keepDeleted", registry))).toBe("OK");
    expect(await s.b.db.replacedVersions.where("[type+id]").equals([CALENDAR_BLOCKS, s.spare]).count()).toBe(2); // the other task's version and the backup's
  });

  it("control: the same pending restore with a consistent history brings the block back with its own task", async () => {
    const s = await deletedWithPendingRestore();
    expect(await codeOf(decide(s.b.db, s.conflictId, "restore", registry))).toBe("OK");
    expect((await blockOf(s.b, s.spare)).taskId).toBe(s.write);
  });
});
