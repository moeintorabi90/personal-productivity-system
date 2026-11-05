/**
 * Actual amounts of a goal per local day (derived "Local-day aggregation": a session's active time
 * is split at local midnight in the configured zone; the record is unchanged). The same records
 * and filters as goal progress (work/progress.ts), so the days add up to the goal's progress.
 */
import type { GoalData } from "../backup/registry.ts";
import { localDateOf, startOfLocalDay } from "../planning/time.ts";
import { completionDate } from "../work/completions.ts";
import type { ProgressRecords } from "../work/progress.ts";
import { MINUTE, type SessionTimes, workIntervals, workMinutes } from "../work/session-time.ts";

/** Exact work milliseconds of `times` per local date in `zone` (paused time excluded, split at local midnight). */
export function workMsByLocalDay(times: SessionTimes, zone: string, now: number = Date.now()): Map<string, number> {
  const out = new Map<string, number>();
  for (const [start, end] of workIntervals(times, now)) {
    let cursor = start;
    while (cursor < end) {
      const date = localDateOf(cursor, zone);
      const next = Math.min(end, startOfLocalDay(nextDate(date), zone));
      out.set(date, (out.get(date) ?? 0) + (next - cursor));
      cursor = next;
    }
  }
  return out;
}

/**
 * Whole work minutes of `times` per local date (derived "Local-day aggregation"): the session's
 * whole minutes (`workMinutes`, as goal progress counts them) are shared among its local days, so
 * the days always add up to that number. Each day's work time is summed over all of its parts
 * (pauses, midnight) before rounding; each day gets its whole minutes, and the minutes left go one
 * each to the days with the largest leftover part of a minute, the earlier day first on a tie
 * (largest remainder; derived, 2026-11-05). Days that end with no minute are left out.
 */
export function minutesByLocalDay(times: SessionTimes, zone: string, now: number = Date.now()): Map<string, number> {
  return shareMinutes(workMsByLocalDay(times, zone, now), workMinutes(times, now));
}

/** Shares `total` whole minutes among days by largest remainder of their milliseconds (ties: earlier day). */
export function shareMinutes(msByDay: ReadonlyMap<string, number>, total: number): Map<string, number> {
  const days = [...msByDay].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out = new Map(days.map(([date, ms]) => [date, Math.floor(ms / MINUTE)]));
  let left = total - [...out.values()].reduce((sum, m) => sum + m, 0);
  // Stable sort: equal remainders keep date order, so the earlier day comes first.
  for (const [date] of [...days].sort(([, a], [, b]) => (b % MINUTE) - (a % MINUTE))) {
    if (left <= 0) break;
    out.set(date, out.get(date)! + 1);
    left -= 1;
  }
  for (const [d, m] of out) if (m === 0) out.delete(d);
  return out;
}

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export interface GoalDays {
  /** Amount in the goal's measure recorded on each local day (whole numbers). */
  amounts: Map<string, number>;
  /** Days with at least one attributed record, whatever its amount (consistency streak, T-185). */
  attributed: Set<string>;
}

/**
 * Per-day amounts and attributed days of one goal: work minutes of ended sessions counted toward a
 * time goal, attributed output values (including recorded zeros) of an output goal's definition on
 * the session's start date, or completions of a task-count goal on their date (T-134, T-156). All
 * dates are local dates in the configured `zone` (D-020), never a session's stored zone or
 * `localDate`; a time session also attributes its start date, so work shorter than a minute counts.
 */
export function goalDays(goalId: string, goal: GoalData, records: ProgressRecords, zone: string): GoalDays {
  const amounts = new Map<string, number>();
  const attributed = new Set<string>();
  const addAmount = (date: string, value: number) => {
    amounts.set(date, (amounts.get(date) ?? 0) + value);
    attributed.add(date);
  };
  const liveSessions = new Map(records.sessions.filter((s) => s.data.deletedAt === null).map((s) => [s.id, s.data]));
  switch (goal.kind) {
    case "time":
      for (const s of liveSessions.values()) {
        if (s.goalId !== goalId || s.endedAt === null) continue;
        for (const [date, minutes] of minutesByLocalDay(s, zone)) addAmount(date, minutes);
        attributed.add(localDateOf(s.startedAt, zone));
      }
      break;
    case "output":
      if (!goal.definitionId) break;
      for (const o of records.outputs) {
        const d = o.data;
        const session = liveSessions.get(d.sessionId);
        if (d.deletedAt === null && session && d.definitionId === goal.definitionId && d.goalIds.includes(goalId)) addAmount(localDateOf(session.startedAt, zone), d.value);
      }
      break;
    case "taskCount":
      for (const c of records.completions) {
        if (c.data.reopenedAt === null && c.data.goalId === goalId) addAmount(completionDate(c.data, zone), 1);
      }
      break;
  }
  return { amounts, attributed };
}

/** Sum of the amounts on days in [from, to] (inclusive; either end open when undefined). */
export function amountBetween(amounts: ReadonlyMap<string, number>, from?: string, to?: string): number {
  let total = 0;
  for (const [date, value] of amounts) if ((from === undefined || date >= from) && (to === undefined || date <= to)) total += value;
  return total;
}

/** The local date of an instant, for callers that only have `now`. */
export const todayIn = (zone: string, now: number = Date.now()) => localDateOf(now, zone);
