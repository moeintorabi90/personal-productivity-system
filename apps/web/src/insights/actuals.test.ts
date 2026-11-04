/**
 * Goal amounts and attributed days per local day (DECISIONS D-020, T-185, "Local-day aggregation",
 * "Output rate inputs"): days come from the configured zone, never from a session's stored zone.
 * Fabricated data only.
 */
import { describe, expect, it } from "vitest";
import type { GoalData, OutputRecordData, SessionData } from "../backup/registry.ts";
import { goalDays } from "./actuals.ts";

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
