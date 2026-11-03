/**
 * The built-in timer's device-local state (DECISIONS T-230 to T-240; "Timer and floating view").
 * The standalone stopwatch, the countdown, its sound setting, and the selected timer are rows of the
 * existing `meta` table: not records, never exported (export reads only named `meta` keys), and
 * untouched by imports. Each state is timestamps, so nothing ticks in storage and time keeps passing
 * while the app is closed. Nothing here creates, ends, or completes a session or a task.
 */
import type { LocalDb } from "./db.ts";
import { getMeta, setMeta } from "./db.ts";

export const STOPWATCH_KEY = "stopwatch";
export const COUNTDOWN_KEY = "countdown";
export const TIMER_SOUND_KEY = "timerSound";
export const SELECTED_TIMER_KEY = "selectedTimer";

export interface StopwatchState {
  status: "idle" | "running" | "paused";
  accumulatedMs: number;
  /** ISO instant the current run started; null unless running. */
  runningSince: string | null;
}

export interface CountdownState {
  status: "idle" | "running" | "paused" | "expired";
  durationMs: number;
  /** ISO instant it reaches zero while running. */
  endsAt: string | null;
  /** Time left while paused. */
  remainingMs: number | null;
}

export type TimerKind = "session" | "stopwatch" | "countdown";
export const TIMER_KINDS: readonly TimerKind[] = ["session", "stopwatch", "countdown"];

export const IDLE_STOPWATCH: StopwatchState = { status: "idle", accumulatedMs: 0, runningSince: null };
export const IDLE_COUNTDOWN: CountdownState = { status: "idle", durationMs: 25 * 60_000, endsAt: null, remainingMs: null };

/* ---------- pure state changes ---------- */

export function stopwatchElapsed(s: StopwatchState, now: number): number {
  return s.accumulatedMs + (s.status === "running" && s.runningSince ? Math.max(0, now - Date.parse(s.runningSince)) : 0);
}

export function startStopwatch(s: StopwatchState, now: number): StopwatchState {
  return s.status === "running" ? s : { status: "running", accumulatedMs: s.accumulatedMs, runningSince: new Date(now).toISOString() };
}

export function pauseStopwatch(s: StopwatchState, now: number): StopwatchState {
  return s.status !== "running" ? s : { status: "paused", accumulatedMs: stopwatchElapsed(s, now), runningSince: null };
}

export const resetStopwatch = (): StopwatchState => ({ ...IDLE_STOPWATCH });

/** Time left (ms): computed from `endsAt` and the clock while running. */
export function countdownRemaining(c: CountdownState, now: number): number {
  switch (c.status) {
    case "running":
      return Math.max(0, Date.parse(c.endsAt!) - now);
    case "paused":
      return c.remainingMs ?? 0;
    case "expired":
      return 0;
    default:
      return c.durationMs;
  }
}

/** Whether a running countdown has reached zero (it is then shown as expired, T-233, T-234). */
export const countdownReachedZero = (c: CountdownState, now: number) => c.status === "expired" || (c.status === "running" && countdownRemaining(c, now) === 0);

export function startCountdown(durationMs: number, now: number): CountdownState {
  return { status: "running", durationMs, endsAt: new Date(now + durationMs).toISOString(), remainingMs: null };
}

export function pauseCountdown(c: CountdownState, now: number): CountdownState {
  if (c.status !== "running") return c;
  const remainingMs = countdownRemaining(c, now);
  return remainingMs === 0 ? expireCountdown(c) : { ...c, status: "paused", endsAt: null, remainingMs };
}

export function resumeCountdown(c: CountdownState, now: number): CountdownState {
  return c.status !== "paused" ? c : { ...c, status: "running", endsAt: new Date(now + (c.remainingMs ?? 0)).toISOString(), remainingMs: null };
}

/** The longest countdown (unchanged by T-239): 24 hours, so `24:00:00` is allowed and anything more is refused. */
export const MAX_COUNTDOWN_MS = 24 * 3_600_000;

export interface DurationFields {
  hours: string;
  minutes: string;
  seconds: string;
}

export type DurationError = "wholeNumbers" | "minSecRange" | "zero" | "max";

/** The hour, minute, and second fields that show a stored duration (whole seconds). */
export function durationFields(ms: number): DurationFields {
  const total = Math.max(0, Math.floor(ms / 1000));
  return { hours: String(Math.floor(total / 3600)), minutes: String(Math.floor((total % 3600) / 60)), seconds: String(total % 60) };
}

/**
 * The countdown length from its three fields (T-239), in milliseconds. Each field is a non-negative
 * whole number, in Latin, Persian, or Arabic-Indic digits; an empty field counts as 0. Minutes and
 * seconds are 0 to 59, at least one field is above zero, and the total is at most 24 hours.
 */
export function parseDuration(fields: DurationFields): { ok: true; ms: number } | { ok: false; error: DurationError } {
  const values: number[] = [];
  for (const raw of [fields.hours, fields.minutes, fields.seconds]) {
    const text = raw.trim().replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
    if (text !== "" && !/^\d+$/.test(text)) return { ok: false, error: "wholeNumbers" };
    values.push(text === "" ? 0 : Number(text));
  }
  const [h, m, s] = values as [number, number, number];
  if (m > 59 || s > 59) return { ok: false, error: "minSecRange" };
  const ms = ((h * 60 + m) * 60 + s) * 1000;
  if (ms === 0) return { ok: false, error: "zero" };
  if (ms > MAX_COUNTDOWN_MS) return { ok: false, error: "max" };
  return { ok: true, ms };
}

export const expireCountdown = (c: CountdownState): CountdownState => ({ ...c, status: "expired", endsAt: null, remainingMs: 0 });
export const resetCountdown = (c: CountdownState): CountdownState => ({ status: "idle", durationMs: c.durationMs, endsAt: null, remainingMs: null });

/* ---------- device-local storage ---------- */

export interface TimerSettings {
  stopwatch: StopwatchState;
  countdown: CountdownState;
  sound: boolean;
  /** The work-session timer until the user selects another (T-236). */
  selected: TimerKind;
}

export async function loadTimer(db: LocalDb): Promise<TimerSettings> {
  return db.transaction("r", db.meta, async () => {
    const selected = await getMeta<TimerKind>(db, SELECTED_TIMER_KEY);
    return {
      stopwatch: (await getMeta<StopwatchState>(db, STOPWATCH_KEY)) ?? IDLE_STOPWATCH,
      countdown: (await getMeta<CountdownState>(db, COUNTDOWN_KEY)) ?? IDLE_COUNTDOWN,
      sound: (await getMeta<boolean>(db, TIMER_SOUND_KEY)) ?? true,
      selected: selected && TIMER_KINDS.includes(selected) ? selected : "session",
    };
  });
}

export const saveStopwatch = (db: LocalDb, s: StopwatchState) => setMeta(db, STOPWATCH_KEY, s);
export const saveCountdown = (db: LocalDb, c: CountdownState) => setMeta(db, COUNTDOWN_KEY, c);
export const saveTimerSound = (db: LocalDb, on: boolean) => setMeta(db, TIMER_SOUND_KEY, on);
/** Written only when the user selects a timer; restoring it changes no timer (T-236). */
export const saveSelectedTimer = (db: LocalDb, kind: TimerKind) => setMeta(db, SELECTED_TIMER_KEY, kind);
