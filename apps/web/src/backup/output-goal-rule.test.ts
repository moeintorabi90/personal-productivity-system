/**
 * An output counts only toward output goals that track its own definition (DECISIONS T-112,
 * T-137): the relationship rule holds for a direct record write, for every version in an
 * imported file, and for a version that a conflict choice makes current. Fabricated data only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createGoal } from "../local/goals.ts";
import { putRecord } from "../local/records.ts";
import { updateSharedPreferences } from "../local/settings.ts";
import { correctOutputValue, createOutputDefinition, linkGoalDefinition, loadWork, recordPastSession, setOutputGoals } from "../local/work.ts";
import { loadConflictViews } from "./conflicts.ts";
import { contentHashOf, makeEnvelope, nowIso } from "./envelope.ts";
import { GOALS, type OutputRecordData, OUTPUT_RECORDS, PRODUCT_REGISTRY } from "./registry.ts";
import { createTestDevice, type TestDevice } from "./test-fixtures.ts";
import { decide, exportFrom, importInto, mutate, snapshot } from "./test-helpers.ts";

const registry = PRODUCT_REGISTRY;
const product = { registry };
const T0 = Date.parse("2026-11-02T06:00:00Z");
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
/** An output goal from before Stage 5: a `unit`, no `definitionId`. */
async function legacyGoal(d: TestDevice, unit: string): Promise<string> {
  const id = crypto.randomUUID();
  await putRecord(d.db, registry, GOALS, id, {
    name: `Legacy ${unit}`,
    description: "",
    projectId: null,
    startDate: "2026-10-01",
    deadline: null,
    kind: "output",
    target: 100,
    unit,
    status: "active",
    archivedAt: null,
  });
  return id;
}

/** Two definitions, an output goal for each, an output goal without a definition, and one "pages" output counted toward its goal. */
async function setup() {
  const d = await device("A");
  const pages = await createOutputDefinition(d.db, { name: "Pages", unit: "pages" });
  const words = await createOutputDefinition(d.db, { name: "Words", unit: "words" });
  const pagesGoal = await createGoal(d.db, { name: "Book", startDate: "2026-10-01", kind: "output", target: 300, definitionId: pages });
  const wordsGoal = await createGoal(d.db, { name: "Essay", startDate: "2026-10-01", kind: "output", target: 300, definitionId: words });
  const legacy = await legacyGoal(d, "pages");
  await recordPastSession(d.db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 30, outputs: [{ definitionId: pages, value: 10, goalIds: [pagesGoal] }] }, T0);
  const output = (await loadWork(d.db)).outputs[0]!;
  return { d, pages, words, pagesGoal, wordsGoal, legacy, output: output.id, data: output.data as OutputRecordData };
}

const withOutput = (text: string, id: string, change: (data: Record<string, any>) => void) =>
  mutate(text, (doc) => {
    const env = doc.payload.records[OUTPUT_RECORDS].find((e: { id: string }) => e.id === id);
    change(env.data);
    env.contentHash = contentHashOf(env.data);
  });

describe("an output's goals track its definition (T-112, T-137)", () => {
  it("a record write is refused for a goal of another definition or an output goal without one", async () => {
    const s = await setup();
    const write = (goalIds: string[]) => putRecord(s.d.db, registry, OUTPUT_RECORDS, s.output, { ...s.data, goalIds });
    expect(await codeOf(write([s.wordsGoal]))).toBe("INVALID_RELATIONSHIP");
    expect(await codeOf(write([s.legacy]))).toBe("INVALID_RELATIONSHIP");
    expect(await codeOf(write([s.pagesGoal, s.wordsGoal]))).toBe("INVALID_RELATIONSHIP");
    expect((await s.d.db.records.get([OUTPUT_RECORDS, s.output]))!.data.goalIds).toEqual([s.pagesGoal]);
    expect(await codeOf(write([]))).toBe("OK");
    expect(await codeOf(write([s.pagesGoal]))).toBe("OK");
  });

  it("an imported file is refused whole when an output version counts toward such a goal, also in its history", async () => {
    const s = await setup();
    const text = await exportText(s.d);
    const b = await device("B");
    const before = await snapshot(b.db);
    const otherDefinition = withOutput(text, s.output, (data) => (data.goalIds = [s.wordsGoal]));
    const noDefinition = withOutput(text, s.output, (data) => (data.goalIds = [s.legacy]));
    const inHistory = mutate(text, (doc) => {
      const entry = { deleted: false, envelope: makeEnvelope(s.output, { ...s.data, goalIds: [s.wordsGoal] }, { [crypto.randomUUID()]: 1 }, nowIso()) };
      doc.payload.replacedVersions.push({ replacedId: crypto.randomUUID(), type: OUTPUT_RECORDS, id: s.output, entry, replacedAt: nowIso(), reason: "x" });
    });
    for (const file of [otherDefinition, noDefinition, inHistory]) {
      expect(await codeOf(importInto(b, file, product))).toBe("INVALID_RELATIONSHIP");
      expect(await snapshot(b.db)).toEqual(before);
    }
    expect(await codeOf(importInto(b, text, product))).toBe("OK");
  });

  /**
   * The same earlier goal is linked to a different "pages" definition on each device; A counts an
   * output toward it, B corrects that output's value. B imports A's backup: goal and output conflict.
   */
  async function linkedDifferently() {
    const a = await device("A");
    const pagesA = await createOutputDefinition(a.db, { name: "Pages", unit: "pages" });
    const goal = await legacyGoal(a, "pages");
    await recordPastSession(a.db, { date: "2026-11-01", startTime: "08:00", durationMinutes: 30, outputs: [{ definitionId: pagesA, value: 10 }] }, T0);
    const output = (await loadWork(a.db)).outputs[0]!.id;
    const b = await device("B");
    await importInto(b, await exportText(a), product);
    await linkGoalDefinition(a.db, goal, pagesA);
    await setOutputGoals(a.db, output, [goal]);
    const pagesB = await createOutputDefinition(b.db, { name: "Pages (B)", unit: "pages" });
    await linkGoalDefinition(b.db, goal, pagesB);
    await correctOutputValue(b.db, output, 11);
    // The file's history check accepts the output: one known version of the goal tracks its definition.
    await importInto(b, await exportText(a), product);
    const views = await loadConflictViews(b.db, registry);
    expect(views.map((v) => v.conflict.type).sort()).toEqual([GOALS, OUTPUT_RECORDS]);
    const conflictOf = (type: string, id: string) => views.find((v) => v.conflict.type === type && v.conflict.id === id)!.conflict.conflictId;
    return { b, goal, output, conflictOf };
  }

  it("a conflict choice that would count an output toward a goal tracking another definition is refused; the goal's versions may differ", async () => {
    const { b, goal, output, conflictOf } = await linkedDifferently();
    // B can still back up with both pending (export re-opens its own file).
    expect(await codeOf(exportText(b))).toBe("OK");

    // Against the live goal (tracking B's definition), the backup's output is refused; nothing changes.
    const before = await snapshot(b.db);
    expect(await codeOf(decide(b.db, conflictOf(OUTPUT_RECORDS, output), "useBackup", registry))).toBe("INVALID_RELATIONSHIP");
    expect(await snapshot(b.db)).toEqual(before);
    // Once the backup's goal version is current, the same choice goes through.
    await decide(b.db, conflictOf(GOALS, goal), "useBackup", registry);
    expect(await codeOf(decide(b.db, conflictOf(OUTPUT_RECORDS, output), "useBackup", registry))).toBe("OK");
    expect((await b.db.records.get([OUTPUT_RECORDS, output]))!.data.goalIds).toEqual([goal]);
  });

  it("keeping this device's goal: the backup's output stays refused, the backup still exports and imports, and the output can be kept", async () => {
    const { b, output, goal, conflictOf } = await linkedDifferently();
    await decide(b.db, conflictOf(GOALS, goal), "keepDevice", registry);
    // The pending output version counts toward the goal version now in the archive: a known version, so the file is valid.
    const text = await exportText(b);
    const c = await device("C");
    expect(await codeOf(importInto(c, text, product))).toBe("OK");
    expect(await codeOf(decide(b.db, conflictOf(OUTPUT_RECORDS, output), "useBackup", registry))).toBe("INVALID_RELATIONSHIP");
    await decide(b.db, conflictOf(OUTPUT_RECORDS, output), "keepDevice", registry);
    expect((await b.db.records.get([OUTPUT_RECORDS, output]))!.data.goalIds).toEqual([]);
  });
});
