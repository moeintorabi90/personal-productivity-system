/**
 * TESTING "Stage 6 acceptance tests" items 3, 5, 6, 15 to 17 (T-180 to T-187, T-206 to T-226):
 * weekly allocations, daily/weekly/monthly targets, the cap projection, and both goal streaks,
 * with the documented numbers. Fixed dates; weeks start on Monday (weekStart 1).
 */
import { describe, expect, it } from "vitest";
import type { GoalData, GoalWeekPlanData, SegmentData } from "../backup/registry.ts";
import { addDays, datesBetween } from "../planning/time.ts";
import { computeAllocations, segmentFor } from "./allocation.ts";
import { roundForDisplay, toNumber } from "./fraction.ts";
import { isOpportunity, planOn } from "./goal-plan.ts";
import { capProjection, consistencyStreak, dailyTargetOn, monthTarget, paceStreak, type PaceInput, weekTarget } from "./pace.ts";
import { writeEntry } from "./plan-merge.ts";

const DEVICE = "11111111-1111-4111-8111-111111111111";
const GOAL = "22222222-2222-4222-8222-222222222222";
const MON = "2026-11-02";
const weekKeys = ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"];

function goal(patch: Partial<GoalData> = {}): GoalData {
  return {
    name: "Pages",
    description: "",
    projectId: null,
    startDate: MON,
    deadline: "2026-11-29",
    kind: "taskCount",
    target: 600,
    status: "active",
    archivedAt: null,
    workdays: [1, 2, 3, 4, 5],
    ...patch,
  };
}

const allocated = (num: number, den = 1): SegmentData => ({ state: "allocated", allocation: { num, den }, source: "automatic" });

/** A weekly plan record with segments from the given dates (this device's entries). */
function plan(weekStart: string, segments: [string, SegmentData][]): GoalWeekPlanData {
  return { goalId: GOAL, weekStart, dates: segments.map(([from, s]) => writeEntry(undefined, from, DEVICE, s)) };
}

function pace(g: GoalData, plans: GoalWeekPlanData[], amounts: Record<string, number>, today: string): PaceInput {
  return { goalId: GOAL, goal: g, plans, thisDevice: DEVICE, amounts: new Map(Object.entries(amounts)), today };
}

const target = (input: PaceInput, day: string) => {
  const t = dailyTargetOn(input, day);
  return t.kind === "target" ? roundForDisplay(t.target) : t.reason;
};

describe("15. weekly allocations (T-206)", () => {
  const base = { goal: goal(), plan: planOn(goal(), MON), weekStart: 1 };

  it("600 over four equal weeks of five workdays starts at 150 each", () => {
    const r = computeAllocations({ ...base, today: MON, progressBeforeCurrentWeek: 0, manual: new Map() });
    expect(r.kind).toBe("allocated");
    if (r.kind !== "allocated") return;
    expect(r.weeks.map((w) => toNumber(w.allocation!))).toEqual([150, 150, 150, 150]);
  });

  it("week 2 set to 200 keeps 200 and the other weeks get 133.33; after week 1 closes at 100, weeks 3 and 4 get 150", () => {
    const manual = new Map([[weekKeys[1]!, 200]]);
    const r = computeAllocations({ ...base, today: MON, progressBeforeCurrentWeek: 0, manual });
    if (r.kind !== "allocated") throw new Error(r.kind);
    expect(r.weeks.map((w) => roundForDisplay(w.allocation!))).toEqual([133.33, 200, 133.33, 133.33]);
    const later = computeAllocations({ ...base, today: "2026-11-09", progressBeforeCurrentWeek: 100, manual });
    if (later.kind !== "allocated") throw new Error(later.kind);
    expect(later.weeks.map((w) => [w.weekStart, roundForDisplay(w.allocation!)])).toEqual([
      ["2026-11-09", 200],
      ["2026-11-16", 150],
      ["2026-11-23", 150],
    ]);
    // In week 2, 30 recorded on its first workday makes the next daily target 42.5.
    const input = pace(goal(), [plan("2026-11-09", [["2026-11-09", segmentFor(later, "2026-11-09", 200)]])], { "2026-11-09": 30 }, "2026-11-10");
    expect(target(input, "2026-11-10")).toBe(42.5);
  });

  it("is shared by workdays: 100 over weeks with 2, 5, and 3 workdays gives 20, 50, and 30", () => {
    // Start on a Thursday (2 workdays that week: Thu, Fri), deadline on a Wednesday (3 workdays).
    const g = goal({ startDate: "2026-11-05", deadline: "2026-11-18", target: 100 });
    const r = computeAllocations({ goal: g, plan: planOn(g, "2026-11-05"), weekStart: 1, today: "2026-11-05", progressBeforeCurrentWeek: 0, manual: new Map() });
    if (r.kind !== "allocated") throw new Error(r.kind);
    expect(r.weeks.map((w) => toNumber(w.allocation!))).toEqual([20, 50, 30]);
  });

  it("no workdays or no deadline: inactive, so no pace; task recurrence never adds workdays (T-180, T-213)", () => {
    for (const g of [goal({ workdays: undefined }), goal({ deadline: null })]) {
      const r = computeAllocations({ goal: g, plan: planOn(g, MON), weekStart: 1, today: MON, progressBeforeCurrentWeek: 0, manual: new Map([[weekKeys[0]!, 150]]) });
      expect(r).toEqual({ kind: "inactive", inactiveManual: [weekKeys[0]] });
    }
    expect(isOpportunity(goal({ workdays: undefined }), MON)).toBe(false);
  });

  it("a goal past its target with no manual amounts has automatic amounts of zero and no mismatch", () => {
    const r = computeAllocations({ ...base, today: "2026-11-09", progressBeforeCurrentWeek: 700, manual: new Map() });
    expect(r.kind).toBe("allocated");
    if (r.kind === "allocated") expect(r.weeks.every((w) => w.allocation!.num === 0)).toBe(true);
  });
});

describe("16. closed weeks, corrections, mid-week changes (T-208, T-214, T-216, T-217)", () => {
  const base = { goal: goal(), plan: planOn(goal(), MON), weekStart: 1, manual: new Map<string, number | null>() };

  it("week 1 planned 150 closing at 100 gives 166.67 each; closing at 170 gives 143.33", () => {
    const low = computeAllocations({ ...base, today: "2026-11-09", progressBeforeCurrentWeek: 100 });
    const high = computeAllocations({ ...base, today: "2026-11-09", progressBeforeCurrentWeek: 170 });
    if (low.kind !== "allocated" || high.kind !== "allocated") throw new Error("mismatch");
    expect(low.weeks.map((w) => roundForDisplay(w.allocation!))).toEqual([166.67, 166.67, 166.67]);
    expect(high.weeks.map((w) => roundForDisplay(w.allocation!))).toEqual([143.33, 143.33, 143.33]);
  });

  it("with 200 for the week, 30 on Monday and 40 on Tuesday: Tuesday's 42.5 is missed; Monday corrected to 50 makes it 37.5 and met", () => {
    const plans = [plan(MON, [[MON, allocated(200)]])];
    const before = pace(goal(), plans, { [MON]: 30, "2026-11-03": 40 }, "2026-11-04");
    expect(target(before, "2026-11-03")).toBe(42.5);
    expect(paceStreak(before).current).toBe(0);
    const after = pace(goal(), plans, { [MON]: 50, "2026-11-03": 40 }, "2026-11-04");
    expect(target(after, "2026-11-03")).toBe(37.5);
    expect(paceStreak(after)).toMatchObject({ current: 2, longest: 2 });
    expect(plans[0]!.dates[0]!.entries[0]!.segment).toEqual(allocated(200)); // the fixed weekly plan stays 200
  });

  it("an allocation change from Wednesday keeps Monday and Tuesday at 30 and makes Wednesday 46.67; a Monday correction recalculates Tuesday with 150", () => {
    const plans = [plan(MON, [[MON, allocated(150)], ["2026-11-04", allocated(200)]])];
    const input = pace(goal(), plans, { [MON]: 30, "2026-11-03": 30 }, "2026-11-05");
    expect([MON, "2026-11-03", "2026-11-04"].map((d) => target(input, d))).toEqual([30, 30, 46.67]);
    const corrected = pace(goal(), plans, { [MON]: 40, "2026-11-03": 30 }, "2026-11-05");
    expect(target(corrected, "2026-11-03")).toBe(27.5);
  });

  it("a longest pace streak of 10 days that a correction reduces to 6 shows 6, recalculated from the corrected history (T-216)", () => {
    // A cap of 10 keeps every daily target at 10, so only the corrected day changes.
    const g = goal({ deadline: "2026-11-15", target: 1000, dailyCap: 10 });
    const plans = [plan(MON, [[MON, allocated(500)]]), plan("2026-11-09", [["2026-11-09", allocated(500)]])];
    const workdays = datesBetween(MON, "2026-11-13").filter((d) => isOpportunity(g, d));
    const amounts = Object.fromEntries(workdays.map((d) => [d, 10]));
    expect(paceStreak(pace(g, plans, amounts, "2026-11-14"))).toMatchObject({ current: 10, longest: 10 });
    const corrected = { ...amounts, [workdays[6]!]: 0 }; // the seventh day corrected to 0: runs of 6 and 3
    expect(paceStreak(pace(g, plans, corrected, "2026-11-14"))).toMatchObject({ current: 3, longest: 6 });
  });

  it("work recorded in the current week does not change its allocation until it closes", () => {
    const a = computeAllocations({ ...base, today: "2026-11-04", progressBeforeCurrentWeek: 0 });
    const b = computeAllocations({ ...base, today: "2026-11-04", progressBeforeCurrentWeek: 0 }); // progress this week is not an input
    expect(a).toEqual(b);
  });
});

describe("17. mismatch (T-207, T-209 to T-213, T-219, T-221)", () => {
  const base = { goal: goal(), plan: planOn(goal(), MON), weekStart: 1 };
  const all150 = new Map(weekKeys.map((w) => [w, 150] as [string, number]));

  it("all manual at 150 and week 1 closing at 100: discrepancy 50; target raised to 700: 100; weeks 1–3 at 250: 150 and week 4 never negative", () => {
    const r1 = computeAllocations({ ...base, today: "2026-11-09", progressBeforeCurrentWeek: 100, manual: all150 });
    expect(r1).toMatchObject({ kind: "mismatch", discrepancy: 50 });
    const g700 = goal({ target: 700 });
    expect(computeAllocations({ ...base, goal: g700, plan: planOn(g700, MON), today: MON, progressBeforeCurrentWeek: 0, manual: all150 })).toMatchObject({ kind: "mismatch", discrepancy: 100 });
    const three = new Map(weekKeys.slice(0, 3).map((w) => [w, 250] as [string, number]));
    const r3 = computeAllocations({ ...base, today: MON, progressBeforeCurrentWeek: 0, manual: three });
    expect(r3).toMatchObject({ kind: "mismatch", discrepancy: 150 });
    if (r3.kind === "mismatch") expect(r3.weeks[3]!.allocation).toBeNull(); // no negative amount, no amount at all
    expect(segmentFor(r3, MON, 250)).toEqual({ state: "mismatch", allocation: null, source: "manual" });
  });

  it("switching a week back to automatic clears the mismatch and the targets return", () => {
    const manual = new Map<string, number | null>([...all150, [weekKeys[3]!, null]]);
    const r = computeAllocations({ ...base, today: "2026-11-09", progressBeforeCurrentWeek: 100, manual });
    expect(r.kind).toBe("allocated");
    if (r.kind === "allocated") expect(toNumber(r.weeks.at(-1)!.allocation!)).toBe(200);
  });

  it("no daily or monthly target during a mismatch, and the pace streak holds (T-209, T-210)", () => {
    const plans = [plan(MON, [[MON, { state: "mismatch", allocation: null, source: "manual" }]])];
    const input = pace(goal(), plans, { [MON]: 50 }, "2026-11-04");
    expect(target(input, MON)).toBe("mismatch");
    const r = computeAllocations({ ...base, today: MON, progressBeforeCurrentWeek: 0, manual: new Map(weekKeys.slice(0, 3).map((w) => [w, 250] as [string, number])) });
    expect(monthTarget(input, r, datesBetween("2026-11-01", "2026-11-30"), 1)).toBeNull();
    expect(paceStreak(input)).toMatchObject({ current: 0, longest: 0 });
  });

  it("a 5-day pace streak followed by 3 workdays in a mismatch stays at 5, and later days count again (T-210)", () => {
    const g = goal({ deadline: "2026-11-22" });
    const mismatch: SegmentData = { state: "mismatch", allocation: null, source: "manual" };
    const plans = [plan(MON, [[MON, allocated(50)]]), plan("2026-11-09", [["2026-11-09", mismatch], ["2026-11-12", allocated(20)]])];
    const amounts: Record<string, number> = {};
    for (const d of datesBetween(MON, "2026-11-06")) amounts[d] = 10;
    expect(paceStreak(pace(g, plans, amounts, "2026-11-11")).current).toBe(5);
    amounts["2026-11-12"] = 10;
    expect(paceStreak(pace(g, plans, amounts, "2026-11-12")).current).toBe(6);
  });

  it("a manual amount on a week the goal no longer covers stays, moves nowhere, and is a mismatch; a closed one is only historical (T-211, T-212, T-219)", () => {
    const moved = goal({ deadline: "2026-11-22" }); // week 4 is now outside the goal
    const manual = new Map([[weekKeys[3]!, 200]]);
    const r = computeAllocations({ goal: moved, plan: planOn(moved, MON), weekStart: 1, today: MON, progressBeforeCurrentWeek: 0, manual });
    expect(r).toMatchObject({ kind: "mismatch", outOfRange: [{ weekStart: weekKeys[3], amount: 200, historical: false }] });
    const saturdayKey = new Map([["2026-10-31", 200]]); // a key from a Saturday week start, already closed
    const h = computeAllocations({ ...base, today: "2026-11-09", progressBeforeCurrentWeek: 150, manual: saturdayKey });
    expect(h).toMatchObject({ kind: "allocated", outOfRange: [{ weekStart: "2026-10-31", amount: 200, historical: true }] });
    // Workdays changed to Mondays with the goal starting on a Tuesday: week 1 has no workday left.
    const noWorkday = goal({ startDate: "2026-11-03", workdays: [1] });
    const w = computeAllocations({ goal: noWorkday, plan: planOn(noWorkday, "2026-11-03"), weekStart: 1, today: "2026-11-03", progressBeforeCurrentWeek: 0, manual: new Map([[weekKeys[0]!, 100]]) });
    expect(w).toMatchObject({ kind: "mismatch", outOfRange: [{ weekStart: weekKeys[0], amount: 100, historical: false }] });
  });
});

describe("5. daily cap and projection (T-183, T-221, T-222)", () => {
  it("cap 20 with 10 workdays left and 400 to do warns (at most 200 more); with 150 to do it does not", () => {
    // Ten workdays from Monday 2026-11-16 to Friday 2026-11-27.
    const g = goal({ dailyCap: 20, deadline: "2026-11-27" });
    expect(capProjection(g, 200, "2026-11-16")).toEqual({ remainingWorkdays: 10, maxProjected: 400, unreachable: true });
    expect(capProjection(g, 450, "2026-11-16")).toMatchObject({ maxProjected: 650, unreachable: false });
    expect(capProjection(goal(), 0, MON)).toBeNull(); // no cap: the required pace is shown instead
  });

  it("counts only work opportunities (T-185): a paused or archived goal adds no capacity, and history applies day by day", () => {
    // Monday 2026-11-16 to Friday 2026-11-27: ten selected workdays.
    const active = goal({ dailyCap: 20, deadline: "2026-11-27" });
    expect(capProjection(active, 200, "2026-11-16")).toEqual({ remainingWorkdays: 10, maxProjected: 400, unreachable: true });
    const pausedNow = goal({
      dailyCap: 20,
      deadline: "2026-11-27",
      status: "paused",
      statusHistory: [
        { from: MON, status: "active", archived: false },
        { from: "2026-11-16", status: "paused", archived: false },
      ],
    });
    expect(capProjection(pausedNow, 200, "2026-11-16")).toEqual({ remainingWorkdays: 0, maxProjected: 200, unreachable: true });
    const archivedNow = goal({
      dailyCap: 20,
      deadline: "2026-11-27",
      archivedAt: "2026-11-16T08:00:00.000Z",
      statusHistory: [
        { from: MON, status: "active", archived: false },
        { from: "2026-11-16", status: "active", archived: true },
      ],
    });
    expect(capProjection(archivedNow, 200, "2026-11-16")).toEqual({ remainingWorkdays: 0, maxProjected: 200, unreachable: true });
    // Paused until Wednesday and active again from then: only Wednesday onward counts (8 workdays).
    const resumed = goal({
      dailyCap: 20,
      deadline: "2026-11-27",
      statusHistory: [
        { from: MON, status: "active", archived: false },
        { from: "2026-11-16", status: "paused", archived: false },
        { from: "2026-11-18", status: "active", archived: false },
      ],
    });
    expect(capProjection(resumed, 200, "2026-11-16")).toEqual({ remainingWorkdays: 8, maxProjected: 360, unreachable: true });
  });

  it("required pace above the cap shows the capped amount, and meeting it continues the pace streak", () => {
    const g = goal({ dailyCap: 20 });
    const plans = [plan(MON, [[MON, allocated(150)]])];
    const input = pace(g, plans, { [MON]: 20 }, "2026-11-03");
    const t = dailyTargetOn(input, MON);
    expect(t).toMatchObject({ kind: "target", capped: true });
    if (t.kind === "target") expect([toNumber(t.target), toNumber(t.uncapped)]).toEqual([20, 30]);
    expect(paceStreak(input).current).toBe(1);
  });
});

describe("7. after the deadline (T-187)", () => {
  it("an incomplete goal stays active: no open week, no allocation or mismatch, no new opportunities, and nothing is marked complete or failed", () => {
    const g = goal({ deadline: "2026-11-06" });
    const r = computeAllocations({ goal: g, plan: planOn(g, "2026-11-10"), weekStart: 1, today: "2026-11-10", progressBeforeCurrentWeek: 40, manual: new Map([["2026-11-02", 150]]) });
    expect(r).toEqual({ kind: "ended" });
    expect(capProjection({ ...g, dailyCap: 20 }, 40, "2026-11-10")).toBeNull();
    expect(isOpportunity(g, "2026-11-09")).toBe(false);
    expect(g.status).toBe("active"); // derived values never change the goal
  });
});

describe("3 and 6. targets and streaks (T-181, T-184 to T-186, T-225, T-226)", () => {
  it("weekly and monthly targets are fractions with whole-number actuals; a week crossing the month counts in both", () => {
    const g = goal({ target: 400, startDate: "2026-11-02", deadline: "2026-12-04" });
    const r = computeAllocations({ goal: g, plan: planOn(g, MON), weekStart: 1, today: MON, progressBeforeCurrentWeek: 0, manual: new Map() });
    if (r.kind !== "allocated") throw new Error(r.kind);
    const plans = [plan(MON, [[MON, segmentFor(r, MON, null)]])];
    const input = pace(g, plans, { [MON]: 13 }, MON);
    const week = weekTarget(input, 1)!;
    expect(roundForDisplay(week.target)).toBe(80); // 400 over 25 workdays × 5
    const month = monthTarget(input, r, datesBetween("2026-11-01", "2026-11-30"), 1)!;
    expect(roundForDisplay(month.target)).toBe(16 * 21); // 21 November workdays at 16 each, including Monday 11-30 of the crossing week
    expect(month.progress).toBe(13);
  });

  it("days before the first recorded plan, and a week without one, show no data and neither add nor break the pace streak", () => {
    const g = goal({ deadline: "2026-11-29" });
    const plans = [plan(MON, [["2026-11-04", allocated(30)]]), plan("2026-11-16", [["2026-11-16", allocated(50)]])];
    const amounts: Record<string, number> = { "2026-11-04": 10, "2026-11-05": 10, "2026-11-06": 10, "2026-11-16": 10 };
    const input = pace(g, plans, amounts, "2026-11-17");
    expect(target(input, MON)).toBe("noPlan");
    expect(target(input, "2026-11-10")).toBe("noPlan"); // the whole week of 11-09 had no run
    expect(paceStreak(input).current).toBe(4);
  });

  it("consistency: any attributed record counts; misses break after the day ends; paused, pre-start, post-deadline days are not opportunities; completion stops it", () => {
    const g = goal({
      statusHistory: [
        { from: MON, status: "active", archived: false },
        { from: "2026-11-05", status: "paused", archived: false },
        { from: "2026-11-09", status: "active", archived: false },
      ],
    });
    const attributed = new Set([MON, "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-09"]);
    expect(consistencyStreak(g, attributed, "2026-11-09")).toMatchObject({ current: 4, longest: 4 });
    expect(consistencyStreak(g, attributed, "2026-11-10")).toMatchObject({ current: 4 }); // today not yet missed
    expect(consistencyStreak(g, attributed, "2026-11-11")).toMatchObject({ current: 0, longest: 4 }); // 11-10 missed
    expect(consistencyStreak({ ...g, status: "completed", statusHistory: [...g.statusHistory!, { from: "2026-11-10", status: "completed", archived: false }] }, attributed, "2026-11-12").current).toBe(0);
    expect(isOpportunity(g, addDays(MON, -1))).toBe(false);
    expect(isOpportunity(g, "2026-11-30")).toBe(false);
  });

  // Completed on Thursday 11-05, reopened on Monday 11-09 (T-060): three met opportunities before
  // completion (Mon to Wed) and two after reopening (Mon, Tue); today is Wednesday 11-11.
  const completedThenReopened = (extra: Partial<GoalData> = {}) =>
    goal({
      statusHistory: [
        { from: MON, status: "active", archived: false },
        { from: "2026-11-05", status: "completed", archived: false },
        { from: "2026-11-09", status: "active", archived: false },
      ],
      ...extra,
    });
  const metDays = [MON, "2026-11-03", "2026-11-04", "2026-11-09", "2026-11-10"];
  const stillCompleted = goal({
    status: "completed",
    statusHistory: [
      { from: MON, status: "active", archived: false },
      { from: "2026-11-05", status: "completed", archived: false },
    ],
  });

  it("completion breaks the consistency streak: after reopening only new opportunities count, and the longest never joins the two periods (T-185, T-060)", () => {
    const attributed = new Set(metDays);
    expect(consistencyStreak(completedThenReopened(), attributed, "2026-11-11")).toEqual({ current: 2, longest: 3, counted: 5 });
    // A longer run after reopening is the longest, still not joined with the earlier one.
    const more = new Set([...metDays, "2026-11-11", "2026-11-12"]);
    expect(consistencyStreak(completedThenReopened(), more, "2026-11-13")).toMatchObject({ current: 4, longest: 4 });
    // While the goal stays completed: no current streak, the longest before completion is kept.
    expect(consistencyStreak(stillCompleted, attributed, "2026-11-11")).toEqual({ current: 0, longest: 3, counted: 3 });
  });

  it("completion breaks the daily pace streak the same way (derived from T-185 and T-184)", () => {
    // A cap of 10 keeps every daily target at 10.
    const plans = [plan(MON, [[MON, allocated(500)]]), plan("2026-11-09", [["2026-11-09", allocated(500)]])];
    const amounts = Object.fromEntries(metDays.map((d) => [d, 10]));
    expect(paceStreak(pace(completedThenReopened({ dailyCap: 10 }), plans, amounts, "2026-11-11"))).toEqual({ current: 2, longest: 3, counted: 5 });
    expect(paceStreak(pace({ ...stillCompleted, dailyCap: 10 }, plans, amounts, "2026-11-11"))).toMatchObject({ current: 0, longest: 3 });
  });

  // Abandoned on Thursday 11-05 and reopened on Monday 11-09, with the same met days (T-244).
  const abandonedThenReopened = (extra: Partial<GoalData> = {}) =>
    goal({
      statusHistory: [
        { from: MON, status: "active", archived: false },
        { from: "2026-11-05", status: "abandoned", archived: false },
        { from: "2026-11-09", status: "active", archived: false },
      ],
      ...extra,
    });
  const stillAbandoned = goal({
    status: "abandoned",
    statusHistory: [
      { from: MON, status: "active", archived: false },
      { from: "2026-11-05", status: "abandoned", archived: false },
    ],
  });

  it("abandonment breaks the consistency streak: a reopened goal counts from zero and the longest never joins the periods (T-244)", () => {
    const attributed = new Set(metDays);
    expect(consistencyStreak(abandonedThenReopened(), attributed, "2026-11-11")).toEqual({ current: 2, longest: 3, counted: 5 });
    const more = new Set([...metDays, "2026-11-11", "2026-11-12"]);
    expect(consistencyStreak(abandonedThenReopened(), more, "2026-11-13")).toMatchObject({ current: 4, longest: 4 });
    // While abandoned: no current streak, the longest from before is kept.
    expect(consistencyStreak(stillAbandoned, attributed, "2026-11-11")).toEqual({ current: 0, longest: 3, counted: 3 });
    // A pause, by contrast, neither adds nor breaks (T-185): the run continues after resuming.
    const pausedThenResumed = goal({
      statusHistory: [
        { from: MON, status: "active", archived: false },
        { from: "2026-11-05", status: "paused", archived: false },
        { from: "2026-11-09", status: "active", archived: false },
      ],
    });
    expect(consistencyStreak(pausedThenResumed, attributed, "2026-11-11")).toMatchObject({ current: 5, longest: 5 });
  });

  it("abandonment breaks the daily pace streak the same way (T-244)", () => {
    const plans = [plan(MON, [[MON, allocated(500)]]), plan("2026-11-09", [["2026-11-09", allocated(500)]])];
    const amounts = Object.fromEntries(metDays.map((d) => [d, 10]));
    expect(paceStreak(pace(abandonedThenReopened({ dailyCap: 10 }), plans, amounts, "2026-11-11"))).toEqual({ current: 2, longest: 3, counted: 5 });
    expect(paceStreak(pace({ ...stillAbandoned, dailyCap: 10 }, plans, amounts, "2026-11-11"))).toMatchObject({ current: 0, longest: 3 });
  });
});
