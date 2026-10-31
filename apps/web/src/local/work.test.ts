/**
 * Stage 5 — sessions, outputs, corrections, trash, completions, and goal attribution through the
 * local domain layer (docs/TESTING.md "Stage 5 acceptance tests" 1–9; DECISIONS T-091 to T-169).
 * Fixed dates and zones; `now` is passed explicitly.
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeEnvelope, nowIso } from "../backup/envelope.ts";
import { CALENDAR_BLOCKS, CORRECTIONS, GOALS, OUTPUT_DEFINITIONS, OUTPUT_RECORDS, PRODUCT_REGISTRY, SESSIONS, TASK_COMPLETIONS, TASK_DEFINITIONS } from "../backup/registry.ts";
import { createTestDevice, type TestDevice } from "../backup/test-fixtures.ts";
import { completedOn, completionDate, completionId } from "../work/completions.ts";
import { goalProgress } from "../work/progress.ts";
import { workMinutes } from "../work/session-time.ts";
import { createGoal, setGoalArchived, setGoalStatus } from "./goals.ts";
import { createTask } from "./organization.ts";
import { createBlock, setRecurrence } from "./planning.ts";
import { putRecord } from "./records.ts";
import { updateSharedPreferences } from "./settings.ts";
import {
  addOutputs,
  allowedTaskCountGoals,
  allowedTimeGoals,
  completeTask,
  correctOutputValue,
  correctSessionTimes,
  createOutputDefinition,
  deleteOutput,
  definitionInUse,
  definitionLabel,
  deleteSession,
  editOutputDefinition,
  endSession,
  linkGoalDefinition,
  loadWork,
  overlappingSessions,
  pastSessionTimes,
  pauseSession,
  purgeTrash,
  recordPastSession,
  reopenTask,
  restoreOutput,
  restoreSession,
  resumeSession,
  sessionPrompts,
  setOutputDefinitionArchived,
  setOutputGoals,
  setSessionGoal,
  setTaskGoals,
  setTaskSuggestedDefinitions,
  startSession,
  TRASH_DAYS,
  updateSessionDetails,
  WorkError,
} from "./work.ts";

const devices: TestDevice[] = [];
async function device(zone: string | null = "Asia/Tehran") {
  const d = await createTestDevice("D");
  devices.push(d);
  if (zone) await updateSharedPreferences(d.db, { timeZone: zone });
  return d.db;
}
afterEach(() => {
  for (const d of devices.splice(0)) d.db.close();
});

type Db = Awaited<ReturnType<typeof device>>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 2026-11-02 09:30 in Tehran. */
const T0 = Date.parse("2026-11-02T06:00:00Z");
const at = (ms: number) => new Date(ms).toISOString();

describe("a definition referenced only by retained history is in use (T-107, T-111, T-167)", () => {
  const recordVersion = (id: string, data: Record<string, unknown>) => ({ deleted: false as const, envelope: makeEnvelope(id, data, { [crypto.randomUUID()]: 1 }, nowIso()) });
  const deletion = (type: string, id: string) => ({ deleted: true as const, tombstone: { type, id, deletedAt: nowIso(), version: { [crypto.randomUUID()]: 1 } } });
  const source = { backupId: crypto.randomUUID(), deviceId: crypto.randomUUID(), deviceName: "Other", exportedAt: nowIso() };
  const archive = (db: Db, type: string, id: string, entry: ReturnType<typeof recordVersion> | ReturnType<typeof deletion>) =>
    db.replacedVersions.put({ replacedId: crypto.randomUUID(), type, id, entry, replacedAt: nowIso(), reason: "notChosen" });
  const pending = (db: Db, type: string, id: string, local: ReturnType<typeof recordVersion> | ReturnType<typeof deletion> | null, incoming: ReturnType<typeof recordVersion> | ReturnType<typeof deletion>) =>
    db.pendingConflicts.put({ conflictId: crypto.randomUUID(), kind: "edit", type, id, local, incoming, source, detectedAt: nowIso() });
  const definitionOf = async (db: Db, id: string) => (await db.records.get([OUTPUT_DEFINITIONS, id]))!.data as Parameters<typeof definitionLabel>[0];

  const references: [string, string, (def: string) => Record<string, unknown>][] = [
    ["output", OUTPUT_RECORDS, (def) => ({ definitionId: def })],
    ["goal", GOALS, (def) => ({ definitionId: def })],
    ["session's expected amount", SESSIONS, (def) => ({ expectedOutputs: [{ definitionId: def, amount: 1 }] })],
    ["block's expected amount", CALENDAR_BLOCKS, (def) => ({ expectedOutputs: [{ definitionId: def, amount: 1 }] })],
    ["task's suggestion", TASK_DEFINITIONS, (def) => ({ outputDefinitionIds: [def] })],
  ];
  const places: [string, (db: Db, type: string, id: string, entry: ReturnType<typeof recordVersion>) => Promise<unknown>][] = [
    ["the archive", (db, type, id, entry) => archive(db, type, id, entry)],
    ["a pending conflict's backup version", (db, type, id, entry) => pending(db, type, id, null, entry)],
    ["a pending conflict's earlier version", (db, type, id, entry) => pending(db, type, id, entry, deletion(type, id))],
  ];
  for (const [name, type, data] of references) {
    for (const [place, retain] of places) {
      it(`a ${name} in ${place}`, async () => {
        const db = await device();
        const def = await createOutputDefinition(db, { name: "Pages", unit: "pages" });
        expect(await definitionInUse(db, def)).toBe(false);
        const id = crypto.randomUUID();
        await retain(db, type, id, recordVersion(id, data(def)));
        expect(await definitionInUse(db, def)).toBe(true);
      });
    }
  }

  it("editing it applies the history choice: the retained version keeps its label unless the owner chooses otherwise", async () => {
    const db = await device();
    const def = await createOutputDefinition(db, { name: "Pages", unit: "pages" });
    const output = crypto.randomUUID();
    await archive(db, OUTPUT_RECORDS, output, recordVersion(output, { definitionId: def, revision: 0 }));

    // A different unit is refused, as for a definition used by a live record.
    expect(await codeOf(editOutputDefinition(db, def, { name: "Pages", unit: "words", history: "keepPrevious" }))).toBe("DIFFERENT_UNIT");
    expect((await definitionOf(db, def)).revisions).toEqual([{ name: "Pages", unit: "pages" }]);

    await editOutputDefinition(db, def, { name: "Read pages", unit: "pages", history: "keepPrevious" });
    const kept = await definitionOf(db, def);
    expect(definitionLabel(kept, 0)).toEqual({ name: "Pages", unit: "pages" });
    expect(definitionLabel(kept)).toEqual({ name: "Read pages", unit: "pages" });

    await editOutputDefinition(db, def, { name: "Book pages", unit: "pages", history: "applyToHistory" });
    const applied = await definitionOf(db, def);
    expect(applied.revisions).toHaveLength(2);
    expect(definitionLabel(applied, 0)).toEqual({ name: "Pages", unit: "pages" });
    expect(definitionLabel(applied)).toEqual({ name: "Book pages", unit: "pages" });
  });

  it("purged data, tombstones, deletion versions, and set-aside versions are not references: the definition edits in place", async () => {
    const db = await device();
    const def = await createOutputDefinition(db, { name: "Pages", unit: "pages" });
    const session = await recordPastSession(db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 30, outputs: [{ definitionId: def, value: 5 }] }, T0);
    expect(await definitionInUse(db, def)).toBe(true);
    await deleteSession(db, session, T0);
    expect(await definitionInUse(db, def)).toBe(true); // still restorable from the trash
    await purgeTrash(db, { emptyNow: true, now: T0 });
    expect(await db.tombstones.where("type").equals(OUTPUT_RECORDS).count()).toBe(1);

    const other = crypto.randomUUID();
    await archive(db, OUTPUT_RECORDS, other, deletion(OUTPUT_RECORDS, other));
    await pending(db, OUTPUT_RECORDS, other, null, deletion(OUTPUT_RECORDS, other));
    await db.meta.put({
      key: "setAsideVersions",
      value: [{ setAsideId: crypto.randomUUID(), type: OUTPUT_RECORDS, id: other, entry: recordVersion(other, { definitionId: def }), setAsideAt: nowIso(), from: "archive" }],
    });
    expect(await definitionInUse(db, def)).toBe(false);
    await editOutputDefinition(db, def, { name: "Words", unit: "words" });
    expect((await definitionOf(db, def)).revisions).toEqual([{ name: "Words", unit: "words" }]);
  });
});

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).name;
  }
};
const session = async (db: Db, id: string) => (await db.records.get([SESSIONS, id]))!.data as import("../backup/registry.ts").SessionData;
const correctionsOf = async (db: Db) => (await db.records.where("type").equals(CORRECTIONS).toArray()).map((r) => r.data);

describe("1. sessions: start, pause, resume, end; one open session per device (T-091, T-092, T-095, T-117)", () => {
  it("works with and without a task; paused time is not work time; ending does not complete the task", async () => {
    const db = await device();
    const task = await createTask(db, { title: "Shadowing" });
    const id = await startSession(db, { taskId: task }, T0);
    await pauseSession(db, id, T0 + 30 * MIN);
    await resumeSession(db, id, T0 + 50 * MIN);
    await endSession(db, id, {}, T0 + 2 * HOUR);
    const s = await session(db, id);
    expect(s).toMatchObject({ taskId: task, startedAt: at(T0), endedAt: at(T0 + 2 * HOUR), localDate: "2026-11-02", goalId: null, energy: null, focus: null });
    expect(s.pauses).toEqual([{ start: at(T0 + 30 * MIN), end: at(T0 + 50 * MIN) }]);
    expect(workMinutes(s)).toBe(100);
    expect(s.snapshot).toMatchObject({ taskTitle: "Shadowing", projectId: null });
    expect(await db.records.where("type").equals(TASK_COMPLETIONS).count()).toBe(0); // T-091

    const taskless = await startSession(db, {}, T0 + 3 * HOUR);
    expect(await session(db, taskless)).toMatchObject({ taskId: null, snapshot: null, blockId: null });
  });

  it("refuses a second start while one is open, also a paused one; a paused session can be ended without resuming", async () => {
    const db = await device();
    const id = await startSession(db, {}, T0);
    expect(await codeOf(startSession(db, {}, T0 + MIN))).toBe("SESSION_OPEN");
    await pauseSession(db, id, T0 + 10 * MIN);
    expect(await codeOf(startSession(db, {}, T0 + 11 * MIN))).toBe("SESSION_OPEN");
    await endSession(db, id, {}, T0 + 40 * MIN);
    const s = await session(db, id);
    expect(s.pauses).toEqual([{ start: at(T0 + 10 * MIN), end: at(T0 + 40 * MIN) }]);
    expect(workMinutes(s)).toBe(10);
    expect(await codeOf(startSession(db, {}, T0 + 41 * MIN))).toBe("OK");
  });

  it("needs a configured time zone", async () => {
    const db = await device(null);
    expect(await codeOf(startSession(db, {}, T0))).toBe("NO_TIME_ZONE");
  });
});

describe("2. forgotten and long-paused sessions (T-093, T-149, T-162, T-164)", () => {
  it("a session left running before the app opened asks for its end time; nothing ends automatically", async () => {
    const db = await device();
    const id = await startSession(db, {}, T0);
    const opened = T0 + 5 * HOUR;
    expect(sessionPrompts(await loadWork(db), opened, opened)).toEqual([{ sessionId: id, kind: "leftRunning" }]);
    expect(sessionPrompts(await loadWork(db), T0 - MIN, T0 + MIN)).toEqual([]); // started after the app opened
    expect((await session(db, id)).endedAt).toBeNull();
    await endSession(db, id, { endedAt: at(T0 + 2 * HOUR) }, opened); // the user enters the end time
    expect(workMinutes(await session(db, id))).toBe(120);
  });

  it("a session started or resumed in the minute the app opened is not 'left running', though its stored time is rounded down", async () => {
    const db = await device();
    const opened = T0 + 20_000; // 20 seconds into the minute
    const id = await startSession(db, {}, T0 + 30_000);
    expect((await session(db, id)).startedAt).toBe(at(T0));
    expect(sessionPrompts(await loadWork(db), opened, T0 + 40_000)).toEqual([]);
    await pauseSession(db, id, T0 + 40_000);
    await resumeSession(db, id, T0 + 50_000);
    expect(sessionPrompts(await loadWork(db), opened, T0 + 55_000)).toEqual([]);
    // Running since the minute before the app opened: still asked, with no change at the boundary.
    expect(sessionPrompts(await loadWork(db), T0 + MIN, T0 + MIN)).toEqual([{ sessionId: id, kind: "leftRunning" }]);
    expect(sessionPrompts(await loadWork(db), T0 + MIN + 20_000, T0 + MIN + 20_000)).toEqual([{ sessionId: id, kind: "leftRunning" }]);
  });

  it("a running session reaching 24 hours of work asks for an end time within the limit", async () => {
    const db = await device();
    const id = await startSession(db, {}, T0);
    expect(sessionPrompts(await loadWork(db), T0, T0 + DAY)).toEqual([{ sessionId: id, kind: "workLimit" }]);
    expect(await codeOf(endSession(db, id, {}, T0 + DAY + MIN))).toBe("TOO_LONG");
    expect(await codeOf(endSession(db, id, { endedAt: at(T0 + DAY) }, T0 + DAY + MIN))).toBe("OK");
  });

  it("a session paused for more than 24 hours gets a reminder; it keeps the open-session slot", async () => {
    const db = await device();
    const id = await startSession(db, {}, T0);
    await pauseSession(db, id, T0 + HOUR);
    expect(sessionPrompts(await loadWork(db), T0 + 2 * HOUR, T0 + 24 * HOUR)).toEqual([]);
    expect(sessionPrompts(await loadWork(db), T0 + 2 * HOUR, T0 + 25 * HOUR + MIN)).toEqual([{ sessionId: id, kind: "longPause" }]);
    expect(await codeOf(startSession(db, {}, T0 + 26 * HOUR))).toBe("SESSION_OPEN");
    expect((await session(db, id)).endedAt).toBeNull();
  });
});

describe("3. block links (T-094, T-135)", () => {
  it("a session from a planned block of its task links it; a block of another task does not; the block never changes", async () => {
    const db = await device();
    const task = await createTask(db, { title: "Write" });
    const other = await createTask(db, { title: "Read" });
    const block = await createBlock(db, { taskId: task, date: "2026-11-02", startTime: "10:00", durationMinutes: 60 });
    const before = await db.records.get([CALENDAR_BLOCKS, block]);
    expect(await codeOf(startSession(db, { taskId: other, blockId: block }, T0))).toBe("BLOCK_OTHER_TASK");
    const id = await startSession(db, { blockId: block }, T0);
    expect(await session(db, id)).toMatchObject({ taskId: task, blockId: block });
    await endSession(db, id, {}, T0 + HOUR);
    expect(await db.records.get([CALENDAR_BLOCKS, block])).toEqual(before);
  });

  it("a separately recorded session can be linked later to a block of the same task only; its times never change", async () => {
    const db = await device();
    const task = await createTask(db, { title: "Write" });
    const other = await createTask(db, { title: "Read" });
    const block = await createBlock(db, { taskId: task, date: "2026-11-02", startTime: "10:00", durationMinutes: 60 });
    const otherBlock = await createBlock(db, { taskId: other, date: "2026-11-02", startTime: "12:00", durationMinutes: 60 });
    const id = await recordPastSession(db, { date: "2026-11-02", startTime: "10:05", durationMinutes: 50, taskId: task }, T0 + 3 * HOUR);
    const times = await session(db, id);
    expect(await codeOf(updateSessionDetails(db, id, { blockId: otherBlock }))).toBe("BLOCK_OTHER_TASK");
    await updateSessionDetails(db, id, { blockId: block });
    const linked = await session(db, id);
    expect(linked.blockId).toBe(block);
    expect([linked.startedAt, linked.endedAt, linked.pauses]).toEqual([times.startedAt, times.endedAt, times.pauses]);
    expect(await correctionsOf(db)).toEqual([]); // association edits keep no history (T-157)
  });
});

describe("4. past sessions and limits (T-096, T-097, T-136, T-149, T-158)", () => {
  it("start plus duration stores exact instants, also across a daylight-saving change", async () => {
    const ny = await device("America/New_York");
    // 2026-11-01 01:30 happens twice in New York: the earlier instant (EDT, UTC−4) is used.
    const id = await recordPastSession(ny, { date: "2026-11-01", startTime: "01:30", durationMinutes: 90 }, Date.parse("2026-11-03T00:00:00Z"));
    expect(await session(ny, id)).toMatchObject({ startedAt: "2026-11-01T05:30:00.000Z", endedAt: "2026-11-01T07:00:00.000Z", localDate: "2026-11-01", timeZone: "America/New_York" });
    expect(workMinutes(await session(ny, id))).toBe(90);
    expect(await codeOf(recordPastSession(ny, { date: "2026-03-08", startTime: "02:30", durationMinutes: 30 }, Date.parse("2026-11-03T00:00:00Z")))).toBe("DST_GAP");
  });

  it("any past date is accepted; an end in the future is refused; overlaps warn but still save", async () => {
    const db = await device();
    expect(await codeOf(recordPastSession(db, { date: "2019-01-05", startTime: "08:00", durationMinutes: 45 }, T0))).toBe("OK");
    expect(await codeOf(recordPastSession(db, { date: "2026-11-02", startTime: "09:00", durationMinutes: 60 }, T0))).toBe("FUTURE"); // ends 10:00, now is 09:30
    const first = await recordPastSession(db, { date: "2026-11-02", startTime: "07:00", durationMinutes: 60 }, T0);
    const work = await loadWork(db);
    const times = pastSessionTimes({ date: "2026-11-02", startTime: "07:30", durationMinutes: 30 }, "Asia/Tehran");
    expect(overlappingSessions(work.sessions, times, undefined, T0).map((s) => s.id)).toEqual([first]);
    expect(await codeOf(recordPastSession(db, { date: "2026-11-02", startTime: "07:30", durationMinutes: 30 }, T0))).toBe("OK");
  });

  it("the 24-hour limit counts work time only: paused time does not count", async () => {
    const db = await device();
    expect(await codeOf(recordPastSession(db, { date: "2026-10-20", startTime: "08:00", durationMinutes: 24 * 60 + 1 }, T0))).toBe("TOO_LONG");
    expect(await codeOf(recordPastSession(db, { date: "2026-10-20", startTime: "08:00", durationMinutes: 24 * 60 }, T0))).toBe("OK");
    // 23 hours of work and 3 hours of pauses: a span of 26 hours is accepted.
    const s = await startSession(db, {}, T0);
    await pauseSession(db, s, T0 + 10 * HOUR);
    await resumeSession(db, s, T0 + 13 * HOUR);
    await endSession(db, s, {}, T0 + 26 * HOUR);
    expect(workMinutes(await session(db, s))).toBe(23 * 60);
    // Work time over 24 hours is refused.
    const long = await startSession(db, {}, T0 + 27 * HOUR);
    await pauseSession(db, long, T0 + 28 * HOUR);
    await resumeSession(db, long, T0 + 29 * HOUR);
    expect(await codeOf(endSession(db, long, {}, T0 + 27 * HOUR + 25 * HOUR + MIN))).toBe("TOO_LONG");
  });
});

describe("5. no end status, separate values, note and ratings (T-098, T-099, T-140, T-157)", () => {
  it("a 2-hour session with 15 content minutes keeps 120 minutes of work and an output of 15; no output is fine", async () => {
    const db = await device();
    const content = await createOutputDefinition(db, { name: "Content covered", unit: "minutes" });
    const id = await startSession(db, {}, T0);
    await endSession(db, id, { outputs: [{ definitionId: content, value: 15 }], notes: " good ", energy: 4, focus: 2 }, T0 + 2 * HOUR);
    const s = await session(db, id);
    expect(workMinutes(s)).toBe(120);
    expect(s).toMatchObject({ notes: "good", energy: 4, focus: 2 });
    const outputs = (await loadWork(db)).outputs;
    expect(outputs.map((o) => o.data.value)).toEqual([15]);
    const empty = await startSession(db, {}, T0 + 3 * HOUR);
    expect(await codeOf(endSession(db, empty, {}, T0 + 4 * HOUR))).toBe("OK");
  });

  it("ratings accept only whole numbers 1–5; editing the note, ratings, or expected amounts writes no correction", async () => {
    const db = await device();
    const id = await recordPastSession(db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 30 }, T0);
    for (const bad of [0, 6, 2.5]) expect(await codeOf(updateSessionDetails(db, id, { energy: bad }))).toBe("INVALID_RATING");
    await updateSessionDetails(db, id, { notes: "new", energy: 5, focus: 1, expectedOutputs: [] });
    expect(await session(db, id)).toMatchObject({ notes: "new", energy: 5, focus: 1 });
    expect(await correctionsOf(db)).toEqual([]);
  });
});

describe("6. outputs and definitions (T-104, T-107, T-137 to T-139, T-154, T-159, T-165 to T-169)", () => {
  it("several outputs per session, whole numbers, 0 is a recorded result; archived definitions are not offered for new outputs", async () => {
    const db = await device();
    const words = await createOutputDefinition(db, { name: "Vocabulary", unit: "words" });
    const content = await createOutputDefinition(db, { name: "Content", unit: "minutes" });
    const id = await startSession(db, {}, T0);
    expect(await codeOf(endSession(db, id, { outputs: [{ definitionId: words, value: 2.5 }] }, T0 + HOUR))).toBe("INVALID_VALUE");
    await endSession(db, id, { outputs: [{ definitionId: words, value: 0 }, { definitionId: content, value: 15 }] }, T0 + HOUR);
    expect((await loadWork(db)).outputs.map((o) => o.data.value).sort()).toEqual([0, 15]);
    await setOutputDefinitionArchived(db, words, true);
    const next = await startSession(db, {}, T0 + 2 * HOUR);
    expect(await codeOf(endSession(db, next, { outputs: [{ definitionId: words, value: 1 }] }, T0 + 3 * HOUR))).toBe("DEFINITION_ARCHIVED");
    expect((await loadWork(db)).outputs).toHaveLength(2); // the old output stays
  });

  it("editing a used definition: apply to history or keep previous labels (T-107, T-111)", async () => {
    const db = await device();
    const def = await createOutputDefinition(db, { name: "Vocab", unit: "word" });
    const past = await recordPastSession(db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 30, outputs: [{ definitionId: def, value: 10 }] }, T0);
    expect(await codeOf(editOutputDefinition(db, def, { name: "Vocabulary", unit: "word", history: "applyToHistory" }))).toBe("OK");
    let work = await loadWork(db);
    expect(work.definitions[0]!.data.revisions).toEqual([{ name: "Vocabulary", unit: "word" }]);
    await editOutputDefinition(db, def, { name: "New words", unit: "word", history: "keepPrevious" });
    work = await loadWork(db);
    expect(work.definitions[0]!.data.revisions).toEqual([
      { name: "Vocabulary", unit: "word" },
      { name: "New words", unit: "word" },
    ]);
    expect(work.outputs.find((o) => o.data.sessionId === past)!.data.revision).toBe(0); // old output keeps its label
  });

  it("a used definition's unit changes only as a rewording of the same unit; a different unit needs a new definition (T-165, T-167)", async () => {
    const db = await device();
    const def = await createOutputDefinition(db, { name: "Reading", unit: "page" });
    await recordPastSession(db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 30, outputs: [{ definitionId: def, value: 10 }] }, T0);
    expect(await codeOf(editOutputDefinition(db, def, { name: "Reading", unit: "words", history: "applyToHistory" }))).toBe("DIFFERENT_UNIT");
    expect(await codeOf(editOutputDefinition(db, def, { name: "Reading", unit: "pages", history: "applyToHistory", sameUnit: true }))).toBe("OK");
    const unused = await createOutputDefinition(db, { name: "Draft", unit: "lines" });
    expect(await codeOf(editOutputDefinition(db, unused, { name: "Draft", unit: "words" }))).toBe("OK"); // not in use: free
    expect((await loadWork(db)).definitions.find((d) => d.id === unused)!.data.revisions).toEqual([{ name: "Draft", unit: "words" }]);
  });

  it("a task's suggested definitions never restrict what is recorded (T-138)", async () => {
    const db = await device();
    const task = await createTask(db, { title: "Study" });
    const a = await createOutputDefinition(db, { name: "A", unit: "pages" });
    const b = await createOutputDefinition(db, { name: "B", unit: "words" });
    await setTaskSuggestedDefinitions(db, task, [a]);
    const id = await startSession(db, { taskId: task }, T0);
    expect(await codeOf(endSession(db, id, { outputs: [{ definitionId: b, value: 3 }] }, T0 + HOUR))).toBe("OK");
    await setTaskSuggestedDefinitions(db, task, []);
    expect((await db.records.get(["taskDefinitions", task]))!.data).not.toHaveProperty("outputDefinitionIds");
  });

  it("legacy output goal migration: match links, a recognized mismatch is refused, an unknown pair needs an explicit yes; nothing is converted or saved as a rule", async () => {
    const db = await device();
    const legacy = async (unit: string) => {
      const id = crypto.randomUUID();
      await putRecord(db, PRODUCT_REGISTRY, GOALS, id, { name: `Goal ${unit}`, description: "", projectId: null, startDate: "2026-10-01", deadline: null, kind: "output", target: 120, unit, status: "active", archivedAt: null });
      return id;
    };
    const page = await createOutputDefinition(db, { name: "Reading", unit: "page" });
    const words = await createOutputDefinition(db, { name: "Writing", unit: "words" });
    const kg = await createOutputDefinition(db, { name: "Lifting", unit: "kg" });
    const safhe = await createOutputDefinition(db, { name: "مطالعه", unit: "صفحه" });

    const pages = await legacy(" Pages ");
    expect(await codeOf(linkGoalDefinition(db, pages, words))).toBe("UNIT_MISMATCH");
    expect(await codeOf(linkGoalDefinition(db, pages, safhe))).toBe("UNIT_MISMATCH"); // a translation
    expect(await linkGoalDefinition(db, pages, page)).toBe("match");
    expect((await db.records.get([GOALS, pages]))!.data).toMatchObject({ definitionId: page, unit: " Pages ", target: 120 });

    const kgs = await legacy("kgs");
    expect(await codeOf(linkGoalDefinition(db, kgs, kg))).toBe("NEEDS_CONFIRMATION");
    expect((await db.records.get([GOALS, kgs]))!.data).not.toHaveProperty("definitionId");
    expect(await linkGoalDefinition(db, kgs, kg, true)).toBe("confirmed");
    const again = await legacy("kgs");
    expect(await codeOf(linkGoalDefinition(db, again, kg))).toBe("NEEDS_CONFIRMATION"); // no alias saved

    const safhat = await legacy("صفحات");
    expect(await linkGoalDefinition(db, safhat, safhe)).toBe("match"); // irregular Persian plural
  });
});

describe("7. corrections keep history (T-102, T-113, T-131, T-148)", () => {
  it("times, output values, and goal attribution keep the old and new values and an optional reason", async () => {
    const db = await device();
    const def = await createOutputDefinition(db, { name: "Pages", unit: "pages" });
    const study = await createGoal(db, { name: "Study", startDate: "2026-10-01", kind: "time", target: 600 });
    const book = await createGoal(db, { name: "Book", startDate: "2026-10-01", kind: "output", target: 300, definitionId: def });
    const id = await recordPastSession(db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 60, outputs: [{ definitionId: def, value: 10 }] }, T0);
    const output = (await loadWork(db)).outputs[0]!.id;
    await correctSessionTimes(db, id, { startedAt: "2026-11-01T04:30:00.000Z", endedAt: "2026-11-01T06:00:00.000Z" }, "typo", T0);
    await correctOutputValue(db, output, 12, null);
    await setSessionGoal(db, id, study, "forgot");
    await setOutputGoals(db, output, [book], null);
    const history = await correctionsOf(db);
    expect(history.map((c) => [c.field, c.before, c.after, c.reason])).toEqual(
      expect.arrayContaining([
        ["times", { startedAt: "2026-11-01T04:30:00.000Z", endedAt: "2026-11-01T05:30:00.000Z", pauses: [] }, { startedAt: "2026-11-01T04:30:00.000Z", endedAt: "2026-11-01T06:00:00.000Z", pauses: [] }, "typo"],
        ["value", 10, 12, null],
        ["goal", null, study, "forgot"],
        ["goals", [], [book], null],
      ]),
    );
    expect(history).toHaveLength(4);
    // Progress follows the current attribution (T-131).
    const work = await loadWork(db);
    expect(goalProgress(study, (await db.records.get([GOALS, study]))!.data as never, work)).toBe(90);
    expect(goalProgress(book, (await db.records.get([GOALS, book]))!.data as never, work)).toBe(12);
  });

  it("a correction cannot be edited (append-only)", async () => {
    const db = await device();
    const id = await recordPastSession(db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 60 }, T0);
    await correctSessionTimes(db, id, { startedAt: "2026-11-01T04:30:00.000Z", endedAt: "2026-11-01T05:00:00.000Z" }, null, T0);
    const row = (await db.records.where("type").equals(CORRECTIONS).first())!;
    await expect(putRecord(db, PRODUCT_REGISTRY, CORRECTIONS, row.id, { ...row.data, reason: "x" })).rejects.toThrow(/Append-only/);
  });
});

describe("8. task completion and goals (T-100, T-101, T-105, T-106, T-108, T-120 to T-132, T-137)", () => {
  it("linked time goals: exactly those and none; without links any time goal; completions likewise, adding no link", async () => {
    const db = await device();
    const g1 = await createGoal(db, { name: "Study", startDate: "2026-10-01", kind: "time", target: 600 });
    const g2 = await createGoal(db, { name: "Practice", startDate: "2026-10-01", kind: "time", target: 600 });
    const c1 = await createGoal(db, { name: "Count", startDate: "2026-10-01", kind: "taskCount", target: 10 });
    const c2 = await createGoal(db, { name: "Count 2", startDate: "2026-10-01", kind: "taskCount", target: 10 });
    const linked = await createTask(db, { title: "Linked" });
    const free = await createTask(db, { title: "Free" });
    await setTaskGoals(db, linked, [g1, c1]);
    const tasks = new Map((await db.records.where("type").equals("taskDefinitions").toArray()).map((r) => [r.id, r.data as never]));
    const goalItems = (await db.records.where("type").equals(GOALS).toArray()).map((r) => ({ id: r.id, data: r.data as never }));
    expect(allowedTimeGoals(linked, tasks, goalItems)).toEqual([g1]);
    expect(allowedTimeGoals(free, tasks, goalItems).sort()).toEqual([g1, g2].sort());
    expect(allowedTimeGoals(null, tasks, goalItems).sort()).toEqual([g1, g2].sort());
    expect(allowedTaskCountGoals(linked, tasks, goalItems)).toEqual([c1]);
    expect(allowedTaskCountGoals(free, tasks, goalItems).sort()).toEqual([c1, c2].sort());

    const s = await startSession(db, { taskId: linked }, T0);
    expect(await codeOf(endSession(db, s, { goalId: g2 }, T0 + HOUR))).toBe("GOAL_NOT_ALLOWED");
    expect(await codeOf(endSession(db, s, { goalId: c1 }, T0 + HOUR))).toBe("GOAL_NOT_ALLOWED");
    await endSession(db, s, { goalId: g1 }, T0 + HOUR);
    const none = await recordPastSession(db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 30, taskId: linked, goalId: null }, T0);
    const manual = await recordPastSession(db, { date: "2026-11-01", startTime: "09:00", durationMinutes: 30, taskId: free, goalId: g2 }, T0);
    expect((await session(db, none)).goalId).toBeNull();
    expect((await session(db, manual)).goalId).toBe(g2);

    expect(await codeOf(completeTask(db, linked, { goalId: c2 }, T0))).toBe("GOAL_NOT_ALLOWED");
    await completeTask(db, linked, { goalId: c1 }, T0);
    await completeTask(db, free, { goalId: c2 }, T0); // manual, without a lasting link
    expect((await db.records.get(["taskDefinitions", free]))!.data).not.toHaveProperty("goalIds");
  });

  it("later link changes do not re-attribute earlier records; attribution never edits the goal; dates and status do not filter", async () => {
    const db = await device();
    const study = await createGoal(db, { name: "Study", startDate: "2026-12-01", deadline: "2026-12-31", kind: "time", target: 60 });
    const task = await createTask(db, { title: "Read" });
    await setTaskGoals(db, task, [study]);
    const goalBefore = await db.records.get([GOALS, study]);
    const s = await recordPastSession(db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 90, taskId: task, goalId: study }, T0);
    expect(await db.records.get([GOALS, study])).toEqual(goalBefore);
    await setTaskGoals(db, task, []);
    expect((await session(db, s)).goalId).toBe(study);
    await setGoalStatus(db, study, "paused");
    await setGoalArchived(db, study, true);
    const work = await loadWork(db);
    // Before the goal's start date, while paused and archived, and beyond the target: counted in full.
    expect(goalProgress(study, (await db.records.get([GOALS, study]))!.data as never, work)).toBe(90);
  });

  it("an output counts toward several goals only when they all track its definition", async () => {
    const db = await device();
    const pages = await createOutputDefinition(db, { name: "Pages", unit: "pages" });
    const words = await createOutputDefinition(db, { name: "Words", unit: "words" });
    const a = await createGoal(db, { name: "A", startDate: "2026-10-01", kind: "output", target: 100, definitionId: pages });
    const b = await createGoal(db, { name: "B", startDate: "2026-10-01", kind: "output", target: 100, definitionId: pages });
    const c = await createGoal(db, { name: "C", startDate: "2026-10-01", kind: "output", target: 100, definitionId: words });
    const s = await startSession(db, {}, T0);
    expect(await codeOf(endSession(db, s, { outputs: [{ definitionId: pages, value: 5, goalIds: [a, c] }] }, T0 + HOUR))).toBe("GOAL_NOT_ALLOWED");
    await endSession(db, s, { outputs: [{ definitionId: pages, value: 5, goalIds: [a, b] }] }, T0 + HOUR);
    const work = await loadWork(db);
    for (const id of [a, b]) expect(goalProgress(id, (await db.records.get([GOALS, id]))!.data as never, work)).toBe(5);
  });
});

describe("8a. recurring tasks and reopening (T-118, T-119, T-133, T-134, T-147, T-155, T-156)", () => {
  it("each occurrence completes once; the task stays active and unchanged; reopen reverses; future dates are refused", async () => {
    const db = await device();
    const goal = await createGoal(db, { name: "Count", startDate: "2026-10-01", kind: "taskCount", target: 10 });
    const task = await createTask(db, { title: "Daily vocab" });
    await setRecurrence(db, task, { kind: "weekdays", weekdays: [0, 1, 2, 3, 4, 5, 6], startDate: "2026-10-01", endDate: null });
    const taskBefore = await db.records.get(["taskDefinitions", task]);
    await completeTask(db, task, { occurrenceDate: "2026-11-01", goalId: goal }, T0);
    // Today's occurrence (09:30 now) can be completed before a block later that day.
    await createBlock(db, { taskId: task, date: "2026-11-02", startTime: "18:00", durationMinutes: 30, occurrenceDate: "2026-11-02" });
    await completeTask(db, task, { occurrenceDate: "2026-11-02", goalId: goal }, T0);
    expect(await codeOf(completeTask(db, task, { occurrenceDate: "2026-11-03" }, T0))).toBe("FUTURE_OCCURRENCE");
    expect(await codeOf(completeTask(db, task, { occurrenceDate: "2026-11-01" }, T0))).toBe("ALREADY_COMPLETED");
    expect(await codeOf(completeTask(db, task, {}, T0))).toBe("NOT_AN_OCCURRENCE");
    expect(await db.records.get(["taskDefinitions", task])).toEqual(taskBefore);
    const goalData = (await db.records.get([GOALS, goal]))!.data as never;
    expect(goalProgress(goal, goalData, await loadWork(db))).toBe(2);
    await reopenTask(db, task, "2026-11-01", T0);
    expect(goalProgress(goal, goalData, await loadWork(db))).toBe(1);
    expect(completedOn((await loadWork(db)).completions, "2026-11-02", "Asia/Tehran")).toHaveLength(1);
    await completeTask(db, task, { occurrenceDate: "2026-11-01", goalId: goal }, T0);
    expect(goalProgress(goal, goalData, await loadWork(db))).toBe(2);
    expect(await db.records.where("type").equals(TASK_COMPLETIONS).count()).toBe(2); // the same record was edited
  });

  it("a one-off task is the same record type without a date; it is shown on the local date it was completed", async () => {
    const db = await device();
    const task = await createTask(db, { title: "Send form" });
    const completedAt = Date.parse("2026-11-01T21:00:00Z"); // 00:30 on 2026-11-02 in Tehran
    const id = await completeTask(db, task, {}, completedAt);
    expect(id).toBe(completionId(task, null));
    const data = (await db.records.get([TASK_COMPLETIONS, id]))!.data as never;
    expect(completionDate(data, "Asia/Tehran")).toBe("2026-11-02");
    expect(await codeOf(completeTask(db, task, { occurrenceDate: "2026-11-02" }, completedAt))).toBe("NOT_AN_OCCURRENCE");
    await reopenTask(db, task);
    expect(await codeOf(reopenTask(db, task))).toBe("NOT_COMPLETED");
  });
});

describe("8b. expected outputs (T-125, T-128, T-141, T-150, T-163)", () => {
  it("0 is a stored amount; a block's amounts are copied once; a later block link copies nothing; never counted", async () => {
    const db = await device();
    const words = await createOutputDefinition(db, { name: "Words", unit: "words" });
    const goal = await createGoal(db, { name: "Words", startDate: "2026-10-01", kind: "output", target: 100, definitionId: words });
    const task = await createTask(db, { title: "Write" });
    const block = await createBlock(db, { taskId: task, date: "2026-11-02", startTime: "10:00", durationMinutes: 60 });
    const row = (await db.records.get([CALENDAR_BLOCKS, block]))!;
    await putRecord(db, PRODUCT_REGISTRY, CALENDAR_BLOCKS, block, { ...row.data, expectedOutputs: [{ definitionId: words, amount: 30 }] });
    const s = await startSession(db, { blockId: block }, T0);
    expect((await session(db, s)).expectedOutputs).toEqual([{ definitionId: words, amount: 30 }]);
    await updateSessionDetails(db, s, { expectedOutputs: [{ definitionId: words, amount: 0 }] });
    expect((await session(db, s)).expectedOutputs).toEqual([{ definitionId: words, amount: 0 }]);
    expect((await db.records.get([CALENDAR_BLOCKS, block]))!.data.expectedOutputs).toEqual([{ definitionId: words, amount: 30 }]);
    await endSession(db, s, { outputs: [{ definitionId: words, value: 20, goalIds: [goal] }] }, T0 + HOUR);
    const past = await recordPastSession(db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 30, taskId: task }, T0);
    await updateSessionDetails(db, past, { blockId: block });
    expect((await session(db, past)).expectedOutputs).toEqual([]);
    expect(goalProgress(goal, (await db.records.get([GOALS, goal]))!.data as never, await loadWork(db))).toBe(20);
  });
});

describe("9. trash (T-103, T-114, T-115, T-142, T-143, T-153, T-160)", () => {
  it("a deleted session and its outputs leave progress and can be restored within 30 days; afterwards they become tombstones", async () => {
    const db = await device();
    const pages = await createOutputDefinition(db, { name: "Pages", unit: "pages" });
    const goal = await createGoal(db, { name: "Pages", startDate: "2026-10-01", kind: "output", target: 100, definitionId: pages });
    const id = await recordPastSession(db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 30, outputs: [{ definitionId: pages, value: 9, goalIds: [goal] }] }, T0);
    const goalData = (await db.records.get([GOALS, goal]))!.data as never;
    await deleteSession(db, id, T0);
    expect(goalProgress(goal, goalData, await loadWork(db))).toBe(0);
    await restoreSession(db, id, T0 + 29 * DAY);
    expect(goalProgress(goal, goalData, await loadWork(db))).toBe(9);
    await deleteSession(db, id, T0 + 29 * DAY);
    expect(await codeOf(restoreSession(db, id, T0 + 29 * DAY + TRASH_DAYS * DAY + MIN))).toBe("TRASH_EXPIRED");
    expect(await purgeTrash(db, { now: T0 + 29 * DAY + 10 * DAY })).toBe(0);
    expect(await purgeTrash(db, { now: T0 + 29 * DAY + TRASH_DAYS * DAY + MIN })).toBe(1);
    expect(await db.records.where("type").anyOf(SESSIONS, OUTPUT_RECORDS).count()).toBe(0);
    expect((await db.tombstones.toArray()).map((t) => t.type).sort()).toEqual([OUTPUT_RECORDS, SESSIONS]);
  });

  it("emptying the trash deletes permanently at once, with the corrections", async () => {
    const db = await device();
    const id = await recordPastSession(db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 30 }, T0);
    await correctSessionTimes(db, id, { startedAt: "2026-11-01T04:30:00.000Z", endedAt: "2026-11-01T05:30:00.000Z" }, null, T0);
    await deleteSession(db, id, T0);
    expect(await purgeTrash(db, { emptyNow: true, now: T0 + MIN })).toBe(1);
    expect((await db.tombstones.toArray()).map((t) => t.type).sort()).toEqual([CORRECTIONS, SESSIONS]);
  });

  it("a single output is deleted to the trash, recorded in history, restored within 30 days, then removed", async () => {
    const db = await device();
    const pages = await createOutputDefinition(db, { name: "Pages", unit: "pages" });
    const id = await recordPastSession(db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 30, outputs: [{ definitionId: pages, value: 9 }] }, T0);
    const output = (await loadWork(db)).outputs[0]!.id;
    await deleteOutput(db, output, "duplicate", T0);
    expect((await correctionsOf(db)).map((c) => [c.field, c.before, c.after, c.reason])).toEqual([["deleted", 9, null, "duplicate"]]);
    await restoreOutput(db, output, T0 + DAY);
    expect((await loadWork(db)).outputs[0]!.data.deletedAt).toBeNull();
    await deleteSession(db, id, T0 + DAY);
    expect(await codeOf(restoreOutput(db, output, T0 + DAY))).toBe("NOT_DELETED");
    await restoreSession(db, id, T0 + DAY);
    await deleteOutput(db, output, null, T0 + 2 * DAY);
    await purgeTrash(db, { now: T0 + 2 * DAY + TRASH_DAYS * DAY + MIN });
    expect(await db.records.get([OUTPUT_RECORDS, output])).toBeUndefined();
    expect(await db.records.get([SESSIONS, id])).toBeDefined();
    expect(await db.records.where("type").equals(CORRECTIONS).count()).toBe(0); // the output's history went with it
  });

  it("outputs can be added to an ended session; the addition is recorded", async () => {
    const db = await device();
    const pages = await createOutputDefinition(db, { name: "Pages", unit: "pages" });
    const id = await recordPastSession(db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 30 }, T0);
    await addOutputs(db, id, [{ definitionId: pages, value: 4 }], "late");
    expect((await correctionsOf(db)).map((c) => [c.field, c.after, c.reason])).toEqual([["added", 4, "late"]]);
  });

  it("an open session in the trash frees the slot; restoring it is refused while another session is open", async () => {
    const db = await device();
    const open = await startSession(db, {}, T0);
    await deleteSession(db, open, T0 + MIN);
    const next = await startSession(db, {}, T0 + 2 * MIN);
    expect(await codeOf(restoreSession(db, open, T0 + 3 * MIN))).toBe("SESSION_OPEN");
    await endSession(db, next, {}, T0 + HOUR);
    expect(await codeOf(restoreSession(db, open, T0 + HOUR))).toBe("OK");
  });
});

describe("errors are typed", () => {
  it("WorkError carries a code", async () => {
    const db = await device();
    await expect(pauseSession(db, crypto.randomUUID(), T0)).rejects.toBeInstanceOf(WorkError);
  });
});
