/**
 * Stage 5 session time (docs/DATA_MODEL.md "Stage 5 record types"; DECISIONS T-092, T-110, T-136,
 * T-149, T-158, T-162, T-164). Pure functions over stored instants: work time = (end − start) −
 * paused time, so durations are reproducible from the record. Nothing here writes.
 */

export const MINUTE = 60_000;
/** Maximum work time of one session (T-136, T-158): paused time does not count. */
export const SESSION_MAX_WORK_MINUTES = 24 * 60;
/** A pause longer than this triggers a reminder when the app opens (T-162, T-164). */
export const LONG_PAUSE_MINUTES = 24 * 60;

export interface Pause {
  start: string;
  end: string | null;
}

export interface SessionTimes {
  startedAt: string;
  endedAt: string | null;
  pauses: Pause[];
}

/** Floors an instant to its minute, as sessions store whole-minute instants (DATA_MODEL). */
export function minuteOf(ms: number): string {
  return new Date(Math.floor(ms / MINUTE) * MINUTE).toISOString();
}

/** Paused milliseconds up to `until` (an open pause runs until `until`). */
export function pausedMs(times: SessionTimes, until: number): number {
  let ms = 0;
  for (const p of times.pauses) {
    const start = Date.parse(p.start);
    const end = p.end === null ? until : Math.min(Date.parse(p.end), until);
    if (end > start) ms += end - start;
  }
  return ms;
}

/** Work milliseconds: for an ended session, end − start − paused; for an open one, up to `now`. */
export function workMs(times: SessionTimes, now: number = Date.now()): number {
  const end = times.endedAt === null ? now : Date.parse(times.endedAt);
  return Math.max(0, end - Date.parse(times.startedAt) - pausedMs(times, end));
}

export function workMinutes(times: SessionTimes, now?: number): number {
  return Math.floor(workMs(times, now) / MINUTE);
}

/**
 * Shape problems of stored session times (used by the record schema): end not before start;
 * pauses in order, inside the session, not overlapping; only the last pause of an open session
 * may still be open; at most 24 hours of work time once ended (T-136, T-158).
 */
export function sessionTimesProblem(times: SessionTimes): string | null {
  const start = Date.parse(times.startedAt);
  const end = times.endedAt === null ? null : Date.parse(times.endedAt);
  if (end !== null && end < start) return "endedAt must not be before startedAt";
  let previousEnd = start;
  for (const [i, p] of times.pauses.entries()) {
    const ps = Date.parse(p.start);
    if (ps < previousEnd) return "pauses must be in order, inside the session, and not overlap";
    if (p.end === null) {
      if (i !== times.pauses.length - 1 || end !== null) return "only the last pause of an open session may be open";
      previousEnd = ps;
      continue;
    }
    const pe = Date.parse(p.end);
    if (pe < ps) return "a pause must not end before it starts";
    if (end !== null && pe > end) return "pauses must lie inside the session";
    previousEnd = pe;
  }
  if (end !== null && workMs(times, end) > SESSION_MAX_WORK_MINUTES * MINUTE) return "a session has at most 24 hours of work time";
  return null;
}

/**
 * State of a session on THIS device. `importedPausedAt` is the backup's creation time when an
 * import brought the session while it was running elsewhere: it is treated as paused from then
 * (T-144, T-152) until its first resume or end here writes that pause.
 */
export type SessionState =
  | { kind: "ended" }
  | { kind: "running"; since: number }
  | { kind: "paused"; since: number; imported: boolean };

export function sessionState(times: SessionTimes, importedPausedAt?: string): SessionState {
  if (times.endedAt !== null) return { kind: "ended" };
  const last = times.pauses.at(-1);
  if (last && last.end === null) return { kind: "paused", since: Date.parse(last.start), imported: false };
  if (importedPausedAt) return { kind: "paused", since: Date.parse(importedPausedAt), imported: true };
  return { kind: "running", since: Date.parse(last?.end ?? times.startedAt) };
}

/**
 * The pauses to store when a session that was imported as running is resumed or ended here: a
 * pause from the backup's creation time (never before the session's last activity) until `at`.
 */
export function withImportedPause(times: SessionTimes, importedPausedAt: string, at: string): Pause[] {
  const last = times.pauses.at(-1);
  const floor = Math.max(Date.parse(last?.end ?? times.startedAt), Date.parse(minuteOf(Date.parse(importedPausedAt))));
  const start = new Date(Math.min(floor, Date.parse(at))).toISOString();
  return [...times.pauses, { start, end: at }];
}

/** [start, end) intervals of actual work (paused time removed), for overlap warnings. */
export function workIntervals(times: SessionTimes, now: number = Date.now()): [number, number][] {
  const end = times.endedAt === null ? now : Date.parse(times.endedAt);
  const out: [number, number][] = [];
  let cursor = Date.parse(times.startedAt);
  for (const p of times.pauses) {
    const ps = Date.parse(p.start);
    if (ps > cursor) out.push([cursor, Math.min(ps, end)]);
    cursor = p.end === null ? end : Date.parse(p.end);
  }
  if (end > cursor) out.push([cursor, end]);
  return out.filter(([a, b]) => b > a);
}

/** Whether two sessions' work intervals overlap (manual entry warns but still saves, T-097). */
export function sessionsOverlap(a: SessionTimes, b: SessionTimes, now: number = Date.now()): boolean {
  const ai = workIntervals(a, now);
  const bi = workIntervals(b, now);
  return ai.some(([s1, e1]) => bi.some(([s2, e2]) => s1 < e2 && s2 < e1));
}
