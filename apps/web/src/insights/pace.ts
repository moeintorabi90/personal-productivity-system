/**
 * Pace targets, the cap projection, and both goal streaks (DECISIONS T-180 to T-187, T-207 to
 * T-226; derived "Daily target", "Daily pace streak"). Daily targets and the pace streak read the
 * recorded weekly plan in effect on each day (`goalWeekPlans`) and the current actual records, so
 * a correction recalculates past results but never the recorded plan (T-214, T-217). Pure.
 */
import type { GoalData, GoalStatus, GoalWeekPlanData, SegmentData } from "../backup/registry.ts";
import { addDays, datesBetween } from "../planning/time.ts";
import { type AllocationResult, dailyShare } from "./allocation.ts";
import { amountBetween } from "./actuals.ts";
import { add, cmp, div, frac, type Fraction, max, min, sub, ZERO } from "./fraction.ts";
import { daysOfWeek, isOpportunity, isPlannedWorkday, planOn, statusOn, weekStartOf, workdaysIn } from "./goal-plan.ts";
import { appliedSegment, planDateOn } from "./plan-merge.ts";

export interface PaceInput {
  goalId: string;
  goal: GoalData;
  plans: readonly GoalWeekPlanData[];
  thisDevice: string;
  /** Amount recorded on each local day (goalDays().amounts). */
  amounts: ReadonlyMap<string, number>;
  today: string;
}

export type NoTarget = "notOpportunity" | "noPlan" | "undecided" | "mismatch" | "inactive" | "none";

export type DayTarget =
  | { kind: "target"; target: Fraction; uncapped: Fraction; capped: boolean; weekStart: string; segment: SegmentData }
  | { kind: "noTarget"; reason: NoTarget };

/** The recorded segment in effect on a day, or why there is none (T-225, T-228). */
export function segmentOn(input: Pick<PaceInput, "plans" | "thisDevice">, day: string): { segment: SegmentData; weekStart: string } | { none: "noPlan" | "undecided" } {
  const applied = planDateOn(input.plans, day, input.thisDevice);
  if (!applied) return { none: "noPlan" };
  const segment = appliedSegment(applied.resolution);
  return segment ? { segment, weekStart: applied.plan.weekStart } : { none: "undecided" };
}

/**
 * Daily target of one day: (the week's allocation − the amount recorded earlier that week) ÷
 * selected workdays remaining in the week, counting the day; never below zero; the smaller of that
 * and the daily cap in effect that day.
 */
export function dailyTargetOn(input: PaceInput, day: string): DayTarget {
  if (!isOpportunity(input.goal, day)) return { kind: "noTarget", reason: "notOpportunity" };
  const found = segmentOn(input, day);
  if ("none" in found) return { kind: "noTarget", reason: found.none };
  const { segment, weekStart } = found;
  if (segment.state !== "allocated" || segment.allocation === null) return { kind: "noTarget", reason: segment.state as NoTarget };
  const plan = planOn(input.goal, day);
  const remaining = workdaysIn(input.goal, plan, weekStart, day).length;
  if (remaining === 0) return { kind: "noTarget", reason: "none" };
  const before = amountBetween(input.amounts, weekStart, addDays(day, -1));
  const uncapped = max(ZERO, div(sub(frac(segment.allocation.num, segment.allocation.den), frac(before)), frac(remaining)));
  const cap = plan.dailyCap;
  const target = cap === null ? uncapped : min(uncapped, frac(cap));
  return { kind: "target", target, uncapped, capped: cap !== null && cmp(uncapped, frac(cap)) > 0, weekStart, segment };
}

/** A day's target is met when its whole-number actual reaches it (a target of zero counts as met). */
export const isMet = (target: Fraction, actual: number) => cmp(frac(actual), target) >= 0;

export interface Streak {
  current: number;
  longest: number;
  /** Opportunities that counted toward the streaks (sample size, T-193). */
  counted: number;
}

/**
 * A run over the days from `first` to `today`: `judge` returns met, missed, skip (neither adds
 * nor breaks), or stop (ends the run without being an opportunity: a day of a completed period,
 * T-185). A missed opportunity breaks the run only after its local day ends; today counts once it
 * is met. The longest is the longest run between two breaks or stops.
 */
function streakOver(first: string, today: string, judge: (day: string) => "met" | "missed" | "skip" | "stop"): Streak {
  let current = 0;
  let longest = 0;
  let counted = 0;
  if (first > today) return { current, longest, counted };
  for (const day of datesBetween(first, today)) {
    const result = judge(day);
    if (result === "skip") continue;
    if (result === "stop") {
      current = 0;
      continue;
    }
    if (result === "met") {
      current += 1;
      counted += 1;
      longest = Math.max(longest, current);
    } else if (day < today) {
      current = 0;
      counted += 1;
    }
  }
  return { current, longest, counted };
}

/** First day with a recorded plan of the goal, or null (the pace streak never starts earlier, T-225). */
export function firstPlanDay(plans: readonly GoalWeekPlanData[]): string | null {
  let first: string | null = null;
  for (const p of plans) for (const d of p.dates) if (first === null || d.from < first) first = d.from;
  return first;
}

/**
 * Daily pace streak (T-184, T-210, T-216, T-226): consecutive opportunities on which the displayed
 * daily target is met; days without a target (no plan, an undecided date, a mismatch, inactive)
 * neither add nor break. Completion and abandonment stop it as they stop the consistency streak
 * (T-185 derived; T-244 for abandonment):
 * a completed period ends the run, and after the goal is reopened (T-060) it starts again from
 * zero. The longest is recalculated from the current history.
 */
export function paceStreak(input: PaceInput): Streak {
  const first = firstPlanDay(input.plans);
  if (first === null) return { current: 0, longest: 0, counted: 0 };
  const streak = streakOver(first, input.today, (day) => {
    if (endsRun(statusOn(input.goal, day).status)) return "stop";
    const t = dailyTargetOn(input, day);
    if (t.kind !== "target") return "skip";
    return isMet(t.target, input.amounts.get(day) ?? 0) ? "met" : "missed";
  });
  return stoppedByCompletion(input.goal, input.today, streak);
}

/**
 * Goal-consistency streak (T-073, T-185, T-216): consecutive opportunities with at least one
 * attributed record, whatever its amount; unscheduled, paused, archived, pre-start, and
 * post-deadline days are not opportunities; a planned block alone never counts. Completion stops
 * the streak (T-185): a completed period ends the run, and after the goal is reopened (T-060) new
 * opportunities count from zero, so runs before and after completion are never joined.
 */
export function consistencyStreak(goal: GoalData, attributed: ReadonlySet<string>, today: string): Streak {
  const streak = streakOver(goal.startDate, today, (day) =>
    endsRun(statusOn(goal, day).status) ? "stop" : !isOpportunity(goal, day) ? "skip" : attributed.has(day) ? "met" : "missed",
  );
  return stoppedByCompletion(goal, today, streak);
}

/**
 * Statuses whose period ends a streak's run: completion (T-185) and abandonment (T-244). After the
 * goal is reopened, new opportunities count from zero, and the longest never joins runs across it.
 */
const endsRun = (status: GoalStatus) => status === "completed" || status === "abandoned";

/** Completion or abandonment stops a streak (T-185, T-244): meanwhile there is no current streak; the longest is kept. */
function stoppedByCompletion(goal: GoalData, today: string, streak: Streak): Streak {
  return endsRun(statusOn(goal, today).status) ? { ...streak, current: 0 } : streak;
}

/* ---------- summary of the current period ---------- */

export interface PeriodTarget {
  target: Fraction;
  progress: number;
  /** Progress as a share of the target (1 = 100%); null for a target of zero. */
  ratio: number | null;
}

/** This week's target from the segment in effect today and the week's recorded work (T-181). */
export function weekTarget(input: PaceInput, weekStart: number): PeriodTarget | null {
  const found = segmentOn(input, input.today);
  if ("none" in found || found.segment.state !== "allocated" || !found.segment.allocation) return null;
  const target = frac(found.segment.allocation.num, found.segment.allocation.den);
  const days = daysOfWeek(found.weekStart ?? weekStartOf(input.today, weekStart));
  const progress = amountBetween(input.amounts, days[0], days[6]);
  return { target, progress, ratio: target.num === 0 ? null : progress / (target.num / target.den) };
}

/**
 * Monthly target (derived): each week's allocation split by its workdays, adding the shares of the
 * month's workdays: recorded plans for days until today, the current allocation for later weeks.
 * None during a mismatch (T-209); `partial` when some days of the month had no recorded plan.
 */
export function monthTarget(input: PaceInput, allocation: AllocationResult, monthDays: readonly string[], weekStart: number): (PeriodTarget & { partial: boolean }) | null {
  if (allocation.kind !== "allocated") return null;
  let target = ZERO;
  let partial = false;
  const currentWeek = weekStartOf(input.today, weekStart);
  for (const day of monthDays) {
    const plan = planOn(input.goal, day);
    if (!isPlannedWorkday(input.goal, plan, day)) continue;
    const week = weekStartOf(day, weekStart);
    if (week > currentWeek) {
      const w = allocation.weeks.find((x) => x.weekStart === week);
      if (w?.allocation) target = add(target, dailyShare(w.allocation, w.workdays));
      continue;
    }
    const found = segmentOn(input, day);
    if ("none" in found || found.segment.state !== "allocated" || !found.segment.allocation) {
      partial = true;
      continue;
    }
    const workdays = workdaysIn(input.goal, plan, found.weekStart).length;
    target = add(target, dailyShare(frac(found.segment.allocation.num, found.segment.allocation.den), workdays));
  }
  const progress = amountBetween(input.amounts, monthDays[0], monthDays[monthDays.length - 1]);
  return { target, progress, ratio: target.num === 0 ? null : progress / (target.num / target.den), partial };
}

export interface CapProjection {
  remainingWorkdays: number;
  maxProjected: number;
  /** The goal may not be reachable by its deadline (T-183, T-221, T-222). */
  unreachable: boolean;
}

/**
 * Maximum projected attainment: progress + cap × work opportunities left until the deadline,
 * counting today if it is one. An opportunity follows T-185 (`isOpportunity`): a selected workday
 * of the plan in effect, inside the goal's dates, while the goal is active and not archived, so
 * paused, archived, and completed periods add no capacity; days after today take the goal's current
 * status, since no future change is assumed. Independent of the weekly allocation, so it is also
 * shown during a mismatch (T-221) and whatever today's target is (T-222).
 */
export function capProjection(goal: GoalData, progress: number, today: string): CapProjection | null {
  const plan = planOn(goal, today);
  if (plan.dailyCap === null || plan.deadline === null || plan.deadline < today || goal.status === "completed" || goal.status === "abandoned") return null;
  const from = today > goal.startDate ? today : goal.startDate;
  const remainingWorkdays = datesBetween(from, plan.deadline).filter((d) => isOpportunity(goal, d)).length;
  const maxProjected = progress + plan.dailyCap * remainingWorkdays;
  return { remainingWorkdays, maxProjected, unreachable: maxProjected < plan.target };
}
