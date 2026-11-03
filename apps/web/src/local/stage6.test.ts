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
  SESSIONS,
  TASK_ESTIMATE_CAPTURES,
} from "../backup/registry.ts";
import { createTestDevice, type TestDevice } from "../backup/test-fixtures.ts";
import { createGoal, updateGoal } from "./goals.ts";
import { GoalPlanError, moveWeekAllocation, setWeekAllocation } from "./goal-plans.ts";
import { recordAppUse } from "./insights.ts";
import { createTask, updateTask } from "./organization.ts";
import { createBlock, setRecurrence, updateBlock } from "./planning.ts";
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
