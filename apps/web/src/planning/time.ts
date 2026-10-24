/**
 * Stage 3 date/time functions (docs/ARCHITECTURE.md "Stage 3 design outline"). Pure and
 * unit-tested. Local dates are ISO Gregorian `YYYY-MM-DD` strings; instants are UTC. Every
 * calculation takes the configured IANA zone explicitly (D-020): nothing here reads the machine's
 * zone, and language or display calendar never change a result.
 */

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A real Gregorian calendar date written as `YYYY-MM-DD`. */
export function isLocalDate(value: string): boolean {
  const m = LOCAL_DATE.exec(value);
  if (!m) return false;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value && Number(m[1]) >= 1;
}

/** `HH:MM` on a 24-hour clock. */
export function isWallTime(value: string): boolean {
  return WALL_TIME.test(value);
}

function dateParts(date: string): [number, number, number] {
  const m = LOCAL_DATE.exec(date);
  if (!m) throw new RangeError(`not a local date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Milliseconds of `date` 00:00 read as if it were UTC (calendar arithmetic only). */
function utcMidnight(date: string): number {
  const [y, mo, d] = dateParts(date);
  return Date.UTC(y, mo - 1, d);
}

function fromUtcMidnight(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromUtcMidnight(utcMidnight(date) + days * DAY_MS);
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((utcMidnight(b) - utcMidnight(a)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. Depends only on the Gregorian date, never on a zone. */
export function weekdayOf(date: string): number {
  return new Date(utcMidnight(date)).getUTCDay();
}

/* ---------------- instants and zones ---------------- */

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      era: "short",
    });
    formatters.set(zone, f);
  }
  return f;
}

interface Wall {
  date: string;
  hour: number;
  minute: number;
  second: number;
}

/** The wall clock reading of an instant in `zone`. */
function wallOf(ms: number, zone: string): Wall {
  const parts: Record<string, string> = {};
  for (const p of wallFormatter(zone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const year = parts.era === "BC" || parts.era === "B" ? 1 - Number(parts.year) : Number(parts.year);
  const date = `${String(year).padStart(4, "0")}-${parts.month}-${parts.day}`;
  return { date, hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

/** The local date of an instant in `zone`. */
export function localDateOf(instant: string | number | Date, zone: string): string {
  return wallOf(new Date(instant).getTime(), zone).date;
}

/** `HH:MM` of an instant in `zone`. */
export function wallTimeOf(instant: string | number | Date, zone: string): string {
  const w = wallOf(new Date(instant).getTime(), zone);
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

/** UTC offset of `zone` at an instant, in minutes (e.g. +210 for Asia/Tehran). */
export function offsetMinutesAt(instant: string | number | Date, zone: string): number {
  const ms = new Date(instant).getTime();
  const w = wallOf(ms, zone);
  const asUtc = utcMidnight(w.date) + ((w.hour * 60 + w.minute) * 60 + w.second) * 1000;
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE_MS);
}

/** "UTC+03:30", "UTC−05:00", "UTC" (offset 0). */
export function formatOffset(minutes: number): string {
  if (minutes === 0) return "UTC";
  const sign = minutes > 0 ? "+" : "−";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export type WallTimeResult =
  | { kind: "ok"; instant: string; offsetMinutes: number; ambiguous: boolean }
  | { kind: "gap" }; // does not exist on that day (clocks went forward)

/**
 * The instant of a local wall time in `zone` (T-030). A wall time inside a daylight-saving gap
 * does not exist and is refused (never shifted); an ambiguous one (clocks going back) resolves to
 * the earlier instant and reports `ambiguous` so its offset can be shown.
 */
export function resolveWallTime(date: string, time: string, zone: string): WallTimeResult {
  if (!isLocalDate(date) || !isWallTime(time)) throw new RangeError(`invalid wall time ${date} ${time}`);
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const naive = utcMidnight(date) + (hh * 60 + mm) * MINUTE_MS;
  const offsets = new Set<number>();
  for (const probe of [naive - DAY_MS, naive - DAY_MS / 2, naive, naive + DAY_MS / 2, naive + DAY_MS]) {
    offsets.add(offsetMinutesAt(probe, zone));
  }
  const candidates = [...offsets]
    .map((offset) => naive - offset * MINUTE_MS)
    .filter((ms) => {
      const w = wallOf(ms, zone);
      return w.date === date && w.hour === hh && w.minute === mm;
    })
    .sort((a, b) => a - b);
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return { kind: "gap" };
  const instant = new Date(unique[0]!).toISOString();
  return { kind: "ok", instant, offsetMinutes: offsetMinutesAt(instant, zone), ambiguous: unique.length > 1 };
}

/** The first instant (ms) whose local date in `zone` is `date` or later. */
export function startOfLocalDay(date: string, zone: string): number {
  // Every real zone is within ±15 h of UTC; search that window to the minute (handles a day
  // that does not start at 00:00 because of a daylight-saving change at midnight).
  let lo = utcMidnight(date) - 15 * 60 * MINUTE_MS;
  let hi = utcMidnight(date) + 15 * 60 * MINUTE_MS;
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS;
    if (wallOf(mid, zone).date < date) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** [start, end) of a local date in `zone`, in ms. Usually 24 hours; 23 or 25 on DST days. */
export function localDayBounds(date: string, zone: string): [number, number] {
  return [startOfLocalDay(date, zone), startOfLocalDay(addDays(date, 1), zone)];
}

/* ---------------- ranges ---------------- */

/** The seven dates of the week containing `date`, starting on `weekStart` (0 = Sunday … 6). */
export function weekDates(date: string, weekStart: number): string[] {
  const back = (weekdayOf(date) - weekStart + 7) % 7;
  const first = addDays(date, -back);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

export function datesBetween(first: string, last: string): string[] {
  const n = daysBetween(first, last);
  return Array.from({ length: Math.max(0, n + 1) }, (_, i) => addDays(first, i));
}

/* ---------------- Jalali (display calendar only) ---------------- */

const jalaliFormatter = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", {
  timeZone: "UTC",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

export interface JalaliDate {
  year: number;
  month: number;
  day: number;
}

/** The Jalali (Solar Hijri) reading of a Gregorian local date. */
export function toJalali(date: string): JalaliDate {
  const parts: Record<string, string> = {};
  for (const p of jalaliFormatter.formatToParts(new Date(utcMidnight(date) + DAY_MS / 2))) parts[p.type] = p.value;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** The Gregorian date of a Jalali date, or null if it does not exist (e.g. 30 Esfand in a common year). */
export function fromJalali(year: number, month: number, day: number): string | null {
  if (![year, month, day].every(Number.isInteger) || month < 1 || month > 12 || day < 1 || day > 31 || year < 1) return null;
  // 1 Farvardin falls on 19–22 March of Gregorian year (year + 621).
  let nowruz = `${String(year + 621).padStart(4, "0")}-03-18`;
  for (let i = 0; i < 6 && !(toJalali(nowruz).month === 1 && toJalali(nowruz).day === 1); i++) nowruz = addDays(nowruz, 1);
  const offset = (month <= 6 ? (month - 1) * 31 : 186 + (month - 7) * 30) + (day - 1);
  const result = addDays(nowruz, offset);
  const check = toJalali(result);
  return check.year === year && check.month === month && check.day === day ? result : null;
}

export type MonthCalendar = "gregorian" | "jalali";

/**
 * The dates of the month containing `date` (T-035): a Gregorian month for the Gregorian and
 * "Both" displays, a Jalali month for the Jalali display.
 */
export function monthDates(date: string, calendar: MonthCalendar): string[] {
  if (calendar === "gregorian") {
    const [y, m] = dateParts(date);
    const first = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
    const next = m === 12 ? `${String(y + 1).padStart(4, "0")}-01-01` : `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-01`;
    return datesBetween(first, addDays(next, -1));
  }
  const j = toJalali(date);
  const first = addDays(date, -(j.day - 1));
  const out: string[] = [];
  for (let d = first; toJalali(d).month === j.month; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The first date of the previous (-1) or next (+1) month in the given calendar. */
export function shiftMonth(date: string, calendar: MonthCalendar, delta: -1 | 1): string {
  const dates = monthDates(date, calendar);
  return delta === 1 ? addDays(dates.at(-1)!, 1) : monthDates(addDays(dates[0]!, -1), calendar)[0]!;
}
