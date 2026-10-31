/**
 * Stage 5 data in backups (docs/TESTING.md "Stage 5 acceptance tests" 7–10a; BACKUP_FORMAT "Data
 * schema version 6"; DECISIONS T-109, T-113, T-115, T-119, T-144, T-146, T-152, T-160, T-161).
 * Backups are plain files, so the same file moves between Windows and Android; an encrypted
 * round-trip is included.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createGoal } from "../local/goals.ts";
import { createTask } from "../local/organization.ts";
import { createBlock } from "../local/planning.ts";
import { putRecord } from "../local/records.ts";
import { updateSharedPreferences } from "../local/settings.ts";
import {
  completeTask,
  correctSessionTimes,
  createOutputDefinition,
  deleteOutput,
  deleteSession,
  endSession,
  loadWork,
  pauseSession,
  purgeTrash,
  recordPastSession,
  resumeSession,
  setTaskGoals,
  setTaskSuggestedDefinitions,
  startSession,
} from "../local/work.ts";
import { sessionState, workMinutes } from "../work/session-time.ts";
import { DATA_SCHEMA_VERSION } from "./limits.ts";
import {
  CALENDAR_BLOCKS,
  CORRECTIONS,
  GOALS,
  OUTPUT_DEFINITIONS,
  OUTPUT_RECORDS,
  PRODUCT_REGISTRY,
  type SessionData,
  SESSIONS,
  TASK_COMPLETIONS,
  TASK_DEFINITIONS,
} from "./registry.ts";
import { createTestDevice, type TestDevice } from "./test-fixtures.ts";
import { exportFrom, importInto, mutate } from "./test-helpers.ts";

const registry = PRODUCT_REGISTRY;
const product = { registry };
const devices: TestDevice[] = [];
/** A test device; `.d` refers to the device itself, matching the shape `workDevice` returns. */
async function device(label: string): Promise<TestDevice & { d: TestDevice }> {
  const d = await createTestDevice(label);
  devices.push(d);
  await updateSharedPreferences(d.db, { timeZone: "Asia/Tehran" });
  return Object.assign(d, { d });
}
afterEach(() => {
  for (const d of devices.splice(0)) d.db.close();
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-02T06:00:00Z");
const exportText = async (d: TestDevice, options: { password?: string; now?: Date } = {}) => (await exportFrom(d, options, registry)).text;
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
const recordsOf = async (d: TestDevice) =>
  (await d.db.records.toArray())
    .map((r) => ({ type: r.type, id: r.id, contentHash: r.contentHash, version: r.version, data: r.data }))
    .sort((a, b) => `${a.type}/${a.id}`.localeCompare(`${b.type}/${b.id}`));
const sessionOf = async (d: TestDevice, id: string) => (await d.db.records.get([SESSIONS, id]))!.data as SessionData;

/** Every Stage 5 type and field: definitions, sessions (paused, taskless, deleted), outputs (0, deleted), corrections, completions, links, expected amounts. */
async function workDevice(label = "A") {
  const d = await device(label);
  const pages = await createOutputDefinition(d.db, { name: "Pages", unit: "pages" });
  const words = await createOutputDefinition(d.db, { name: "Words", unit: "words" });
  const study = await createGoal(d.db, { name: "Study", startDate: "2026-10-01", kind: "time", target: 600 });
  const book = await createGoal(d.db, { name: "Book", startDate: "2026-10-01", kind: "output", target: 300, definitionId: pages });
  const count = await createGoal(d.db, { name: "Done", startDate: "2026-10-01", kind: "taskCount", target: 5 });
  const task = await createTask(d.db, { title: "Write" });
  const plain = await createTask(d.db, { title: "Plain" });
  await setTaskGoals(d.db, task, [study, book, count]);
  await setTaskSuggestedDefinitions(d.db, task, [pages]);
  const block = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "10:00", durationMinutes: 60 });
  const blockRow = (await d.db.records.get([CALENDAR_BLOCKS, block]))!;
  await putRecord(d.db, registry, CALENDAR_BLOCKS, block, { ...blockRow.data, expectedOutputs: [{ definitionId: words, amount: 0 }] });
  const session = await startSession(d.db, { blockId: block }, T0);
  await pauseSession(d.db, session, T0 + 20 * MIN);
  await resumeSession(d.db, session, T0 + 30 * MIN);
  await endSession(d.db, session, { goalId: study, outputs: [{ definitionId: pages, value: 12, goalIds: [book] }, { definitionId: words, value: 0 }], energy: 3, focus: 4, notes: "ok" }, T0 + HOUR);
  const taskless = await recordPastSession(d.db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 30 }, T0);
  await correctSessionTimes(d.db, taskless, { startedAt: "2026-11-01T04:30:00.000Z", endedAt: "2026-11-01T05:15:00.000Z" }, "typo", T0);
  const deleted = await recordPastSession(d.db, { date: "2026-10-31", startTime: "08:00", durationMinutes: 30 }, T0);
  await deleteSession(d.db, deleted, T0);
  const work = await loadWork(d.db);
  const zero = work.outputs.find((o) => o.data.value === 0)!.id;
  await deleteOutput(d.db, zero, null, T0);
  await completeTask(d.db, task, { goalId: count }, T0);
  return { d, pages, words, study, book, count, task, plain, block, session, taskless, deleted, zero };
}

describe("10. backup version 6 (T-109, T-146)", () => {
  it("round-trips with identical IDs, hashes, and versions; new types carry null, fields added to existing types are omitted", async () => {
    const a = await workDevice();
    const text = await exportText(a.d);
    const doc = JSON.parse(text);
    expect(doc.app.dataSchemaVersion).toBe(7);
    expect(DATA_SCHEMA_VERSION).toBe(7);
    for (const type of [SESSIONS, OUTPUT_DEFINITIONS, OUTPUT_RECORDS, CORRECTIONS, TASK_COMPLETIONS]) expect(doc.payload.records[type]?.length).toBeGreaterThan(0);
    const taskless = doc.payload.records[SESSIONS].find((e: { id: string }) => e.id === a.taskless).data;
    expect(taskless).toMatchObject({ taskId: null, blockId: null, snapshot: null, goalId: null, energy: null, focus: null, deletedAt: null });
    const plain = doc.payload.records[TASK_DEFINITIONS].find((e: { id: string }) => e.id === a.plain).data;
    expect(plain).not.toHaveProperty("goalIds");
    expect(plain).not.toHaveProperty("outputDefinitionIds");
    const book = doc.payload.records[GOALS].find((e: { id: string }) => e.id === a.book).data;
    expect(book).not.toHaveProperty("unit");

    const b = await device("B");
    const { result } = await importInto(b, text, product);
    expect(result.counts.conflict).toBe(0);
    const sent = (await recordsOf(a.d)).filter((r) => r.type !== "preferences");
    const received = (await recordsOf(b.d)).filter((r) => r.type !== "preferences");
    expect(received).toEqual(sent);
  });

  it("an encrypted version-6 file round-trips the same way (the file moves between Windows and Android unchanged)", async () => {
    const a = await workDevice();
    const text = await exportText(a.d, { password: "correct horse battery" });
    const b = await device("B");
    await importInto(b, text, { ...product, password: "correct horse battery" });
    expect((await recordsOf(b.d)).filter((r) => r.type !== "preferences")).toEqual((await recordsOf(a.d)).filter((r) => r.type !== "preferences"));
  });

  it("version-5 data is unchanged: a re-import of a version-5 backup is 'already here'; a version-5 file with version-6 data is refused; a newer version is refused", async () => {
    const b = await device("B");
    const v5 = readFileSync(new URL("./samples/pps-backup-format-v1-data-v5.json", import.meta.url), "utf8");
    await importInto(b, v5, product);
    const before = await recordsOf(b.d);
    const again = await importInto(b, v5, product);
    expect(again.result.counts.new).toBe(0);
    expect(await recordsOf(b.d)).toEqual(before);
    // Exported by this app, the same records keep their hashes and versions (identity upgrade).
    const c = await device("C");
    await importInto(c, await exportText(b), product);
    expect((await recordsOf(c.d)).filter((r) => r.type !== "preferences")).toEqual(before.filter((r) => r.type !== "preferences"));

    const a = await workDevice();
    const text = await exportText(a.d);
    expect(await codeOf(importInto(b, mutate(text, (doc) => (doc.app.dataSchemaVersion = 5)), product))).toBe("INVALID_PAYLOAD"); // task goalIds come first
    const onlyNewTypes = mutate(text, (doc) => {
      doc.app.dataSchemaVersion = 5;
      for (const type of [TASK_DEFINITIONS, GOALS, CALENDAR_BLOCKS]) delete doc.payload.records[type];
    });
    expect(await codeOf(importInto(b, onlyNewTypes, product))).toBe("UNKNOWN_RECORD_TYPE"); // a session in a version-5 file
    const onlyNewFields = mutate(text, (doc) => {
      doc.app.dataSchemaVersion = 5;
      for (const type of [SESSIONS, OUTPUT_DEFINITIONS, OUTPUT_RECORDS, CORRECTIONS, TASK_COMPLETIONS, GOALS, CALENDAR_BLOCKS]) delete doc.payload.records[type];
      doc.payload.tombstones = [];
    });
    expect(await codeOf(importInto(b, onlyNewFields, product))).toBe("INVALID_PAYLOAD"); // task goalIds in a version-5 file
    expect(await codeOf(importInto(b, mutate(text, (doc) => (doc.app.dataSchemaVersion = 8)), product))).toBe("NEWER_VERSION");
    expect(await recordsOf(b.d)).toEqual(before);
  });

  it("the committed samples of versions 1 to 5 import", async () => {
    for (const name of ["pps-backup-format-v1.json", "pps-backup-format-v1-data-v2.json", "pps-backup-format-v1-data-v3.json", "pps-backup-format-v1-data-v4.json", "pps-backup-format-v1-data-v5.json"]) {
      const b = await device(`B ${name}`);
      expect(await codeOf(importInto(b, readFileSync(new URL(`./samples/${name}`, import.meta.url), "utf8"), product))).toBe("OK");
    }
  });

  const v6Sample = new URL("./samples/pps-backup-format-v1-data-v6.json", import.meta.url);

  it("writes the dataSchemaVersion-6 sample when PPS_WRITE_SAMPLE=1 (maintainers only)", async () => {
    // The app writes its current version; this sample stays the committed version-6 file.
    if (process.env.PPS_WRITE_SAMPLE !== "1" || (DATA_SCHEMA_VERSION as number) !== 6) return;
    const a = await workDevice("Sample device");
    const file = await exportFrom(a.d, { now: new Date("2026-11-03T08:00:00Z"), backupId: "6b7f9a3c-2d14-4e8b-9f61-0c5a7d3e2b18" }, registry);
    writeFileSync(v6Sample, `${file.text}\n`);
  });

  it("the committed dataSchemaVersion-6 sample imports (fabricated data only)", async () => {
    const text = readFileSync(v6Sample, "utf8");
    expect(JSON.parse(text).app.dataSchemaVersion).toBe(6);
    const b = await device("B");
    expect(await codeOf(importInto(b, text, product))).toBe("OK");
    const work = await loadWork(b.db);
    expect(work.sessions.length).toBeGreaterThanOrEqual(3);
    expect(work.corrections.length).toBeGreaterThan(0);
  });
});

describe("7, 9. history and deletion travel in backups (T-113, T-115, T-160)", () => {
  it("imported corrections are appended; a deletion and restore merge as edits", async () => {
    const a = await workDevice();
    const b = await device("B");
    await importInto(b, await exportText(a.d), product);
    await correctSessionTimes(a.d.db, a.session, { startedAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 50 * MIN).toISOString() }, "late start", T0 + 2 * HOUR);
    await deleteSession(a.d.db, a.taskless, T0 + 2 * HOUR);
    const { preview } = await importInto(b, await exportText(a.d), { ...product, applyUpdates: true });
    const byId = new Map(preview.items.map((i) => [`${i.type}/${i.id}`, i.category]));
    expect(byId.get(`${SESSIONS}/${a.session}`)).toBe("newerInBackup");
    expect([...byId.entries()].filter(([k, c]) => k.startsWith(CORRECTIONS) && c === "new")).toHaveLength(1);
    expect((await sessionOf(b, a.taskless)).deletedAt).not.toBeNull();
    expect((await loadWork(b.db)).corrections.filter((c) => c.data.reason === "late start")).toHaveLength(1);
  });

  it("after the trash is emptied, an older backup is an 'older copy' and brings nothing back; the tombstones travel", async () => {
    const a = await workDevice();
    const old = await exportText(a.d);
    await deleteSession(a.d.db, a.session, T0 + HOUR);
    await purgeTrash(a.d.db, { emptyNow: true, now: T0 + HOUR });
    expect(await a.d.db.records.get([SESSIONS, a.session])).toBeUndefined();
    const { result } = await importInto(a.d, old, product);
    expect(result.counts.new).toBe(0);
    expect(await a.d.db.records.get([SESSIONS, a.session])).toBeUndefined();
    const doc = JSON.parse(await exportText(a.d));
    expect(doc.payload.tombstones.map((t: { type: string }) => t.type)).toEqual(expect.arrayContaining([SESSIONS, OUTPUT_RECORDS]));
  });
});

describe("8a. the same completion made on two devices is one record (T-119)", () => {
  it("both devices complete the same one-off task: one record ID, counted once", async () => {
    const a = await workDevice();
    const b = await device("B");
    await importInto(b, await exportText(a.d), product);
    const other = await createTask(a.d.db, { title: "Both" });
    await importInto(b, await exportText(a.d), product);
    await completeTask(a.d.db, other, {}, T0);
    await completeTask(b.d.db, other, {}, T0 + MIN);
    await importInto(a.d, await exportText(b), product);
    const completions = (await loadWork(a.d.db)).completions.filter((c) => c.data.taskId === other);
    expect(completions).toHaveLength(1);
  });
});

describe("10a. open sessions in backups (T-144, T-152)", () => {
  it("a running session arrives paused from the backup's creation time; its timer does not run; a paused one stays paused", async () => {
    const a = await device("A");
    const running = await startSession(a.d.db, {}, T0);
    const exportedAt = new Date(T0 + HOUR);
    const text = await exportText(a, { now: exportedAt });
    const b = await device("B");
    await importInto(b, text, product);
    const work = await loadWork(b.db);
    const state = sessionState(work.sessions[0]!.data, work.importedPaused[running]);
    expect(state).toEqual({ kind: "paused", since: exportedAt.getTime(), imported: true });
    // Resuming later writes the pause from the backup's creation time: no work time is invented.
    await resumeSession(b.d.db, running, T0 + 5 * HOUR);
    await endSession(b.d.db, running, {}, T0 + 6 * HOUR);
    expect(workMinutes(await sessionOf(b, running))).toBe(120);
    expect((await loadWork(b.db)).importedPaused).toEqual({});

    const c = await device("C");
    const paused = await startSession(c.d.db, {}, T0);
    await pauseSession(c.d.db, paused, T0 + 10 * MIN);
    const d = await device("D");
    await importInto(d, await exportText(c, { now: new Date(T0 + HOUR) }), product);
    const dWork = await loadWork(d.db);
    expect(sessionState(dWork.sessions[0]!.data, dWork.importedPaused[paused])).toEqual({ kind: "paused", since: T0 + 10 * MIN, imported: false });
  });

  it("with an open session already here, the user must end or delete one before any session starts or resumes", async () => {
    const a = await device("A");
    await startSession(a.d.db, {}, T0);
    const text = await exportText(a, { now: new Date(T0 + HOUR) });
    const b = await device("B");
    const mine = await startSession(b.d.db, {}, T0 + 10 * MIN);
    await pauseSession(b.d.db, mine, T0 + 20 * MIN);
    await importInto(b, text, product);
    const theirs = (await loadWork(b.db)).sessions.find((s) => s.id !== mine)!.id;
    expect(await codeOf(startSession(b.d.db, {}, T0 + 2 * HOUR))).toBe("SESSION_OPEN");
    expect(await codeOf(resumeSession(b.d.db, mine, T0 + 2 * HOUR))).toBe("TWO_OPEN_SESSIONS");
    expect(await codeOf(resumeSession(b.d.db, theirs, T0 + 2 * HOUR))).toBe("TWO_OPEN_SESSIONS");
    await endSession(b.d.db, theirs, { endedAt: new Date(T0 + HOUR).toISOString() }, T0 + 2 * HOUR);
    expect(await codeOf(resumeSession(b.d.db, mine, T0 + 2 * HOUR))).toBe("OK");
  });

  it("a running session's trash state and pauses older than 30 days are untouched by the import itself", async () => {
    const a = await device("A");
    const s = await startSession(a.d.db, {}, T0);
    const b = await device("B");
    const before = await exportText(a, { now: new Date(T0 + DAY) });
    await importInto(b, before, product);
    expect(await sessionOf(b, s)).toEqual(await sessionOf(a, s)); // the record itself is never changed by the import
  });
});
