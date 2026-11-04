/**
 * Stage 6 reports (DECISIONS T-178, T-179, T-188 to T-196): planned versus actual by task and local
 * day, estimate accuracy per occurrence, work without a task or project, output rates, and the
 * app-use streak. Pure, recomputed on display; nothing here is stored (T-196) and nothing reads or
 * writes a session's block link (T-178).
 */
import type {
  CalendarBlockData,
  OutputRecordData,
  SessionData,
  TaskCompletionData,
  TaskDefinitionData,
  TaskEstimateCaptureData,
} from "../backup/registry.ts";
import { estimateCaptureId } from "../backup/derived-id.ts";
import { addDays, datesBetween, localDateOf, startOfLocalDay } from "../planning/time.ts";
import { MINUTE, workMinutes } from "../work/session-time.ts";
import { minutesByLocalDay } from "./actuals.ts";

interface Item<T> {
  id: string;
  data: T;
}

/** An inclusive range of local dates; `from` null = from the beginning. */
export interface DateRange {
  from: string | null;
  to: string;
}

export const inRange = (date: string, range: DateRange) => (range.from === null || date >= range.from) && date <= range.to;

/** The plan a block is compared with (T-179): its comparison plan if one was kept, else its current times. */
export function comparedPlan(block: CalendarBlockData): { startsAt: string; endsAt: string; status: "planned" | "cancelled" } {
  return block.comparisonPlan ?? { startsAt: block.startsAt, endsAt: block.endsAt, status: block.status };
}

/** Planned minutes of a block per local day (split at local midnight, like sessions). */
export function plannedMinutesByDay(block: CalendarBlockData, zone: string): Map<string, number> {
  const plan = comparedPlan(block);
  const out = new Map<string, number>();
  if (plan.status !== "planned") return out;
  let cursor = Date.parse(plan.startsAt);
  const end = Date.parse(plan.endsAt);
  while (cursor < end) {
    const date = localDateOf(cursor, zone);
    const next = Math.min(end, startOfLocalDay(addDays(date, 1), zone));
    out.set(date, (out.get(date) ?? 0) + Math.round((next - cursor) / MINUTE));
    cursor = next;
  }
  return out;
}

/** Sessions that count in reports: ended and not in the trash (T-103, T-143). */
export const reportSessions = <T extends Item<SessionData>>(sessions: readonly T[]) => sessions.filter((s) => s.data.deletedAt === null && s.data.endedAt !== null);

export interface ComparisonRow {
  date: string;
  /** null: "No task" (T-192). */
  taskId: string | null;
  title: string | null;
  plannedMinutes: number;
  actualMinutes: number;
  blocks: number;
  sessions: number;
}

/**
 * Planned versus actual by task and local day (T-178): several blocks and sessions of one task on
 * one day aggregate, a session with no block link still counts, and sessions stay at their
 * recorded times. Rows are sorted by date, then title.
 */
export function plannedVersusActual(
  blocks: readonly Item<CalendarBlockData>[],
  sessions: readonly Item<SessionData>[],
  range: DateRange,
  zone: string,
  tasks: ReadonlyMap<string, TaskDefinitionData>,
): ComparisonRow[] {
  const rows = new Map<string, ComparisonRow>();
  const row = (date: string, taskId: string | null, title: string | null) => {
    const k = `${date}/${taskId ?? ""}`;
    let r = rows.get(k);
    if (!r) rows.set(k, (r = { date, taskId, title: taskId ? (tasks.get(taskId)?.title ?? title) : null, plannedMinutes: 0, actualMinutes: 0, blocks: 0, sessions: 0 }));
    return r;
  };
  for (const b of blocks) {
    for (const [date, minutes] of plannedMinutesByDay(b.data, zone)) {
      if (!inRange(date, range)) continue;
      const r = row(date, b.data.taskId, b.data.snapshot.taskTitle);
      r.plannedMinutes += minutes;
      r.blocks += 1;
    }
  }
  for (const s of reportSessions(sessions)) {
    for (const [date, minutes] of minutesByLocalDay(s.data, zone)) {
      if (!inRange(date, range)) continue;
      const r = row(date, s.data.taskId, s.data.snapshot?.taskTitle ?? null);
      r.actualMinutes += minutes;
      r.sessions += 1;
    }
  }
  return [...rows.values()].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : (a.title ?? "").localeCompare(b.title ?? "")));
}

export interface WorkTotals {
  minutes: number;
  sessions: number;
  /** Per project (`null`: "No project"), with "No task" counted separately (T-192). */
  byProject: { projectId: string | null; name: string | null; minutes: number; sessions: number }[];
  noTaskMinutes: number;
  noTaskSessions: number;
}

/** Work time in a range, with nothing silently left out: totals equal the sum of the categories. */
export function workTotals(sessions: readonly Item<SessionData>[], range: DateRange, zone: string, tasks: ReadonlyMap<string, TaskDefinitionData>, projectNames: ReadonlyMap<string, string>): WorkTotals {
  const byProject = new Map<string, WorkTotals["byProject"][number]>();
  let minutes = 0;
  let count = 0;
  let noTaskMinutes = 0;
  let noTaskSessions = 0;
  for (const s of reportSessions(sessions)) {
    let m = 0;
    for (const [date, value] of minutesByLocalDay(s.data, zone)) if (inRange(date, range)) m += value;
    // A session with no minutes in the range (e.g. under a minute) counts on its start date in `zone` (D-020).
    if (m === 0 && !inRange(localDateOf(s.data.startedAt, zone), range)) continue;
    minutes += m;
    count += 1;
    if (s.data.taskId === null) {
      noTaskMinutes += m;
      noTaskSessions += 1;
    }
    const projectId = s.data.taskId ? (tasks.get(s.data.taskId)?.projectId ?? s.data.snapshot?.projectId ?? null) : null;
    const k = projectId ?? "";
    const entry = byProject.get(k) ?? { projectId, name: projectId ? (projectNames.get(projectId) ?? s.data.snapshot?.projectName ?? null) : null, minutes: 0, sessions: 0 };
    entry.minutes += m;
    entry.sessions += 1;
    byProject.set(k, entry);
  }
  return { minutes, sessions: count, byProject: [...byProject.values()].sort((a, b) => b.minutes - a.minutes), noTaskMinutes, noTaskSessions };
}

/* ---------- estimates (T-188 to T-191) ---------- */

/** The occurrence a session counts for: a one-off task's only one (null), or the assigned date; undefined = unassigned. */
export function sessionOccurrence(s: SessionData, tasks: ReadonlyMap<string, TaskDefinitionData>): string | null | undefined {
  if (s.taskId === null) return undefined;
  const task = tasks.get(s.taskId);
  if (!task?.recurrence) return null;
  return s.occurrenceDate;
}

export interface EstimateRow {
  taskId: string;
  occurrenceDate: string | null;
  title: string;
  estimateMinutes: number | null;
  actualMinutes: number;
  completed: boolean;
  /** Only after explicit completion and with a captured estimate (T-191). */
  differenceMinutes: number | null;
  /** (actual − estimate) ÷ estimate. */
  differenceRatio: number | null;
  completedOn: string | null;
}

/**
 * Estimate versus actual per occurrence: the estimate captured for it (T-189; none for occurrences
 * from before version 8, never back-filled), the work time of its sessions (elapsed while it is
 * open), and the difference once it is completed. Recurring-task sessions without an occurrence
 * are counted in `unassignedSessions`, not in any occurrence (T-190). Reopened completions do not count.
 */
export function estimateRows(
  tasks: ReadonlyMap<string, TaskDefinitionData>,
  captures: ReadonlyMap<string, TaskEstimateCaptureData>,
  completions: readonly Item<TaskCompletionData>[],
  sessions: readonly Item<SessionData>[],
  zone: string,
  now: number = Date.now(),
): { rows: EstimateRow[]; unassignedSessions: number } {
  const minutes = new Map<string, number>();
  const worked = new Map<string, [string, string | null]>();
  let unassignedSessions = 0;
  for (const s of sessions) {
    if (s.data.deletedAt !== null || s.data.taskId === null) continue;
    const occurrence = sessionOccurrence(s.data, tasks);
    if (occurrence === undefined) {
      unassignedSessions += 1;
      continue;
    }
    const k = estimateCaptureId(s.data.taskId, occurrence);
    minutes.set(k, (minutes.get(k) ?? 0) + workMinutes(s.data, now));
    worked.set(k, [s.data.taskId, occurrence]);
  }
  const rows = new Map<string, EstimateRow>();
  const add = (taskId: string, occurrenceDate: string | null) => {
    const k = estimateCaptureId(taskId, occurrenceDate);
    if (rows.has(k)) return rows.get(k)!;
    const row: EstimateRow = {
      taskId,
      occurrenceDate,
      title: tasks.get(taskId)?.title ?? "",
      estimateMinutes: captures.get(k)?.estimateMinutes ?? null,
      actualMinutes: minutes.get(k) ?? 0,
      completed: false,
      differenceMinutes: null,
      differenceRatio: null,
      completedOn: null,
    };
    rows.set(k, row);
    return row;
  };
  for (const c of completions) {
    if (c.data.reopenedAt !== null) continue;
    const row = add(c.data.taskId, c.data.occurrenceDate);
    row.completed = true;
    row.completedOn = c.data.occurrenceDate ?? localDateOf(c.data.completedAt, zone);
    if (row.estimateMinutes !== null) {
      row.differenceMinutes = row.actualMinutes - row.estimateMinutes;
      row.differenceRatio = row.differenceMinutes / row.estimateMinutes;
    }
  }
  for (const [k, capture] of captures) if (!rows.has(k)) add(capture.taskId, capture.occurrenceDate);
  // Occurrences being worked on show their elapsed time before completion (T-191).
  for (const [k, [taskId, occurrence]] of worked) if (!rows.has(k)) add(taskId, occurrence);
  return { rows: [...rows.values()].sort((a, b) => a.title.localeCompare(b.title) || (a.occurrenceDate ?? "").localeCompare(b.occurrenceDate ?? "")), unassignedSessions };
}

/** Accuracy over completed rows in a range: average absolute difference and sample count (T-193). */
export function estimateSummary(rows: readonly EstimateRow[], range: DateRange) {
  const done = rows.filter((r) => r.completed && r.differenceMinutes !== null && r.completedOn !== null && inRange(r.completedOn, range));
  if (done.length === 0) return { samples: 0, meanDifference: null, meanRatio: null };
  const meanDifference = done.reduce((s, r) => s + r.differenceMinutes!, 0) / done.length;
  const meanRatio = done.reduce((s, r) => s + r.differenceRatio!, 0) / done.length;
  return { samples: done.length, meanDifference, meanRatio };
}

/* ---------- output rate (T-195, T-196) ---------- */

export interface RateBucket {
  from: string;
  to: string;
  total: number;
  minutes: number;
  samples: number;
  /** Per hour; null when no session in the bucket recorded this output ("no data", T-193). */
  perHour: number | null;
}

export interface OutputRate extends RateBucket {
  definitionId: string;
  trend: RateBucket[];
}

/**
 * Output rate per definition: total recorded output ÷ active work time of the sessions where it was
 * recorded, per hour. Ended sessions only, not in the trash; deleted outputs excluded; a recorded 0
 * counts, an absent record does not; several records of one definition in a session add up and the
 * session's time counts once; units are never combined. The trend splits the range into weeks.
 * Session-level (owner, 2026-11-05): a session's whole output and whole active time count together
 * on the local date of its start in the configured `zone` (not its stored `localDate`), and in the
 * week bucket holding that date; neither is split at local midnight, unlike the comparisons.
 */
export function outputRates(
  outputs: readonly Item<OutputRecordData>[],
  sessions: readonly Item<SessionData>[],
  range: { from: string; to: string },
  zone: string,
): OutputRate[] {
  const ended = reportSessions(sessions);
  const live = new Map(ended.map((s) => [s.id, s.data]));
  const startDate = new Map(ended.map((s) => [s.id, localDateOf(s.data.startedAt, zone)]));
  const perSession = new Map<string, Map<string, number>>(); // definition → session → total
  for (const o of outputs) {
    const s = live.get(o.data.sessionId);
    if (o.data.deletedAt !== null || !s || !inRange(startDate.get(o.data.sessionId)!, range)) continue;
    const m = perSession.get(o.data.definitionId) ?? new Map<string, number>();
    m.set(o.data.sessionId, (m.get(o.data.sessionId) ?? 0) + o.data.value);
    perSession.set(o.data.definitionId, m);
  }
  const bucket = (definitionSessions: Map<string, number>, from: string, to: string): RateBucket => {
    let total = 0;
    let minutes = 0;
    let samples = 0;
    for (const [sessionId, value] of definitionSessions) {
      const s = live.get(sessionId)!;
      const date = startDate.get(sessionId)!;
      if (date < from || date > to) continue;
      total += value;
      minutes += workMinutes(s);
      samples += 1;
    }
    return { from, to, total, minutes, samples, perHour: samples === 0 || minutes === 0 ? null : (total * 60) / minutes };
  };
  const weeks: [string, string][] = [];
  const days = datesBetween(range.from, range.to);
  for (let i = 0; i < days.length; i += 7) weeks.push([days[i]!, days[Math.min(i + 6, days.length - 1)]!]);
  return [...perSession.entries()]
    .map(([definitionId, m]) => ({ definitionId, ...bucket(m, range.from, range.to), trend: weeks.map(([a, b]) => bucket(m, a, b)) }))
    .sort((a, b) => a.definitionId.localeCompare(b.definitionId));
}

/* ---------- app-use streak (T-074, T-203 to T-205) ---------- */

/**
 * Current and longest runs of consecutive use dates. The current run ends today, or yesterday
 * while today has not been recorded yet; a day without use breaks it and keeps the longest.
 */
export function appUseStreak(dates: Iterable<string>, today: string): { current: number; longest: number; days: number } {
  const set = new Set(dates);
  const sorted = [...set].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  let current = 0;
  let cursor = set.has(today) ? today : addDays(today, -1);
  while (set.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  return { current, longest, days: set.size };
}
