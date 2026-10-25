/**
 * Time-grid geometry (docs/TESTING.md "Stage 3 follow-up: time grid and drag" 1–3, 4a; DECISIONS
 * T-066, T-067, T-089). Fixed dates and zones.
 */
import { describe, expect, it } from "vitest";
import { laneLayout, moveTarget, rangeSelection, resizeTarget, segmentPlacement, tapSelection, wallAt } from "./grid.ts";

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

  it("a move snaps the start to the nearest 15 minutes and keeps the duration; whole days move to another column", () => {
    expect(moveTarget(block, 0, 22, TEHRAN)).toEqual({ kind: "ok", input: { date: "2026-11-02", startTime: "09:15", durationMinutes: 60 } });
    expect(moveTarget(block, 0, 23, TEHRAN)).toEqual({ kind: "ok", input: { date: "2026-11-02", startTime: "09:30", durationMinutes: 60 } });
    expect(moveTarget(block, 2, -60, TEHRAN)).toEqual({ kind: "ok", input: { date: "2026-11-04", startTime: "08:00", durationMinutes: 60 } });
    // Past midnight the start carries into the next date.
    expect(moveTarget(block, 0, 15 * 60 + 30, TEHRAN)).toEqual({ kind: "ok", input: { date: "2026-11-03", startTime: "00:30", durationMinutes: 60 } });
  });

  it("a move into a daylight-saving gap is refused, not shifted", () => {
    const ny = { startsAt: at("2026-03-08T05:00:00Z"), endsAt: at("2026-03-08T06:00:00Z") }; // 00:00–01:00 EST
    expect(moveTarget(ny, 0, 135, NY)).toEqual({ kind: "gap" }); // 02:15 does not exist
  });

  it("resizing either edge snaps to 15 minutes; zero length and more than 24 hours are refused", () => {
    expect(resizeTarget(block, "end", "2026-11-02", 10 * 60 + 40, TEHRAN)).toEqual({ kind: "ok", input: { date: "2026-11-02", startTime: "09:00", durationMinutes: 105 } });
    expect(resizeTarget(block, "start", "2026-11-02", 8 * 60 + 52, TEHRAN)).toEqual({ kind: "ok", input: { date: "2026-11-02", startTime: "08:45", durationMinutes: 75 } });
    expect(resizeTarget(block, "end", "2026-11-02", 9 * 60, TEHRAN)).toEqual({ kind: "invalid" });
    expect(resizeTarget(block, "start", "2026-11-02", 10 * 60 + 15, TEHRAN)).toEqual({ kind: "invalid" });
    expect(resizeTarget(block, "end", "2026-11-03", 9 * 60 + 15, TEHRAN)).toEqual({ kind: "invalid" });
    expect(resizeTarget(block, "end", "2026-11-03", 24 * 60, TEHRAN).kind).toBe("invalid");
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
