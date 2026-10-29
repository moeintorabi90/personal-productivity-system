/**
 * An output counts only toward output goals that track its own definition (DECISIONS T-112,
 * T-137): the relationship rule holds for a direct record write, for every version in an
 * imported file, and for a version that a conflict choice makes current; and a goal version may
 * become current (conflict choice or undo) only if the outputs counting toward it still fit.
 * Fabricated data only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createGoal } from "../local/goals.ts";
import { putRecord } from "../local/records.ts";
import { updateSharedPreferences } from "../local/settings.ts";
import {
  correctOutputValue,
  createOutputDefinition,
  deleteOutput,
  linkGoalDefinition,
  loadWork,
  recordPastSession,
  restoreOutput,
  setOutputGoals,
} from "../local/work.ts";
import { loadConflictViews, ResolutionError, restoreReplacedVersion } from "./conflicts.ts";
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
   * With `attributeOnB`, B also records its own output counted toward the goal (B's definition).
   */
  async function linkedDifferently(attributeOnB = false) {
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
    let outputOnB = "";
    if (attributeOnB) {
      await recordPastSession(b.db, { date: "2026-11-01", startTime: "10:00", durationMinutes: 30, outputs: [{ definitionId: pagesB, value: 3, goalIds: [goal] }] }, T0);
      outputOnB = (await loadWork(b.db)).outputs.find((o) => o.data.definitionId === pagesB)!.id;
    }
    // The file's history check accepts the output: one known version of the goal tracks its definition.
    await importInto(b, await exportText(a), product);
    const views = await loadConflictViews(b.db, registry);
    expect(views.map((v) => v.conflict.type).sort()).toEqual([GOALS, OUTPUT_RECORDS]);
    const conflictOf = (type: string, id: string) => views.find((v) => v.conflict.type === type && v.conflict.id === id)!.conflict.conflictId;
    return { b, goal, output, outputOnB, conflictOf };
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

  const goalIdsOf = async (d: TestDevice, id: string) => ((await d.db.records.get([OUTPUT_RECORDS, id]))!.data as OutputRecordData).goalIds;

  it("choosing the backup's goal version is refused while an output here counts toward the goal with this device's definition; after the owner removes that attribution it goes through", async () => {
    const { b, goal, outputOnB, conflictOf } = await linkedDifferently(true);
    const before = await snapshot(b.db);
    const error = await decide(b.db, conflictOf(GOALS, goal), "useBackup", registry).catch((e: unknown) => e);
    expect((error as ResolutionError).code).toBe("LINKED_ITEMS_MISMATCH");
    expect((error as ResolutionError).linkedItems).toEqual([{ type: OUTPUT_RECORDS, id: outputOnB, conflictId: null }]);
    // Nothing written: the goal, the output's attribution, the pending decisions, and the archive are unchanged.
    expect(await snapshot(b.db)).toEqual(before);
    expect(await goalIdsOf(b, outputOnB)).toEqual([goal]);

    // An output in the trash still counts: it could be restored later.
    await deleteOutput(b.db, outputOnB);
    expect(await codeOf(decide(b.db, conflictOf(GOALS, goal), "useBackup", registry))).toBe("LINKED_ITEMS_MISMATCH");
    await restoreOutput(b.db, outputOnB);

    await setOutputGoals(b.db, outputOnB, []);
    expect(await codeOf(decide(b.db, conflictOf(GOALS, goal), "useBackup", registry))).toBe("OK");
    expect(await goalIdsOf(b, outputOnB)).toEqual([]);
    expect(((await b.db.records.get([GOALS, goal]))!.data as { definitionId?: string }).definitionId).not.toBe(
      (await loadWork(b.db)).outputs.find((o) => o.id === outputOnB)!.data.definitionId,
    );
  });

  it("restoring the archived goal version is refused the same way, and allowed once the attribution is changed", async () => {
    const { b, goal, outputOnB, conflictOf } = await linkedDifferently(true);
    await decide(b.db, conflictOf(GOALS, goal), "keepDevice", registry); // the backup's goal version goes to the archive
    const archived = (await b.db.replacedVersions.toArray()).find((r) => r.type === GOALS && r.id === goal)!;
    const before = await snapshot(b.db);
    const error = await restoreReplacedVersion(b.db, registry, archived.replacedId).catch((e: unknown) => e);
    expect((error as ResolutionError).code).toBe("LINKED_ITEMS_MISMATCH");
    expect(await snapshot(b.db)).toEqual(before);
    expect(await goalIdsOf(b, outputOnB)).toEqual([goal]);
    expect(await b.db.replacedVersions.get(archived.replacedId)).toBeDefined();

    await setOutputGoals(b.db, outputOnB, []);
    await restoreReplacedVersion(b.db, registry, archived.replacedId);
    expect(((await b.db.records.get([GOALS, goal]))!.data as { definitionId?: string }).definitionId).toBe(
      ((archived.entry as { envelope: { data: { definitionId?: string } } }).envelope.data).definitionId,
    );
    expect(await goalIdsOf(b, outputOnB)).toEqual([]);
  });
});
