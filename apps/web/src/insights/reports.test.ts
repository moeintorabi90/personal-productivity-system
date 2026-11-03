/**
 * TESTING "Stage 6 acceptance tests" items 2, 8 to 12 (T-178, T-188 to T-205): planned versus
 * actual, honest totals with "No task" and "No project", estimate accuracy, output rate, the
 * app-use streak, and card windows. Seeded records with fixed dates in UTC.
 */
import { describe, expect, it } from "vitest";
import type { CalendarBlockData, OutputRecordData, SessionData, TaskCompletionData, TaskDefinitionData, TaskEstimateCaptureData } from "../backup/registry.ts";
import { estimateCaptureId } from "../backup/derived-id.ts";
import { METRIC_CATALOG, presetRange, SUGGESTED_MAIN_DASHBOARD } from "./metrics.ts";
import { appUseStreak, estimateRows, estimateSummary, outputRates, plannedVersusActual, workTotals } from "./reports.ts";

const TASK = "11111111-1111-4111-8111-111111111111";
const REC = "33333333-3333-4333-8333-333333333333";
const DEF = "44444444-4444-4444-8444-444444444444";
const DEF2 = "55555555-5555-4555-8555-555555555555";
const DEVICE = "66666666-6666-4666-8666-666666666666";
const snapshot = { taskTitle: "Write", projectId: null, projectName: null, workstreamId: null, workstreamName: null };
const tasks = new Map<string, TaskDefinitionData>([
  [TASK, { title: "Write", notes: "", projectId: null, workstreamId: null, nextAction: "", estimateMinutes: 60, archivedAt: null }],
  [REC, { title: "Run", notes: "", projectId: null, workstreamId: null, nextAction: "", estimateMinutes: 30, archivedAt: null, recurrence: { kind: "weekdays", weekdays: [1, 3], startDate: "2026-11-02", endDate: null } }],
]);

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
function block(start: string, minutes: number, patch: Partial<CalendarBlockData> = {}) {
  const startsAt = new Date(start).toISOString();
  const endsAt = new Date(Date.parse(start) + minutes * 60_000).toISOString();
  return { id: id(), data: { taskId: TASK, startsAt, endsAt, timeZone: "UTC", localDate: startsAt.slice(0, 10), occurrenceDate: null, status: "planned", snapshot, ...patch } as CalendarBlockData };
}
function session(start: string, minutes: number, patch: Partial<SessionData> = {}, pauses: SessionData["pauses"] = []) {
  const startedAt = new Date(start).toISOString();
  const pausedMs = pauses.reduce((s, p) => s + Date.parse(p.end!) - Date.parse(p.start), 0);
  const endedAt = new Date(Date.parse(start) + minutes * 60_000 + pausedMs).toISOString();
  return {
    id: id(),
    data: {
      taskId: TASK,
      blockId: null,
      startedAt,
      endedAt,
      pauses,
      timeZone: "UTC",
      localDate: startedAt.slice(0, 10),
      goalId: null,
      expectedOutputs: [],
      snapshot,
      startedOnDevice: DEVICE,
      notes: "",
      energy: null,
      focus: null,
      deletedAt: null,
      ...patch,
    } as SessionData,
  };
}
const output = (sessionId: string, value: number, definitionId = DEF, patch: Partial<OutputRecordData> = {}) => ({ id: id(), data: { sessionId, definitionId, revision: 0, value, goalIds: [], deletedAt: null, ...patch } });

describe("2. planned versus actual by task and local day (T-178)", () => {
  it("two blocks and three sessions of one task on one day aggregate; an unlinked session counts; nothing reads a block link", () => {
    const blocks = [block("2026-11-02T09:00:00Z", 60), block("2026-11-02T14:00:00Z", 30), block("2026-11-02T16:00:00Z", 30, { status: "cancelled" })];
    const sessions = [session("2026-11-02T09:10:00Z", 50, { blockId: blocks[0]!.id }), session("2026-11-02T13:00:00Z", 20), session("2026-11-02T20:00:00Z", 25)];
    const rows = plannedVersusActual(blocks, sessions, { from: "2026-11-02", to: "2026-11-02" }, "UTC", tasks);
    expect(rows).toEqual([{ date: "2026-11-02", taskId: TASK, title: "Write", plannedMinutes: 90, actualMinutes: 95, blocks: 2, sessions: 3 }]);
  });

  it("a block edited after its start is compared with its kept plan, and sessions across midnight are split by local day", () => {
    const moved = block("2026-11-02T18:00:00Z", 60, { comparisonPlan: { startsAt: "2026-11-02T09:00:00.000Z", endsAt: "2026-11-02T09:30:00.000Z", status: "planned" } });
    const late = session("2026-11-02T23:30:00Z", 60);
    const rows = plannedVersusActual([moved], [late], { from: "2026-11-02", to: "2026-11-03" }, "UTC", tasks);
    expect(rows.map((r) => [r.date, r.plannedMinutes, r.actualMinutes])).toEqual([
      ["2026-11-02", 30, 30],
      ["2026-11-03", 0, 30],
    ]);
  });
});

describe("9. honest reports (T-192, T-193)", () => {
  it("sessions without a task or project stay in their category and totals match; paused time is excluded", () => {
    const sessions = [
      session("2026-11-02T08:00:00Z", 40),
      session("2026-11-02T10:00:00Z", 15, { taskId: null, snapshot: null }),
      session("2026-11-02T12:00:00Z", 30, {}, [{ start: "2026-11-02T12:10:00.000Z", end: "2026-11-02T12:30:00.000Z" }]),
      session("2026-11-02T14:00:00Z", 30, { deletedAt: "2026-11-02T15:00:00.000Z" }),
    ];
    const totals = workTotals(sessions, { from: "2026-11-02", to: "2026-11-02" }, "UTC", tasks, new Map());
    expect(totals).toMatchObject({ minutes: 85, sessions: 3, noTaskMinutes: 15, noTaskSessions: 1 });
    expect(totals.byProject).toEqual([{ projectId: null, name: null, minutes: 85, sessions: 3 }]);
    expect(totals.byProject.reduce((s, p) => s + p.minutes, 0)).toBe(totals.minutes);
    expect(workTotals(sessions, { from: "2026-11-05", to: "2026-11-05" }, "UTC", tasks, new Map())).toMatchObject({ minutes: 0, sessions: 0 }); // no data: zero samples
  });
});

describe("8. estimate accuracy (T-188 to T-191)", () => {
  const captures = new Map<string, TaskEstimateCaptureData>([
    [estimateCaptureId(TASK, null), { taskId: TASK, occurrenceDate: null, estimateMinutes: 60, capturedAt: "2026-11-01T00:00:00.000Z", source: "plan" }],
    [estimateCaptureId(REC, "2026-11-02"), { taskId: REC, occurrenceDate: "2026-11-02", estimateMinutes: 30, capturedAt: "2026-11-01T00:00:00.000Z", source: "plan" }],
  ]);
  const completion = (taskId: string, occurrenceDate: string | null) => ({ id: id(), data: { taskId, occurrenceDate, completedAt: "2026-11-02T20:00:00.000Z", goalId: null, reopenedAt: null } as TaskCompletionData });

  it("accuracy appears only after explicit completion, in minutes and percent; elapsed time before; recurring occurrences are separate; unassigned sessions are counted apart", () => {
    const sessions = [
      session("2026-11-02T08:00:00Z", 75),
      session("2026-11-02T06:00:00Z", 24, { taskId: REC, occurrenceDate: "2026-11-02" }),
      session("2026-11-04T06:00:00Z", 40, { taskId: REC, occurrenceDate: "2026-11-04" }),
      session("2026-11-05T06:00:00Z", 10, { taskId: REC }),
    ];
    const open = estimateRows(tasks, captures, [], sessions, "UTC");
    expect(open.rows.find((r) => r.taskId === TASK)).toMatchObject({ actualMinutes: 75, completed: false, differenceMinutes: null });
    const done = estimateRows(tasks, captures, [completion(TASK, null), completion(REC, "2026-11-02")], sessions, "UTC");
    expect(done.rows.find((r) => r.taskId === TASK)).toMatchObject({ estimateMinutes: 60, actualMinutes: 75, differenceMinutes: 15, differenceRatio: 0.25 });
    expect(done.rows.find((r) => r.occurrenceDate === "2026-11-02")).toMatchObject({ differenceMinutes: -6, differenceRatio: -0.2 });
    expect(done.rows.find((r) => r.occurrenceDate === "2026-11-04")).toMatchObject({ estimateMinutes: null, completed: false }); // no capture: no data
    expect(done.unassignedSessions).toBe(1);
    expect(estimateSummary(done.rows, { from: "2026-11-01", to: "2026-11-30" })).toMatchObject({ samples: 2 });
    expect(estimateSummary(done.rows, { from: "2026-12-01", to: "2026-12-31" })).toEqual({ samples: 0, meanDifference: null, meanRatio: null });
  });
});

describe("10. output rate (T-195, T-196)", () => {
  it("excludes paused time; a recorded zero lowers the rate, an absent record does not; two definitions give two rates; deleted outputs and sessions do not count", () => {
    const s1 = session("2026-11-02T08:00:00Z", 60, {}, [{ start: "2026-11-02T08:30:00.000Z", end: "2026-11-02T09:30:00.000Z" }]);
    const s2 = session("2026-11-03T08:00:00Z", 60);
    const s3 = session("2026-11-04T08:00:00Z", 60); // no output record for DEF: not part of its rate
    const s4 = session("2026-11-05T08:00:00Z", 60, { deletedAt: "2026-11-05T10:00:00.000Z" });
    const outputs = [output(s1.id, 10), output(s1.id, 2), output(s1.id, 5, DEF2), output(s2.id, 0), output(s2.id, 99, DEF, { deletedAt: "2026-11-03T10:00:00.000Z" }), output(s4.id, 50)];
    const rates = outputRates(outputs, [s1, s2, s3, s4], { from: "2026-11-02", to: "2026-11-08" });
    const def = rates.find((r) => r.definitionId === DEF)!;
    expect(def).toMatchObject({ total: 12, minutes: 120, samples: 2, perHour: 6 });
    expect(rates.find((r) => r.definitionId === DEF2)).toMatchObject({ total: 5, minutes: 60, perHour: 5 });
    expect(def.trend).toHaveLength(1);
    const withoutZero = outputRates(outputs.filter((o) => o.data.value !== 0), [s1, s2, s3], { from: "2026-11-02", to: "2026-11-08" });
    expect(withoutZero.find((r) => r.definitionId === DEF)!.perHour).toBe(12);
    expect(outputRates([], [s1], { from: "2026-11-02", to: "2026-11-08" })).toEqual([]); // no data, not zero
  });
});

describe("12. app-use streak (T-074, T-203 to T-205)", () => {
  it("consecutive days give current and longest; a gap breaks the current one and keeps the longest", () => {
    const dates = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-11-01", "2026-11-02"];
    expect(appUseStreak(dates, "2026-11-02")).toEqual({ current: 2, longest: 4, days: 6 });
    expect(appUseStreak(dates, "2026-11-03")).toEqual({ current: 2, longest: 4, days: 6 }); // today not recorded yet
    expect(appUseStreak(dates, "2026-11-04")).toMatchObject({ current: 0, longest: 4 });
  });
});

describe("11. metric catalog and windows (T-197, T-200)", () => {
  it("cards use catalog IDs only; the suggested main layout starts with the app-use streak; presets resolve in the display calendar", () => {
    const ids = new Set(METRIC_CATALOG.map((m) => m.id));
    expect(SUGGESTED_MAIN_DASHBOARD.cards.every((c) => ids.has(c.metric))).toBe(true);
    expect(SUGGESTED_MAIN_DASHBOARD.cards[0]!.metric).toBe("appUseStreak");
    expect(presetRange("last7", "2026-11-03", 1, "gregorian")).toEqual({ from: "2026-10-28", to: "2026-11-03" });
    expect(presetRange("thisWeek", "2026-11-03", 6, "gregorian")).toEqual({ from: "2026-10-31", to: "2026-11-06" });
    expect(presetRange("thisMonth", "2026-11-03", 1, "jalali")).toEqual({ from: "2026-10-23", to: "2026-11-21" }); // Aban 1405
    expect(presetRange("all", "2026-11-03", 1, "gregorian")).toEqual({ from: null, to: "2026-11-03" });
  });
});
