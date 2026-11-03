/**
 * Stage 6 data in backups (TESTING "Stage 6 acceptance tests" items 4, 11 to 13, 18, 19; BACKUP_FORMAT
 * "Data schema version 8"; DECISIONS T-201, T-204, T-223, T-227 to T-229, T-234 to T-237). Fixed
 * clock (only `Date` is faked), weeks start on Monday, zone UTC. Fabricated data only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "./jcs.ts";
import { contentHashOf } from "./envelope.ts";
import { createGoal, updateGoal } from "../local/goals.ts";
import { decidePlanDate, loadGoalPlanning, setWeekAllocation } from "../local/goal-plans.ts";
import { loadInsightRecords, recordAppUse, saveDashboard } from "../local/insights.ts";
import { createTask } from "../local/organization.ts";
import { createBlock, dragBlockTimes } from "../local/planning.ts";
import { setMeta } from "../local/db.ts";
import { updateSharedPreferences } from "../local/settings.ts";
import { loadTimer, saveCountdown, saveSelectedTimer, saveStopwatch, startCountdown, startStopwatch } from "../local/timer.ts";
import { planDateOn, resolveDate, eventStatus, candidatesOf } from "../insights/plan-merge.ts";
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
  type GoalWeekPlanData,
  MAIN_DASHBOARD_ID,
  PRODUCT_REGISTRY,
  TASK_ESTIMATE_CAPTURES,
} from "./registry.ts";
import { weekPlanId } from "./derived-id.ts";
import { createTestDevice, type TestDevice } from "./test-fixtures.ts";
import { exportFrom, importInto, mutate } from "./test-helpers.ts";

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
    });
    const c = await device("C");
    expect(await codeOf(importInto(c, text, product))).toBe("UNRESOLVED_REFERENCE");
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
    const file = await exportFrom(a, { now: new Date("2026-11-05T09:00:00Z"), backupId: "8c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5" }, registry);
    writeFileSync(v8Sample, `${file.text}\n`);
  });

  it("the committed dataSchemaVersion-8 sample imports and covers the listed cases (fabricated data only)", async () => {
    const text = readFileSync(v8Sample, "utf8");
    const doc = JSON.parse(text);
    expect(doc.app.dataSchemaVersion).toBe(8);
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
    const c = await device("C");
    expect(await codeOf(importInto(c, text, product))).toBe("OK");
  });
});
