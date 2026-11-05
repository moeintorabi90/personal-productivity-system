/**
 * Weekly allocations of a goal's overall target (DECISIONS T-206 to T-213, T-215, T-219; derived
 * "Weekly allocation formula", "When a mismatch exists", "Open and closed weeks"). Pure: the
 * caller passes the plan, today's date, the actual progress before the current week, and each
 * week's current manual amount. Nothing is stored here; the result is either the amounts of the
 * open weeks or a discrepancy, and manual amounts are never changed.
 */
import type { GoalData, SegmentData } from "../backup/registry.ts";
import { add, div, frac, type Fraction, mul, ZERO } from "./fraction.ts";
import { goalWeekStarts, isClosedWeek, type GoalPlan, weekStartOf, workdaysIn } from "./goal-plan.ts";

export interface AllocationInput {
  goal: Pick<GoalData, "startDate" | "status" | "archivedAt" | "continuedAllocation">;
  plan: GoalPlan;
  /** Configured week start (0 = Sunday … 6). */
  weekStart: number;
  today: string;
  /** Actual progress recorded before the current week (closed weeks, T-208), whole number. */
  progressBeforeCurrentWeek: number;
  /** Current manual amount per stored week key (`null` = automatic). */
  manual: ReadonlyMap<string, number | null>;
}

export interface WeekAllocation {
  weekStart: string;
  /** Selected workdays of the week inside the goal's dates. */
  workdays: number;
  manual: number | null;
  /** The week's allocation; null during a mismatch for automatic weeks. */
  allocation: Fraction | null;
}

/** A manual amount kept outside the current weeks or on a week without workdays (T-211, T-212). */
export interface OutOfRange {
  weekStart: string;
  amount: number;
  /** Its week is closed: only a historical warning (T-219). */
  historical: boolean;
}

export type AllocationResult =
  /** No deadline or no workdays: manual amounts are kept but inactive (T-180, T-213). */
  | { kind: "inactive"; inactiveManual: string[] }
  /** After the deadline or completion: no open week (derived "After the deadline or completion"). */
  | { kind: "ended" }
  | {
      kind: "allocated" | "mismatch";
      weeks: WeekAllocation[];
      /** Target − progress before this week − active manual amounts (whole number). */
      share: number;
      /** |share| when the share cannot be distributed (T-207); 0 otherwise. */
      discrepancy: number;
      outOfRange: OutOfRange[];
    };

export function computeAllocations(input: AllocationInput): AllocationResult {
  const { goal, plan, today } = input;
  // A completed or abandoned goal is not pursued: no open week (T-243 for abandoned; derived).
  if (goal.status === "completed" || goal.status === "abandoned") return { kind: "ended" };
  if (plan.deadline === null || plan.workdays.length === 0) {
    return { kind: "inactive", inactiveManual: [...input.manual].filter(([, a]) => a !== null).map(([w]) => w).sort() };
  }
  if (plan.deadline < today) return { kind: "ended" };
  const current = weekStartOf(today, input.weekStart);
  const open = goalWeekStarts(goal, plan, input.weekStart).filter((w) => w >= current);
  const workdays = new Map(open.map((w) => [w, workdaysIn(goal, plan, w).length]));
  const active = new Map<string, number>();
  const outOfRange: OutOfRange[] = [];
  for (const [week, amount] of [...input.manual].sort(([a], [b]) => a.localeCompare(b))) {
    if (amount === null) continue;
    if (workdays.has(week) && workdays.get(week)! > 0) active.set(week, amount);
    else outOfRange.push({ weekStart: week, amount, historical: isClosedWeek(week, today) });
  }
  let share = plan.target - input.progressBeforeCurrentWeek;
  for (const amount of active.values()) share -= amount;
  const automatic = open.filter((w) => !active.has(w) && workdays.get(w)! > 0);
  const blocking = outOfRange.some((o) => !o.historical);
  const shareMismatch = (share < 0 && active.size > 0) || (share > 0 && automatic.length === 0);
  const mismatch = blocking || shareMismatch;
  // Resumed with "continue the previous plan" (T-246): every open automatic week keeps the weekly amount
  // from before the pause (its `from` is the resume date, so no open week is earlier) instead of a share
  // of the remaining target. The mismatch check of T-207 still applies as for any goal: manual amounts
  // that leave a negative amount to share, or a positive one no automatic week can take, are a
  // mismatch; then automatic weeks show no amount and manual ones keep theirs, never changed.
  const continued = goal.continuedAllocation;
  if (continued) {
    const weeks = open.map((w): WeekAllocation => {
      const manual = input.manual.get(w) ?? null;
      const allocation = active.has(w) ? frac(active.get(w)!) : mismatch ? null : workdays.get(w)! > 0 ? { ...continued.amount } : ZERO;
      return { weekStart: w, workdays: workdays.get(w)!, manual, allocation };
    });
    return { kind: mismatch ? "mismatch" : "allocated", weeks, share, discrepancy: shareMismatch ? Math.abs(share) : 0, outOfRange };
  }
  const totalAutoDays = automatic.reduce((sum, w) => sum + workdays.get(w)!, 0);
  const toShare = frac(Math.max(share, 0));
  const weeks = open.map((w): WeekAllocation => {
    const manual = input.manual.get(w) ?? null;
    let allocation: Fraction | null = null;
    if (active.has(w)) allocation = frac(active.get(w)!);
    else if (!mismatch && workdays.get(w)! > 0) allocation = mul(toShare, frac(workdays.get(w)!, totalAutoDays));
    else if (!mismatch) allocation = ZERO;
    return { weekStart: w, workdays: workdays.get(w)!, manual, allocation };
  });
  return {
    kind: mismatch ? "mismatch" : "allocated",
    weeks,
    share,
    discrepancy: shareMismatch ? Math.abs(share) : 0,
    outOfRange,
  };
}

/** The segment to record for one week key from an allocation result (T-208, T-213). */
export function segmentFor(result: AllocationResult, weekStartDate: string, manual: number | null): SegmentData {
  const source = manual !== null ? "manual" : "automatic";
  if (result.kind === "inactive") return { state: "inactive", allocation: null, source };
  if (result.kind === "ended") return { state: "none", allocation: null, source };
  if (result.kind === "mismatch") return { state: "mismatch", allocation: null, source };
  const week = result.weeks.find((w) => w.weekStart === weekStartDate);
  if (!week || week.workdays === 0 || week.allocation === null) return { state: "none", allocation: null, source };
  return { state: "allocated", allocation: { num: week.allocation.num, den: week.allocation.den }, source };
}

/** Sum of the open weeks' allocations (equals the remaining target when allocations match). */
export function allocatedTotal(result: AllocationResult): Fraction {
  if (result.kind !== "allocated") return ZERO;
  return result.weeks.reduce((sum, w) => (w.allocation ? add(sum, w.allocation) : sum), ZERO);
}

/** The allocation of one workday of a week: the week's allocation split by its workdays (monthly target). */
export const dailyShare = (allocation: Fraction, workdays: number) => (workdays > 0 ? div(allocation, frac(workdays)) : ZERO);
