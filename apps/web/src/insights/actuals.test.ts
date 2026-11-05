/**
 * Goal amounts and attributed days per local day (DECISIONS D-020, T-185, "Local-day aggregation",
 * "Output rate inputs"): days come from the configured zone, never from a session's stored zone.
 * Fabricated data only.
 */
import { describe, expect, it } from "vitest";
import type { GoalData, OutputRecordData, SessionData } from "../backup/registry.ts";
import { goalProgress } from "../work/progress.ts";
import { amountBetween, goalDays } from "./actuals.ts";
import { consistencyStreak } from "./pace.ts";

const GOAL = "11111111-1111-4111-8111-111111111111";
const DEF = "44444444-4444-4444-8444-444444444444";
const DEVICE = "66666666-6666-4666-8666-666666666666";

const goal = (kind: "time" | "output"): GoalData =>
  ({
    name: "Reading",
    description: "",
    projectId: null,
    startDate: "2026-11-02",
    deadline: "2026-11-29",
    kind,
    target: 600,
    status: "active",
    archivedAt: null,
    workdays: [1, 2, 3, 4, 5],
    ...(kind === "output" ? { definitionId: DEF } : {}),
  }) as GoalData;

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
function session(start: string, seconds: number, timeZone: string, localDate: string) {
  const startedAt = new Date(start).toISOString();
  return {
    id: id(),
    data: {
      taskId: null,
      blockId: null,
      startedAt,
      endedAt: new Date(Date.parse(start) + seconds * 1000).toISOString(),
      pauses: [],
      timeZone,
      localDate,
      goalId: GOAL,
      expectedOutputs: [],
      snapshot: null,
      startedOnDevice: DEVICE,
      notes: "",
      energy: null,
      focus: null,
      deletedAt: null,
    } as unknown as SessionData,
  };
}
const output = (sessionId: string, value: number) => ({
  id: id(),
  data: { sessionId, definitionId: DEF, revision: 0, value, goalIds: [GOAL], deletedAt: null } as OutputRecordData,
});
const days = (map: ReadonlyMap<string, number>) => Object.fromEntries([...map].sort());

// Started 21:00 UTC on Monday 11-02: 00:30 on Tuesday 11-03 in Tehran (UTC+3:30), where it was recorded.
const tehran = () => session("2026-11-02T21:00:00Z", 3600, "Asia/Tehran", "2026-11-03");

describe("goal days follow the configured time zone, not the session's stored one (D-020; Codex review, 2026-11-05)", () => {
  it("time goal: the attributed days are the days of its amounts in the configured zone", () => {
    const s = tehran();
    const records = { sessions: [s], outputs: [], completions: [] };
    const utc = goalDays(GOAL, goal("time"), records, "UTC");
    expect(days(utc.amounts)).toEqual({ "2026-11-02": 60 });
    expect([...utc.attributed]).toEqual(["2026-11-02"]); // not the stored Tuesday
    const local = goalDays(GOAL, goal("time"), records, "Asia/Tehran");
    expect(days(local.amounts)).toEqual({ "2026-11-03": 60 });
    expect([...local.attributed]).toEqual(["2026-11-03"]);
  });

  it("time goal: a session shorter than a minute still attributes its start date, in the configured zone", () => {
    const s = session("2026-11-02T21:00:00Z", 20, "Asia/Tehran", "2026-11-03");
    const result = goalDays(GOAL, goal("time"), { sessions: [s], outputs: [], completions: [] }, "UTC");
    expect(result.amounts.size).toBe(0);
    expect([...result.attributed]).toEqual(["2026-11-02"]);
  });

  it("output goal: the value counts on the session's start date in the configured zone", () => {
    const s = tehran();
    const records = { sessions: [s], outputs: [output(s.id, 5)], completions: [] };
    for (const [zone, date] of [["UTC", "2026-11-02"], ["Asia/Tehran", "2026-11-03"]] as const) {
      const result = goalDays(GOAL, goal("output"), records, zone);
      expect(days(result.amounts)).toEqual({ [date]: 5 });
      expect([...result.attributed]).toEqual([date]);
    }
  });

  it("without a zone difference nothing changes: a time session crossing midnight counts on both days, an output on its start date", () => {
    const s = session("2026-11-08T23:00:00Z", 7200, "UTC", "2026-11-08"); // Sunday 23:00 to Monday 01:00
    const records = { sessions: [s], outputs: [output(s.id, 12)], completions: [] };
    const time = goalDays(GOAL, goal("time"), records, "UTC");
    expect(days(time.amounts)).toEqual({ "2026-11-08": 60, "2026-11-09": 60 });
    expect([...time.attributed].sort()).toEqual(["2026-11-08", "2026-11-09"]);
    const out = goalDays(GOAL, goal("output"), records, "UTC");
    expect(days(out.amounts)).toEqual({ "2026-11-08": 12 });
    expect([...out.attributed]).toEqual(["2026-11-08"]);
  });
});

describe("a time goal's daily amounts add up to its progress (derived \"Local-day aggregation\"; independent review of Stage 6, 2026-11-05)", () => {
  /** A session from `start` (UTC) to `start + seconds`, with pauses given as [offset, length] in seconds. */
  function timed(start: string, seconds: number, pauses: [number, number][] = []) {
    const s = session(start, seconds, "UTC", start.slice(0, 10));
    const at = (offset: number) => new Date(Date.parse(start) + offset * 1000).toISOString();
    s.data = { ...s.data, pauses: pauses.map(([offset, length]) => ({ start: at(offset), end: at(offset + length) })) };
    return s;
  }
  const check = (sessions: ReturnType<typeof timed>[], zone: string) => {
    const records = { sessions, outputs: [], completions: [] };
    const result = goalDays(GOAL, goal("time"), records, zone);
    expect(amountBetween(result.amounts)).toBe(goalProgress(GOAL, goal("time"), records));
    return result;
  };

  it("a 40-second session adds 0 minutes to the day as to the progress, and still attributes its start date", () => {
    const s = timed("2026-11-02T10:00:00Z", 40);
    const result = check([s], "UTC");
    expect(days(result.amounts)).toEqual({});
    expect([...result.attributed]).toEqual(["2026-11-02"]);
    // The consistency streak counts that Monday (T-185: any attributed work, whatever its amount).
    expect(consistencyStreak(goal("time"), result.attributed, "2026-11-02")).toMatchObject({ current: 1, longest: 1 });
  });

  it("several short sessions: each adds its own whole minutes, so three of 40 seconds and one of 90 seconds give 1, not 5", () => {
    const sessions = [timed("2026-11-02T08:00:00Z", 40), timed("2026-11-02T09:00:00Z", 40), timed("2026-11-02T10:00:00Z", 40), timed("2026-11-02T11:00:00Z", 90)];
    const result = check(sessions, "UTC");
    expect(days(result.amounts)).toEqual({ "2026-11-02": 1 });
  });

  it("a session crossing local midnight in the configured zone shares its whole minutes by largest remainder, the earlier day first on a tie", () => {
    // 23:59:30 in Tehran (UTC+3:30) for 70 s: 30 s on Monday, 40 s on Tuesday; 1 minute in all, to Tuesday.
    expect(days(check([timed("2026-11-02T20:29:30Z", 70)], "Asia/Tehran").amounts)).toEqual({ "2026-11-03": 1 });
    // 30 s on each side: a tie, so the minute goes to the earlier day.
    expect(days(check([timed("2026-11-02T20:29:30Z", 60)], "Asia/Tehran").amounts)).toEqual({ "2026-11-02": 1 });
    // 22:30:20 to 00:45:50 UTC: 89 min 40 s and 45 min 50 s, 135 minutes in all (rounding each day would give 136).
    const long = check([timed("2026-11-08T22:30:20Z", 8130)], "UTC");
    expect(days(long.amounts)).toEqual({ "2026-11-08": 89, "2026-11-09": 46 });
    expect([...long.attributed].sort()).toEqual(["2026-11-08", "2026-11-09"]);
  });

  it("a session with pauses sums each day's parts before rounding: two parts of 40 s are 1 minute, not 2", () => {
    // 10:00:00 to 10:05:40 with a pause from 10:00:40 to 10:05:00: 80 s of work.
    expect(days(check([timed("2026-11-02T10:00:00Z", 340, [[40, 260]])], "UTC").amounts)).toEqual({ "2026-11-02": 1 });
    // A pause over midnight: 23:59:20 to 00:00:20 is paused; 40 s before it on Sunday, 50 s after on Monday.
    const over = check([timed("2026-11-08T23:58:40Z", 150, [[40, 60]])], "UTC");
    expect(days(over.amounts)).toEqual({ "2026-11-09": 1 });
    expect([...over.attributed].sort()).toEqual(["2026-11-08", "2026-11-09"]);
  });

  it("all of these together: the days of the goal add up to its progress", () => {
    const sessions = [
      timed("2026-11-02T10:00:00Z", 40),
      timed("2026-11-02T11:00:00Z", 90),
      timed("2026-11-02T20:29:30Z", 70),
      timed("2026-11-08T22:30:20Z", 8130),
      timed("2026-11-08T23:58:40Z", 150, [[40, 60]]),
    ];
    for (const zone of ["UTC", "Asia/Tehran", "America/New_York"]) check(sessions, zone);
  });
});
