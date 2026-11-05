/**
 * Stage 6 local commands (TESTING "Stage 6 acceptance tests" items 2, 8, 17, 18, 19): manual
 * allocations and moves (T-206, T-218, T-220, T-224), estimate captures (T-189, T-190), the audited
 * move of an actual session (T-072), the compared plan of a block (T-179), the first plan of a week
 * (T-225), and the device-local timers (T-231 to T-236). Only `Date` is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateCaptureId, weekAllocationId, weekPlanId } from "../backup/derived-id.ts";
import {
  CALENDAR_BLOCKS,
  CORRECTIONS,
  GOAL_WEEK_ALLOCATIONS,
  GOAL_WEEK_PLANS,
  type GoalWeekAllocationData,
  type GoalWeekPlanData,
  type SessionData,
  PLAN_SEQ_MAX,
  PRODUCT_REGISTRY,
  SESSIONS,
  TASK_ESTIMATE_CAPTURES,
} from "../backup/registry.ts";
import { createTestDevice, type TestDevice } from "../backup/test-fixtures.ts";
import { createGoal, updateGoal } from "./goals.ts";
import { GoalPlanError, moveWeekAllocation, setWeekAllocation } from "./goal-plans.ts";
import { recordAppUse } from "./insights.ts";
import { createTask, updateTask } from "./organization.ts";
import { createBlock, setRecurrence, updateBlock } from "./planning.ts";
import { appliedSegment, planDateOn } from "../insights/plan-merge.ts";
import { putRecord } from "./records.ts";
import { updateSharedPreferences } from "./settings.ts";
import {
  countdownReachedZero,
  countdownRemaining,
  durationFields,
  IDLE_COUNTDOWN,
  IDLE_STOPWATCH,
  loadTimer,
  MAX_COUNTDOWN_MS,
  parseDuration,
  pauseCountdown,
  pauseStopwatch,
  resetStopwatch,
  resumeCountdown,
  saveCountdown,
  saveSelectedTimer,
  saveStopwatch,
  startCountdown,
  startStopwatch,
  stopwatchElapsed,
} from "./timer.ts";
import { endSession, moveSessionTimes, pauseSession, recordPastSession, resumeSession, startSession, updateSessionDetails } from "./work.ts";

const devices: TestDevice[] = [];
async function device(): Promise<TestDevice> {
  const d = await createTestDevice("A");
  devices.push(d);
  await updateSharedPreferences(d.db, { timeZone: "UTC", weekStart: 1 });
  return d;
}
const at = (iso: string) => vi.setSystemTime(new Date(iso));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-11-02T08:00:00Z");
});
afterEach(() => {
  vi.useRealTimers();
  for (const d of devices.splice(0)) d.db.close();
});
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
const goalInput = { name: "Pages", startDate: "2026-11-02", deadline: "2026-11-29", kind: "taskCount" as const, target: 600, workdays: [1, 2, 3, 4, 5] };
const allocationOf = async (d: TestDevice, goalId: string, week: string) => (await d.db.records.get([GOAL_WEEK_ALLOCATIONS, weekAllocationId(goalId, week)]))?.data as GoalWeekAllocationData | undefined;

describe("17–18. manual allocations and moves (T-206, T-207, T-218, T-220, T-224)", () => {
  it("setting a week back to automatic writes null and keeps the ID; same-day changes replace that day's revision", async () => {
    const d = await device();
    const goalId = await createGoal(d.db, goalInput);
    await setWeekAllocation(d.db, goalId, "2026-11-09", 200);
    await setWeekAllocation(d.db, goalId, "2026-11-09", 210);
    expect((await allocationOf(d, goalId, "2026-11-09"))!.revisions).toEqual([{ from: "2026-11-02", amount: 210 }]);
    at("2026-11-03T08:00:00Z");
    await setWeekAllocation(d.db, goalId, "2026-11-09", null);
    at("2026-11-04T08:00:00Z");
    await setWeekAllocation(d.db, goalId, "2026-11-09", 150);
    expect((await allocationOf(d, goalId, "2026-11-09"))!.revisions).toEqual([
      { from: "2026-11-02", amount: 210 },
      { from: "2026-11-03", amount: null },
      { from: "2026-11-04", amount: 150 },
    ]);
    expect(await d.db.records.where("type").equals(GOAL_WEEK_ALLOCATIONS).count()).toBe(1);
  });

  it("refuses a new manual amount on a closed week, a week outside the goal, or without allocations; negative amounts are refused", async () => {
    const d = await device();
    const goalId = await createGoal(d.db, goalInput);
    at("2026-11-10T08:00:00Z");
    expect(await codeOf(setWeekAllocation(d.db, goalId, "2026-11-02", 100))).toBe("WEEK_NOT_EDITABLE");
    expect(await codeOf(setWeekAllocation(d.db, goalId, "2026-11-30", 100))).toBe("WEEK_NOT_EDITABLE");
    expect(await codeOf(setWeekAllocation(d.db, goalId, "2026-11-16", -1))).toBe("INVALID_AMOUNT");
    const open = await createGoal(d.db, { ...goalInput, deadline: null });
    expect(await codeOf(setWeekAllocation(d.db, open, "2026-11-16", 10))).toBe("NO_ALLOCATIONS");
  });

  it("removing the deadline keeps manual amounts unchanged and inactive; they stay correctable (T-213, T-215)", async () => {
    const d = await device();
    const goalId = await createGoal(d.db, goalInput);
    await setWeekAllocation(d.db, goalId, "2026-11-16", 200);
    await updateGoal(d.db, goalId, { deadline: null });
    expect((await allocationOf(d, goalId, "2026-11-16"))!.revisions.at(-1)!.amount).toBe(200);
    const plan = (await d.db.records.get([GOAL_WEEK_PLANS, weekPlanId(goalId, "2026-11-02")]))!.data as GoalWeekPlanData;
    expect(plan.dates.at(-1)!.entries[0]!.segment).toEqual({ state: "inactive", allocation: null, source: "automatic" });
    await updateGoal(d.db, goalId, { deadline: "2026-11-29" });
    const back = (await d.db.records.get([GOAL_WEEK_PLANS, weekPlanId(goalId, "2026-11-02")]))!.data as GoalWeekPlanData;
    expect(back.dates.at(-1)!.entries[0]!.segment.state).toBe("allocated");
  });

  it("moving 200 onto a week with 150 asks first: replace gives 200, add gives 350, cancel changes nothing; the source has no manual amount after", async () => {
    for (const mode of ["replace", "add", undefined] as const) {
      const d = await device();
      const goalId = await createGoal(d.db, goalInput);
      await setWeekAllocation(d.db, goalId, "2026-11-09", 200);
      await setWeekAllocation(d.db, goalId, "2026-11-16", 150);
      const before = await d.db.records.where("type").equals(GOAL_WEEK_ALLOCATIONS).toArray();
      if (mode === undefined) {
        expect(await codeOf(moveWeekAllocation(d.db, goalId, "2026-11-09", "2026-11-16"))).toBe("NEEDS_CHOICE");
        expect(await d.db.records.where("type").equals(GOAL_WEEK_ALLOCATIONS).toArray()).toEqual(before);
        continue;
      }
      await moveWeekAllocation(d.db, goalId, "2026-11-09", "2026-11-16", mode);
      expect((await allocationOf(d, goalId, "2026-11-16"))!.revisions.at(-1)!.amount).toBe(mode === "replace" ? 200 : 350);
      expect((await allocationOf(d, goalId, "2026-11-09"))!.revisions.at(-1)!.amount).toBeNull();
      expect(await d.db.records.where("type").equals(GOAL_WEEK_ALLOCATIONS).count()).toBe(2); // no move record
    }
  });

  it("a week the app was not run in gets no record; the first run in a week starts its plan on that day, never earlier (T-225)", async () => {
    const d = await device();
    const goalId = await createGoal(d.db, goalInput);
    at("2026-11-18T08:00:00Z"); // Wednesday of week 3; week 2 was never run
    await recordAppUse(d.db);
    const plans = (await d.db.records.where("type").equals(GOAL_WEEK_PLANS).toArray()).map((r) => r.data as GoalWeekPlanData).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    expect(plans.map((p) => [p.weekStart, p.dates.map((x) => x.from)])).toEqual([
      ["2026-11-02", ["2026-11-02"]],
      ["2026-11-16", ["2026-11-18"]],
    ]);
    expect(await d.db.records.get([GOAL_WEEK_PLANS, weekPlanId(goalId, "2026-11-09")])).toBeUndefined();
    await recordAppUse(d.db); // nothing more on the same day
    expect(await d.db.records.where("type").equals(GOAL_WEEK_PLANS).count()).toBe(2);
  });

  it("errors are GoalPlanErrors", () => {
    expect(new GoalPlanError("NOT_FOUND", "x").code).toBe("NOT_FOUND");
  });
});

describe("a change of week start applies the new week's plan from that day, also back and forth on one day (T-217, T-247)", () => {
  const allPlans = async (d: TestDevice) => (await d.db.records.where("type").equals(GOAL_WEEK_PLANS).toArray()).map((r) => r.data as GoalWeekPlanData);
  const planOf = async (d: TestDevice, goalId: string, week: string) => (await d.db.records.get([GOAL_WEEK_PLANS, weekPlanId(goalId, week)]))?.data as GoalWeekPlanData;
  /** The week key in effect on `day` on this device, and whether its segment is that record's own for the date. */
  const weekOn = async (d: TestDevice, day: string) => planDateOn(await allPlans(d), day, d.deviceId)!.plan.weekStart;
  const segmentOnDay = async (d: TestDevice, day: string) => appliedSegment(planDateOn(await allPlans(d), day, d.deviceId)!.resolution);
  const KEY = { 0: "2026-11-01", 6: "2026-10-31", 1: "2026-11-02" } as const;

  /**
   * A goal from Monday 11-02 under a Sunday week start (record 11-01 from 11-02), its target changed
   * on Thursday 11-05 (a segment from 11-05 in that record); the week start then changes on 11-05.
   */
  async function sundayGoal() {
    const d = await device();
    await updateSharedPreferences(d.db, { weekStart: 0 });
    const goalId = await createGoal(d.db, goalInput);
    at("2026-11-05T08:00:00Z");
    await updateGoal(d.db, goalId, { target: 700 });
    const before = await planOf(d, goalId, "2026-11-01");
    expect(before.dates.map((x) => x.from)).toEqual(["2026-11-02", "2026-11-05"]);
    return { d, goalId, before };
  }
  /** Days before the change keep the Sunday week's plan from 11-02, and its earlier date is unchanged. */
  async function earlierDaysKept(d: TestDevice, goalId: string, before: GoalWeekPlanData) {
    for (const day of ["2026-11-02", "2026-11-03", "2026-11-04"]) {
      expect(await weekOn(d, day)).toBe("2026-11-01");
      expect(await segmentOnDay(d, day)).toEqual(before.dates[0]!.entries[0]!.segment);
    }
    expect((await planOf(d, goalId, "2026-11-01")).dates[0]).toEqual(before.dates[0]);
  }

  it("Sunday → Saturday → Sunday on one day: after each change the week just chosen applies from that day, by the change of setting alone", async () => {
    const { d, goalId, before } = await sundayGoal();
    at("2026-11-05T09:00:00Z");
    await updateSharedPreferences(d.db, { weekStart: 6 });
    expect(await weekOn(d, "2026-11-05")).toBe("2026-10-31");
    expect(await weekOn(d, "2026-11-06")).toBe("2026-10-31");
    at("2026-11-05T10:00:00Z");
    await updateSharedPreferences(d.db, { weekStart: 0 }); // back to a week whose record already exists
    expect(await weekOn(d, "2026-11-05")).toBe("2026-11-01");
    expect(await weekOn(d, "2026-11-06")).toBe("2026-11-01");
    await earlierDaysKept(d, goalId, before);
    // A goal change after it is written to the Sunday week, which keeps applying.
    at("2026-11-05T11:00:00Z");
    await updateGoal(d.db, goalId, { target: 800 });
    const sunday = await planOf(d, goalId, "2026-11-01");
    expect(await weekOn(d, "2026-11-05")).toBe("2026-11-01");
    expect(await segmentOnDay(d, "2026-11-05")).toEqual(sunday.dates.find((x) => x.from === "2026-11-05")!.entries[0]!.segment);
  });

  it("several more round trips, also through a third week start: the week of the device's latest change always applies, earlier days never change", async () => {
    const { d, goalId, before } = await sundayGoal();
    let minute = 0;
    for (const weekStart of [6, 0, 6, 0, 1, 6, 1, 0, 6] as const) {
      at(`2026-11-05T09:${String(++minute).padStart(2, "0")}:00Z`);
      await updateSharedPreferences(d.db, { weekStart });
      expect([weekStart, await weekOn(d, "2026-11-05")]).toEqual([weekStart, KEY[weekStart]]);
      await earlierDaysKept(d, goalId, before);
    }
    // Opening the app again later that day changes nothing.
    const plans = await allPlans(d);
    await recordAppUse(d.db);
    expect(await allPlans(d)).toEqual(plans);
    // The next day under the same week start: still the Saturday week, from its date of 11-05.
    at("2026-11-06T08:00:00Z");
    await recordAppUse(d.db);
    expect(await weekOn(d, "2026-11-06")).toBe("2026-10-31");
  });

  it("a week start change on a day no other week record has a date from adds no takeover mark", async () => {
    const d = await device();
    await updateSharedPreferences(d.db, { weekStart: 0 });
    const goalId = await createGoal(d.db, goalInput);
    at("2026-11-05T09:00:00Z");
    await updateSharedPreferences(d.db, { weekStart: 6 });
    const saturday = await planOf(d, goalId, "2026-10-31");
    expect(saturday.dates.map((x) => [x.from, x.takeovers])).toEqual([["2026-11-05", undefined]]);
    expect(await weekOn(d, "2026-11-05")).toBe("2026-10-31"); // its later `from` applies, as before
  });

  /** Sets this device's takeover mark on `week`'s date from 11-05 to `seq` (a counter used up by earlier changes). */
  async function setOwnMark(d: TestDevice, goalId: string, week: string, seq: number) {
    const plan = await planOf(d, goalId, week);
    const dates = plan.dates.map((x) => (x.from !== "2026-11-05" ? x : { ...x, takeovers: x.takeovers!.map((t) => (t.device === d.deviceId ? { ...t, seq } : t)) }));
    await d.db.transaction("rw", [d.db.records, d.db.tombstones, d.db.meta], () => putRecord(d.db, PRODUCT_REGISTRY, GOAL_WEEK_PLANS, weekPlanId(goalId, week), { ...plan, dates }));
  }
  const prefsAndPlans = async (d: TestDevice) =>
    (await d.db.records.toArray()).filter((r) => r.type === "preferences" || r.type === GOAL_WEEK_PLANS).map((r) => [r.type, r.id, r.contentHash, r.version]);

  it("a takeover counter at its maximum: the week start change is refused (SEQ_LIMIT) with nothing written; one below it succeeds and uses the maximum", async () => {
    for (const [seq, refused] of [[PLAN_SEQ_MAX, true], [PLAN_SEQ_MAX - 1, false]] as const) {
      at("2026-11-02T08:00:00Z");
      const { d, goalId } = await sundayGoal();
      at("2026-11-05T09:00:00Z");
      await updateSharedPreferences(d.db, { weekStart: 6 }); // the Saturday week takes over: a mark of this device
      await setOwnMark(d, goalId, "2026-10-31", seq);
      const before = await prefsAndPlans(d);
      at("2026-11-05T10:00:00Z");
      const result = updateSharedPreferences(d.db, { weekStart: 0 }); // back to Sunday needs the next counter
      if (refused) {
        await expect(result).rejects.toMatchObject({ name: "GoalPlanError", code: "SEQ_LIMIT" });
        expect(await prefsAndPlans(d)).toEqual(before);
        expect(await weekOn(d, "2026-11-05")).toBe("2026-10-31");
      } else {
        await result;
        expect(await weekOn(d, "2026-11-05")).toBe("2026-11-01");
        const mark = (await planOf(d, goalId, "2026-11-01")).dates.find((x) => x.from === "2026-11-05")!.takeovers!.find((t) => t.device === d.deviceId)!;
        expect(mark.seq).toBe(PLAN_SEQ_MAX);
      }
    }
  });

  /** `week`'s record lists 32 other devices (from imports): this device's next write would add a 33rd. */
  async function fillDevices(d: TestDevice, goalId: string, week: string) {
    const row = (await d.db.records.get([GOAL_WEEK_PLANS, weekPlanId(goalId, week)]))!;
    await d.db.records.put({ ...row, version: Object.fromEntries(Array.from({ length: 32 }, () => [crypto.randomUUID(), 1])) });
  }

  it("a record limit (32 devices on the week's plan) refuses the week start change the same way, with its own reason and nothing written", async () => {
    const { d, goalId } = await sundayGoal();
    at("2026-11-05T09:00:00Z");
    await updateSharedPreferences(d.db, { weekStart: 6 });
    await fillDevices(d, goalId, "2026-11-01");
    const before = await prefsAndPlans(d);
    at("2026-11-05T10:00:00Z");
    await expect(updateSharedPreferences(d.db, { weekStart: 0 })).rejects.toMatchObject({ name: "GoalPlanError", code: "DEVICE_LIMIT", weekStartChange: true });
    expect(await prefsAndPlans(d)).toEqual(before);
    expect(await weekOn(d, "2026-11-05")).toBe("2026-10-31");
  });

  it("outside a change of week start, a takeover the counter cannot record leaves the plan as it is, as the entry counter does: the goal change itself is kept", async () => {
    const { d, goalId } = await sundayGoal();
    at("2026-11-05T09:00:00Z");
    await updateSharedPreferences(d.db, { weekStart: 6 });
    await setOwnMark(d, goalId, "2026-10-31", PLAN_SEQ_MAX);
    // The shared setting written as it was before this fix (no plan refresh): the Saturday week still applies.
    const prefs = (await d.db.records.get(["preferences", "00000000-0000-4000-8000-000000000001"]))!;
    await d.db.transaction("rw", [d.db.records, d.db.tombstones, d.db.meta], () => putRecord(d.db, PRODUCT_REGISTRY, "preferences", prefs.id, { ...prefs.data, weekStart: 0 }));
    const plans = (await prefsAndPlans(d)).filter(([type]) => type === GOAL_WEEK_PLANS);
    at("2026-11-05T10:00:00Z");
    await updateGoal(d.db, goalId, { target: 900 });
    await recordAppUse(d.db);
    expect((await prefsAndPlans(d)).filter(([type]) => type === GOAL_WEEK_PLANS)).toEqual(plans);
    expect(await weekOn(d, "2026-11-05")).toBe("2026-10-31");
  });
});

describe("8. estimate captures and session occurrences (T-189 to T-191)", () => {
  it("captures at first planning, once; a later estimate edit applies only to later occurrences", async () => {
    const d = await device();
    const task = await createTask(d.db, { title: "Run", estimateMinutes: 30 });
    await setRecurrence(d.db, task, { kind: "weekdays", weekdays: [1, 3], startDate: "2026-11-02", endDate: null });
    await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "09:00", durationMinutes: 30, occurrenceDate: "2026-11-02" });
    await updateTask(d.db, task, { estimateMinutes: 45 });
    await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "18:00", durationMinutes: 30, occurrenceDate: "2026-11-02" });
    await createBlock(d.db, { taskId: task, date: "2026-11-04", startTime: "09:00", durationMinutes: 30, occurrenceDate: "2026-11-04" });
    const capture = async (date: string | null) => (await d.db.records.get([TASK_ESTIMATE_CAPTURES, estimateCaptureId(task, date)]))?.data;
    expect(await capture("2026-11-02")).toMatchObject({ estimateMinutes: 30, source: "plan" });
    expect(await capture("2026-11-04")).toMatchObject({ estimateMinutes: 45, source: "plan" });
  });

  it("an unplanned occurrence is captured at its first session; a session can be assigned to an occurrence without a block; a task without an estimate captures none", async () => {
    const d = await device();
    const one = await createTask(d.db, { title: "Essay", estimateMinutes: 60 });
    const none = await createTask(d.db, { title: "Misc" });
    const s = await startSession(d.db, { taskId: one });
    await endSession(d.db, s);
    expect((await d.db.records.get([TASK_ESTIMATE_CAPTURES, estimateCaptureId(one, null)]))?.data).toMatchObject({ estimateMinutes: 60, source: "session" });
    await startSession(d.db, { taskId: none }).then((id) => endSession(d.db, id));
    expect(await d.db.records.get([TASK_ESTIMATE_CAPTURES, estimateCaptureId(none, null)])).toBeUndefined();
    const rec = await createTask(d.db, { title: "Gym", estimateMinutes: 40 });
    await setRecurrence(d.db, rec, { kind: "weekdays", weekdays: [1], startDate: "2026-11-02", endDate: null });
    const past = await recordPastSession(d.db, { date: "2026-11-02", startTime: "06:00", durationMinutes: 35, taskId: rec });
    expect((await d.db.records.get([SESSIONS, past]))!.data).not.toHaveProperty("occurrenceDate"); // unassigned
    expect(await codeOf(updateSessionDetails(d.db, past, { occurrenceDate: "2026-11-03" }))).toBe("NOT_AN_OCCURRENCE");
    await updateSessionDetails(d.db, past, { occurrenceDate: "2026-11-02" });
    const data = (await d.db.records.get([SESSIONS, past]))!.data as SessionData;
    expect(data).toMatchObject({ occurrenceDate: "2026-11-02", blockId: null, startedAt: "2026-11-02T06:00:00.000Z" });
    expect((await d.db.records.get([TASK_ESTIMATE_CAPTURES, estimateCaptureId(rec, "2026-11-02")]))?.data).toMatchObject({ estimateMinutes: 40 });
  });

  it("a session started from a block takes the block's occurrence date", async () => {
    const d = await device();
    const task = await createTask(d.db, { title: "Run", estimateMinutes: 30 });
    await setRecurrence(d.db, task, { kind: "weekdays", weekdays: [1], startDate: "2026-11-02", endDate: null });
    const block = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "09:00", durationMinutes: 30, occurrenceDate: "2026-11-02" });
    const s = await startSession(d.db, { blockId: block });
    expect(((await d.db.records.get([SESSIONS, s]))!.data as SessionData).occurrenceDate).toBe("2026-11-02");
  });
});

describe("2. drag correction of an actual session and the compared plan (T-072, T-179)", () => {
  it("moving an ended session keeps it as one record with its pauses and work time, with the times before and after in its history", async () => {
    const d = await device();
    at("2026-11-02T06:00:00Z");
    const s = await startSession(d.db);
    at("2026-11-02T06:30:00Z");
    await pauseSession(d.db, s);
    at("2026-11-02T06:40:00Z");
    await resumeSession(d.db, s);
    at("2026-11-02T07:10:00Z");
    await endSession(d.db, s);
    const before = (await d.db.records.get([SESSIONS, s]))!.data as SessionData;
    await moveSessionTimes(d.db, s, "2026-11-02T04:00:00.000Z", "started earlier");
    const after = (await d.db.records.get([SESSIONS, s]))!.data as SessionData;
    expect(after).toMatchObject({ startedAt: "2026-11-02T04:00:00.000Z", endedAt: "2026-11-02T05:10:00.000Z", pauses: [{ start: "2026-11-02T04:30:00.000Z", end: "2026-11-02T04:40:00.000Z" }] });
    const corrections = (await d.db.records.where("type").equals(CORRECTIONS).toArray()).map((r) => r.data);
    expect(corrections).toEqual([expect.objectContaining({ sessionId: s, field: "times", before: { startedAt: before.startedAt, endedAt: before.endedAt, pauses: before.pauses }, reason: "started earlier" })]);
    expect(await codeOf(moveSessionTimes(d.db, s, "2026-11-03T04:00:00.000Z"))).toBe("FUTURE");
  });

  it("an edit before the block's start changes the compared plan; the first edit after it keeps the earlier plan, which later edits never change", async () => {
    const d = await device();
    const task = await createTask(d.db, { title: "Draft" });
    const id = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "10:00", durationMinutes: 60 });
    await updateBlock(d.db, id, { date: "2026-11-02", startTime: "11:00", durationMinutes: 60 });
    expect((await d.db.records.get([CALENDAR_BLOCKS, id]))!.data).not.toHaveProperty("comparisonPlan");
    at("2026-11-02T11:30:00Z");
    await updateBlock(d.db, id, { date: "2026-11-02", startTime: "12:00", durationMinutes: 30 });
    await updateBlock(d.db, id, { date: "2026-11-02", startTime: "13:00", durationMinutes: 30 });
    expect((await d.db.records.get([CALENDAR_BLOCKS, id]))!.data.comparisonPlan).toEqual({ startsAt: "2026-11-02T11:00:00.000Z", endsAt: "2026-11-02T12:00:00.000Z", status: "planned" });
  });
});

describe("19. timers (T-231 to T-236)", () => {
  const MIN = 60_000;
  it("a running stopwatch at 4 minutes, closed for 6, shows about 10 and keeps running; a paused one stays at 4", () => {
    const t0 = Date.parse("2026-11-02T08:00:00Z");
    const running = startStopwatch(IDLE_STOPWATCH, t0 - 4 * MIN);
    expect(stopwatchElapsed(running, t0 + 6 * MIN)).toBe(10 * MIN);
    const paused = pauseStopwatch(running, t0);
    expect(stopwatchElapsed(paused, t0 + 600 * MIN)).toBe(4 * MIN);
    expect(resetStopwatch()).toEqual(IDLE_STOPWATCH);
  });

  it("a 10-minute countdown closed after 2 and reopened after 3 more shows about 5 left; after zero it is expired", () => {
    const t0 = Date.parse("2026-11-02T08:00:00Z");
    const c = startCountdown(10 * MIN, t0);
    expect(countdownRemaining(c, t0 + 5 * MIN)).toBe(5 * MIN);
    expect(countdownReachedZero(c, t0 + 11 * MIN)).toBe(true);
    const p = pauseCountdown(c, t0 + 2 * MIN);
    expect(countdownRemaining(p, t0 + 100 * MIN)).toBe(8 * MIN);
    expect(countdownRemaining(resumeCountdown(p, t0 + 100 * MIN), t0 + 101 * MIN)).toBe(7 * MIN);
  });

  it("countdown length from hours, minutes, and seconds (T-239): whole numbers, minutes and seconds 0 to 59, above zero, at most 24 hours", () => {
    const len = (hours: string, minutes: string, seconds: string) => parseDuration({ hours, minutes, seconds });
    expect(len("1", "30", "45")).toEqual({ ok: true, ms: 5_445_000 });
    expect(len("0", "0", "1")).toEqual({ ok: true, ms: 1000 });
    expect(len("", "25", "")).toEqual({ ok: true, ms: 25 * MIN }); // an empty field counts as 0
    expect(len("۱", "۳۰", "٤٥")).toEqual({ ok: true, ms: 5_445_000 }); // Persian and Arabic-Indic digits
    expect(len("24", "0", "0")).toEqual({ ok: true, ms: MAX_COUNTDOWN_MS });
    expect(len("24", "0", "1")).toEqual({ ok: false, error: "max" });
    expect(len("25", "0", "0")).toEqual({ ok: false, error: "max" });
    expect(len("0", "0", "0")).toEqual({ ok: false, error: "zero" });
    expect(len("", "", "")).toEqual({ ok: false, error: "zero" });
    expect(len("0", "60", "0")).toEqual({ ok: false, error: "minSecRange" });
    expect(len("0", "0", "60")).toEqual({ ok: false, error: "minSecRange" });
    for (const bad of ["-1", "1.5", "1e2", "x", "+3"]) expect(len(bad, "0", "0")).toEqual({ ok: false, error: "wholeNumbers" });
    expect(durationFields(5_445_000)).toEqual({ hours: "1", minutes: "30", seconds: "45" });
    expect(durationFields(IDLE_COUNTDOWN.durationMs)).toEqual({ hours: "0", minutes: "25", seconds: "0" });
    expect(durationFields(MAX_COUNTDOWN_MS)).toEqual({ hours: "24", minutes: "0", seconds: "0" });
  });

  it("state and selection survive a restart, and nothing starts, stops, or resets by reopening; no session or record is written", async () => {
    const d = await device();
    expect((await loadTimer(d.db)).selected).toBe("session"); // nothing stored yet
    await saveStopwatch(d.db, startStopwatch(IDLE_STOPWATCH, Date.now()));
    await saveCountdown(d.db, startCountdown(10 * MIN, Date.now()));
    for (const kind of ["stopwatch", "countdown", "session"] as const) {
      await saveSelectedTimer(d.db, kind);
      const before = await loadTimer(d.db);
      await d.restart();
      expect(await loadTimer(d.db)).toEqual(before);
    }
    expect(await d.db.records.where("type").equals(SESSIONS).count()).toBe(0);
    expect(IDLE_COUNTDOWN.status).toBe("idle");
  });
});
