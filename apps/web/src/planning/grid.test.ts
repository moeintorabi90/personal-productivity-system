/**
 * Time-grid geometry (docs/TESTING.md "Stage 3 follow-up: time grid and drag" 1–3, 4a; DECISIONS
 * T-066, T-067, T-089). Fixed dates and zones.
 */
import { describe, expect, it } from "vitest";
import { isAmbiguousInstant, laneLayout, moveTarget, rangeSelection, resizeTarget, segmentPlacement, tapSelection, wallAt } from "./grid.ts";

const TEHRAN = "Asia/Tehran"; // UTC+3:30, no DST
const NY = "America/New_York"; // DST starts 2026-03-08 02:00 → 03:00, ends 2026-11-01 02:00 → 01:00

const at = (iso: string) => new Date(iso).toISOString();

describe("4a. taps and selections snap to 15 minutes; a tap pre-fills 30 minutes", () => {
  it("a tap at 09:07 pre-fills 09:00–09:30", () => {
    expect(tapSelection("2026-11-02", 9 * 60 + 7, TEHRAN)).toEqual({ kind: "ok", input: { date: "2026-11-02", startTime: "09:00", durationMinutes: 30 } });
  });

  it("a tap near midnight keeps 30 minutes, ending on the next date", () => {
    expect(tapSelection("2026-11-02", 23 * 60 + 50, TEHRAN)).toEqual({ kind: "ok", input: { date: "2026-11-02", startTime: "23:45", durationMinutes: 30 } });
  });

  it("a drag selection covers the dragged range on 15-minute boundaries, in either direction", () => {
    const expected = { kind: "ok", input: { date: "2026-11-02", startTime: "09:00", durationMinutes: 75 } };
    expect(rangeSelection("2026-11-02", 9 * 60 + 5, 10 * 60 + 10, TEHRAN)).toEqual(expected);
    expect(rangeSelection("2026-11-02", 10 * 60 + 10, 9 * 60 + 5, TEHRAN)).toEqual(expected);
    // A tiny drag still gives at least one slot.
    expect(rangeSelection("2026-11-02", 9 * 60 + 1, 9 * 60 + 2, TEHRAN)).toEqual({ kind: "ok", input: { date: "2026-11-02", startTime: "09:00", durationMinutes: 15 } });
  });

  it("on a daylight-saving date, durations are real minutes and a time in the gap is refused (T-030)", () => {
    // 01:30 EST → 03:30 EDT is one real hour.
    expect(rangeSelection("2026-03-08", 90, 210, NY)).toEqual({ kind: "ok", input: { date: "2026-03-08", startTime: "01:30", durationMinutes: 60 } });
    expect(tapSelection("2026-03-08", 2 * 60 + 20, NY)).toEqual({ kind: "gap" });
    expect(rangeSelection("2026-03-08", 60, 2 * 60 + 20, NY)).toEqual({ kind: "gap" });
  });
});

describe("2–3. moving and resizing", () => {
  const block = { startsAt: at("2026-11-02T05:30:00Z"), endsAt: at("2026-11-02T06:30:00Z") }; // 09:00–10:00 Tehran

  const ok = (startsAt: string, endsAt: string, offsetMinutes = 210, ambiguous = false) => ({ kind: "ok", startsAt: at(startsAt), endsAt: at(endsAt), ambiguous, offsetMinutes });

  it("a move snaps the start to the nearest 15 minutes and keeps the duration; whole days move to another column", () => {
    expect(moveTarget(block, 0, 22, TEHRAN)).toEqual(ok("2026-11-02T05:45:00Z", "2026-11-02T06:45:00Z")); // 09:15
    expect(moveTarget(block, 0, 23, TEHRAN)).toEqual(ok("2026-11-02T06:00:00Z", "2026-11-02T07:00:00Z")); // 09:30
    expect(moveTarget(block, 2, -60, TEHRAN)).toEqual(ok("2026-11-04T04:30:00Z", "2026-11-04T05:30:00Z")); // 08:00 two days later
    // Past midnight the start carries into the next date (00:30 on 3 Nov).
    expect(moveTarget(block, 0, 15 * 60 + 30, TEHRAN)).toEqual(ok("2026-11-02T21:00:00Z", "2026-11-02T22:00:00Z"));
    // Staying within the same snapped slot is no move at all.
    expect(moveTarget(block, 0, 7, TEHRAN)).toEqual({ kind: "unchanged" });
  });

  it("a move into a daylight-saving gap is refused, not shifted", () => {
    const ny = { startsAt: at("2026-03-08T05:00:00Z"), endsAt: at("2026-03-08T06:00:00Z") }; // 00:00–01:00 EST
    expect(moveTarget(ny, 0, 135, NY)).toEqual({ kind: "gap" }); // 02:15 does not exist
  });

  it("resizing either edge snaps to 15 minutes; zero length and more than 24 hours are refused", () => {
    expect(resizeTarget(block, "end", "2026-11-02", 10 * 60 + 40, TEHRAN)).toEqual(ok("2026-11-02T05:30:00Z", "2026-11-02T07:15:00Z")); // to 10:45
    expect(resizeTarget(block, "start", "2026-11-02", 8 * 60 + 52, TEHRAN)).toEqual(ok("2026-11-02T05:15:00Z", "2026-11-02T06:30:00Z")); // from 08:45
    expect(resizeTarget(block, "end", "2026-11-02", 10 * 60 + 5, TEHRAN)).toEqual({ kind: "unchanged" });
    expect(resizeTarget(block, "end", "2026-11-02", 9 * 60, TEHRAN)).toEqual({ kind: "invalid" });
    expect(resizeTarget(block, "start", "2026-11-02", 10 * 60 + 15, TEHRAN)).toEqual({ kind: "invalid" });
    expect(resizeTarget(block, "end", "2026-11-03", 9 * 60 + 15, TEHRAN)).toEqual({ kind: "invalid" });
    expect(resizeTarget(block, "end", "2026-11-03", 24 * 60, TEHRAN).kind).toBe("invalid");
  });
});

describe("daylight saving: New York falls back on 2026-11-01 (01:00–01:59 occurs twice) (T-030)", () => {
  // 01:30 EDT (first occurrence, UTC−4) = 05:30Z; 01:30 EST (second occurrence, UTC−5) = 06:30Z.
  const second = { startsAt: at("2026-11-01T06:30:00Z"), endsAt: at("2026-11-01T07:00:00Z") }; // 01:30–02:00 EST
  const first = { startsAt: at("2026-11-01T05:30:00Z"), endsAt: at("2026-11-01T06:00:00Z") }; // 01:30 EDT to 01:00 EST (30 real minutes)

  it("a block in the second 01:xx occurrence does not shift an hour from a drag that stays in the same snapped slot", () => {
    for (const delta of [-7, 0, 5, 7]) expect(moveTarget(second, 0, delta, NY), String(delta)).toEqual({ kind: "unchanged" });
    expect(resizeTarget(second, "start", "2026-11-01", 90 + 4, NY)).toEqual({ kind: "unchanged" });
    expect(resizeTarget(second, "end", "2026-11-01", 2 * 60 + 6, NY)).toEqual({ kind: "unchanged" });
  });

  it("resizing the end of a second-occurrence block keeps its start instant (the undragged edge never re-resolves)", () => {
    expect(resizeTarget(second, "end", "2026-11-01", 3 * 60, NY)).toEqual({
      kind: "ok",
      startsAt: second.startsAt, // still 01:30 EST
      endsAt: at("2026-11-01T08:00:00Z"), // 03:00 EST
      ambiguous: false,
      offsetMinutes: -300,
    });
  });

  it("moving or resizing TO an ambiguous wall time takes the earlier instant and reports its offset, as entered times do", () => {
    // From 00:30 (EDT) by +60 min → wall 01:30 → the earlier 01:30 (EDT, UTC−04:00).
    const early = { startsAt: at("2026-11-01T04:30:00Z"), endsAt: at("2026-11-01T05:00:00Z") };
    expect(moveTarget(early, 0, 60, NY)).toEqual({ kind: "ok", startsAt: at("2026-11-01T05:30:00Z"), endsAt: at("2026-11-01T06:00:00Z"), ambiguous: true, offsetMinutes: -240 });
    // A second-occurrence block moved by one slot to 01:45 lands on the EARLIER 01:45 (the rule for any ambiguous time).
    expect(moveTarget(second, 0, 15, NY)).toEqual({ kind: "ok", startsAt: at("2026-11-01T05:45:00Z"), endsAt: at("2026-11-01T06:15:00Z"), ambiguous: true, offsetMinutes: -240 });
    // Resizing an end to 01:15 resolves to 01:15 EDT.
    expect(resizeTarget(early, "end", "2026-11-01", 75, NY)).toEqual({ kind: "ok", startsAt: early.startsAt, endsAt: at("2026-11-01T05:15:00Z"), ambiguous: true, offsetMinutes: -240 });
  });

  it("instants in the repeated hour are flagged so the grid shows their offset; others are not", () => {
    expect(isAmbiguousInstant(first.startsAt, NY)).toBe(true);
    expect(isAmbiguousInstant(second.startsAt, NY)).toBe(true);
    expect(isAmbiguousInstant(at("2026-11-01T08:00:00Z"), NY)).toBe(false); // 03:00 EST
    expect(isAmbiguousInstant(at("2026-11-02T06:30:00Z"), NY)).toBe(false);
  });

  it("the spring-forward gap is still refused for moves, resizes, taps, and selections", () => {
    const ny = { startsAt: at("2026-03-08T05:00:00Z"), endsAt: at("2026-03-08T06:00:00Z") }; // 00:00–01:00 EST
    expect(moveTarget(ny, 0, 135, NY)).toEqual({ kind: "gap" });
    expect(resizeTarget(ny, "end", "2026-03-08", 2 * 60 + 30, NY)).toEqual({ kind: "gap" });
    expect(tapSelection("2026-03-08", 2 * 60 + 20, NY)).toEqual({ kind: "gap" });
    expect(rangeSelection("2026-03-08", 60, 2 * 60 + 20, NY)).toEqual({ kind: "gap" });
  });
});

describe("drawing", () => {
  it("a block is placed by wall minutes; a block crossing midnight is clipped on both dates", () => {
    const night = { startsAt: at("2026-11-02T19:30:00Z"), endsAt: at("2026-11-02T22:30:00Z") }; // 23:00–02:00 Tehran
    expect(segmentPlacement(night, "2026-11-02", TEHRAN)).toEqual({ top: 23 * 60, bottom: 24 * 60, startsHere: true, endsHere: false });
    expect(segmentPlacement(night, "2026-11-03", TEHRAN)).toEqual({ top: 0, bottom: 120, startsHere: false, endsHere: true });
    expect(segmentPlacement(night, "2026-11-04", TEHRAN)).toBeNull();
  });

  it("overlapping blocks get side-by-side lanes; separate ones keep the full width", () => {
    const lanes = laneLayout([
      { id: "a", top: 540, bottom: 600 },
      { id: "b", top: 570, bottom: 630 },
      { id: "c", top: 600, bottom: 660 },
      { id: "d", top: 700, bottom: 720 },
    ]);
    expect(lanes.get("a")).toEqual({ lane: 0, lanes: 2 });
    expect(lanes.get("b")).toEqual({ lane: 1, lanes: 2 });
    expect(lanes.get("c")).toEqual({ lane: 0, lanes: 2 });
    expect(lanes.get("d")).toEqual({ lane: 0, lanes: 1 });
  });

  it("wall positions carry across dates", () => {
    expect(wallAt("2026-11-02", 24 * 60)).toEqual({ date: "2026-11-03", time: "00:00" });
    expect(wallAt("2026-11-02", -30)).toEqual({ date: "2026-11-01", time: "23:30" });
  });
});
