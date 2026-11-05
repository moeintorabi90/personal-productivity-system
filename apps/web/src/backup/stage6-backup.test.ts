/**
 * Stage 6 data in backups (TESTING "Stage 6 acceptance tests" items 4, 11 to 13, 18, 19; BACKUP_FORMAT
 * "Data schema version 8"; DECISIONS T-201, T-204, T-223, T-227 to T-229, T-234 to T-237). Fixed
 * clock (only `Date` is faked), weeks start on Monday, zone UTC. Fabricated data only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "./jcs.ts";
import { contentHashOf } from "./envelope.ts";
import { createGoal, resumeGoal, setGoalStatus, updateGoal } from "../local/goals.ts";
import { decidePlanDate, loadGoalPlanning, planWriteLimit, refreshWeekPlans, setWeekAllocation } from "../local/goal-plans.ts";
import { deleteRecord, plannedWriteEnvelope, putRecord, toEnvelope } from "../local/records.ts";
import { envelopeFits, nowIso } from "./envelope.ts";
import { canonicalBytes } from "./jcs.ts";
import { MAX_ENVELOPE_BYTES } from "./limits.ts";
import { loadInsightRecords, recordAppUse, saveDashboard } from "../local/insights.ts";
import { createTask } from "../local/organization.ts";
import { createBlock, dragBlockTimes } from "../local/planning.ts";
import { setMeta } from "../local/db.ts";
import { updateSharedPreferences } from "../local/settings.ts";
import { loadTimer, saveCountdown, saveSelectedTimer, saveStopwatch, startCountdown, startStopwatch } from "../local/timer.ts";
import {
  canChangeChoice,
  canWriteEntry,
  candidatesOf,
  decisionChoices,
  eventStatus,
  hasCoverageCycle,
  mergePlans,
  needsDecision,
  nextSeq,
  planDateOn,
  planHasCoverageCycle,
  resolveDate,
} from "../insights/plan-merge.ts";
import { cyclicEntries, newPlanIntegrityProblem } from "../insights/plan-integrity.ts";
import { SUGGESTED_MAIN_DASHBOARD } from "../insights/metrics.ts";
import { DATA_SCHEMA_VERSION } from "./limits.ts";
import {
  APP_USE_DAYS,
  CALENDAR_BLOCKS,
  DASHBOARDS,
  GOAL_WEEK_ALLOCATIONS,
  GOAL_WEEK_PLAN_CHOICES,
  GOAL_WEEK_PLANS,
  GOALS,
  type GoalWeekAllocationData,
  type GoalWeekPlanData,
  MAIN_DASHBOARD_ID,
  PLAN_SEQ_MAX,
  type PlanEntryData,
  PRODUCT_REGISTRY,
  type SegmentData,
  TASK_ESTIMATE_CAPTURES,
} from "./registry.ts";
import { planChoiceId, weekAllocationId, weekPlanId } from "./derived-id.ts";
import { createTestDevice, type TestDevice } from "./test-fixtures.ts";
import { loadConflictViews, resolveConflict, restoreReplacedVersion } from "./conflicts.ts";
import { applyImport, previewImport } from "./merge.ts";
import { openBackupFile } from "./read.ts";
import { blobOf, decide, exportFrom, importInto, mutate, snapshot } from "./test-helpers.ts";

const registry = PRODUCT_REGISTRY;
const product = { registry };
const devices: TestDevice[] = [];
async function device(label: string): Promise<TestDevice> {
  const d = await createTestDevice(label);
  devices.push(d);
  await updateSharedPreferences(d.db, { timeZone: "UTC", weekStart: 1 });
  return d;
}
const at = (iso: string) => vi.setSystemTime(new Date(iso));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-11-02T08:00:00Z"); // Monday
});
afterEach(() => {
  vi.useRealTimers();
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
const recordsOf = async (d: TestDevice) =>
  (await d.db.records.toArray())
    .map((r) => ({ type: r.type, id: r.id, contentHash: r.contentHash, version: r.version, data: r.data }))
    .sort((a, b) => `${a.type}/${a.id}`.localeCompare(`${b.type}/${b.id}`));
/**
 * Stores `data` as a build before the weekly plans' integrity checks could have (malformed data
 * already on a device): the envelope `putRecord` would write, without its checks.
 */
async function storeUnchecked(d: TestDevice, type: string, id: string, data: unknown) {
  const row = await d.db.records.get([type, id]);
  await d.db.records.put({ type, ...plannedWriteEnvelope(row, id, data as Record<string, unknown>, d.deviceId, nowIso()) });
}

const planOf = async (d: TestDevice, goalId: string, week = "2026-11-02") => (await d.db.records.get([GOAL_WEEK_PLANS, weekPlanId(goalId, week)]))?.data as GoalWeekPlanData | undefined;

const goalInput = { name: "Pages", startDate: "2026-11-02", deadline: "2026-11-29", kind: "taskCount" as const, target: 600, workdays: [1, 2, 3, 4, 5] };

/** A goal on A, imported by B, so both devices hold the same goal and week plan. */
async function sharedGoal() {
  const a = await device("A");
  const goalId = await createGoal(a.db, goalInput);
  const b = await device("B");
  await importInto(b, await exportText(a), product);
  return { a, b, goalId };
}

/** Both devices change the current week's automatic amount differently on Wednesday: a conflict for that date. */
async function conflictOnWednesday() {
  const s = await sharedGoal();
  at("2026-11-04T08:00:00Z");
  await setWeekAllocation(s.a.db, s.goalId, "2026-11-16", 200, Date.now());
  await setWeekAllocation(s.b.db, s.goalId, "2026-11-23", 100, Date.now());
  return s;
}

describe("13. backup version 8 (derived)", () => {
  it("round-trips with identical IDs, hashes, and versions; re-import changes nothing", async () => {
    const a = await device("A");
    const goalId = await createGoal(a.db, goalInput);
    await setWeekAllocation(a.db, goalId, "2026-11-09", 200, Date.now());
    await recordAppUse(a.db, Date.now());
    await saveDashboard(a.db, MAIN_DASHBOARD_ID, { ...SUGGESTED_MAIN_DASHBOARD, name: "Main" });
    const task = await createTask(a.db, { title: "Draft", estimateMinutes: 50 });
    await createBlock(a.db, { taskId: task, date: "2026-11-02", startTime: "06:00", durationMinutes: 60 });
    const text = await exportText(a);
    const doc = JSON.parse(text);
    expect(doc.app.dataSchemaVersion).toBe(DATA_SCHEMA_VERSION);
    expect(DATA_SCHEMA_VERSION).toBe(8);
    for (const type of [GOAL_WEEK_PLANS, GOAL_WEEK_ALLOCATIONS, APP_USE_DAYS, DASHBOARDS, TASK_ESTIMATE_CAPTURES]) expect(doc.payload.records[type]).toHaveLength(1);
    // 400 over three automatic weeks is kept exactly: 400/3, never rounded.
    expect(doc.payload.records[GOAL_WEEK_PLANS][0].data.dates.at(-1).entries[0].segment).toEqual({ state: "allocated", allocation: { num: 400, den: 3 }, source: "automatic" });
    const b = await device("B");
    await importInto(b, text, { ...product, applyUpdates: true });
    const without = (rs: Awaited<ReturnType<typeof recordsOf>>) => rs.filter((r) => r.type !== "preferences");
    expect(without(await recordsOf(b))).toEqual(without(await recordsOf(a)));
    const before = await recordsOf(b);
    const again = await importInto(b, text, { ...product, applyUpdates: true });
    expect(again.result.appliedUpdates).toBe(0);
    expect(await recordsOf(b)).toEqual(before);
  });

  it("a version-7 file with version-8 data is refused; a newer version is refused; a weekly-plan tombstone is refused", async () => {
    const a = await device("A");
    await createGoal(a.db, goalInput);
    const text = await exportText(a);
    const b = await device("B");
    const before = await recordsOf(b);
    expect(await codeOf(importInto(b, mutate(text, (doc) => (doc.app.dataSchemaVersion = 7)), product))).toMatch(/UNKNOWN_RECORD_TYPE|INVALID_PAYLOAD/);
    const v8FieldOnly = mutate(text, (doc) => {
      doc.app.dataSchemaVersion = 7;
      delete doc.payload.records[GOAL_WEEK_PLANS];
    });
    expect(await codeOf(importInto(b, v8FieldOnly, product))).toBe("INVALID_PAYLOAD"); // goal.workdays in a version-7 file
    expect(await codeOf(importInto(b, mutate(text, (doc) => (doc.app.dataSchemaVersion = 9)), product))).toBe("NEWER_VERSION");
    const tomb = mutate(text, (doc) => {
      const plan = doc.payload.records[GOAL_WEEK_PLANS][0];
      delete doc.payload.records[GOAL_WEEK_PLANS];
      doc.payload.tombstones.push({ type: GOAL_WEEK_PLANS, id: plan.id, deletedAt: "2026-11-02T08:00:00.000Z", version: plan.version });
    });
    expect(await codeOf(importInto(b, tomb, product))).toBe("INVALID_PAYLOAD");
    expect(await recordsOf(b)).toEqual(before);
  });

  describe("pausing and resuming a goal's weekly plans (T-246)", () => {
    const allPlans = async (d: TestDevice) =>
      (await d.db.records.where("type").equals(GOAL_WEEK_PLANS).toArray()).map((r) => r.data as GoalWeekPlanData).sort((p, q) => p.weekStart.localeCompare(q.weekStart));
    const datesOf = (plans: GoalWeekPlanData[]) => plans.map((p) => [p.weekStart, p.dates.map((d) => [d.from, d.entries[0]!.segment.allocation])]);
    /** Created Monday 11-02 (150 a week: 600 over four weeks), paused Tuesday, its target raised to 700 on Thursday while paused. */
    async function pausedGoal() {
      const a = await device("A");
      const goalId = await createGoal(a.db, goalInput);
      at("2026-11-03T08:00:00Z");
      await setGoalStatus(a.db, goalId, "paused");
      at("2026-11-05T08:00:00Z");
      await updateGoal(a.db, goalId, { target: 700 }, registry, Date.now()); // would rewrite today's plan of an active goal
      at("2026-11-09T08:00:00Z"); // the next Monday: an active goal would start that week's plan
      await refreshWeekPlans(a.db, registry, "change");
      return { a, goalId };
    }

    it("no weekly plan is written or updated while paused; earlier plans stay; resuming needs the owner's choice", async () => {
      const { a, goalId } = await pausedGoal();
      expect(datesOf(await allPlans(a))).toEqual([["2026-11-02", [["2026-11-02", { num: 150, den: 1 }]]]]);
      const before = await recordsOf(a);
      expect(await codeOf(setGoalStatus(a.db, goalId, "active"))).toBe("RESUME_NEEDS_CHOICE");
      expect(await recordsOf(a)).toEqual(before);
    });

    it("resuming with a recalculated plan writes it from the resume date only; the paused days keep no plan", async () => {
      const { a, goalId } = await pausedGoal();
      const earlier = (await allPlans(a))[0];
      await resumeGoal(a.db, goalId, "recalculate", registry, Date.now());
      const plans = await allPlans(a);
      expect(plans[0]).toEqual(earlier); // the week before the pause is unchanged
      // 700 over the three weeks left, from Monday 11-09: nothing for 11-03 to 11-08.
      expect(datesOf(plans)).toEqual([["2026-11-02", [["2026-11-02", { num: 150, den: 1 }]]], ["2026-11-09", [["2026-11-09", { num: 700, den: 3 }]]]]);
      expect((await a.db.records.get([GOALS, goalId]))!.data).not.toHaveProperty("continuedAllocation");
    });

    it("resuming with the previous plan continues the weekly amount from before the pause in every later week, until the goal changes", async () => {
      const { a, goalId } = await pausedGoal();
      await resumeGoal(a.db, goalId, "continue", registry, Date.now());
      expect((await a.db.records.get([GOALS, goalId]))!.data).toMatchObject({ status: "active", continuedAllocation: { from: "2026-11-09", amount: { num: 150, den: 1 } } });
      at("2026-11-16T08:00:00Z");
      await refreshWeekPlans(a.db, registry, "change");
      expect(datesOf(await allPlans(a))).toEqual([
        ["2026-11-02", [["2026-11-02", { num: 150, den: 1 }]]],
        ["2026-11-09", [["2026-11-09", { num: 150, den: 1 }]]], // not 700 / 3
        ["2026-11-16", [["2026-11-16", { num: 150, den: 1 }]]],
      ]);
      // A change of the goal's plan ends the continued amount: the usual calculation takes over from that day.
      at("2026-11-17T08:00:00Z");
      await updateGoal(a.db, goalId, { target: 650 }, registry, Date.now());
      expect((await a.db.records.get([GOALS, goalId]))!.data).not.toHaveProperty("continuedAllocation");
      const week = (await allPlans(a)).find((p) => p.weekStart === "2026-11-16")!;
      expect(week.dates.map((d) => [d.from, d.entries[0]!.segment.allocation])).toEqual([["2026-11-16", { num: 150, den: 1 }], ["2026-11-17", { num: 325, den: 1 }]]);
    });

    it("so does a change of a weekly allocation; with no plan just before the pause, continuing is refused and nothing changes", async () => {
      const { a, goalId } = await pausedGoal();
      await resumeGoal(a.db, goalId, "continue", registry, Date.now());
      await setWeekAllocation(a.db, goalId, "2026-11-23", 100, Date.now());
      expect((await a.db.records.get([GOALS, goalId]))!.data).not.toHaveProperty("continuedAllocation");
      // Paused on the day it was created: the day before has no recorded plan.
      const b = await device("B");
      at("2026-11-09T08:00:00Z");
      const fresh = await createGoal(b.db, goalInput);
      await setGoalStatus(b.db, fresh, "paused");
      const before = await recordsOf(b);
      expect(await codeOf(resumeGoal(b.db, fresh, "continue", registry, Date.now()))).toBe("NOTHING_TO_CONTINUE");
      expect(await recordsOf(b)).toEqual(before);
      await resumeGoal(b.db, fresh, "recalculate", registry, Date.now());
      expect((await b.db.records.get([GOALS, fresh]))!.data).toMatchObject({ status: "active" });
    });
  });

  it("an abandoned goal gets no new weekly-plan writes and keeps its stored plans; reopened, its plans are written again (T-243)", async () => {
    const a = await device("A");
    const goalId = await createGoal(a.db, goalInput);
    at("2026-11-04T08:00:00Z");
    await setGoalStatus(a.db, goalId, "abandoned");
    const stored = await a.db.records.get([GOAL_WEEK_PLANS, weekPlanId(goalId, "2026-11-02")]);
    await updateGoal(a.db, goalId, { target: 900 }, registry, Date.now()); // would change today's plan of a running goal
    await refreshWeekPlans(a.db, registry, "change");
    expect(await a.db.records.get([GOAL_WEEK_PLANS, weekPlanId(goalId, "2026-11-02")])).toEqual(stored);
    await setGoalStatus(a.db, goalId, "active"); // reopen
    const reopened = (await planOf(a, goalId))!;
    expect(reopened.dates.map((d) => d.from)).toEqual(["2026-11-02", "2026-11-04"]); // a segment from today with the new target
  });

  it("an abandoned goal travels in version 8 with its status history; a version-7 file cannot hold the status (T-243)", async () => {
    const a = await device("A");
    const goalId = await createGoal(a.db, goalInput);
    at("2026-11-04T08:00:00Z");
    await setGoalStatus(a.db, goalId, "abandoned");
    const plansBefore = await a.db.records.where("type").equals(GOAL_WEEK_PLANS).toArray();
    expect(plansBefore).toHaveLength(1); // the plan written while it was active stays
    const text = await exportText(a);
    const b = await device("B");
    expect(await codeOf(importInto(b, text, product))).toBe("OK");
    const onB = (await b.db.records.get([GOALS, goalId]))!.data as { status: string; statusHistory: { from: string; status: string }[] };
    expect(onB.status).toBe("abandoned");
    expect(onB.statusHistory.map((e) => [e.from, e.status])).toEqual([["2026-11-02", "active"], ["2026-11-04", "abandoned"]]);
    expect(await b.db.records.where("type").equals(GOAL_WEEK_PLANS).count()).toBe(1);

    // The same goal as a version-7 file would carry it (no version-8 fields or types): refused only for the new status.
    const asV7 = (status: string) =>
      mutate(text, (doc) => {
        doc.app.dataSchemaVersion = 7;
        for (const type of [GOAL_WEEK_PLANS, GOAL_WEEK_ALLOCATIONS, GOAL_WEEK_PLAN_CHOICES, APP_USE_DAYS, DASHBOARDS, TASK_ESTIMATE_CAPTURES]) delete doc.payload.records[type];
        for (const env of doc.payload.records[GOALS]) {
          for (const field of ["workdays", "dailyCap", "planHistory", "statusHistory"]) delete env.data[field];
          env.data.status = status;
          env.contentHash = contentHashOf(env.data);
        }
      });
    const c = await device("C");
    const cBefore = await recordsOf(c);
    expect(await codeOf(importInto(c, asV7("abandoned"), product))).toBe("INVALID_PAYLOAD");
    expect(await recordsOf(c)).toEqual(cBefore);
    expect(await codeOf(importInto(c, asV7("completed"), product))).toBe("OK");
  });

  it("the stored version-7 sample imports, with no weekly plans (no data)", async () => {
    const b = await device("B");
    const text = readFileSync(new URL("./samples/pps-backup-format-v1-data-v7.json", import.meta.url), "utf8");
    expect(await codeOf(importInto(b, text, product))).toBe("OK");
    expect((await loadGoalPlanning(b.db)).plans).toEqual([]);
  });
});

describe("18. weekly plans and allocations through backups (T-223, T-227 to T-229)", () => {
  it("different weeks merge without conflict; the same week's manual allocation edited on both devices is an ordinary conflict; identical is already here", async () => {
    const { a, b, goalId } = await sharedGoal();
    await setWeekAllocation(a.db, goalId, "2026-11-16", 200, Date.now());
    await setWeekAllocation(b.db, goalId, "2026-11-16", 180, Date.now());
    const { preview } = await importInto(a, await exportText(b), { ...product, applyUpdates: true });
    expect(preview.items.filter((i) => i.type === GOAL_WEEK_ALLOCATIONS).map((i) => i.category)).toEqual(["conflict"]);
    expect((await a.db.pendingConflicts.toArray()).map((c) => c.type)).toEqual([GOAL_WEEK_ALLOCATIONS]);
  });

  it("with Apply updates off, an existing plan stays byte-identical and is counted as skipped; on, the dates merge and the conflict date is counted", async () => {
    const { a, b, goalId } = await conflictOnWednesday();
    const before = await a.db.records.get([GOAL_WEEK_PLANS, weekPlanId(goalId, "2026-11-02")]);
    const fromB = await exportText(b);
    const off = await importInto(a, fromB, product);
    expect(off.preview.counts.planMerge).toBe(1);
    expect(off.preview.counts.planDecisions).toBe(1);
    expect(off.result.skippedUpdates).toBeGreaterThanOrEqual(1);
    expect(await a.db.records.get([GOAL_WEEK_PLANS, weekPlanId(goalId, "2026-11-02")])).toEqual(before);
    await importInto(a, fromB, { ...product, applyUpdates: true });
    const merged = (await planOf(a, goalId))!;
    expect(merged.dates.map((d) => d.from)).toEqual(["2026-11-02", "2026-11-04"]);
    const wed = merged.dates[1]!;
    expect(candidatesOf(wed)).toHaveLength(2);
    // Each device's own segment stays in effect until the owner decides (T-227).
    const own = wed.entries.find((e) => e.device === a.deviceId)!.segment;
    expect(resolveDate(wed, a.deviceId)).toMatchObject({ kind: "conflict", segment: own });
    // Importing again changes nothing and adds no conflict.
    const snapshotAfter = await recordsOf(a);
    await importInto(a, fromB, { ...product, applyUpdates: true });
    expect(await recordsOf(a)).toEqual(snapshotAfter);
  });

  it("a plan whose entries cover one another is a data-integrity issue: neither imported as new nor merged, and this device's plan stays in effect (Codex review)", async () => {
    const { a, goalId } = await sharedGoal();
    const planId = weekPlanId(goalId, "2026-11-02");
    const before = await a.db.records.get([GOAL_WEEK_PLANS, planId]);
    const own = (await planOf(a, goalId))!.dates[0]!.entries[0]!;
    const [d1, d2] = [crypto.randomUUID(), crypto.randomUUID()];
    const segment = (num: number) => ({ state: "allocated" as const, allocation: { num, den: 1 }, source: "manual" as const });
    const withCycle = (text: string, change: (plan: GoalWeekPlanData) => void) =>
      mutate(text, (doc) => {
        const env = doc.payload.records[GOAL_WEEK_PLANS].find((e: { id: string }) => e.id === planId);
        change(env.data);
        env.contentHash = contentHashOf(env.data);
        env.version = { ...env.version, [d1]: 1 }; // newer than this device's, so it would be merged
      });
    const text = await exportText(a);
    // Two other devices' entries for Wednesday that each claim to have seen the other.
    const wednesday = withCycle(text, (plan) => {
      plan.dates.push({
        from: "2026-11-04",
        entries: [
          { device: d1, seq: 1, seen: { [d2]: 1 }, segment: segment(100) },
          { device: d2, seq: 1, seen: { [d1]: 1 }, segment: segment(90) },
        ].sort((p, q) => (p.device < q.device ? -1 : 1)) as GoalWeekPlanData["dates"][number]["entries"],
        options: [],
      });
    });
    const merging = await importInto(a, wednesday, { ...product, applyUpdates: true });
    expect(merging.preview.counts.planIntegrity).toBe(1);
    expect(merging.preview.counts.planMerge).toBe(0);
    expect(merging.preview.counts.planDecisions).toBe(0);
    expect(await a.db.records.get([GOAL_WEEK_PLANS, planId])).toEqual(before); // left unchanged
    expect(resolveDate((await planOf(a, goalId))!.dates[0]!, a.deviceId)).toEqual({ kind: "settled", segment: own.segment });

    // The reported shape, Monday's own entry and another device's covering each other, arriving as a new record.
    const monday = withCycle(text, (plan) => {
      plan.dates[0]!.entries = [
        { ...own, seen: { [d1]: 1 } },
        { device: d1, seq: 1, seen: { [own.device]: own.seq }, segment: segment(90) },
      ].sort((p, q) => (p.device < q.device ? -1 : 1));
    });
    const c = await device("C");
    const fresh = await importInto(c, monday, product);
    expect(fresh.preview.counts.planIntegrity).toBe(1);
    expect(fresh.preview.counts.planDecisions).toBe(0);
    expect(await planOf(c, goalId)).toBeUndefined(); // not imported as a silent "no data" week
    expect(await c.db.records.get([GOALS, goalId])).toBeTruthy(); // the rest of the file is imported
  });

  it("a file and a local plan without cycles whose merge would make one: counted as an integrity issue, and this device's plan stays unchanged (Codex review)", async () => {
    const { a, goalId } = await sharedGoal();
    const planId = weekPlanId(goalId, "2026-11-02");
    const text = await exportText(a);
    const original = (await planOf(a, goalId))!;
    const own = original.dates[0]!.entries[0]!;
    const d = crypto.randomUUID();
    const y = { state: "allocated" as const, allocation: { num: 90, den: 1 }, source: "manual" as const };
    const byDevice = (p: PlanEntryData, q: PlanEntryData) => (p.device < q.device ? -1 : 1);
    // Here: this device's next Monday entry claims to have seen D's first entry, which is not here
    // (a claim no entry bears out, so only data stored before that check could hold it).
    await storeUnchecked(a, GOAL_WEEK_PLANS, planId, { ...original, dates: [{ ...original.dates[0]!, entries: [{ ...own, seq: own.seq + 1, seen: { [d]: 1 } }] }] });
    const before = (await a.db.records.get([GOAL_WEEK_PLANS, planId]))!;
    // In the file: D's first entry claims this device's second, while the file holds its first.
    const incomingText = mutate(text, (doc) => {
      const env = doc.payload.records[GOAL_WEEK_PLANS].find((e: { id: string }) => e.id === planId);
      env.data.dates[0].entries = [own, { device: d, seq: 1, seen: { [own.device]: own.seq + 1 }, segment: y }].sort(byDevice);
      env.contentHash = contentHashOf(env.data);
      env.version = { ...env.version, [d]: 1 }; // concurrent with this device's version: a plan merge
    });
    const incoming = JSON.parse(incomingText).payload.records[GOAL_WEEK_PLANS].find((e: { id: string }) => e.id === planId).data as GoalWeekPlanData;
    expect(planHasCoverageCycle(incoming)).toBe(false);
    expect(planHasCoverageCycle(before.data as GoalWeekPlanData)).toBe(false);
    expect(hasCoverageCycle(mergePlans(before.data as GoalWeekPlanData, incoming)!.dates[0]!)).toBe(true); // only the merge has one
    for (const applyUpdates of [false, true]) {
      const { preview } = await importInto(a, incomingText, { ...product, applyUpdates });
      expect(preview.counts.planIntegrity).toBe(1);
      expect(preview.counts.planMerge).toBe(0);
      expect(preview.counts.planDecisions).toBe(0);
      expect(await a.db.records.get([GOAL_WEEK_PLANS, planId])).toEqual(before); // byte-identical
    }
    // The stored claim of an absent entry is shown for the owner to settle; this device's plan still applies.
    expect(resolveDate((await planOf(a, goalId))!.dates[0]!, a.deviceId)).toMatchObject({ kind: "inconsistent", segment: own.segment });
  });

  it("a choice whose counter would pass the maximum is refused (SEQ_LIMIT) and writes nothing; up to the maximum it is recorded; a plan write is skipped (Codex review)", async () => {
    const { a, goalId } = await sharedGoal();
    const planId = weekPlanId(goalId, "2026-11-02");
    const original = (await planOf(a, goalId))!;
    const own = original.dates[0]!.entries[0]!;
    const d = crypto.randomUUID();
    const y = { state: "allocated" as const, allocation: { num: 90, den: 1 }, source: "manual" as const };
    const byDevice = (p: PlanEntryData, q: PlanEntryData) => (p.device < q.device ? -1 : 1);
    // Malformed: Monday's entries cover each other, and D's claims this device's counter is at the maximum.
    const cyclic = (claim: number) => ({
      ...original,
      dates: [{ ...original.dates[0]!, entries: [{ ...own, seen: { [d]: 1 } }, { device: d, seq: 1, seen: { [own.device]: claim }, segment: y }].sort(byDevice) }],
    });
    // Malformed data stored before the integrity checks (normal writes refuse it, DATA_INTEGRITY).
    expect(await codeOf(putRecord(a.db, registry, GOAL_WEEK_PLANS, planId, cyclic(PLAN_SEQ_MAX)))).toBe("DATA_INTEGRITY");
    await storeUnchecked(a, GOAL_WEEK_PLANS, planId, cyclic(PLAN_SEQ_MAX));
    const stored = (await planOf(a, goalId))!.dates[0]!;
    expect(resolveDate(stored, a.deviceId).kind).toBe("inconsistent");
    expect(nextSeq(stored, a.deviceId)).toBe(PLAN_SEQ_MAX + 1);
    expect(canWriteEntry(stored, a.deviceId)).toBe(false);
    expect(canWriteEntry(stored, d)).toBe(true); // the other device can still decide
    const before = await recordsOf(a);
    expect(await codeOf(decidePlanDate(a.db, planId, "2026-11-02", y, canonicalize(stored)))).toBe("SEQ_LIMIT");
    expect(await recordsOf(a)).toEqual(before); // no plan entry and no choice event

    // One below the maximum: the choice is recorded at the maximum and settles the date.
    await storeUnchecked(a, GOAL_WEEK_PLANS, planId, cyclic(PLAN_SEQ_MAX - 1));
    const below = (await planOf(a, goalId))!.dates[0]!;
    await decidePlanDate(a.db, planId, "2026-11-02", y, canonicalize(below));
    const decided = (await planOf(a, goalId))!.dates[0]!;
    expect(decided.entries.find((e) => e.device === a.deviceId)!.seq).toBe(PLAN_SEQ_MAX);
    expect(resolveDate(decided, a.deviceId)).toEqual({ kind: "settled", segment: y });

    // A plan change that would need a new entry for that date is skipped; the recorded plan stays.
    const settled = await a.db.records.get([GOAL_WEEK_PLANS, planId]);
    await updateGoal(a.db, goalId, { target: 700 }, registry, Date.now()); // refreshes the week plans itself
    await refreshWeekPlans(a.db, registry, "change");
    expect(await a.db.records.get([GOAL_WEEK_PLANS, planId])).toEqual(settled);
  });

  describe("options past 64 and the per-record size limit (owner, 2026-11-04)", () => {
    // Segments of equal canonical length (six-digit amounts), so record sizes grow evenly.
    const manual = (num: number): SegmentData => ({ state: "allocated", allocation: { num, den: 1 }, source: "manual" });
    const sorted = <T>(list: T[]) => [...list].sort((p, q) => (canonicalize(p) < canonicalize(q) ? -1 : 1));
    const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => manual(from + i));
    /** Whether `data` written over `planId` on device `d` stays within the limit, on the exact envelope `putRecord` stores. */
    async function fitsOn(d: TestDevice, planId: string) {
      const row = await d.db.records.get([GOAL_WEEK_PLANS, planId]);
      return (data: GoalWeekPlanData) => envelopeFits(plannedWriteEnvelope(row, planId, data as unknown as Record<string, unknown>, d.deviceId, nowIso()));
    }
    /** The largest count of `range(from, n)` options for which `make(options)` still fits. */
    function largestFitting(make: (options: SegmentData[]) => GoalWeekPlanData, from: number, fits: (data: GoalWeekPlanData) => boolean): number {
      let low = 0;
      let high = 10_000;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(make(range(from, mid)))) low = mid;
        else high = mid - 1;
      }
      return low;
    }

    async function conflictSetup() {
      const s = await sharedGoal();
      const planId = weekPlanId(s.goalId, "2026-11-02");
      const original = (await planOf(s.a, s.goalId))!;
      const own = original.dates[0]!.entries[0]!;
      const theirs = manual(5);
      const other = crypto.randomUUID();
      const conflictWith = (options: SegmentData[]): GoalWeekPlanData => ({
        ...original,
        dates: [{ ...original.dates[0]!, entries: [own, { device: other, seq: 1, seen: {}, segment: theirs }].sort((p, q) => (p.device < q.device ? -1 : 1)), options: sorted(options) }],
      });
      return { ...s, planId, original, own, theirs, conflictWith };
    }

    it("a date keeps more than 64 options: a decision and an import merge succeed, none is dropped, and a backup round-trip keeps them", async () => {
      const { a, b, goalId, planId, own, theirs, conflictWith } = await conflictSetup();
      const earlier = range(100_000, 100);
      await putRecord(a.db, registry, GOAL_WEEK_PLANS, planId, conflictWith(earlier));
      const full = (await planOf(a, goalId))!.dates[0]!;
      await decidePlanDate(a.db, planId, "2026-11-02", theirs, canonicalize(full));
      const expected = sorted([...earlier, own.segment, theirs]);
      const decided = (await planOf(a, goalId))!.dates[0]!;
      expect(decided.options).toEqual(expected); // 102 options, every earlier one kept
      expect(resolveDate(decided, a.deviceId)).toEqual({ kind: "settled", segment: theirs });
      expect(canChangeChoice(decided)).toBe(true);
      // B still holds the original record: the merge brings all of them, in either "Apply updates" run.
      const fromA = await exportText(a);
      const merging = await importInto(b, fromA, { ...product, applyUpdates: true });
      expect(merging.preview.counts.planMerge).toBe(1);
      expect(merging.preview.counts.planTooLarge).toBe(0);
      expect((await planOf(b, goalId))!.dates[0]!.options).toEqual(expected);
      const again = await recordsOf(b);
      await importInto(b, fromA, { ...product, applyUpdates: true });
      expect(await recordsOf(b)).toEqual(again); // importing again changes nothing
      const c = await device("C");
      await importInto(c, await exportText(b), product);
      expect((await planOf(c, goalId))!.dates[0]!.options).toEqual(expected);
    });

    it("at the per-record size limit a decision is refused (RECORD_LIMIT) and an import merge is shown as too large; nothing is written or dropped", async () => {
      const { a, b, goalId, planId, original, conflictWith } = await conflictSetup();
      // The most options with which A's conflicting record still fits; the decision would add two more.
      const n = largestFitting(conflictWith, 100_000, await fitsOn(a, planId));
      expect(n).toBeGreaterThan(64);
      await putRecord(a.db, registry, GOAL_WEEK_PLANS, planId, conflictWith(range(100_000, n)));
      const stored = (await planOf(a, goalId))!;
      expect(envelopeFits(toEnvelope((await a.db.records.get([GOAL_WEEK_PLANS, planId]))!))).toBe(true);
      const before = await recordsOf(a);
      expect(await codeOf(decidePlanDate(a.db, planId, "2026-11-02", manual(5), canonicalize(stored.dates[0]!)))).toBe("RECORD_LIMIT");
      expect(await recordsOf(a)).toEqual(before); // no entry, no event, no option removed
      expect(resolveDate((await planOf(a, goalId))!.dates[0]!, a.deviceId).kind).toBe("conflict"); // still the owner's to decide
      const fromA = await exportText(a); // the stored record is within the limit, so it exports

      // B keeps other options that fit on their own; merged with A's, the record would not.
      const onB = (options: SegmentData[]): GoalWeekPlanData => ({ ...original, dates: [{ ...original.dates[0]!, options: sorted(options) }] });
      const m = largestFitting(onB, 200_000, await fitsOn(b, planId));
      await putRecord(b.db, registry, GOAL_WEEK_PLANS, planId, onB(range(200_000, m)));
      const bBefore = await b.db.records.get([GOAL_WEEK_PLANS, planId]);
      for (const applyUpdates of [false, true]) {
        const { preview } = await importInto(b, fromA, { ...product, applyUpdates });
        expect(preview.counts.planTooLarge).toBe(1);
        expect(preview.counts.planMerge).toBe(0);
        expect(preview.counts.planIntegrity).toBe(0);
        expect(await b.db.records.get([GOAL_WEEK_PLANS, planId])).toEqual(bBefore); // byte-identical, nothing dropped
      }
      expect(await codeOf(exportText(b))).toBe("OK"); // B's own data still exports
    });

    it("when this device's record grows between the preview and the import, the write is measured again and a merge past the limit is not written", async () => {
      const { a, b, goalId, planId, original, own, theirs, conflictWith } = await conflictSetup();
      await putRecord(a.db, registry, GOAL_WEEK_PLANS, planId, conflictWith([]));
      await decidePlanDate(a.db, planId, "2026-11-02", theirs, canonicalize((await planOf(a, goalId))!.dates[0]!));
      const opened = await openBackupFile(blobOf(await exportText(a)), registry);
      const preview = await previewImport(b.db, opened, registry);
      expect(preview.counts.planMerge).toBe(1); // fits when previewed
      expect(preview.counts.planTooLarge).toBe(0);
      // Then B's record grows to as many options as still fit, so the merge no longer would.
      const onB = (options: SegmentData[]): GoalWeekPlanData => ({ ...original, dates: [{ ...original.dates[0]!, options: sorted([own.segment, ...options]) }] });
      await putRecord(b.db, registry, GOAL_WEEK_PLANS, planId, onB(range(300_000, largestFitting(onB, 300_000, await fitsOn(b, planId)))));
      const grown = await b.db.records.get([GOAL_WEEK_PLANS, planId]);
      const result = await applyImport(b.db, opened, registry, { applyUpdates: true, applyDisplaySettings: false });
      expect(result.counts.planTooLarge).toBe(1);
      expect(await b.db.records.get([GOAL_WEEK_PLANS, planId])).toEqual(grown); // nothing written past the limit, nothing dropped
      expect(await codeOf(exportText(b))).toBe("OK");
    });
  });

  it("an imported plan envelope near 256 KiB because of a long ISO time: a decision, the app's plan write, and import merges that would pass the limit change nothing; the data still exports (Codex review)", async () => {
    const { a, goalId } = await sharedGoal();
    const planId = weekPlanId(goalId, "2026-11-02");
    const original = (await planOf(a, goalId))!;
    const own = original.dates[0]!.entries[0]!;
    const theirs: SegmentData = { state: "allocated", allocation: { num: 5, den: 1 }, source: "manual" };
    // Monday holds a conflict on A, so a decision can be tried on the importing device.
    await putRecord(a.db, registry, GOAL_WEEK_PLANS, planId, {
      ...original,
      dates: [{ ...original.dates[0]!, entries: [own, { device: crypto.randomUUID(), seq: 1, seen: {}, segment: theirs }].sort((p, q) => (p.device < q.device ? -1 : 1)) }],
    });
    // The plan's createdAt gets a long fractional second (valid ISO), leaving 16 bytes under the limit.
    const room = 16;
    const plain = await exportText(a);
    const padded = mutate(plain, (doc) => {
      const env = doc.payload.records[GOAL_WEEK_PLANS].find((e: { id: string }) => e.id === planId);
      const missing = MAX_ENVELOPE_BYTES - room - canonicalBytes(env).length;
      env.createdAt = env.createdAt.replace("Z", `${"0".repeat(missing)}Z`);
    });
    const c = await device("C");
    await importInto(c, padded, product);
    const stored = (await c.db.records.get([GOAL_WEEK_PLANS, planId]))!;
    expect(canonicalBytes(toEnvelope(stored)).length).toBe(MAX_ENVELOPE_BYTES - room); // accepted, near the limit
    const before = await recordsOf(c);

    // A decision would raise C's version counter and add options: refused, nothing written.
    const monday = (stored.data as GoalWeekPlanData).dates[0]!;
    expect(await codeOf(decidePlanDate(c.db, planId, "2026-11-02", theirs, canonicalize(monday)))).toBe("RECORD_LIMIT");
    expect(await recordsOf(c)).toEqual(before);

    // On Tuesday, a plan change would add a date to the record: the write is skipped.
    at("2026-11-03T08:00:00Z");
    await setWeekAllocation(c.db, goalId, "2026-11-09", 300);
    expect(await c.db.records.get([GOAL_WEEK_PLANS, planId])).toEqual(stored);

    // An import merge whose written envelope would pass the limit: a content change from A, and a
    // file holding only part of C's entries with another device in its version vector, whose merge
    // gives C's own content and would combine the versions only. Neither file is large itself; the
    // written envelope keeps C's long createdAt.
    await decidePlanDate(a.db, planId, "2026-11-02", theirs, canonicalize((await planOf(a, goalId))!.dates[0]!));
    const versionOnly = mutate(plain, (doc) => {
      const env = doc.payload.records[GOAL_WEEK_PLANS].find((e: { id: string }) => e.id === planId);
      env.data.dates[0].entries = env.data.dates[0].entries.filter((e: { device: string }) => e.device === own.device);
      env.contentHash = contentHashOf(env.data);
      env.version = { ...env.version, [crypto.randomUUID()]: 1 };
    });
    expect(canonicalize(mergePlans(stored.data as GoalWeekPlanData, JSON.parse(versionOnly).payload.records[GOAL_WEEK_PLANS][0].data))).toBe(canonicalize(stored.data));
    for (const file of [await exportText(a), versionOnly]) {
      for (const applyUpdates of [false, true]) {
        const { preview } = await importInto(c, file, { ...product, applyUpdates });
        expect(preview.counts.planTooLarge).toBe(1);
        expect(preview.counts.planMerge).toBe(0);
        expect(await c.db.records.get([GOAL_WEEK_PLANS, planId])).toEqual(stored); // kept as it is, no raw error
      }
    }
    expect(await codeOf(exportText(c))).toBe("OK"); // the accepted records still export
  });

  describe("version vectors stay within 32 devices (Codex review, 2026-11-04)", () => {
    /** A copy of the file whose record `id` of `type` also lists `count` more (made-up) devices. */
    const withDevices = (text: string, type: string, id: string, count: number) =>
      mutate(text, (doc) => {
        const env = doc.payload.records[type].find((e: { id: string }) => e.id === id);
        for (let i = 0; i < count; i++) env.version[crypto.randomUUID()] = 1;
      });
    const vectorOf = async (d: TestDevice, type: string, id: string) => Object.keys((await d.db.records.get([type, id]))!.version).length;

    it("a local write, a deletion, a plan decision, and the app's plan write that would make a 33rd device are refused, nothing changes, and options keep no count limit", async () => {
      const { a, goalId } = await sharedGoal();
      const planId = weekPlanId(goalId, "2026-11-02");
      const original = (await planOf(a, goalId))!;
      const own = original.dates[0]!.entries[0]!;
      const theirs: SegmentData = { state: "allocated", allocation: { num: 5, den: 1 }, source: "manual" };
      const earlier = Array.from({ length: 100 }, (_, i): SegmentData => ({ state: "allocated", allocation: { num: 100_000 + i, den: 1 }, source: "manual" }));
      // Monday: a conflict with 100 earlier options.
      await putRecord(a.db, registry, GOAL_WEEK_PLANS, planId, {
        ...original,
        dates: [{ ...original.dates[0]!, entries: [own, { device: crypto.randomUUID(), seq: 1, seen: {}, segment: theirs }].sort((p, q) => (p.device < q.device ? -1 : 1)), options: earlier.sort((p, q) => (canonicalize(p) < canonicalize(q) ? -1 : 1)) }],
      });
      const plain = await exportText(a);
      const fullFile = (text: string, type: string, id: string) => withDevices(text, type, id, 32 - Object.keys(JSON.parse(text).payload.records[type].find((e: { id: string }) => e.id === id).version).length);

      // C imports the goal and the plan each listing 32 devices already (valid): any write from C would add a 33rd.
      const c = await device("C");
      await importInto(c, fullFile(fullFile(plain, GOALS, goalId), GOAL_WEEK_PLANS, planId), product);
      expect([await vectorOf(c, GOALS, goalId), await vectorOf(c, GOAL_WEEK_PLANS, planId)]).toEqual([32, 32]);
      const before = await recordsOf(c);
      const tombstones = await c.db.tombstones.count();
      expect(await codeOf(updateGoal(c.db, goalId, { name: "Renamed" }, registry, Date.now()))).toBe("TOO_MANY_DEVICES");
      expect(await codeOf(deleteRecord(c.db, GOALS, goalId))).toBe("TOO_MANY_DEVICES");
      const monday = (await planOf(c, goalId))!.dates[0]!;
      expect(await codeOf(decidePlanDate(c.db, planId, "2026-11-02", theirs, canonicalize(monday)))).toBe("DEVICE_LIMIT");
      expect(await recordsOf(c)).toEqual(before);
      expect(await c.db.tombstones.count()).toBe(tombstones);
      // The app's plan write on Tuesday would add C as well: the step reports it, and the plan is not written.
      at("2026-11-03T08:00:00Z");
      const plans = (await loadGoalPlanning(c.db)).plans;
      expect(planWriteLimit(plans, c.deviceId, nowIso())(plans[0]!.data)).toBe("devices");
      const planRow = await c.db.records.get([GOAL_WEEK_PLANS, planId]);
      await setWeekAllocation(c.db, goalId, "2026-11-09", 300, Date.now());
      expect(await c.db.records.get([GOAL_WEEK_PLANS, planId])).toEqual(planRow);
      expect(await codeOf(exportText(c))).toBe("OK"); // the records still export

      // With 31 devices listed, C is the 32nd: the decision is recorded, with all 102 options.
      at("2026-11-02T08:00:00Z");
      const d = await device("D");
      const almost = withDevices(plain, GOAL_WEEK_PLANS, planId, 31 - Object.keys(JSON.parse(plain).payload.records[GOAL_WEEK_PLANS].find((e: { id: string }) => e.id === planId).version).length);
      await importInto(d, almost, product);
      await decidePlanDate(d.db, planId, "2026-11-02", theirs, canonicalize((await planOf(d, goalId))!.dates[0]!));
      expect(await vectorOf(d, GOAL_WEEK_PLANS, planId)).toBe(32);
      expect((await planOf(d, goalId))!.dates[0]!.options).toHaveLength(102); // no count limit on options
      expect(await codeOf(exportText(d))).toBe("OK");
    });

    it("an import whose merge would list more than 32 devices is shown in the preview and writes nothing; resolving a conflict that would do so is refused", async () => {
      const { a, goalId } = await sharedGoal();
      const planId = weekPlanId(goalId, "2026-11-02");
      // C first gets A's goal and plan, each listing 20 more devices.
      const c = await device("C");
      const first = await exportText(a);
      await importInto(c, withDevices(withDevices(first, GOALS, goalId, 20), GOAL_WEEK_PLANS, planId, 20), product);
      // A then changes both; its next file lists 20 other devices. Each file is valid on its own (21 devices).
      await setWeekAllocation(a.db, goalId, "2026-11-02", 100, Date.now());
      await updateGoal(a.db, goalId, { name: "Pages, revised" }, registry, Date.now());
      const second = withDevices(withDevices(await exportText(a), GOALS, goalId, 20), GOAL_WEEK_PLANS, planId, 20);
      const planBefore = await c.db.records.get([GOAL_WEEK_PLANS, planId]);
      for (const applyUpdates of [false, true]) {
        const { preview } = await importInto(c, second, { ...product, applyUpdates });
        expect(preview.counts.planTooManyDevices).toBe(1);
        expect(preview.counts.planMerge).toBe(0);
        expect(preview.counts.planTooLarge).toBe(0);
        expect(await c.db.records.get([GOAL_WEEK_PLANS, planId])).toEqual(planBefore); // nothing written
      }
      // The goal's two versions are an ordinary conflict; keeping either would combine 41 devices plus C.
      const goalBefore = await c.db.records.get([GOALS, goalId]);
      const conflict = (await c.db.pendingConflicts.toArray()).find((p) => p.type === GOALS && p.id === goalId)!;
      expect(conflict).toBeTruthy();
      for (const resolution of ["keepDevice", "useBackup"] as const) {
        expect(await codeOf(decide(c.db, conflict.conflictId, resolution, registry))).toBe("TOO_MANY_DEVICES");
      }
      expect(await c.db.records.get([GOALS, goalId])).toEqual(goalBefore);
      expect(await c.db.pendingConflicts.get(conflict.conflictId)).toBeTruthy(); // still the owner's to decide
      expect(await codeOf(exportText(c))).toBe("OK");
    });
    it("with this device's counter already at Number.MAX_SAFE_INTEGER, every write that would raise it is refused: edit, deletion, decision, plan write, merge, and conflict resolution; nothing changes and the records still export", async () => {
      const { a, goalId } = await sharedGoal();
      const planId = weekPlanId(goalId, "2026-11-02");
      const original = (await planOf(a, goalId))!;
      const own = original.dates[0]!.entries[0]!;
      const theirs: SegmentData = { state: "allocated", allocation: { num: 5, den: 1 }, source: "manual" };
      // Monday holds a conflict, so a decision can be tried.
      await putRecord(a.db, registry, GOAL_WEEK_PLANS, planId, {
        ...original,
        dates: [{ ...original.dates[0]!, entries: [own, { device: crypto.randomUUID(), seq: 1, seen: {}, segment: theirs }].sort((p, q) => (p.device < q.device ? -1 : 1)) }],
      });
      const c = await device("C");
      // A valid file in which C's own counter for the goal and the plan is already the maximum the format accepts.
      const atMaximum = (text: string) =>
        mutate(text, (doc) => {
          for (const [type, id] of [[GOALS, goalId], [GOAL_WEEK_PLANS, planId]] as const) {
            doc.payload.records[type].find((e: { id: string }) => e.id === id).version[c.deviceId] = Number.MAX_SAFE_INTEGER;
          }
        });
      await importInto(c, atMaximum(await exportText(a)), product);
      expect((await c.db.records.get([GOALS, goalId]))!.version[c.deviceId]).toBe(Number.MAX_SAFE_INTEGER);
      const before = await recordsOf(c);
      const tombstones = await c.db.tombstones.count();

      expect(await codeOf(updateGoal(c.db, goalId, { name: "Renamed" }, registry, Date.now()))).toBe("VERSION_COUNTER_EXHAUSTED");
      expect(await codeOf(deleteRecord(c.db, GOALS, goalId))).toBe("VERSION_COUNTER_EXHAUSTED");
      const monday = (await planOf(c, goalId))!.dates[0]!;
      expect(await codeOf(decidePlanDate(c.db, planId, "2026-11-02", theirs, canonicalize(monday)))).toBe("VERSION_LIMIT");
      const plans = (await loadGoalPlanning(c.db)).plans;
      expect(planWriteLimit(plans, c.deviceId, nowIso())(plans[0]!.data)).toBe("versionCounter"); // the plan write is reported, not written
      at("2026-11-03T08:00:00Z");
      await setWeekAllocation(c.db, goalId, "2026-11-09", 300, Date.now());
      // The allocation itself is a new record of C's; the goal and the plan are unchanged.
      expect((await recordsOf(c)).filter((r) => r.type !== GOAL_WEEK_ALLOCATIONS)).toEqual(before);
      expect(await c.db.tombstones.count()).toBe(tombstones);

      // A's later changes: the plan merge would raise C's counter (shown, nothing written); the goal's
      // two versions are a conflict whose resolution would too (refused, still pending).
      at("2026-11-02T08:00:00Z");
      await decidePlanDate(a.db, planId, "2026-11-02", theirs, canonicalize((await planOf(a, goalId))!.dates[0]!));
      await updateGoal(a.db, goalId, { name: "Pages, revised" }, registry, Date.now());
      const later = await exportText(a);
      for (const applyUpdates of [false, true]) {
        const { preview } = await importInto(c, later, { ...product, applyUpdates });
        expect(preview.counts.planVersionCounter).toBe(1);
        expect(preview.counts.planMerge).toBe(0);
      }
      const conflict = (await c.db.pendingConflicts.toArray()).find((p) => p.type === GOALS && p.id === goalId)!;
      const pending = await c.db.pendingConflicts.toArray();
      for (const resolution of ["keepDevice", "useBackup"] as const) {
        expect(await codeOf(decide(c.db, conflict.conflictId, resolution, registry))).toBe("VERSION_COUNTER_EXHAUSTED");
      }
      // The goal and the plan are unchanged (A's choice event arrived as a new history record).
      const goalAndPlan = (rows: Awaited<ReturnType<typeof recordsOf>>) => rows.filter((r) => r.type === GOALS || r.type === GOAL_WEEK_PLANS);
      expect(goalAndPlan(await recordsOf(c))).toEqual(goalAndPlan(before));
      expect(await c.db.pendingConflicts.toArray()).toEqual(pending); // the conflict and its versions stay as they were
      expect(await codeOf(exportText(c))).toBe("OK"); // the original records still export
    });
  });

  it("a new plan record carrying an undecided date is imported as new with Apply updates off: a third device shows no data for it (D-015, T-228)", async () => {
    const { a, b, goalId } = await conflictOnWednesday();
    await importInto(a, await exportText(b), { ...product, applyUpdates: true });
    const c = await device("C");
    const { preview } = await importInto(c, await exportText(a), product);
    expect(preview.counts.planDecisions).toBe(1);
    const plans = (await loadGoalPlanning(c.db)).plans.map((p) => p.data);
    expect(plans).toHaveLength(1);
    expect(planDateOn(plans, "2026-11-04", c.deviceId)!.resolution.kind).toBe("undecided");
    expect(planDateOn(plans, "2026-11-03", c.deviceId)!.resolution.kind).toBe("settled");
    void goalId;
  });

  it("a decision travels with the record and its history event; re-import adds no event; an older backup removes none (T-237)", async () => {
    const { a, b, goalId } = await conflictOnWednesday();
    const fromB = await exportText(b);
    await importInto(a, fromB, { ...product, applyUpdates: true });
    const plan = (await planOf(a, goalId))!;
    const wed = plan.dates.find((d) => d.from === "2026-11-04")!;
    const x = wed.entries.find((e) => e.device === a.deviceId)!.segment;
    const olderA = await exportText(a);
    at("2026-11-04T09:00:00Z");
    await decidePlanDate(a.db, weekPlanId(goalId, "2026-11-02"), "2026-11-04", x, canonicalize(wed), Date.now());
    const events = (await loadGoalPlanning(a.db)).choices;
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ from: "2026-11-04", device: a.deviceId, seq: 2, previous: x, chosen: x });
    expect(eventStatus(events[0]!.data, [(await planOf(a, goalId))!])).toBe("current");

    const newerA = await exportText(a);
    // B: with Apply updates off, the event arrives but the plan merge is skipped: "not applied here".
    await importInto(b, newerA, product);
    const onB = await loadGoalPlanning(b.db);
    expect(onB.choices).toHaveLength(1);
    expect(eventStatus(onB.choices[0]!.data, onB.plans.map((p) => p.data))).toBe("notApplied");
    // Merged later with Apply updates on: the same event becomes current without being edited.
    await importInto(b, newerA, { ...product, applyUpdates: true });
    const merged = await loadGoalPlanning(b.db);
    expect(eventStatus(merged.choices[0]!.data, merged.plans.map((p) => p.data))).toBe("current");
    expect(resolveDate(merged.plans[0]!.data.dates.find((d) => d.from === "2026-11-04")!, b.deviceId)).toEqual({ kind: "settled", segment: x });
    const count = (await loadGoalPlanning(b.db)).choices.length;
    await importInto(b, newerA, { ...product, applyUpdates: true });
    await importInto(b, olderA, { ...product, applyUpdates: true });
    expect((await loadGoalPlanning(b.db)).choices).toHaveLength(count);
  });

  it("an event whose goal is unknown in the file and on this device is refused, as for any link", async () => {
    const { a, b, goalId } = await conflictOnWednesday();
    await importInto(a, await exportText(b), { ...product, applyUpdates: true });
    const plan = (await planOf(a, goalId))!;
    const wed = plan.dates.find((d) => d.from === "2026-11-04")!;
    await decidePlanDate(a.db, weekPlanId(goalId, "2026-11-02"), "2026-11-04", wed.entries[0]!.segment, canonicalize(wed), Date.now());
    const text = mutate(await exportText(a), (doc) => {
      doc.payload.records[GOAL_WEEK_PLAN_CHOICES][0].data.goalId = "99999999-9999-4999-8999-999999999999";
      const env = doc.payload.records[GOAL_WEEK_PLAN_CHOICES][0];
      env.contentHash = contentHashOf(env.data);
      // Its ID follows its data, so the file is refused for the unknown goal, not for a mismatched ID.
      env.id = planChoiceId(env.data.goalId, env.data.weekStart, env.data.from, env.data.device, env.data.seq);
    });
    const c = await device("C");
    expect(await codeOf(importInto(c, text, product))).toBe("UNRESOLVED_REFERENCE");
  });
});

describe("derived IDs match their natural keys (Codex review, 2026-11-04)", () => {
  const DERIVED = [TASK_ESTIMATE_CAPTURES, APP_USE_DAYS, GOAL_WEEK_ALLOCATIONS, GOAL_WEEK_PLANS, GOAL_WEEK_PLAN_CHOICES];
  const sample = () => readFileSync(new URL("./samples/pps-backup-format-v1-data-v8.json", import.meta.url), "utf8");
  type Env = { id: string; data: any; contentHash: string };
  /** A copy of `text` changed by `change`, with content hashes and the integrity hash computed again. */
  const changed = (text: string, change: (records: Record<string, Env[]>, doc: any) => void) =>
    mutate(text, (doc) => {
      change(doc.payload.records, doc);
      for (const list of Object.values(doc.payload.records) as Env[][]) for (const env of list) env.contentHash = contentHashOf(env.data);
    });
  const refusal = async (text: string) => {
    try {
      await openBackupFile(blobOf(text), registry);
      return "OK";
    } catch (e) {
      expect((e as { code?: string }).code).toBe("INVALID_PAYLOAD");
      return (e as Error).message; // starts with the code
    }
  };

  it("a correct backup whose weekly plan gets another ID (integrity recomputed) is refused before anything is written", async () => {
    const { a, b, goalId } = await sharedGoal();
    const planId = weekPlanId(goalId, "2026-11-02");
    const text = await exportText(a);
    const otherId = crypto.randomUUID();
    const renamed = changed(text, (records) => {
      records[GOAL_WEEK_PLANS]!.find((e) => e.id === planId)!.id = otherId;
    });
    // B already holds the same goal and week under the derived ID; C has nothing yet.
    const c = await device("C");
    for (const d of [b, c]) {
      const before = await snapshot(d.db);
      const imports = await d.db.importLog.count();
      for (const applyUpdates of [false, true]) expect(await codeOf(importInto(d, renamed, { ...product, applyUpdates }))).toBe("INVALID_PAYLOAD");
      expect(await snapshot(d.db)).toEqual(before);
      expect(await d.db.importLog.count()).toBe(imports);
      expect(await d.db.records.get([GOAL_WEEK_PLANS, otherId])).toBeUndefined();
    }
    expect(await codeOf(importInto(c, text, product))).toBe("OK"); // the correct file still imports
    expect((await c.db.records.where("type").equals(GOAL_WEEK_PLANS).toArray()).map((r) => r.id)).toEqual([planId]);
  });

  it("every type with a derived ID is refused under another ID, under its old ID with another key, and as a second record for the same key", async () => {
    expect(await refusal(sample())).toBe("OK");
    for (const type of DERIVED) {
      // Another ID for the same content.
      const other = changed(sample(), (records) => {
        records[type]![0]!.id = crypto.randomUUID();
      });
      expect(await refusal(other)).toMatch(/^INVALID_PAYLOAD: records\.\w+\[0\]: the ID does not match/);
      // A second record for the same natural key (e.g. the same goal and week, the same choice event).
      const twice = changed(sample(), (records) => {
        records[type]!.push({ ...structuredClone(records[type]![0]!), id: crypto.randomUUID() });
      });
      expect(await refusal(twice)).toMatch(/^INVALID_PAYLOAD: .*the ID does not match/);
    }
    // The old ID with another natural key.
    const otherKey: [string, (d: any) => void][] = [
      [TASK_ESTIMATE_CAPTURES, (d) => (d.occurrenceDate = d.occurrenceDate === null ? "2026-11-30" : null)],
      [APP_USE_DAYS, (d) => (d.date = "2026-12-31")],
      [GOAL_WEEK_ALLOCATIONS, (d) => (d.goalId = crypto.randomUUID())],
      [GOAL_WEEK_PLANS, (d) => (d.goalId = crypto.randomUUID())],
      [GOAL_WEEK_PLAN_CHOICES, (d) => (d.seq += 1)],
    ];
    for (const [type, change] of otherKey) {
      const text = changed(sample(), (records) => change(records[type]![0]!.data));
      expect(await refusal(text)).toMatch(/^INVALID_PAYLOAD: .*the ID does not match/);
    }
    // A pending conflict's versions under another ID.
    const conflictText = changed(sample(), (_records, doc) => {
      const conflict = doc.payload.pendingConflicts[0];
      expect(DERIVED).toContain(conflict.type);
      const id = crypto.randomUUID();
      conflict.id = id;
      for (const entry of [conflict.local, conflict.incoming]) if (entry && !entry.deleted) entry.envelope.id = id;
      for (const entry of [conflict.local, conflict.incoming]) if (entry && !entry.deleted) entry.envelope.contentHash = contentHashOf(entry.envelope.data);
    });
    expect(await refusal(conflictText)).toMatch(/^INVALID_PAYLOAD: pendingConflicts.*the ID does not match/);
  });

  it("no local write stores a derived-ID record under another ID, and keeping both is never offered for these types", async () => {
    const { a, goalId } = await sharedGoal();
    const plan = (await planOf(a, goalId))!;
    const before = await recordsOf(a);
    expect(await codeOf(putRecord(a.db, registry, GOAL_WEEK_PLANS, crypto.randomUUID(), plan))).toBe("ID_MISMATCH");
    expect(await codeOf(putRecord(a.db, registry, APP_USE_DAYS, crypto.randomUUID(), { date: "2026-11-02" }))).toBe("ID_MISMATCH");
    expect(await recordsOf(a)).toEqual(before);
    for (const type of DERIVED) expect(registry.allowsKeepBoth(type)).toBe(false);
  });

  it("resolving a conflict or restoring an archived version whose ID does not match its data is refused with nothing changed; matching versions still work", async () => {
    const { a, b, goalId } = await sharedGoal();
    await setWeekAllocation(a.db, goalId, "2026-11-09", 200, Date.now());
    await setWeekAllocation(b.db, goalId, "2026-11-09", 100, Date.now());
    await importInto(a, await exportText(b), product);
    const allocationId = weekAllocationId(goalId, "2026-11-09");
    const conflict = (await a.db.pendingConflicts.toArray()).find((p) => p.type === GOAL_WEEK_ALLOCATIONS && p.id === allocationId)!;
    expect(conflict).toBeTruthy();
    const current = (await a.db.records.get([GOAL_WEEK_ALLOCATIONS, allocationId]))!;
    const amount = async () => ((await a.db.records.get([GOAL_WEEK_ALLOCATIONS, allocationId]))!.data as GoalWeekAllocationData).revisions.at(-1)!.amount;
    const state = async () => ({
      records: await recordsOf(a),
      pending: await a.db.pendingConflicts.toArray(),
      replaced: await a.db.replacedVersions.toArray(),
      tombstones: await a.db.tombstones.toArray(),
    });
    // As a build before the check might have left them: every version agrees on another week, so the
    // immutable-field checks pass, but none derives this record's ID.
    const otherWeek = <T>(entry: T): T => {
      const copy = structuredClone(entry) as T & { deleted?: boolean; envelope?: { data: GoalWeekAllocationData } };
      if (copy.envelope) copy.envelope.data.weekStart = "2026-11-16";
      return copy;
    };
    await a.db.records.put({ ...current, data: { ...current.data, weekStart: "2026-11-16" } });
    await a.db.pendingConflicts.put({ ...conflict, incoming: otherWeek(conflict.incoming), local: conflict.local && otherWeek(conflict.local) });
    const before = await state();
    for (const resolution of ["useBackup", "keepDevice"] as const) {
      expect(await codeOf(decide(a.db, conflict.conflictId, resolution, registry))).toBe("ID_MISMATCH");
      expect(await state()).toEqual(before); // the record, the conflict, and the archive are unchanged
    }

    // With matching versions, using the backup's works; this device's 200 goes to the archive.
    await a.db.records.put(current);
    await a.db.pendingConflicts.put(conflict);
    expect(await amount()).toBe(200);
    await decide(a.db, conflict.conflictId, "useBackup", registry);
    expect(await amount()).toBe(100);
    const archived = (await a.db.replacedVersions.toArray()).find((r) => r.type === GOAL_WEEK_ALLOCATIONS && r.id === allocationId)!;
    expect(archived).toBeTruthy();

    // With no live record here, an archived version is the only one known: restoring it under an ID
    // its data does not derive is refused.
    const live = (await a.db.records.get([GOAL_WEEK_ALLOCATIONS, allocationId]))!;
    await a.db.records.delete([GOAL_WEEK_ALLOCATIONS, allocationId]);
    await a.db.tombstones.put({ type: GOAL_WEEK_ALLOCATIONS, id: allocationId, deletedAt: new Date().toISOString(), version: live.version });
    await a.db.replacedVersions.put({ ...archived, entry: otherWeek(archived.entry) });
    const beforeRestore = await state();
    expect(await codeOf(restoreReplacedVersion(a.db, registry, archived.replacedId))).toBe("ID_MISMATCH");
    expect(await state()).toEqual(beforeRestore);

    // The matching archived version is restored.
    await a.db.replacedVersions.put(archived);
    await restoreReplacedVersion(a.db, registry, archived.replacedId);
    expect(await amount()).toBe(200);
    expect(await a.db.replacedVersions.get(archived.replacedId)).toBeUndefined();
  });
});

describe("12. app-use dates (T-203 to T-205)", () => {
  it("imports merge both devices' dates, never erase one, re-import changes nothing; the preview counts use dates on their own", async () => {
    const a = await device("A");
    const b = await device("B");
    for (const day of ["2026-11-01", "2026-11-02"]) {
      at(`${day}T10:00:00Z`);
      await recordAppUse(a.db, Date.now());
    }
    for (const day of ["2026-11-02", "2026-11-03"]) {
      at(`${day}T10:00:00Z`);
      await recordAppUse(b.db, Date.now());
    }
    expect(await recordAppUse(b.db, Date.now())).toBeNull(); // once per date
    const { preview } = await importInto(b, await exportText(a), product);
    expect(preview.counts.appUseDates).toBe(1);
    expect(preview.counts.new).toBe(0);
    expect((await loadInsightRecords(b.db)).appUseDates).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    await importInto(a, await exportText(b), product);
    expect((await loadInsightRecords(a.db)).appUseDates).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
  });
});

describe("11. dashboards in backups (T-201)", () => {
  it("names, cards, order, sizes, and windows travel and stay editable on the destination", async () => {
    const a = await device("A");
    const cards = [...SUGGESTED_MAIN_DASHBOARD.cards].reverse().map((c, i) => ({ ...c, size: i === 0 ? ("large" as const) : c.size }));
    await saveDashboard(a.db, MAIN_DASHBOARD_ID, { name: "Home", cards: [...cards, { ...cards[0]!, id: "00000000-0000-4000-8000-0000000000b1", window: { kind: "custom" as const, from: "2026-10-01", to: "2026-10-31" } }] });
    const b = await device("B");
    await importInto(b, await exportText(a), product);
    const onB = (await loadInsightRecords(b.db)).dashboards.find((d) => d.id === MAIN_DASHBOARD_ID)!;
    expect(onB.data).toEqual((await loadInsightRecords(a.db)).dashboards[0]!.data);
    await saveDashboard(b.db, MAIN_DASHBOARD_ID, { ...onB.data, name: "Home (B)" });
    expect((await loadInsightRecords(b.db)).dashboards[0]!.data.name).toBe("Home (B)");
  });
});

describe("19. timers stay on the device (T-234 to T-236)", () => {
  it("an export taken while a countdown and a stopwatch run contains neither nor the selection; an import leaves this device's timers unchanged", async () => {
    const a = await device("A");
    await saveStopwatch(a.db, startStopwatch({ status: "idle", accumulatedMs: 0, runningSince: null }, Date.now()));
    await saveCountdown(a.db, startCountdown(600_000, Date.now()));
    await saveSelectedTimer(a.db, "countdown");
    const text = await exportText(a);
    expect(text).not.toMatch(/stopwatch|countdown|selectedTimer|timerSound/);
    const b = await device("B");
    await saveSelectedTimer(b.db, "stopwatch");
    await setMeta(b.db, "timerSound", false);
    const before = await loadTimer(b.db);
    await importInto(b, text, { ...product, applyUpdates: true, applyDisplaySettings: true });
    expect(await loadTimer(b.db)).toEqual(before);
  });
});

describe("4. plan history and comparison plan travel as record fields (T-179, T-182)", () => {
  it("a target change keeps the earlier plan with its date; a block moved after its start keeps its compared plan", async () => {
    const a = await device("A");
    const goalId = await createGoal(a.db, goalInput);
    at("2026-11-05T08:00:00Z");
    await updateGoal(a.db, goalId, { target: 700 }, registry, Date.now());
    const goal = (await a.db.records.get([GOALS, goalId]))!.data;
    expect(goal.planHistory).toEqual([
      { effectiveFrom: "2026-11-02", target: 600, deadline: "2026-11-29", workdays: [1, 2, 3, 4, 5], dailyCap: null },
      { effectiveFrom: "2026-11-05", target: 700, deadline: "2026-11-29", workdays: [1, 2, 3, 4, 5], dailyCap: null },
    ]);
    const task = await createTask(a.db, { title: "Draft" });
    const id = await createBlock(a.db, { taskId: task, date: "2026-11-05", startTime: "07:00", durationMinutes: 60 });
    await dragBlockTimes(a.db, id, { startsAt: "2026-11-05T10:00:00.000Z", endsAt: "2026-11-05T11:00:00.000Z" });
    const block = (await a.db.records.get([CALENDAR_BLOCKS, id]))!.data;
    expect(block.comparisonPlan).toEqual({ startsAt: "2026-11-05T07:00:00.000Z", endsAt: "2026-11-05T08:00:00.000Z", status: "planned" });
    const b = await device("B");
    await importInto(b, await exportText(a), product);
    expect((await b.db.records.get([CALENDAR_BLOCKS, id]))!.data).toEqual(block);
  });
});

describe("13. the version-8 sample", () => {
  const v8Sample = new URL("./samples/pps-backup-format-v1-data-v8.json", import.meta.url);

  it("writes the dataSchemaVersion-8 sample when PPS_WRITE_SAMPLE=1 (maintainers only)", async () => {
    if (process.env.PPS_WRITE_SAMPLE !== "1" || (DATA_SCHEMA_VERSION as number) !== 8) return;
    const { a, b, goalId } = await conflictOnWednesday();
    // Out of range: a manual amount kept after the deadline moved before its week (T-211).
    await setWeekAllocation(a.db, goalId, "2026-11-23", 50, Date.now());
    await setWeekAllocation(a.db, goalId, "2026-11-09", null, Date.now()); // an automatic (null) revision
    await setWeekAllocation(a.db, goalId, "2026-11-09", 120, Date.now());
    await setWeekAllocation(a.db, goalId, "2026-11-09", null, Date.now());
    await importInto(a, await exportText(b), { ...product, applyUpdates: true });
    const plan = (await planOf(a, goalId))!;
    const wed = plan.dates.find((d) => d.from === "2026-11-04")!;
    await decidePlanDate(a.db, weekPlanId(goalId, "2026-11-02"), "2026-11-04", wed.entries.find((e) => e.device === a.deviceId)!.segment, canonicalize(wed), Date.now());
    await importInto(b, await exportText(a), { ...product, applyUpdates: true });
    const onB = (await planOf(b, goalId))!;
    const wedB = onB.dates.find((d) => d.from === "2026-11-04")!;
    const other = wedB.options.find((s) => canonicalize(s) !== canonicalize(resolveDate(wedB, b.deviceId).kind === "settled" ? (resolveDate(wedB, b.deviceId) as { segment: unknown }).segment : null))!;
    at("2026-11-04T10:00:00Z");
    await decidePlanDate(b.db, weekPlanId(goalId, "2026-11-02"), "2026-11-04", other, canonicalize(wedB), Date.now());
    await importInto(a, await exportText(b), { ...product, applyUpdates: true });
    at("2026-11-05T08:00:00Z");
    await updateGoal(a.db, goalId, { deadline: "2026-11-22" }, registry, Date.now()); // week 4 now out of range: a mismatch segment
    const inactive = await createGoal(a.db, { name: "Reading", startDate: "2026-11-02", deadline: null, kind: "taskCount", target: 20 });
    await setWeekAllocation(a.db, goalId, "2026-11-16", 150, Date.now());
    void inactive;
    for (const day of ["2026-11-03", "2026-11-04", "2026-11-05"]) await recordAppUse(a.db, Date.parse(`${day}T09:00:00Z`));
    await saveDashboard(a.db, MAIN_DASHBOARD_ID, SUGGESTED_MAIN_DASHBOARD);
    const task = await createTask(a.db, { title: "Draft chapter", estimateMinutes: 90 });
    const block = await createBlock(a.db, { taskId: task, date: "2026-11-05", startTime: "06:00", durationMinutes: 60 });
    await dragBlockTimes(a.db, block, { startsAt: "2026-11-05T09:00:00.000Z", endsAt: "2026-11-05T10:30:00.000Z" });
    // Changes of week start on Thursday (T-247): the Sunday week's new record takes over from the
    // Monday week's, which already has a date from that day; putting the setting back takes it back.
    await updateSharedPreferences(a.db, { weekStart: 0 });
    await updateSharedPreferences(a.db, { weekStart: 1 });
    const file = await exportFrom(a, { now: new Date("2026-11-05T09:00:00Z"), backupId: "8c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5" }, registry);
    writeFileSync(v8Sample, `${file.text}\n`);
  });

  it("the committed dataSchemaVersion-8 sample imports and covers the listed cases (fabricated data only)", async () => {
    const text = readFileSync(v8Sample, "utf8");
    const doc = JSON.parse(text);
    expect(doc.app).toEqual({ version: "0.8.0", dataSchemaVersion: 8 }); // written by the Stage 6 app
    const records = doc.payload.records;
    const revisions = records[GOAL_WEEK_ALLOCATIONS].flatMap((r: { data: { revisions: { amount: number | null }[] } }) => r.data.revisions.map((x) => x.amount));
    expect(revisions).toContain(null);
    expect(revisions.some((x: number | null) => typeof x === "number")).toBe(true);
    const segments = records[GOAL_WEEK_PLANS].flatMap((p: { data: GoalWeekPlanData }) => p.data.dates.flatMap((d) => d.entries.map((e) => e.segment)));
    expect(segments.some((s: { state: string }) => s.state === "mismatch")).toBe(true);
    expect(segments.some((s: { allocation: { den: number } | null }) => s.allocation && s.allocation.den === 3)).toBe(true);
    expect(records[APP_USE_DAYS].length).toBeGreaterThanOrEqual(3);
    expect(records[GOALS].some((g: { data: { planHistory?: unknown[] } }) => (g.data.planHistory?.length ?? 0) > 1)).toBe(true);
    expect(records[GOALS].some((g: { data: { deadline: string | null } }) => g.data.deadline === null)).toBe(true);
    expect(records[CALENDAR_BLOCKS].some((b: { data: { comparisonPlan?: unknown } }) => b.data.comparisonPlan)).toBe(true);
    const events = records[GOAL_WEEK_PLAN_CHOICES];
    expect(new Set(events.map((e: { data: { device: string } }) => e.data.device)).size).toBe(2);
    expect(new Set(events.map((e: { data: { from: string } }) => e.data.from)).size).toBe(1);
    expect(records[DASHBOARDS]).toHaveLength(1);
    // Takeover marks after changes of week start on one day (T-247): Sunday took over from Monday,
    // then Monday back from Sunday, with the device's counter ordering them.
    const marks = (records[GOAL_WEEK_PLANS] as { data: GoalWeekPlanData }[]).flatMap((p) =>
      p.data.dates.flatMap((d) => (d.takeovers ?? []).map((t) => [p.data.weekStart, d.from, t.seq, t.over])),
    ).sort((x, y) => (x[2] as number) - (y[2] as number));
    expect(marks).toEqual([
      ["2026-11-01", "2026-11-05", 1, ["2026-11-02"]],
      ["2026-11-02", "2026-11-05", 2, ["2026-11-01"]],
    ]);
    const plans = (records[GOAL_WEEK_PLANS] as { data: GoalWeekPlanData }[]).map((p) => p.data);
    expect(planDateOn(plans, "2026-11-05", "00000000-0000-4000-8000-000000000000")!.plan.weekStart).toBe("2026-11-02");
    const c = await device("C");
    expect(await codeOf(importInto(c, text, product))).toBe("OK");
  });
});

describe("changes of week start on one day travel in backups (T-247; derived \"Week start changes on one day\")", () => {
  const plansOf = async (d: TestDevice) =>
    (await d.db.records.where("type").equals(GOAL_WEEK_PLANS).toArray()).map((r) => r.data as GoalWeekPlanData).sort((x, y) => x.weekStart.localeCompare(y.weekStart));
  const weekOn = async (d: TestDevice, day = "2026-11-05") => planDateOn(await plansOf(d), day, d.deviceId)!.plan.weekStart;
  const apply = { ...product, applyUpdates: true };

  it("the same backups imported in different orders, and again, give the same plans, with the source's latest change in effect", async () => {
    const a = await device("A");
    await updateSharedPreferences(a.db, { weekStart: 0 });
    const goalId = await createGoal(a.db, goalInput);
    at("2026-11-05T08:00:00Z");
    await updateGoal(a.db, goalId, { target: 700 }, registry, Date.now());
    const snapshots = [await exportText(a)];
    for (const [time, weekStart] of [["09:00", 6], ["10:00", 0], ["11:00", 6]] as const) {
      at(`2026-11-05T${time}:00Z`);
      await updateSharedPreferences(a.db, { weekStart });
      snapshots.push(await exportText(a));
    }
    expect(await weekOn(a)).toBe("2026-10-31");
    const expected = canonicalize(await plansOf(a));
    for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [2, 3, 0, 1, 3]]) {
      const c = await device("C");
      for (const i of order) expect(await codeOf(importInto(c, snapshots[i]!, apply))).toBe("OK");
      expect(canonicalize(await plansOf(c))).toBe(expected);
      expect(await weekOn(c)).toBe("2026-10-31");
      expect(await weekOn(c, "2026-11-04")).toBe("2026-11-01"); // the day before keeps the Sunday week's plan
      const before = await recordsOf(c);
      await importInto(c, snapshots[3]!, apply); // again: nothing changes
      await importInto(c, snapshots[0]!, apply); // an older one cannot take a change back
      expect((await recordsOf(c)).filter((r) => r.type === GOAL_WEEK_PLANS)).toEqual(before.filter((r) => r.type === GOAL_WEEK_PLANS));
    }
  });

  /**
   * One goal on A and B under a Monday week start, its target changed on A on Thursday and carried
   * to B; then, without seeing each other, A changes to Sunday and B to Saturday, at `aTime` and `bTime`.
   */
  async function independentChanges(aTime: string, bTime: string) {
    const { a, b, goalId } = await sharedGoal();
    at("2026-11-05T08:00:00Z");
    await updateGoal(a.db, goalId, { target: 700 }, registry, Date.now());
    await importInto(b, await exportText(a), apply);
    at(`2026-11-05T${aTime}:00Z`);
    await updateSharedPreferences(a.db, { weekStart: 0 });
    at(`2026-11-05T${bTime}:00Z`);
    await updateSharedPreferences(b.db, { weekStart: 6 });
    at("2026-11-05T12:00:00Z");
    return { a, b, goalId };
  }

  it("two devices that did not see each other: after exchanging backups both show the later week key, whichever changed later by its clock (T-247)", async () => {
    for (const [aTime, bTime] of [["09:00", "10:00"], ["10:00", "09:00"]] as const) {
      const { a, b } = await independentChanges(aTime, bTime);
      expect([await weekOn(a), await weekOn(b)]).toEqual(["2026-11-01", "2026-10-31"]); // each its own change
      const fromA = await exportText(a);
      const fromB = await exportText(b);
      await importInto(a, fromB, apply);
      await importInto(b, fromA, apply);
      expect([await weekOn(a), await weekOn(b)]).toEqual(["2026-11-01", "2026-11-01"]);
      expect(canonicalize(await plansOf(a))).toBe(canonicalize(await plansOf(b)));
    }
  });

  /**
   * B: a goal from Monday 11-02 under a Monday week start, its target changed on Thursday 11-05
   * (its week record has dates from 11-02 and 11-05). `weekStartFrom` is B's own export with only
   * the shared week start changed by another device (a newer version), as a backup that changes it.
   */
  const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  async function goalOnB() {
    const b = await device("B");
    const goalId = await createGoal(b.db, goalInput);
    at("2026-11-05T08:00:00Z");
    await updateGoal(b.db, goalId, { target: 700 }, registry, Date.now());
    return { b, goalId, own: await exportText(b) };
  }
  const weekStartFrom = (text: string, weekStart: number, updatedAt = "2026-11-05T08:30:00.000Z") =>
    mutate(text, (doc) => {
      const env = doc.payload.records.preferences[0];
      env.data.weekStart = weekStart;
      env.version = { ...env.version, [OTHER]: (env.version[OTHER] ?? 0) + 1 };
      env.updatedAt = updatedAt;
      env.contentHash = contentHashOf(env.data);
    });
  const prefsAndPlans = async (d: TestDevice) => (await recordsOf(d)).filter((r) => r.type === "preferences" || r.type === GOAL_WEEK_PLANS);
  const weekStartOn = async (d: TestDevice) => (await d.db.records.get(["preferences", "00000000-0000-4000-8000-000000000001"]))!.data.weekStart;

  it("a backup that changes the week start, imported with \"Apply updates\": the new week applies from today, earlier days keep their plan, and again changes nothing", async () => {
    const { b, goalId, own } = await goalOnB();
    const monday = (await planOf(b, goalId, "2026-11-02"))!;
    at("2026-11-05T09:00:00Z");
    const text = weekStartFrom(own, 0);
    expect(await codeOf(importInto(b, text, apply))).toBe("OK");
    expect(await weekStartOn(b)).toBe(0);
    expect(await weekOn(b)).toBe("2026-11-01"); // the Sunday week, from today
    expect(await weekOn(b, "2026-11-06")).toBe("2026-11-01");
    for (const day of ["2026-11-02", "2026-11-03", "2026-11-04"]) expect(await weekOn(b, day)).toBe("2026-11-02");
    expect((await planOf(b, goalId, "2026-11-02"))!.dates[0]).toEqual(monday.dates[0]); // the earlier date is unchanged
    // Written by this import on this device: a takeover over the Monday week, which has a date from today.
    expect((await planOf(b, goalId, "2026-11-01"))!.dates).toMatchObject([{ from: "2026-11-05", takeovers: [{ device: b.deviceId, over: ["2026-11-02"] }] }]);
    const after = await prefsAndPlans(b);
    expect(await codeOf(importInto(b, text, apply))).toBe("OK"); // the same backup again
    expect(await prefsAndPlans(b)).toEqual(after);
  });

  it("without \"Apply updates\" neither the week start nor any plan changes", async () => {
    const { b, own } = await goalOnB();
    const before = await prefsAndPlans(b);
    at("2026-11-05T09:00:00Z");
    expect(await codeOf(importInto(b, weekStartFrom(own, 0), product))).toBe("OK");
    expect(await weekStartOn(b)).toBe(1);
    expect(await prefsAndPlans(b)).toEqual(before);
    expect(await weekOn(b)).toBe("2026-11-02");
  });

  it("a week start changed here and in the backup is a conflict, whatever the backup's clock: nothing changes until the owner chooses; choosing the backup's applies its week from today", async () => {
    const { b, goalId, own } = await goalOnB();
    at("2026-11-05T09:00:00Z");
    await updateSharedPreferences(b.db, { weekStart: 6 }); // changed here too, without seeing the backup's change
    expect(await weekOn(b)).toBe("2026-10-31");
    const before = await prefsAndPlans(b);
    // The backup's version claims a later time than this device's change: it does not matter.
    expect(await codeOf(importInto(b, weekStartFrom(own, 0, "2026-11-05T23:00:00.000Z"), apply))).toBe("OK");
    expect(await weekStartOn(b)).toBe(6);
    expect(await prefsAndPlans(b)).toEqual(before);
    const view = (await loadConflictViews(b.db, registry)).find((v) => v.conflict.type === "preferences")!;
    expect(view.options).toContain("useBackup");
    at("2026-11-05T10:00:00Z");
    await resolveConflict(b.db, registry, view.conflict.conflictId, "useBackup", view.token);
    expect(await weekStartOn(b)).toBe(0);
    expect(await weekOn(b)).toBe("2026-11-01");
    expect(await weekOn(b, "2026-11-04")).toBe("2026-11-02");
    expect((await planOf(b, goalId, "2026-11-02"))!.dates.map((x) => x.from)).toEqual(["2026-11-02", "2026-11-05"]);
  });

  it("undoing the imported week start puts the earlier week back from today", async () => {
    const { b, own } = await goalOnB();
    at("2026-11-05T09:00:00Z");
    await importInto(b, weekStartFrom(own, 0), apply);
    expect(await weekOn(b)).toBe("2026-11-01");
    const replaced = (await b.db.replacedVersions.toArray()).find((r) => r.type === "preferences")!;
    at("2026-11-05T10:00:00Z");
    await restoreReplacedVersion(b.db, registry, replaced.replacedId);
    expect(await weekStartOn(b)).toBe(1);
    expect(await weekOn(b)).toBe("2026-11-02"); // back to an existing record, by a takeover mark
    expect(await weekOn(b, "2026-11-04")).toBe("2026-11-02");
  });

  /** Puts this device's takeover mark with counter \`seq\` on \`week\`'s date from 11-05, as if earlier changes had used it up. */
  async function setOwnMark(d: TestDevice, goalId: string, week: string, seq: number, over: string[]) {
    const plan = (await planOf(d, goalId, week))!;
    const dates = plan.dates.map((x) => {
      if (x.from !== "2026-11-05") return x;
      const others = (x.takeovers ?? []).filter((t) => t.device !== d.deviceId);
      const takeovers = [...others, { device: d.deviceId, seq, seen: {}, over }].sort((p, q) => p.device.localeCompare(q.device));
      return { ...x, takeovers };
    });
    await d.db.transaction("rw", [d.db.records, d.db.tombstones, d.db.meta], () => putRecord(d.db, registry, GOAL_WEEK_PLANS, weekPlanId(goalId, week), { ...plan, dates }));
  }
  /** Everything an import, a decision, or an undo could write. */
  const stateOf = async (d: TestDevice) => ({
    records: await prefsAndPlans(d),
    conflicts: (await d.db.pendingConflicts.toArray()).length,
    replaced: (await d.db.replacedVersions.toArray()).length,
    imports: (await d.db.importLog.toArray()).length,
  });

  it("an import whose week start the takeover counter cannot record is refused (SEQ_LIMIT) with nothing written; below the maximum it imports", async () => {
    for (const [seq, refused] of [[PLAN_SEQ_MAX, true], [PLAN_SEQ_MAX - 1, false]] as const) {
      at("2026-11-02T08:00:00Z");
      const { b, goalId } = await goalOnB();
      await setOwnMark(b, goalId, "2026-11-02", seq, ["2026-11-01"]); // the Monday week took over the Sunday week before
      const text = weekStartFrom(await exportText(b), 0);
      const before = await stateOf(b);
      at("2026-11-05T09:00:00Z");
      const result = await codeOf(importInto(b, text, apply));
      if (refused) {
        expect(result).toBe("SEQ_LIMIT");
        expect(await stateOf(b)).toEqual(before); // not the week start, no plan, no import record
        expect(await weekOn(b)).toBe("2026-11-02");
      } else {
        expect(result).toBe("OK");
        expect(await weekOn(b)).toBe("2026-11-01");
        expect((await planOf(b, goalId, "2026-11-01"))!.dates[0]!.takeovers).toMatchObject([{ device: b.deviceId, seq: PLAN_SEQ_MAX }]);
      }
    }
  });

  it("choosing the backup's week start in a conflict is refused the same way, and the conflict stays to decide later", async () => {
    const { b, goalId, own } = await goalOnB();
    at("2026-11-05T09:00:00Z");
    await updateSharedPreferences(b.db, { weekStart: 6 }); // the Saturday week takes over here
    await setOwnMark(b, goalId, "2026-10-31", PLAN_SEQ_MAX, ["2026-11-01", "2026-11-02"]); // over Sunday too, from earlier changes
    await importInto(b, weekStartFrom(own, 0), apply); // a preferences conflict: nothing changes
    const view = (await loadConflictViews(b.db, registry)).find((v) => v.conflict.type === "preferences")!;
    const before = await stateOf(b);
    expect(await codeOf(resolveConflict(b.db, registry, view.conflict.conflictId, "useBackup", view.token))).toBe("SEQ_LIMIT");
    expect(await stateOf(b)).toEqual(before);
    expect(await weekStartOn(b)).toBe(6);
  });

  it("undoing an imported week start is refused the same way, and the earlier version stays to restore later", async () => {
    const { b, goalId, own } = await goalOnB();
    at("2026-11-05T09:00:00Z");
    await importInto(b, weekStartFrom(own, 0), apply); // the Sunday week takes over here
    await setOwnMark(b, goalId, "2026-11-01", PLAN_SEQ_MAX, ["2026-11-02"]);
    const replaced = (await b.db.replacedVersions.toArray()).find((r) => r.type === "preferences")!;
    const before = await stateOf(b);
    expect(await codeOf(restoreReplacedVersion(b.db, registry, replaced.replacedId))).toBe("SEQ_LIMIT");
    expect(await stateOf(b)).toEqual(before);
    expect(await weekStartOn(b)).toBe(0);
  });

  it("once a device has seen the other's change, its own later change applies on both, carried by its counters, not its clock", async () => {
    const { a, b, goalId } = await independentChanges("10:00", "09:00");
    await importInto(b, await exportText(a), apply); // B has now seen A's change to Sunday
    // B's week start is still Saturday; its next plan write makes the Saturday week apply again.
    at("2026-11-05T08:30:00Z"); // an earlier clock reading than A's change: it does not matter
    await updateGoal(b.db, goalId, { target: 750 }, registry, Date.now());
    expect(await weekOn(b)).toBe("2026-10-31");
    await importInto(a, await exportText(b), apply);
    expect(await weekOn(a)).toBe("2026-10-31");
    expect(canonicalize(await plansOf(a))).toBe(canonicalize(await plansOf(b)));
  });
});

describe("weekly plan options are distinct and in canonical order (independent review, 2026-11-05)", () => {
  const manual = (num: number): SegmentData => ({ state: "allocated", allocation: { num, den: 1 }, source: "manual" });
  const byKey = (list: SegmentData[]) => [...list].sort((p, q) => (canonicalize(p) < canonicalize(q) ? -1 : 1));
  /** `text` with the week plan's first date given `options`, content hashes and the integrity hash computed again. */
  const withOptions = (text: string, planId: string, options: SegmentData[]) =>
    mutate(text, (doc) => {
      const env = doc.payload.records[GOAL_WEEK_PLANS].find((e: { id: string }) => e.id === planId);
      env.data.dates[0].options = options;
      env.contentHash = contentHashOf(env.data);
    });

  it("a backup whose settled date repeats an option, or lists options out of order, is refused before anything is written", async () => {
    const { a, b, goalId } = await sharedGoal();
    const planId = weekPlanId(goalId, "2026-11-02");
    const text = await exportText(a);
    const settled = (await planOf(a, goalId))!.dates[0]!;
    const x = settled.entries[0]!.segment;
    // [x, x] on a settled date would otherwise offer "Change choice" between two equal options.
    expect(canChangeChoice({ ...settled, options: [x, x] })).toBe(true);
    const [low, high] = byKey([x, manual(7)]);
    const malformed = [withOptions(text, planId, [x, x]), withOptions(text, planId, [high!, low!])];
    const c = await device("C"); // C has no plan yet (a new record); B already holds it (a merge)
    for (const file of malformed) {
      await expect(openBackupFile(blobOf(file), registry)).rejects.toThrow(/^INVALID_PAYLOAD: .*options must be distinct and sorted by canonical JSON/);
      for (const d of [b, c]) {
        const before = await snapshot(d.db);
        const imports = await d.db.importLog.count();
        for (const applyUpdates of [false, true]) expect(await codeOf(importInto(d, file, { ...product, applyUpdates }))).toBe("INVALID_PAYLOAD");
        expect(await snapshot(d.db)).toEqual(before);
        expect(await d.db.importLog.count()).toBe(imports);
      }
    }
    // The same options, distinct and in order, are accepted.
    expect(await codeOf(importInto(c, withOptions(text, planId, [low!, high!]), product))).toBe("OK");
    expect((await planOf(c, goalId))!.dates[0]!.options).toEqual([low, high]);
  });

  it("a local write with repeated or out-of-order options is refused and changes nothing", async () => {
    const { a, goalId } = await sharedGoal();
    const planId = weekPlanId(goalId, "2026-11-02");
    const plan = (await planOf(a, goalId))!;
    const x = plan.dates[0]!.entries[0]!.segment;
    const [low, high] = byKey([x, manual(7)]);
    const before = await snapshot(a.db);
    for (const options of [[x, x], [high!, low!]]) {
      const data = { ...plan, dates: [{ ...plan.dates[0]!, options }] };
      await expect(putRecord(a.db, registry, GOAL_WEEK_PLANS, planId, data)).rejects.toThrow(/options must be distinct and sorted by canonical JSON/);
    }
    expect(await snapshot(a.db)).toEqual(before);
  });

  it("more than 64 distinct options in canonical order are accepted on import, as a new record and in a merge, while the record fits", async () => {
    const { a, b, goalId } = await sharedGoal();
    const planId = weekPlanId(goalId, "2026-11-02");
    const x = (await planOf(a, goalId))!.dates[0]!.entries[0]!.segment;
    const options = byKey([x, ...Array.from({ length: 80 }, (_, i) => manual(100_000 + i))]);
    const file = withOptions(await exportText(a), planId, options);
    await expect(openBackupFile(blobOf(file), registry)).resolves.toBeDefined();
    const c = await device("C");
    expect(await codeOf(importInto(c, file, product))).toBe("OK"); // a new record
    expect((await planOf(c, goalId))!.dates[0]!.options).toEqual(options);
    const { preview } = await importInto(b, file, { ...product, applyUpdates: true }); // a merge into B's record
    expect(preview.counts.planMerge).toBe(1);
    expect((await planOf(b, goalId))!.dates[0]!.options).toEqual(options);
  });
});

describe("weekly plan integrity: new cycles and seen claims (Codex review, 2026-11-05)", () => {
  type Entry = PlanEntryData;
  const seg = (num: number): SegmentData => ({ state: "allocated", allocation: { num, den: 1 }, source: "manual" });
  const byDevice = (p: Entry, q: Entry) => (p.device < q.device ? -1 : 1);
  const mondayWith = (plan: GoalWeekPlanData, entries: Entry[]): GoalWeekPlanData => ({ ...plan, dates: [{ ...plan.dates[0]!, entries: [...entries].sort(byDevice) }] });
  /** The exported file with this plan's Monday entries replaced; its version is concurrent with the device's, so it is a plan merge. */
  const fileWith = (text: string, planId: string, entries: Entry[]) =>
    mutate(text, (doc) => {
      const env = doc.payload.records[GOAL_WEEK_PLANS].find((e: { id: string }) => e.id === planId);
      env.data.dates[0].entries = [...entries].sort(byDevice);
      env.contentHash = contentHashOf(env.data);
      env.version = { ...env.version, [crypto.randomUUID()]: 1 };
    });
  const incomingOf = (text: string, planId: string) => JSON.parse(text).payload.records[GOAL_WEEK_PLANS].find((e: { id: string }) => e.id === planId).data as GoalWeekPlanData;
  const newId = () => crypto.randomUUID();
  const cyclicEntriesOf = (plan: GoalWeekPlanData) => cyclicEntries(plan.dates[0]!).map((e) => e.device);

  it("a date that already had a cycle: an import that would add a second cycle is an integrity issue and changes nothing", async () => {
    const { a, goalId } = await sharedGoal();
    const planId = weekPlanId(goalId, "2026-11-02");
    const text = await exportText(a);
    const original = (await planOf(a, goalId))!;
    const own = original.dates[0]!.entries[0]!;
    const [p, q, r] = [newId(), newId(), newId()];
    // Stored before the checks: this device and P cover each other, and Q claims R, which is not here.
    const local = mondayWith(original, [
      { ...own, seen: { [p]: 1 } },
      { device: p, seq: 1, seen: { [own.device]: own.seq }, segment: seg(90) },
      { device: q, seq: 1, seen: { [r]: 1 }, segment: seg(80) },
    ]);
    await storeUnchecked(a, GOAL_WEEK_PLANS, planId, local);
    expect(hasCoverageCycle(local.dates[0]!)).toBe(true);
    const before = await a.db.records.get([GOAL_WEEK_PLANS, planId]);
    // The file brings R's entry claiming Q's: merged, Q and R would cover each other, a second cycle.
    const file = fileWith(text, planId, [{ device: r, seq: 1, seen: { [q]: 1 }, segment: seg(70) }]);
    expect(newPlanIntegrityProblem(local, mergePlans(local, incomingOf(file, planId))!)).toBe("cycle");
    for (const applyUpdates of [false, true]) {
      const { preview } = await importInto(a, file, { ...product, applyUpdates });
      expect(preview.counts.planIntegrity).toBe(1);
      expect(preview.counts.planMerge).toBe(0);
      expect(await a.db.records.get([GOAL_WEEK_PLANS, planId])).toEqual(before); // byte-identical
    }
    expect(resolveDate((await planOf(a, goalId))!.dates[0]!, a.deviceId)).toEqual(resolveDate(local.dates[0]!, a.deviceId)); // the plan applying is as before
  });

  it("the cycle rule on its own: an older cycle left as it is allows a merge, a new cycle on the same date does not", () => {
    const [a, p, q, r] = [newId(), newId(), newId(), newId()];
    const plan = (entries: Entry[]): GoalWeekPlanData => ({ goalId: GOAL_ID_FOR_RULE, weekStart: "2026-11-02", dates: [{ from: "2026-11-02", entries: [...entries].sort(byDevice), options: [] }] });
    const old: Entry[] = [
      { device: a, seq: 1, seen: { [p]: 1 }, segment: seg(100) },
      { device: p, seq: 1, seen: { [a]: 1 }, segment: seg(90) },
    ];
    const before = plan(old);
    expect(newPlanIntegrityProblem(undefined, before)).toBe("cycle"); // a record new here with a cycle
    expect(newPlanIntegrityProblem(before, plan([...old, { device: q, seq: 1, seen: {}, segment: seg(80) }]))).toBeNull();
    const second = [...old, { device: q, seq: 1, seen: { [r]: 1 }, segment: seg(80) }, { device: r, seq: 1, seen: { [q]: 1 }, segment: seg(70) }];
    expect(newPlanIntegrityProblem(before, plan(second))).toBe("cycle");
    // P's entry replaced by a newer one that still lies on a cycle with this device's: a new cycle as well.
    const replaced = [{ ...old[0]!, seen: { [p]: 2 } }, { device: p, seq: 2, seen: { [a]: 1 }, segment: seg(60) }];
    expect(newPlanIntegrityProblem(before, plan(replaced))).toBe("cycle");
  });

  it("a date that already had a cycle still takes a merge that adds none: the owner's decision from another device settles it", async () => {
    const { a, goalId } = await sharedGoal();
    const planId = weekPlanId(goalId, "2026-11-02");
    const text = await exportText(a);
    const original = (await planOf(a, goalId))!;
    const own = original.dates[0]!.entries[0]!;
    const p = newId();
    const ownCyclic = { ...own, seen: { [p]: 1 } };
    await storeUnchecked(a, GOAL_WEEK_PLANS, planId, mondayWith(original, [ownCyclic, { device: p, seq: 1, seen: { [own.device]: own.seq }, segment: seg(90) }]));
    expect(resolveDate((await planOf(a, goalId))!.dates[0]!, a.deviceId).kind).toBe("inconsistent");
    // P decided after seeing both entries: its second entry covers this device's, and nothing covers it.
    const decided = fileWith(text, planId, [ownCyclic, { device: p, seq: 2, seen: { [own.device]: own.seq }, segment: seg(90) }]);
    const { preview } = await importInto(a, decided, { ...product, applyUpdates: true });
    expect(preview.counts.planIntegrity).toBe(0);
    expect(preview.counts.planMerge).toBe(1);
    const monday = (await planOf(a, goalId))!.dates[0]!;
    expect(hasCoverageCycle(monday)).toBe(false);
    expect(resolveDate(monday, a.deviceId)).toEqual({ kind: "settled", segment: seg(90) });
  });

  it("a third device's backup carrying the same old cycle plus its decision covering both merges: the decision applies, the old cycle stays as it was", async () => {
    const { a, goalId } = await sharedGoal();
    const planId = weekPlanId(goalId, "2026-11-02");
    const text = await exportText(a);
    const original = (await planOf(a, goalId))!;
    const [p, q, c] = [newId(), newId(), newId()];
    // Stored before the checks here: P's and Q's entries cover each other (the old cycle A/B of the report).
    const p1: Entry = { device: p, seq: 1, seen: { [q]: 1 }, segment: seg(90) };
    const q1: Entry = { device: q, seq: 1, seen: { [p]: 1 }, segment: seg(80) };
    await storeUnchecked(a, GOAL_WEEK_PLANS, planId, mondayWith(original, [p1, q1]));
    expect(resolveDate((await planOf(a, goalId))!.dates[0]!, a.deviceId).kind).toBe("inconsistent");
    // The third device holds the same two entries and decided after seeing both.
    const c1: Entry = { device: c, seq: 1, seen: { [p]: 1, [q]: 1 }, segment: seg(70) };
    const file = fileWith(text, planId, [p1, q1, c1]);
    const incoming = incomingOf(file, planId);
    expect(newPlanIntegrityProblem(undefined, incoming)).toBe("cycle"); // on its own, the backup's record has a cycle
    const local = (await planOf(a, goalId))!;
    expect(newPlanIntegrityProblem(local, incoming)).toBeNull(); // but exactly the one already here

    // Without "Apply updates" nothing is written; with it, the merge is accepted.
    const before = await a.db.records.get([GOAL_WEEK_PLANS, planId]);
    const skipped = await importInto(a, file, { ...product, applyUpdates: false });
    expect(skipped.preview.counts.planIntegrity).toBe(0);
    expect(skipped.preview.counts.planMerge).toBe(1);
    expect(await a.db.records.get([GOAL_WEEK_PLANS, planId])).toEqual(before);
    const { preview } = await importInto(a, file, { ...product, applyUpdates: true });
    expect(preview.counts.planIntegrity).toBe(0);
    expect(preview.counts.planMerge).toBe(1);
    const monday = (await planOf(a, goalId))!.dates[0]!;
    expect(candidatesOf(monday)).toEqual([seg(70)]); // C's decision is the only candidate
    expect(resolveDate(monday, a.deviceId)).toEqual({ kind: "settled", segment: seg(70) });
    // The old cycle is still there, unchanged, and covered by C's entry.
    expect(monday.entries.find((e) => e.device === p)).toEqual(p1);
    expect(monday.entries.find((e) => e.device === q)).toEqual(q1);
    expect(hasCoverageCycle(monday)).toBe(true);

    // The same backup is still refused as a plan new to a device, which has no such baseline.
    const d = await device("D");
    const fresh = await importInto(d, file, product);
    expect(fresh.preview.counts.planIntegrity).toBe(1);
    expect(await planOf(d, goalId)).toBeUndefined();
  });

  it("with an old cycle here, a merge that would create a new cycle is still refused and nothing changes", async () => {
    const { a, goalId } = await sharedGoal();
    const planId = weekPlanId(goalId, "2026-11-02");
    const text = await exportText(a);
    const original = (await planOf(a, goalId))!;
    const [p, q, x, y] = [newId(), newId(), newId(), newId()];
    const p1: Entry = { device: p, seq: 1, seen: { [q]: 1 }, segment: seg(90) };
    const q1: Entry = { device: q, seq: 1, seen: { [p]: 1 }, segment: seg(80) };
    // Also stored before the checks: X's entry claims Y's first entry, which is not here.
    const x1: Entry = { device: x, seq: 1, seen: { [y]: 1 }, segment: seg(60) };
    const local = mondayWith(original, [p1, q1, x1]);
    await storeUnchecked(a, GOAL_WEEK_PLANS, planId, local);
    const before = await a.db.records.get([GOAL_WEEK_PLANS, planId]);
    // A backup with the same old cycle and Y's entry claiming X's: merged, X and Y would cover each other.
    const file = fileWith(text, planId, [p1, q1, { device: y, seq: 1, seen: { [x]: 1 }, segment: seg(50) }]);
    const merged = mergePlans(local, incomingOf(file, planId))!;
    expect(cyclicEntriesOf(merged).sort()).toEqual([p, q, x, y].sort()); // the old cycle and a new one
    expect(newPlanIntegrityProblem(local, merged)).toBe("cycle");
    for (const applyUpdates of [false, true]) {
      const { preview } = await importInto(a, file, { ...product, applyUpdates });
      expect(preview.counts.planIntegrity).toBe(1);
      expect(preview.counts.planMerge).toBe(0);
      expect(await a.db.records.get([GOAL_WEEK_PLANS, planId])).toEqual(before); // byte-identical
    }
  });

  for (const kind of ["missing device", "impossible counter"] as const) {
    it(`a seen claim with ${kind === "missing device" ? "a" : "an"} ${kind}: not imported as a new plan, not merged, refused as a local write; nothing changes`, async () => {
      const { a, b, goalId } = await sharedGoal();
      const planId = weekPlanId(goalId, "2026-11-02");
      const text = await exportText(a);
      const original = (await planOf(a, goalId))!;
      const own = original.dates[0]!.entries[0]!;
      const x = newId();
      // Missing device: X has no entry on Monday. Impossible counter: X's entry is its first, the claim its third.
      const entries: Entry[] =
        kind === "missing device" ? [{ ...own, seen: { [x]: 1 } }] : [{ ...own, seen: { [x]: 3 } }, { device: x, seq: 1, seen: {}, segment: seg(90) }];
      expect(newPlanIntegrityProblem(undefined, mondayWith(original, entries))).toBe("seen");
      const file = fileWith(text, planId, entries);
      // As a new record: counted with the integrity issues and not imported; the rest of the file is.
      const c = await device("C");
      const fresh = await importInto(c, file, product);
      expect(fresh.preview.counts.planIntegrity).toBe(1);
      expect(await planOf(c, goalId)).toBeUndefined();
      expect(await c.db.records.get([GOALS, goalId])).toBeTruthy();
      // Merged into B's plan: counted, and B's plan stays byte-identical in either "Apply updates" run.
      const bBefore = await b.db.records.get([GOAL_WEEK_PLANS, planId]);
      for (const applyUpdates of [false, true]) {
        const { preview } = await importInto(b, file, { ...product, applyUpdates });
        expect(preview.counts.planIntegrity).toBe(1);
        expect(preview.counts.planMerge).toBe(0);
        expect(await b.db.records.get([GOAL_WEEK_PLANS, planId])).toEqual(bBefore);
      }
      // A local write that would bring the claim in is refused.
      const aBefore = await recordsOf(a);
      expect(await codeOf(putRecord(a.db, registry, GOAL_WEEK_PLANS, planId, mondayWith(original, entries)))).toBe("DATA_INTEGRITY");
      expect(await recordsOf(a)).toEqual(aBefore);
    });
  }

  it("a claim no entry bears out cannot hide a later entry: when X's real entry arrives, the owner sees a conflict", async () => {
    const { a, b, goalId } = await sharedGoal();
    const planId = weekPlanId(goalId, "2026-11-02");
    const text = await exportText(a);
    const own = (await planOf(a, goalId))!.dates[0]!.entries[0]!;
    const x = newId();
    // A file whose next entry of A's claims X's third entry while X has none: refused, so B keeps no such claim.
    const claim = await importInto(b, fileWith(text, planId, [{ ...own, seq: own.seq + 1, seen: { [x]: 3 } }]), { ...product, applyUpdates: true });
    expect(claim.preview.counts.planIntegrity).toBe(1);
    // X's first entry, written without seeing anyone, then arrives and is not silently covered.
    const { preview } = await importInto(b, fileWith(text, planId, [own, { device: x, seq: 1, seen: {}, segment: seg(90) }]), { ...product, applyUpdates: true });
    expect(preview.counts.planMerge).toBe(1);
    expect(candidatesOf((await planOf(b, goalId))!.dates[0]!)).toHaveLength(2);
  });

  it("a stored claim of an absent entry: the entry's later arrival is refused instead of silently covered, and the owner can settle the date (Codex review of 9b736d2)", async () => {
    const { a, goalId } = await sharedGoal();
    const planId = weekPlanId(goalId, "2026-11-02");
    const text = await exportText(a);
    const original = (await planOf(a, goalId))!;
    const own = original.dates[0]!.entries[0]!;
    const d = newId();
    // Stored before the checks: this device's entry claims D's first entry, which is not here.
    const legacyOwn = { ...own, seen: { [d]: 1 } };
    await storeUnchecked(a, GOAL_WEEK_PLANS, planId, mondayWith(original, [legacyOwn]));
    const stored = (await planOf(a, goalId))!.dates[0]!;
    // Shown as a data-integrity issue for the owner, like a cycle; this device's plan still applies.
    expect(resolveDate(stored, a.deviceId)).toEqual({ kind: "inconsistent", segment: own.segment, candidates: [own.segment] });
    expect(needsDecision(stored)).toBe(true);
    expect(decisionChoices(stored)).toEqual([own.segment]);

    // A later backup, valid on its own, brings D's first entry: merged, the old claim would cover it and hide D's plan.
    const file = fileWith(text, planId, [legacyOwn, { device: d, seq: 1, seen: {}, segment: seg(90) }]);
    const incoming = incomingOf(file, planId);
    expect(newPlanIntegrityProblem(undefined, incoming)).toBeNull();
    expect(candidatesOf(mergePlans(mondayWith(original, [legacyOwn]), incoming)!.dates[0]!)).toEqual([own.segment]); // D would be covered
    const before = await a.db.records.get([GOAL_WEEK_PLANS, planId]);
    for (const applyUpdates of [false, true]) {
      const { preview } = await importInto(a, file, { ...product, applyUpdates });
      expect(preview.counts.planIntegrity).toBe(1);
      expect(preview.counts.planMerge).toBe(0);
      expect(await a.db.records.get([GOAL_WEEK_PLANS, planId])).toEqual(before); // byte-identical
    }
    expect(candidatesOf((await planOf(a, goalId))!.dates[0]!)).toEqual([own.segment]); // D's entry is not here, so not hidden

    // The owner settles the date: the decision's entry claims only what is here.
    await decidePlanDate(a.db, planId, "2026-11-02", own.segment, canonicalize(stored));
    const settled = (await planOf(a, goalId))!.dates[0]!;
    expect(settled.entries.find((e) => e.device === a.deviceId)!.seen).toEqual({});
    expect(resolveDate(settled, a.deviceId)).toEqual({ kind: "settled", segment: own.segment });
    // The same backup now merges, and D's version, written without seeing that decision, is a conflict for the owner.
    const { preview } = await importInto(a, file, { ...product, applyUpdates: true });
    expect(preview.counts.planIntegrity).toBe(0);
    expect(preview.counts.planMerge).toBe(1);
    const merged = (await planOf(a, goalId))!.dates[0]!;
    expect(candidatesOf(merged)).toEqual([own.segment, seg(90)].sort((p, q) => (canonicalize(p) < canonicalize(q) ? -1 : 1)));
    expect(resolveDate(merged, a.deviceId).kind).toBe("conflict");
  });

  it("a stored claim from before the checks does not block a write that leaves it as it is", async () => {
    const { a, goalId } = await sharedGoal();
    const planId = weekPlanId(goalId, "2026-11-02");
    const original = (await planOf(a, goalId))!;
    const own = original.dates[0]!.entries[0]!;
    const legacy = mondayWith(original, [{ ...own, seen: { [newId()]: 1 } }]);
    await storeUnchecked(a, GOAL_WEEK_PLANS, planId, legacy);
    // The same claim, unchanged, with another part of the record changed: written.
    const next = { ...legacy, dates: [{ ...legacy.dates[0]!, options: [seg(50)] }] };
    expect(await codeOf(putRecord(a.db, registry, GOAL_WEEK_PLANS, planId, next))).toBe("OK");
    expect((await planOf(a, goalId))!.dates[0]!.options).toEqual([seg(50)]);
  });
});

const GOAL_ID_FOR_RULE = "77777777-7777-4777-8777-777777777777";
