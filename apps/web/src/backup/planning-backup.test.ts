/**
 * Stage 3 data in backups (docs/TESTING.md "Stage 3 acceptance tests" 21–24; BACKUP_FORMAT
 * "Data schema version 3"): blocks, recurrence, and capacity round-trip and merge; Stage 2 data is
 * upgraded without any change; every version in a file is validated against its own version.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTask, loadOrganization, setArchived, updateTask } from "../local/organization.ts";
import { createBlock, loadBlocks, setBlockCancelled, setRecurrence, updateBlock } from "../local/planning.ts";
import { deleteRecord } from "../local/records.ts";
import { updateSharedPreferences } from "../local/settings.ts";
import { isOccurrenceScheduled } from "../planning/planning.ts";
import { loadConflictViews, resolveConflict } from "./conflicts.ts";
import { contentHashOf, makeEnvelope, nowIso } from "./envelope.ts";
import { SHARED_PREFERENCES_ID } from "./limits.ts";
import { openBackupFile } from "./read.ts";
import { CALENDAR_BLOCKS, PRODUCT_REGISTRY, type Recurrence, TASK_DEFINITIONS } from "./registry.ts";
import { createTestDevice, type TestDevice } from "./test-fixtures.ts";
import { blobOf, decide, exportFrom, importInto, mutate, snapshot } from "./test-helpers.ts";

const registry = PRODUCT_REGISTRY;
const product = { registry };
const devices: TestDevice[] = [];
async function device(label: string, zone: string | null = "Asia/Tehran") {
  const d = await createTestDevice(label);
  devices.push(d);
  if (zone) await updateSharedPreferences(d.db, { timeZone: zone });
  return d;
}
afterEach(() => {
  for (const d of devices.splice(0)) d.db.close();
});

const exportText = async (d: TestDevice) => (await exportFrom(d, {}, registry)).text;
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
const weekly = (weekdays: number[], startDate: string): Recurrence => ({ kind: "weekdays", weekdays, startDate, endDate: null });

const recordsOf = async (d: TestDevice) =>
  (await d.db.records.toArray())
    .map((r) => ({ type: r.type, id: r.id, contentHash: r.contentHash, version: r.version, data: r.data }))
    .sort((a, b) => `${a.type}/${a.id}`.localeCompare(`${b.type}/${b.id}`));

/** A device with a recurring task scheduled by two blocks, a plain task with a block, and capacity. */
async function plannedDevice(label = "A") {
  const d = await device(label);
  await updateSharedPreferences(d.db, { dailyCapacityMinutes: 300 });
  const gym = await createTask(d.db, { title: "Gym", estimateMinutes: 45 });
  await setRecurrence(d.db, gym, weekly([1, 2], "2026-11-01"));
  const plain = await createTask(d.db, { title: "Write" });
  const morning = await createBlock(d.db, { taskId: gym, date: "2026-11-02", startTime: "07:00", durationMinutes: 20, occurrenceDate: "2026-11-02" });
  const evening = await createBlock(d.db, { taskId: gym, date: "2026-11-02", startTime: "19:00", durationMinutes: 25, occurrenceDate: "2026-11-02" });
  const write = await createBlock(d.db, { taskId: plain, date: "2026-11-02", startTime: "09:00", durationMinutes: 90 });
  return { d, gym, plain, morning, evening, write };
}

describe("21. round-trip and merge of blocks, recurrence, and capacity", () => {
  it("an empty device receives everything with identical IDs, hashes, and versions (written as dataSchemaVersion 5 since the Stage 3 follow-up)", async () => {
    const a = await plannedDevice();
    const text = await exportText(a.d);
    const doc = JSON.parse(text);
    expect(doc.app.dataSchemaVersion).toBe(5);
    expect(doc.payload.records[CALENDAR_BLOCKS]).toHaveLength(3);
    const b = await device("B", null);
    const { preview } = await importInto(b, text, { ...product, applyUpdates: true });
    expect(preview.counts.new).toBe(5); // 2 tasks, 3 blocks (preferences: newer in backup)
    expect(preview.counts.newerInBackup).toBe(1);
    expect(await recordsOf(b)).toEqual(await recordsOf(a.d));
  });

  it("re-import is idempotent; an older copy keeps local edits; a block changed elsewhere needs confirmation", async () => {
    const a = await plannedDevice();
    const b = await device("B", null);
    const first = await exportText(a.d);
    await importInto(b, first, { ...product, applyUpdates: true });
    const before = await snapshot(b.db);
    const again = await importInto(b, first, product);
    expect(again.preview.counts.new).toBe(0);
    expect(await snapshot(b.db)).toEqual(before);

    await updateBlock(b.db, a.write, { date: "2026-11-02", startTime: "10:00", durationMinutes: 90 });
    expect((await importInto(b, first, product)).preview.counts.olderCopy).toBe(1);

    await updateBlock(a.d.db, a.morning, { date: "2026-11-02", startTime: "06:30", durationMinutes: 30 });
    const newer = await exportText(a.d);
    const pending = await importInto(b, newer, product);
    expect(pending.preview.counts.newerInBackup).toBe(1);
    expect((await b.db.records.get([CALENDAR_BLOCKS, a.morning]))!.data.startsAt).toBe("2026-11-02T03:30:00.000Z"); // 07:00 Tehran, unchanged
    await importInto(b, newer, { ...product, applyUpdates: true });
    expect((await b.db.records.get([CALENDAR_BLOCKS, a.morning]))!.data.startsAt).toBe("2026-11-02T03:00:00.000Z");
  });

  it("a block moved on both devices is a conflict with keep/use only; cancelling one of two blocks keeps the occurrence scheduled", async () => {
    const a = await plannedDevice();
    const b = await device("B", null);
    await importInto(b, await exportText(a.d), { ...product, applyUpdates: true });
    await setBlockCancelled(a.d.db, a.morning, true); // A cancels one of the two Gym blocks
    await updateBlock(b.db, a.morning, { date: "2026-11-02", startTime: "08:00", durationMinutes: 20 }); // B moves it
    await importInto(b, await exportText(a.d), product);
    const [view] = await loadConflictViews(b.db, registry);
    expect(view!.conflict).toMatchObject({ type: CALENDAR_BLOCKS, id: a.morning, kind: "edit" });
    expect(view!.options).toEqual(["keepDevice", "useBackup"]);
    await decide(b.db, view!.conflict.conflictId, "useBackup", registry);
    const blocks = await loadBlocks(b.db);
    expect(blocks.find((x) => x.id === a.morning)!.data.status).toBe("cancelled");
    expect(isOccurrenceScheduled(blocks, a.gym, "2026-11-02")).toBe(true); // the evening block is still planned (D-023)
  });

  it("importing preferences with another time zone changes no block and no occurrenceDate", async () => {
    const a = await plannedDevice();
    const b = await device("B", null);
    await importInto(b, await exportText(a.d), { ...product, applyUpdates: true });
    const blocksBefore = await b.db.records.where("type").equals(CALENDAR_BLOCKS).toArray();
    await updateSharedPreferences(a.d.db, { timeZone: "Asia/Tokyo" });
    await importInto(b, await exportText(a.d), { ...product, applyUpdates: true });
    expect((await b.db.records.get(["preferences", SHARED_PREFERENCES_ID]))!.data.timeZone).toBe("Asia/Tokyo");
    expect(await b.db.records.where("type").equals(CALENDAR_BLOCKS).toArray()).toEqual(blocksBefore);
  });

  it("deletions: a task with live blocks cannot be deleted by a conflict choice; a deleted block becomes a decision", async () => {
    const a = await plannedDevice();
    const b = await device("B", null);
    await importInto(b, await exportText(a.d), { ...product, applyUpdates: true });
    await deleteRecord(a.d.db, CALENDAR_BLOCKS, a.write); // only possible through backup data / earlier choices
    await deleteRecord(a.d.db, TASK_DEFINITIONS, a.gym);
    await importInto(b, await exportText(a.d), product);
    const views = await loadConflictViews(b.db, registry);
    expect(views.map((v) => [v.conflict.type, v.conflict.kind]).sort()).toEqual([
      [CALENDAR_BLOCKS, "deletedInBackup"],
      [TASK_DEFINITIONS, "deletedInBackup"],
    ]);
    const taskView = views.find((v) => v.conflict.type === TASK_DEFINITIONS)!;
    const before = await snapshot(b.db);
    await expect(resolveConflict(b.db, registry, taskView.conflict.conflictId, "deleteHere", taskView.token)).rejects.toMatchObject({ code: "HAS_LINKED_ITEMS" });
    expect(await snapshot(b.db)).toEqual(before);
    const blockView = views.find((v) => v.conflict.type === CALENDAR_BLOCKS)!;
    await decide(b.db, blockView.conflict.conflictId, "deleteHere", registry);
    expect(await b.db.records.get([CALENDAR_BLOCKS, a.write])).toBeUndefined();
  });
});

describe("22. upgrade from Stage 2 without loss", () => {
  it("Stage 2 records are byte-identical under the Stage 3 app; re-importing a Stage 2 backup is 'already here'", async () => {
    const sample = readFileSync(new URL("./samples/pps-backup-format-v1-data-v2.json", import.meta.url), "utf8");
    const d = await device("Upgraded", null);
    await importInto(d, sample, { ...product, applyUpdates: true });
    const before = await recordsOf(d);
    // Stage 3 code reads and edits nothing unless asked; recurrence and capacity stay absent.
    for (const r of before) {
      expect("recurrence" in r.data).toBe(false);
      expect("dailyCapacityMinutes" in r.data).toBe(false);
      expect(contentHashOf(r.data)).toBe(r.contentHash);
    }
    await d.restart();
    expect(await recordsOf(d)).toEqual(before);
    const exported = await exportText(d);
    const target = await device("Holds Stage 2 backup", null);
    await importInto(target, sample, { ...product, applyUpdates: true });
    const { preview } = await importInto(target, exported, product);
    expect(preview.counts.conflict).toBe(0);
    expect(preview.counts.new).toBe(0);
    expect(preview.counts.alreadyHere).toBe(before.length);
  });

  it("an edit that leaves recurrence and capacity off keeps them absent (never null)", async () => {
    const d = await device("D");
    const task = await createTask(d.db, { title: "Plain" });
    await updateTask(d.db, task, { title: "Plain 2", recurrence: null });
    await setArchived(d.db, TASK_DEFINITIONS, task, true);
    await updateSharedPreferences(d.db, { weekStart: 1, dailyCapacityMinutes: null });
    const doc = JSON.parse(await exportText(d));
    expect(doc.payload.records[TASK_DEFINITIONS][0].data).not.toHaveProperty("recurrence");
    expect(doc.payload.records.preferences[0].data).not.toHaveProperty("dailyCapacityMinutes");
  });
});

describe("23. versioning and per-version fields", () => {
  const v1Sample = new URL("./samples/pps-backup-format-v1.json", import.meta.url);
  const v2Sample = new URL("./samples/pps-backup-format-v1-data-v2.json", import.meta.url);
  const v3Sample = new URL("./samples/pps-backup-format-v1-data-v3.json", import.meta.url);

  it("the committed version-1 and version-2 samples import unchanged", async () => {
    const b = await device("B", null);
    expect((await importInto(b, readFileSync(v1Sample, "utf8"), { ...product, applyUpdates: true })).preview.counts.newerInBackup).toBe(1);
    await importInto(b, readFileSync(v2Sample, "utf8"), product);
    expect((await loadOrganization(b.db)).tasks.map((t) => t.data.title).sort()).toEqual(
      ["Sample inbox item", "Sample task directly in the project", "Sample task in a workstream"].sort(),
    );
  });

  it("a version-2 file with recurrence, capacity, or blocks is refused with no change; version 6 is refused as newer", async () => {
    const a = await plannedDevice();
    const text = await exportText(a.d);
    const b = await device("B", null);
    const before = await snapshot(b.db);
    const asV2 = (change: (doc: any) => void) => mutate(text, (doc) => {
      doc.app.dataSchemaVersion = 2;
      change(doc);
    });
    const withoutBlocks = (doc: any) => delete doc.payload.records[CALENDAR_BLOCKS];
    const plainTasks = (doc: any) => {
      for (const env of doc.payload.records[TASK_DEFINITIONS]) {
        delete env.data.recurrence;
        env.contentHash = contentHashOf(env.data);
      }
    };
    const plainPrefs = (doc: any) => {
      const env = doc.payload.records.preferences[0];
      delete env.data.dailyCapacityMinutes;
      env.contentHash = contentHashOf(env.data);
    };
    expect(await codeOf(importInto(b, asV2((doc) => (plainTasks(doc), plainPrefs(doc))), product))).toBe("UNKNOWN_RECORD_TYPE");
    expect(await codeOf(importInto(b, asV2((doc) => (withoutBlocks(doc), plainPrefs(doc))), product))).toBe("INVALID_PAYLOAD");
    expect(await codeOf(importInto(b, asV2((doc) => (withoutBlocks(doc), plainTasks(doc))), product))).toBe("INVALID_PAYLOAD");
    expect(await codeOf(importInto(b, asV2((doc) => (withoutBlocks(doc), plainTasks(doc), plainPrefs(doc))), product))).toBe("OK");
    const newer = mutate(text, (doc) => (doc.app.dataSchemaVersion = 6));
    await expect(openBackupFile(blobOf(newer), registry)).rejects.toMatchObject({ code: "NEWER_VERSION" });
    const b2 = await device("B2", null);
    expect(await snapshot(b2.db)).toEqual(before);
  });

  it("null for the optional new fields is refused", async () => {
    const a = await plannedDevice();
    const text = await exportText(a.d);
    const b = await device("B", null);
    const before = await snapshot(b.db);
    const nullTask = mutate(text, (doc) => {
      const env = doc.payload.records[TASK_DEFINITIONS][0];
      env.data.recurrence = null;
      env.contentHash = contentHashOf(env.data);
    });
    const nullCapacity = mutate(text, (doc) => {
      const env = doc.payload.records.preferences[0];
      env.data.dailyCapacityMinutes = null;
      env.contentHash = contentHashOf(env.data);
    });
    expect(await codeOf(importInto(b, nullTask, product))).toBe("INVALID_PAYLOAD");
    expect(await codeOf(importInto(b, nullCapacity, product))).toBe("INVALID_PAYLOAD");
    expect(await snapshot(b.db)).toEqual(before);
  });

  it("writes the dataSchemaVersion-3 sample when PPS_WRITE_SAMPLE=1 (maintainers only)", async () => {
    if (process.env.PPS_WRITE_SAMPLE !== "1") return;
    const d = await device("Sample device");
    await updateSharedPreferences(d.db, { dailyCapacityMinutes: 240 });
    const recurring = await createTask(d.db, { title: "Sample recurring task", estimateMinutes: 30 });
    await setRecurrence(d.db, recurring, { kind: "weekdays", weekdays: [1, 3], startDate: "2026-11-02", endDate: "2026-12-31" });
    const plain = await createTask(d.db, { title: "Sample task without recurrence" });
    await createBlock(d.db, { taskId: recurring, date: "2026-11-02", startTime: "08:00", durationMinutes: 30, occurrenceDate: "2026-11-02" });
    await createBlock(d.db, { taskId: plain, date: "2026-11-03", startTime: "10:00", durationMinutes: 60 });
    const cancelled = await createBlock(d.db, { taskId: plain, date: "2026-11-04", startTime: "14:00", durationMinutes: 45 });
    await setBlockCancelled(d.db, cancelled, true);
    const file = await exportFrom(d, { now: new Date("2026-10-24T08:00:00.000Z"), backupId: "33333333-3333-4333-8333-333333333333" }, registry);
    writeFileSync(v3Sample, `${file.text}\n`);
  });

  it("the committed dataSchemaVersion-3 sample imports (fabricated data only)", async () => {
    const text = readFileSync(v3Sample, "utf8");
    const doc = JSON.parse(text);
    expect(doc.app.dataSchemaVersion).toBe(3);
    const b = await device("B", null);
    await importInto(b, text, { ...product, applyUpdates: true });
    const blocks = await loadBlocks(b.db);
    expect(blocks.map((x) => x.data.status).sort()).toEqual(["cancelled", "planned", "planned"]);
    expect(blocks.filter((x) => x.data.occurrenceDate !== null)).toHaveLength(1);
    const tasks = (await loadOrganization(b.db)).tasks;
    expect(tasks.filter((t) => t.data.recurrence)).toHaveLength(1);
    expect((await b.db.records.get(["preferences", SHARED_PREFERENCES_ID]))!.data.dailyCapacityMinutes).toBe(240);
  });
});

describe("24. every block version in a file is validated (records, carried conflicts, archive)", () => {
  async function fileWithBlock() {
    const a = await plannedDevice();
    const text = await exportText(a.d);
    const b = await device("B", null);
    return { a, text, b, before: await snapshot(b.db) };
  }
  const withBlock = (text: string, id: string, change: (data: Record<string, any>) => void) =>
    mutate(text, (doc) => {
      const env = doc.payload.records[CALENDAR_BLOCKS].find((e: { id: string }) => e.id === id);
      change(env.data);
      env.contentHash = contentHashOf(env.data);
    });

  it("bad times, wrong localDate, unknown zone, inconsistent snapshot, unknown task", async () => {
    const s = await fileWithBlock();
    const cases: [string, string][] = [
      [withBlock(s.text, s.a.write, (d) => (d.endsAt = d.startsAt)), "INVALID_PAYLOAD"],
      [withBlock(s.text, s.a.write, (d) => (d.startsAt = "2026-11-02T05:30:15.000Z")), "INVALID_PAYLOAD"],
      [withBlock(s.text, s.a.write, (d) => (d.endsAt = "2026-11-04T06:00:00.000Z")), "INVALID_PAYLOAD"],
      [withBlock(s.text, s.a.write, (d) => (d.localDate = "2026-11-01")), "INVALID_PAYLOAD"],
      [withBlock(s.text, s.a.write, (d) => (d.timeZone = "Mars/Olympus")), "INVALID_PAYLOAD"],
      [withBlock(s.text, s.a.write, (d) => (d.snapshot.projectName = "Ghost")), "INVALID_PAYLOAD"],
      [withBlock(s.text, s.a.write, (d) => (d.status = "done")), "INVALID_PAYLOAD"],
      [withBlock(s.text, s.a.write, (d) => (d.actualMinutes = 30)), "INVALID_PAYLOAD"],
      [withBlock(s.text, s.a.write, (d) => (d.taskId = crypto.randomUUID())), "UNRESOLVED_REFERENCE"],
    ];
    for (const [file, expected] of cases) expect(await codeOf(importInto(s.b, file, product)), expected).toBe(expected);
    expect(await snapshot(s.b.db)).toEqual(s.before);
  });

  it("the same checks apply to carried conflict and archived versions", async () => {
    const s = await fileWithBlock();
    const original = (await s.a.d.db.records.get([CALENDAR_BLOCKS, s.a.write]))!.data;
    const bad = { ...original, localDate: "2026-11-05" };
    const entry = { deleted: false, envelope: makeEnvelope(s.a.write, bad, { [crypto.randomUUID()]: 9 }, nowIso()) };
    const inArchive = mutate(s.text, (doc) => {
      doc.payload.replacedVersions.push({ replacedId: crypto.randomUUID(), type: CALENDAR_BLOCKS, id: s.a.write, entry, replacedAt: nowIso(), reason: "x" });
    });
    const inConflict = mutate(s.text, (doc) => {
      doc.payload.pendingConflicts.push({
        conflictId: crypto.randomUUID(),
        kind: "edit",
        type: CALENDAR_BLOCKS,
        id: s.a.write,
        local: null,
        incoming: entry,
        source: { backupId: crypto.randomUUID(), deviceId: crypto.randomUUID(), deviceName: "X", exportedAt: nowIso() },
        detectedAt: nowIso(),
      });
    });
    const orphanArchive = mutate(s.text, (doc) => {
      const ok = { deleted: false, envelope: makeEnvelope(crypto.randomUUID(), { ...original, taskId: crypto.randomUUID() }, { [crypto.randomUUID()]: 1 }, nowIso()) };
      doc.payload.replacedVersions.push({ replacedId: crypto.randomUUID(), type: CALENDAR_BLOCKS, id: ok.envelope.id, entry: ok, replacedAt: nowIso(), reason: "x" });
    });
    expect(await codeOf(importInto(s.b, inArchive, product))).toBe("INVALID_PAYLOAD");
    expect(await codeOf(importInto(s.b, inConflict, product))).toBe("INVALID_PAYLOAD");
    expect(await codeOf(importInto(s.b, orphanArchive, product))).toBe("UNRESOLVED_REFERENCE");
    expect(await snapshot(s.b.db)).toEqual(s.before);
  });
});
