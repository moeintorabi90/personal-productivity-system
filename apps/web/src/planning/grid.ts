/**
 * Time-grid geometry (Stage 3 follow-up; DECISIONS T-066, T-067, T-089, "Derived technical
 * choices"). Pure functions over local dates and wall-clock minutes in the configured zone: a grid
 * column is one local date from 00:00 to 24:00 of wall time. Taps, selections, moves, and resizes
 * snap to 15-minute wall-clock boundaries; a tap pre-fills 30 minutes. A time inside a
 * daylight-saving gap is refused, never shifted (T-030). Nothing here writes data.
 */
import type { BlockTimeInput } from "../local/planning.ts";
import type { CalendarBlockData } from "../backup/registry.ts";
import { blockSegmentOn } from "./planning.ts";
import { addDays, localDateOf, localDayBounds, MINUTE_MS, resolveWallTime, wallTimeOf } from "./time.ts";

export const SLOT_MINUTES = 15;
export const TAP_MINUTES = 30;
export const DAY_MINUTES = 24 * 60;

export const floorToSlot = (minutes: number) => Math.floor(minutes / SLOT_MINUTES) * SLOT_MINUTES;
export const ceilToSlot = (minutes: number) => Math.ceil(minutes / SLOT_MINUTES) * SLOT_MINUTES;
export const roundToSlot = (minutes: number) => Math.round(minutes / SLOT_MINUTES) * SLOT_MINUTES;

/** A wall-clock position: minutes may lie outside 0–1440 and carry into neighbouring dates. */
export function wallAt(date: string, minutes: number): { date: string; time: string } {
  const days = Math.floor(minutes / DAY_MINUTES);
  const m = minutes - days * DAY_MINUTES;
  return { date: addDays(date, days), time: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}` };
}

/** Wall-clock minutes since local midnight of an instant in `zone`. */
export function wallMinutesOf(instant: string | number, zone: string): number {
  const [h, m] = wallTimeOf(instant, zone).split(":").map(Number) as [number, number];
  return h * 60 + m;
}

/** The instant of a wall-clock position, or null inside a daylight-saving gap. */
export function instantAt(date: string, minutes: number, zone: string): number | null {
  const wall = wallAt(date, minutes);
  const resolved = resolveWallTime(wall.date, wall.time, zone);
  return resolved.kind === "ok" ? Date.parse(resolved.instant) : null;
}

export type GridResult = { kind: "ok"; input: BlockTimeInput } | { kind: "gap" } | { kind: "invalid" };

/** A block input from two wall positions (start inclusive, end exclusive), with the REAL duration across DST changes. */
function spanInput(startDate: string, startMinutes: number, endDate: string, endMinutes: number, zone: string): GridResult {
  const start = instantAt(startDate, startMinutes, zone);
  const end = instantAt(endDate, endMinutes, zone);
  if (start === null || end === null) return { kind: "gap" };
  const durationMinutes = (end - start) / MINUTE_MS;
  if (!(durationMinutes >= 1) || durationMinutes > DAY_MINUTES) return { kind: "invalid" };
  const wall = wallAt(startDate, startMinutes);
  return { kind: "ok", input: { date: wall.date, startTime: wall.time, durationMinutes } };
}

/** A tap or click on an empty slot: starts at the 15-minute boundary at or before the pointer; 30 minutes (T-089). */
export function tapSelection(date: string, pointerMinutes: number, zone: string): GridResult {
  const start = floorToSlot(Math.min(Math.max(pointerMinutes, 0), DAY_MINUTES - 1));
  return spanInput(date, start, date, start + TAP_MINUTES, zone);
}

/** A drag across empty time: from the boundary at or before the earlier point to the one at or after the later point. */
export function rangeSelection(date: string, aMinutes: number, bMinutes: number, zone: string): GridResult {
  const lo = Math.max(Math.min(aMinutes, bMinutes), 0);
  const hi = Math.min(Math.max(aMinutes, bMinutes), DAY_MINUTES);
  const start = floorToSlot(Math.min(lo, DAY_MINUTES - 1));
  const end = Math.max(ceilToSlot(hi), start + SLOT_MINUTES);
  return spanInput(date, start, date, end, zone);
}

/** Start date and wall minutes of a block's start in `zone`. */
export function blockStartWall(block: Pick<CalendarBlockData, "startsAt">, zone: string): { date: string; minutes: number } {
  return { date: localDateOf(block.startsAt, zone), minutes: wallMinutesOf(block.startsAt, zone) };
}

/**
 * Moving a block by drag: its start moves by the pointer's offset (minutes and whole days, e.g. to
 * another week column) and snaps to the nearest 15-minute boundary; the real duration is kept.
 */
export function moveTarget(block: Pick<CalendarBlockData, "startsAt" | "endsAt">, deltaDays: number, deltaMinutes: number, zone: string): GridResult {
  const start = blockStartWall(block, zone);
  const duration = (Date.parse(block.endsAt) - Date.parse(block.startsAt)) / MINUTE_MS;
  const minutes = roundToSlot(start.minutes + deltaMinutes);
  const wall = wallAt(addDays(start.date, deltaDays), minutes);
  if (resolveWallTime(wall.date, wall.time, zone).kind === "gap") return { kind: "gap" };
  return { kind: "ok", input: { date: wall.date, startTime: wall.time, durationMinutes: duration } };
}

/**
 * Resizing a block by dragging its start or end edge to a wall position (snapped to the nearest
 * 15-minute boundary); the other edge stays at its instant. Zero or negative length and more than
 * 24 hours are refused.
 */
export function resizeTarget(
  block: Pick<CalendarBlockData, "startsAt" | "endsAt">,
  edge: "start" | "end",
  date: string,
  pointerMinutes: number,
  zone: string,
): GridResult {
  const minutes = roundToSlot(pointerMinutes);
  if (edge === "end") {
    const start = blockStartWall(block, zone);
    const end = instantAt(date, minutes, zone);
    if (end === null) return { kind: "gap" };
    const duration = (end - Date.parse(block.startsAt)) / MINUTE_MS;
    if (!(duration >= 1) || duration > DAY_MINUTES) return { kind: "invalid" };
    const wall = wallAt(start.date, start.minutes);
    return { kind: "ok", input: { date: wall.date, startTime: wall.time, durationMinutes: duration } };
  }
  const start = instantAt(date, minutes, zone);
  if (start === null) return { kind: "gap" };
  const duration = (Date.parse(block.endsAt) - start) / MINUTE_MS;
  if (!(duration >= 1) || duration > DAY_MINUTES) return { kind: "invalid" };
  const wall = wallAt(date, minutes);
  return { kind: "ok", input: { date: wall.date, startTime: wall.time, durationMinutes: duration } };
}

/** Where a block's part on `date` is drawn: wall minutes from the top and to the bottom of the column. */
export function segmentPlacement(block: Pick<CalendarBlockData, "startsAt" | "endsAt">, date: string, zone: string) {
  const seg = blockSegmentOn(block as CalendarBlockData, date, zone);
  if (!seg) return null;
  const [dayStart, dayEnd] = localDayBounds(date, zone);
  const top = seg[0] === dayStart ? 0 : wallMinutesOf(seg[0], zone);
  let bottom = seg[1] === dayEnd ? DAY_MINUTES : wallMinutesOf(seg[1], zone);
  // A segment inside a repeated hour (DST fall-back) can end "before" it starts on the wall clock.
  if (bottom <= top) bottom = Math.min(DAY_MINUTES, top + (seg[1] - seg[0]) / MINUTE_MS);
  return { top, bottom, startsHere: seg[0] === Date.parse(block.startsAt), endsHere: seg[1] === Date.parse(block.endsAt) };
}

/** Side-by-side lanes for blocks drawn on one date: overlapping blocks share a group and split its width. */
export function laneLayout<T extends { id: string }>(items: readonly (T & { top: number; bottom: number })[]): Map<string, { lane: number; lanes: number }> {
  const sorted = [...items].sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.id.localeCompare(b.id));
  const out = new Map<string, { lane: number; lanes: number }>();
  let group: { id: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;
  const flush = () => {
    for (const g of group) out.set(g.id, { lane: g.lane, lanes: laneEnds.length });
    group = [];
    laneEnds = [];
  };
  for (const item of sorted) {
    if (item.top >= groupEnd) {
      flush();
      groupEnd = -Infinity;
    }
    let lane = laneEnds.findIndex((end) => end <= item.top);
    if (lane === -1) lane = laneEnds.push(item.bottom) - 1;
    else laneEnds[lane] = item.bottom;
    group.push({ id: item.id, lane });
    groupEnd = Math.max(groupEnd, item.bottom);
  }
  flush();
  return out;
}
