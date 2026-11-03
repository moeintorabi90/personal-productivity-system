/**
 * Which goal plan applied on a date, calendar weeks of a goal, and its work opportunities
 * (DECISIONS T-180 to T-187, T-206; derived "Which plan applies", "Workdays", "Open and closed
 * weeks"). Pure functions over goal data and local dates in the configured zone.
 */
import type { GoalData, GoalPlanEntry, GoalStatus } from "../backup/registry.ts";
import { addDays, weekDates, weekdayOf } from "../planning/time.ts";

export interface GoalPlan {
  target: number;
  deadline: string | null;
  workdays: number[];
  dailyCap: number | null;
}

/** The goal's current plan from its own fields. */
export function currentPlan(goal: GoalData): GoalPlan {
  return { target: goal.target, deadline: goal.deadline, workdays: goal.workdays ?? [], dailyCap: goal.dailyCap ?? null };
}

/**
 * The plan in effect on `date` (T-182): the history entry with the latest `effectiveFrom` on or
 * before it; before the first entry, the first one. A goal without history has had its current
 * plan from its start (the unknown past is not reconstructed).
 */
export function planOn(goal: GoalData, date: string): GoalPlan {
  const history = goal.planHistory;
  if (!history || history.length === 0) return currentPlan(goal);
  let chosen: GoalPlanEntry = history[0]!;
  for (const entry of history) if (entry.effectiveFrom <= date) chosen = entry;
  return { target: chosen.target, deadline: chosen.deadline, workdays: chosen.workdays, dailyCap: chosen.dailyCap };
}

/** Status and archive state on `date`; without history, the current ones. */
export function statusOn(goal: GoalData, date: string): { status: GoalStatus; archived: boolean } {
  const history = goal.statusHistory;
  if (!history || history.length === 0) return { status: goal.status, archived: goal.archivedAt !== null };
  let chosen = history[0]!;
  for (const entry of history) if (entry.from <= date) chosen = entry;
  return { status: chosen.status, archived: chosen.archived };
}

/** First day of the calendar week containing `date` under the configured week start (D-020). */
export function weekStartOf(date: string, weekStart: number): string {
  return weekDates(date, weekStart)[0]!;
}

/** The seven dates of the week that starts on `weekStart` (a stored key; no week-start setting needed). */
export function daysOfWeek(weekStartDate: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStartDate, i));
}

/** Whether `date` is inside the goal's dates under a plan (start date to deadline, inclusive). */
export function inGoalRange(goal: Pick<GoalData, "startDate">, plan: Pick<GoalPlan, "deadline">, date: string): boolean {
  return date >= goal.startDate && (plan.deadline === null || date <= plan.deadline);
}

/** A selected workday of the plan inside the goal's dates. */
export function isPlannedWorkday(goal: Pick<GoalData, "startDate">, plan: GoalPlan, date: string): boolean {
  return inGoalRange(goal, plan, date) && plan.workdays.includes(weekdayOf(date));
}

/** Selected workdays of a week inside the goal's dates, under one plan. */
export function workdaysIn(goal: Pick<GoalData, "startDate">, plan: GoalPlan, weekStartDate: string, fromDate?: string): string[] {
  return daysOfWeek(weekStartDate).filter((d) => (fromDate === undefined || d >= fromDate) && isPlannedWorkday(goal, plan, d));
}

/** Calendar weeks (their first days) that overlap the goal's dates; needs a deadline. */
export function goalWeekStarts(goal: Pick<GoalData, "startDate">, plan: GoalPlan, weekStart: number): string[] {
  if (plan.deadline === null || plan.deadline < goal.startDate) return [];
  const out: string[] = [];
  for (let w = weekStartOf(goal.startDate, weekStart); w <= plan.deadline; w = addDays(w, 7)) out.push(w);
  return out;
}

/** A week whose last local day has ended (derived "Open and closed weeks"). */
export const isClosedWeek = (weekStartDate: string, today: string) => addDays(weekStartDate, 6) < today;

/**
 * Whether `date` is a work opportunity of the goal (derived "Workdays", T-185): a selected weekday
 * of the plan in effect that day, within the goal's dates, while the goal was active and not
 * archived. Completion, pause, and archive periods are not opportunities.
 */
export function isOpportunity(goal: GoalData, date: string): boolean {
  const plan = planOn(goal, date);
  if (!isPlannedWorkday(goal, plan, date)) return false;
  const state = statusOn(goal, date);
  return state.status === "active" && !state.archived;
}
