/**
 * Stage 6 goal-plan commands (DECISIONS T-180 to T-187, T-206 to T-237; "Data design for weekly
 * allocations"). Plan history and status history on the goal record, manual weekly allocations,
 * the recorded weekly plans, and the owner's decisions between recorded versions of a date with
 * their history. Every write is an explicit user action or follows one in the same transaction;
 * the only writes without an action are a week's first plan when the app runs in it (T-225).
 * The app never computes or appends a segment for a closed week by itself (T-208).
 */
import {
  type GoalData,
  GOAL_WEEK_ALLOCATIONS,
  GOAL_WEEK_PLAN_CHOICES,
  GOAL_WEEK_PLANS,
  type GoalPlanEntry,
  GOALS,
  type GoalStatusEntry,
  type GoalWeekAllocationData,
  type GoalWeekPlanChoiceData,
  type GoalWeekPlanData,
  OUTPUT_RECORDS,
  OUTPUT_VALUE_MAX,
  type OutputRecordData,
  PRODUCT_REGISTRY,
  type Registry,
  type SegmentData,
  type SessionData,
  SESSIONS,
  TASK_COMPLETIONS,
  type TaskCompletionData,
} from "../backup/registry.ts";
import { canonicalize } from "../backup/jcs.ts";
import { type EnvelopeLimit, envelopeLimitProblem, nowIso } from "../backup/envelope.ts";
import { planChoiceId, weekAllocationId, weekPlanId } from "../backup/derived-id.ts";
import { localDateOf } from "../planning/time.ts";
import { computeAllocations, segmentFor, type AllocationResult } from "../insights/allocation.ts";
import { amountBetween, goalDays } from "../insights/actuals.ts";
import { currentPlan, goalWeekStarts, isClosedWeek, planOn, weekStartOf, workdaysIn, type GoalPlan } from "../insights/goal-plan.ts";
import { appliedSegment, canWriteEntry, decideEntry, decisionChoices, needsDecision, planDateOn, resolveDate, withDate, writeEntry } from "../insights/plan-merge.ts";
import type { VersionVector } from "../backup/versions.ts";
import type { LocalDb, RecordRow } from "./db.ts";
import type { Item } from "./organization.ts";
import { deviceIdentity, plannedWriteEnvelope, putRecord } from "./records.ts";
import { getSharedPreferences } from "./settings.ts";

export type GoalPlanErrorCode =
  | "NOT_FOUND"
  | "ARCHIVED"
  | "INVALID_AMOUNT"
  /** Allocations need a deadline and selected workdays (T-180, T-213). */
  | "NO_ALLOCATIONS"
  /** Only open weeks of the goal with a selected workday take a new manual amount (derived). */
  | "WEEK_NOT_EDITABLE"
  | "NO_MANUAL_AMOUNT"
  /** The destination already has a manual amount: replace, add, or cancel (T-220). */
  | "NEEDS_CHOICE"
  | "SAME_WEEK"
  /** The choice is not one of the recorded versions shown for that date (T-223, T-227). */
  | "NOT_A_CHOICE"
  /** The date changed after it was shown; show it again. */
  | "CHANGED"
  /** This device's counter for the date, or a malformed claim about it, is at its maximum: no entry can be written. */
  | "SEQ_LIMIT"
  /** The record would pass the per-record size limit; nothing is written or dropped. */
  | "RECORD_LIMIT"
  /** The record's version vector would list more than the 32 devices a backup record may; nothing is written. */
  | "DEVICE_LIMIT"
  /** This device's edit counter of the record is at its maximum; nothing is written. */
  | "VERSION_LIMIT";

export class GoalPlanError extends Error {
  readonly code: GoalPlanErrorCode;
  constructor(code: GoalPlanErrorCode, message: string) {
    super(message);
    this.name = "GoalPlanError";
    this.code = code;
  }
}

/** A weekly plan with its version vector, so the exact envelope of its next write can be measured. */
export type PlanItem = Item<GoalWeekPlanData> & { version: VersionVector };

export interface GoalPlanning {
  allocations: Item<GoalWeekAllocationData>[];
  plans: PlanItem[];
  choices: Item<GoalWeekPlanChoiceData>[];
}

const itemOf = <T>(row: RecordRow): Item<T> => ({ id: row.id, data: row.data as T, createdAt: row.createdAt, updatedAt: row.updatedAt });

async function rowsOf<T>(db: LocalDb, type: string): Promise<Item<T>[]> {
  return (await db.records.where("type").equals(type).toArray()).map((row) => itemOf<T>(row));
}

async function planRows(db: LocalDb): Promise<PlanItem[]> {
  return (await db.records.where("type").equals(GOAL_WEEK_PLANS).toArray()).map((row) => ({ ...itemOf<GoalWeekPlanData>(row), version: row.version }));
}

/**
 * Which per-record limit this device's write of a weekly plan would break (32 devices in the
 * version vector, or 256 KiB), or null, measured on the exact envelope `putRecord` would store at
 * `at` (the record's ID, `createdAt` as stored, the new `updatedAt`, raised version vector, content
 * hash, and data). Nothing is dropped to fit.
 */
export function planWriteLimit(rows: readonly PlanItem[], deviceId: string, at: string): (data: GoalWeekPlanData) => EnvelopeLimit | null {
  return (data) => {
    const row = rows.find((r) => r.data.goalId === data.goalId && r.data.weekStart === data.weekStart);
    const id = row?.id ?? weekPlanId(data.goalId, data.weekStart);
    return envelopeLimitProblem(plannedWriteEnvelope(row, id, data as unknown as Record<string, unknown>, deviceId, at));
  };
}

/** Allocations, weekly plans, and choice history on this device (live records). */
export async function loadGoalPlanning(db: LocalDb): Promise<GoalPlanning> {
  return db.transaction("r", db.records, async () => ({
    allocations: await rowsOf<GoalWeekAllocationData>(db, GOAL_WEEK_ALLOCATIONS),
    plans: await planRows(db),
    choices: await rowsOf<GoalWeekPlanChoiceData>(db, GOAL_WEEK_PLAN_CHOICES),
  }));
}

/** The current manual amount of each week key of a goal (last revision; `null` = automatic). */
export function manualAmounts(allocations: readonly { data: GoalWeekAllocationData }[], goalId: string): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const a of allocations) if (a.data.goalId === goalId) out.set(a.data.weekStart, a.data.revisions.at(-1)!.amount);
  return out;
}

/** The manual amount of a week key on a past date (T-224: the plan applied at any time can be shown). */
export function manualAmountOn(allocation: GoalWeekAllocationData, date: string): number | null {
  let amount: number | null = null;
  for (const r of allocation.revisions) if (r.from <= date) amount = r.amount;
  return amount;
}

/** Today's local date: the configured zone, else the device calendar (T-086). */
export async function todayOf(db: LocalDb, now: number = Date.now()): Promise<{ today: string; zone: string; weekStart: number }> {
  const shared = await getSharedPreferences(db);
  const zone = shared.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  return { today: localDateOf(now, zone), zone, weekStart: shared.weekStart };
}

async function progressRecords(db: LocalDb) {
  return {
    sessions: await rowsOf<SessionData>(db, SESSIONS),
    outputs: await rowsOf<OutputRecordData>(db, OUTPUT_RECORDS),
    completions: await rowsOf<TaskCompletionData>(db, TASK_COMPLETIONS),
  };
}

export interface AllocationState {
  plan: GoalPlan;
  result: AllocationResult;
  currentWeek: string;
}

/** The allocation of a goal today, from its current plan, closed weeks' actual output, and manual amounts. */
export function allocationState(
  goalId: string,
  goal: GoalData,
  amounts: ReadonlyMap<string, number>,
  allocations: readonly { data: GoalWeekAllocationData }[],
  today: string,
  weekStart: number,
): AllocationState {
  const plan = currentPlan(goal);
  const currentWeek = weekStartOf(today, weekStart);
  const result = computeAllocations({
    goal,
    plan,
    weekStart,
    today,
    progressBeforeCurrentWeek: amountBetween(amounts, undefined, previousDay(currentWeek)),
    manual: manualAmounts(allocations, goalId),
  });
  return { plan, result, currentWeek };
}

const previousDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** Whether the app writes a weekly plan for the goal today: running, not archived or completed. */
function plansToday(goal: GoalData, today: string): boolean {
  const plan = currentPlan(goal);
  return goal.archivedAt === null && goal.status !== "completed" && goal.startDate <= today && (plan.deadline === null || plan.deadline >= today);
}

/**
 * What a refresh would write for one goal's current week today (pure; `refreshWeekPlans` acts on it
 * and the goal view reads it, so the two never disagree). `start`: no record yet, a first segment
 * from today. `owner`: today's date waits for the owner's decision (T-223). `same`: the computed
 * segment is already in effect. `write`: this device's entry for today is to be written.
 * `blocked`: the computed segment differs from the one in effect, but it cannot be written: this
 * device's counter for today is at its maximum (`canWriteEntry`, reason `counter`), or the record's
 * exact envelope would break a per-record limit of the backup format (`limit`, from
 * `planWriteLimit`: reason `devices` for more than 32 devices in its version vector,
 * `versionCounter` for this device's edit counter at its maximum, `size` for more than 256 KiB). The recorded plan stays, and the goal view says so.
 * `none`: the goal is not running, or has no deadline or workdays to start a record with.
 */
export type PlanWriteStep =
  | { kind: "none" | "owner" | "same" }
  | { kind: "start" | "write"; segment: SegmentData }
  | { kind: "blocked"; reason: "counter" | EnvelopeLimit; segment: SegmentData; inEffect: SegmentData | null };

export function planWriteStep(
  goal: GoalData,
  state: AllocationState,
  manual: ReadonlyMap<string, number | null>,
  goalPlans: readonly GoalWeekPlanData[],
  today: string,
  thisDevice: string,
  limit: (data: GoalWeekPlanData) => EnvelopeLimit | null,
): PlanWriteStep {
  if (!plansToday(goal, today)) return { kind: "none" };
  const segment = segmentFor(state.result, state.currentWeek, manual.get(state.currentWeek) ?? null);
  const existing = goalPlans.find((p) => p.weekStart === state.currentWeek);
  if (!existing) {
    // Without a deadline and workdays there is nothing to allocate (T-180): no record is started.
    return state.plan.deadline === null || state.plan.workdays.length === 0 ? { kind: "none" } : { kind: "start", segment };
  }
  const todayDate = existing.dates.find((d) => d.from === today);
  if (todayDate && needsDecision(todayDate)) return { kind: "owner" }; // undecided, in conflict, or inconsistent
  const applied = planDateOn(goalPlans, today, thisDevice);
  const inEffect = applied ? appliedSegment(applied.resolution) : null;
  if (inEffect && canonicalize(inEffect) === canonicalize(segment)) return { kind: "same" };
  if (!canWriteEntry(todayDate, thisDevice)) return { kind: "blocked", reason: "counter", segment, inEffect };
  const problem = limit(withDate(existing, writeEntry(todayDate, today, thisDevice, segment)));
  if (problem) return { kind: "blocked", reason: problem, segment, inEffect };
  return { kind: "write", segment };
}

/**
 * Records the current week's plan of every running goal (T-208, T-225). "open": only a week that
 * has no record yet gets its first segment, from today (never backdated). "change": after a change
 * that may alter the current week's allocation, this device's entry for today is written when the
 * computed segment differs from the one in effect; a date the owner has not decided is never
 * written over (the owner decides it, T-223). Runs inside the caller's transaction.
 */
export async function refreshWeekPlans(db: LocalDb, registry: Registry, mode: "open" | "change", now: number = Date.now()): Promise<void> {
  const { today, zone, weekStart } = await todayOf(db, now);
  const goals = await rowsOf<GoalData>(db, GOALS);
  const running = goals.filter((g) => plansToday(g.data, today));
  if (running.length === 0) return;
  const device = await deviceIdentity(db);
  const allocations = await rowsOf<GoalWeekAllocationData>(db, GOAL_WEEK_ALLOCATIONS);
  const plans = await planRows(db);
  const limit = planWriteLimit(plans, device.id, new Date(now).toISOString());
  const records = await progressRecords(db);
  for (const goal of running) {
    const state = allocationState(goal.id, goal.data, goalDays(goal.id, goal.data, records, zone).amounts, allocations, today, weekStart);
    const id = weekPlanId(goal.id, state.currentWeek);
    const goalPlans = plans.filter((p) => p.data.goalId === goal.id).map((p) => p.data);
    const step = planWriteStep(goal.data, state, manualAmounts(allocations, goal.id), goalPlans, today, device.id, limit);
    if (step.kind === "start") {
      const data: GoalWeekPlanData = { goalId: goal.id, weekStart: state.currentWeek, dates: [writeEntry(undefined, today, device.id, step.segment)] };
      await putRecord(db, registry, GOAL_WEEK_PLANS, id, data);
    } else if (step.kind === "write" && mode === "change") {
      const existing = goalPlans.find((p) => p.weekStart === state.currentWeek)!;
      await putRecord(db, registry, GOAL_WEEK_PLANS, id, withDate(existing, writeEntry(existing.dates.find((d) => d.from === today), today, device.id, step.segment)));
    }
    // "owner", "same", "blocked", and "none" write nothing; "blocked" is shown on the goal page.
  }
}

/* ---------- plan and status history (T-182, T-185) ---------- */

/** Appends today's plan to the goal's history (same-day changes replace that day's entry). */
export function withPlanHistory(before: GoalData, after: GoalData, today: string): GoalData {
  const was = currentPlan(before);
  const now = currentPlan(after);
  if (canonicalize(was) === canonicalize(now)) return after;
  const base: GoalPlanEntry[] = before.planHistory ? [...before.planHistory] : before.startDate < today ? [{ effectiveFrom: before.startDate, ...was }] : [];
  const history = [...base.filter((e) => e.effectiveFrom < today), { effectiveFrom: today, ...now }];
  return { ...after, planHistory: history };
}

/** Appends today's status and archive state to the goal's status history. */
export function withStatusHistory(before: GoalData, after: GoalData, today: string): GoalData {
  const was = { status: before.status, archived: before.archivedAt !== null };
  const now = { status: after.status, archived: after.archivedAt !== null };
  if (was.status === now.status && was.archived === now.archived) return after;
  const base: GoalStatusEntry[] = before.statusHistory ? [...before.statusHistory] : before.startDate < today ? [{ from: before.startDate, ...was }] : [];
  return { ...after, statusHistory: [...base.filter((e) => e.from < today), { from: today, ...now }] };
}

/* ---------- manual weekly allocations (T-206, T-207, T-211 to T-220, T-224) ---------- */

async function editableGoal(db: LocalDb, goalId: string): Promise<GoalData> {
  const row = await db.records.get([GOALS, goalId]);
  if (!row) throw new GoalPlanError("NOT_FOUND", `goal ${goalId} does not exist`);
  const goal = row.data as GoalData;
  if (goal.archivedAt !== null) throw new GoalPlanError("ARCHIVED", "restore the goal before changing it");
  return goal;
}

function checkAmount(amount: number | null): void {
  if (amount !== null && (!Number.isInteger(amount) || amount < 0 || amount > OUTPUT_VALUE_MAX)) throw new GoalPlanError("INVALID_AMOUNT", "a whole number of 0 or more");
}

/** Whether a week key may take a new manual amount: an open week of the goal with a selected workday. */
export function weekTakesManual(goal: GoalData, weekKey: string, today: string, weekStart: number): boolean {
  const plan = currentPlan(goal);
  if (plan.deadline === null || plan.workdays.length === 0 || isClosedWeek(weekKey, today)) return false;
  return goalWeekStarts(goal, plan, weekStart).includes(weekKey) && workdaysIn(goal, plan, weekKey).length > 0;
}

async function writeAllocation(db: LocalDb, registry: Registry, goalId: string, weekKey: string, amount: number | null, today: string): Promise<boolean> {
  const id = weekAllocationId(goalId, weekKey);
  const current = (await db.records.get([GOAL_WEEK_ALLOCATIONS, id]))?.data as GoalWeekAllocationData | undefined;
  if (!current) {
    if (amount === null) return false;
    await putRecord(db, registry, GOAL_WEEK_ALLOCATIONS, id, { goalId, weekStart: weekKey, revisions: [{ from: today, amount }] } satisfies GoalWeekAllocationData);
    return true;
  }
  if (current.revisions.at(-1)!.amount === amount) return false;
  const kept = current.revisions.filter((r) => r.from < today);
  const revisions = kept.length > 0 && kept.at(-1)!.amount === amount ? kept : [...kept, { from: today, amount }];
  await putRecord(db, registry, GOAL_WEEK_ALLOCATIONS, id, { ...current, revisions: revisions.length > 0 ? revisions : [{ from: today, amount }] });
  return true;
}

/**
 * Sets a week's manual amount, or returns it to automatic with `null` (T-206, T-207). A new manual
 * amount needs an open week of the goal with a selected workday; a manual amount kept out of range
 * stays correctable (T-211, T-212). The current week's plan is updated in the same transaction.
 */
export async function setWeekAllocation(db: LocalDb, goalId: string, weekKey: string, amount: number | null, now: number = Date.now(), registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  checkAmount(amount);
  await db.transaction("rw", [db.records, db.tombstones, db.meta], async () => {
    const goal = await editableGoal(db, goalId);
    const { today, weekStart } = await todayOf(db, now);
    if (amount !== null) {
      const plan = currentPlan(goal);
      if (plan.deadline === null || plan.workdays.length === 0) throw new GoalPlanError("NO_ALLOCATIONS", "allocations need a deadline and workdays");
      const existing = (await db.records.get([GOAL_WEEK_ALLOCATIONS, weekAllocationId(goalId, weekKey)]))?.data as GoalWeekAllocationData | undefined;
      const hasManual = existing !== undefined && existing.revisions.at(-1)!.amount !== null;
      if (isClosedWeek(weekKey, today) || (!hasManual && !weekTakesManual(goal, weekKey, today, weekStart))) {
        throw new GoalPlanError("WEEK_NOT_EDITABLE", "only open weeks of the goal with a workday");
      }
    }
    if (await writeAllocation(db, registry, goalId, weekKey, amount, today)) await refreshWeekPlans(db, registry, "change", now);
  });
}

/**
 * Moves a manual amount to another open week of the goal, only by the owner's explicit action
 * (T-218): the source returns to automatic and the destination takes the amount; if the
 * destination already has a manual amount, `mode` must say replace or add (T-220). No separate
 * record of the move is kept (T-224).
 */
export async function moveWeekAllocation(
  db: LocalDb,
  goalId: string,
  fromWeek: string,
  toWeek: string,
  mode?: "replace" | "add",
  now: number = Date.now(),
  registry: Registry = PRODUCT_REGISTRY,
): Promise<void> {
  await db.transaction("rw", [db.records, db.tombstones, db.meta], async () => {
    if (fromWeek === toWeek) throw new GoalPlanError("SAME_WEEK", "choose another week");
    const goal = await editableGoal(db, goalId);
    const { today, weekStart } = await todayOf(db, now);
    const source = (await db.records.get([GOAL_WEEK_ALLOCATIONS, weekAllocationId(goalId, fromWeek)]))?.data as GoalWeekAllocationData | undefined;
    const amount = source?.revisions.at(-1)!.amount ?? null;
    if (amount === null) throw new GoalPlanError("NO_MANUAL_AMOUNT", "the week has no manual amount");
    if (!weekTakesManual(goal, toWeek, today, weekStart)) throw new GoalPlanError("WEEK_NOT_EDITABLE", "only open weeks of the goal with a workday");
    const dest = (await db.records.get([GOAL_WEEK_ALLOCATIONS, weekAllocationId(goalId, toWeek)]))?.data as GoalWeekAllocationData | undefined;
    const destAmount = dest?.revisions.at(-1)!.amount ?? null;
    if (destAmount !== null && !mode) throw new GoalPlanError("NEEDS_CHOICE", "replace, add, or cancel");
    const total = destAmount !== null && mode === "add" ? destAmount + amount : amount;
    checkAmount(total);
    await writeAllocation(db, registry, goalId, fromWeek, null, today);
    await writeAllocation(db, registry, goalId, toWeek, total, today);
    await refreshWeekPlans(db, registry, "change", now);
  });
}

/* ---------- owner decisions between recorded versions (T-223, T-227, T-228, T-237) ---------- */

/**
 * Decides a date of a weekly plan, or changes an earlier choice: `chosen` must be one of the
 * date's candidates (while undecided or in conflict) or one of its `options` (a settled date). This
 * device's entry is replaced with the next counter and `seen` covering every entry on this device,
 * and a choice-history event is written in the same transaction. `shown` is the canonical JSON of
 * the date as the owner saw it, so a date that changed meanwhile is refused.
 */
export async function decidePlanDate(
  db: LocalDb,
  planId: string,
  from: string,
  chosen: SegmentData,
  shown: string,
  now: number = Date.now(),
  registry: Registry = PRODUCT_REGISTRY,
): Promise<void> {
  await db.transaction("rw", [db.records, db.tombstones, db.meta], async () => {
    const row = await db.records.get([GOAL_WEEK_PLANS, planId]);
    if (!row) throw new GoalPlanError("NOT_FOUND", "the weekly plan is not on this device");
    const plan = row.data as GoalWeekPlanData;
    const date = plan.dates.find((d) => d.from === from);
    if (!date) throw new GoalPlanError("NOT_FOUND", "no such date");
    if (canonicalize(date) !== shown) throw new GoalPlanError("CHANGED", "the date changed; review it again");
    const offered = needsDecision(date) ? decisionChoices(date) : date.options;
    if (!offered.some((s) => canonicalize(s) === canonicalize(chosen))) throw new GoalPlanError("NOT_A_CHOICE", "choose one of the recorded versions");
    const device = await deviceIdentity(db);
    if (!canWriteEntry(date, device.id)) throw new GoalPlanError("SEQ_LIMIT", "this device's counter for the date is at its maximum; nothing was written");
    const previous = appliedSegment(resolveDate(date, device.id));
    const next = decideEntry(date, from, device.id, chosen);
    // Nothing is dropped to make room: if the exact envelope would break a per-record limit, the decision is refused.
    const problem = planWriteLimit([{ ...itemOf<GoalWeekPlanData>(row), version: row.version }], device.id, nowIso())(withDate(plan, next));
    if (problem === "devices") throw new GoalPlanError("DEVICE_LIMIT", "the weekly plan's version vector would list more than 32 devices; nothing was written");
    if (problem === "versionCounter") throw new GoalPlanError("VERSION_LIMIT", "this device's edit counter of the weekly plan is at its maximum; nothing was written");
    if (problem === "size") throw new GoalPlanError("RECORD_LIMIT", "the weekly plan would pass the per-record size limit; nothing was written");
    const entry = next.entries.find((e) => e.device === device.id)!;
    await putRecord(db, registry, GOAL_WEEK_PLANS, planId, withDate(plan, next));
    const event: GoalWeekPlanChoiceData = {
      goalId: plan.goalId,
      weekStart: plan.weekStart,
      from,
      device: device.id,
      deviceName: device.name.slice(0, 80),
      seq: entry.seq,
      previous,
      chosen,
      seen: entry.seen,
      recordedAt: nowIso(),
    };
    await putRecord(db, registry, GOAL_WEEK_PLAN_CHOICES, planChoiceId(plan.goalId, plan.weekStart, from, device.id, entry.seq), event);
  });
}

/** The recorded plan in effect today for one goal on this device (for the goal page), if any. */
export function planInEffect(plans: readonly { data: GoalWeekPlanData }[], goalId: string, day: string, thisDevice: string) {
  return planDateOn(plans.filter((p) => p.data.goalId === goalId).map((p) => p.data), day, thisDevice);
}

export { planOn };
