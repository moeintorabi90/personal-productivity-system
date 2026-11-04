/**
 * TESTING "Stage 6 acceptance tests" item 18 (DECISIONS "Segment merge", T-223, T-227, T-228,
 * T-237): per-device entries, `seen` coverage, candidates by exact canonical equality, options,
 * decisions and changes of choice, order independence, and the status and order of choice events.
 * Pure functions; the import path is tested in backup/stage6-backup.test.ts.
 */
import { describe, expect, it } from "vitest";
import { canonicalize } from "../backup/jcs.ts";
import type { GoalWeekPlanChoiceData, GoalWeekPlanData, PlanDateData, SegmentData } from "../backup/registry.ts";
import {
  appliedSegment,
  candidatesOf,
  canChangeChoice,
  conflictDates,
  decisionChoices,
  eventStatus,
  hasCoverageCycle,
  isInconsistentDate,
  mergePlans,
  needsDecision,
  orderEvents,
  planDateOn,
  resolveDate,
  withDate,
  writeEntry,
} from "./plan-merge.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GOAL = "22222222-2222-4222-8222-222222222222";
const WEEK = "2026-11-02";
const MON = "2026-11-02";
const seg = (num: number): SegmentData => ({ state: "allocated", allocation: { num, den: 1 }, source: "automatic" });
const x = seg(150);
const y = seg(120);

const record = (...dates: PlanDateData[]): GoalWeekPlanData => ({ goalId: GOAL, weekStart: WEEK, dates });
const one = (device: string, from: string, s: SegmentData) => record(writeEntry(undefined, from, device, s));
const merge = (...plans: GoalWeekPlanData[]) => plans.reduce((a, b) => mergePlans(a, b)!);
const dateOf = (p: GoalWeekPlanData, from = MON) => p.dates.find((d) => d.from === from)!;

/** The owner decides `from` on `device` with the record as it is there. */
function decide(p: GoalWeekPlanData, device: string, chosen: SegmentData, from = MON): GoalWeekPlanData {
  return withDate(p, writeEntry(dateOf(p, from), from, device, chosen));
}

describe("18. malformed entries that cover one another (data integrity, Codex review 2026-11-04)", () => {
  // The reported case: each entry claims to have seen the other, so both are covered.
  const cyclic: PlanDateData = {
    from: MON,
    entries: [
      { device: A, seq: 1, seen: { [B]: 1 }, segment: x },
      { device: B, seq: 1, seen: { [A]: 1 }, segment: y },
    ],
    options: [],
  };

  it("is detected, needs the owner's decision, and does not hide this device's own plan", () => {
    expect(candidatesOf(cyclic)).toEqual([]);
    expect(hasCoverageCycle(cyclic)).toBe(true);
    expect(isInconsistentDate(cyclic)).toBe(true);
    expect(needsDecision(cyclic)).toBe(true);
    expect(conflictDates(record(cyclic))).toEqual([MON]); // counted, not silently "no data"
    const choices = [x, y].sort((a, b) => (canonicalize(a) < canonicalize(b) ? -1 : 1));
    expect(decisionChoices(cyclic)).toEqual(choices);
    expect(resolveDate(cyclic, A)).toEqual({ kind: "inconsistent", segment: x, candidates: choices });
    expect(appliedSegment(resolveDate(cyclic, A))).toEqual(x); // A's own plan still applies, with the warning
    expect(resolveDate(cyclic, C)).toEqual({ kind: "inconsistent", segment: null, candidates: choices });
    expect(canChangeChoice(cyclic)).toBe(false);
  });

  it("a decision settles it on a device in the cycle and on another device", () => {
    for (const [device, chosen] of [[A, y], [B, x], [C, x]] as const) {
      const decided = writeEntry(cyclic, MON, device, chosen);
      expect(candidatesOf(decided)).toEqual([chosen]);
      expect(resolveDate(decided, device)).toEqual({ kind: "settled", segment: chosen });
      expect(needsDecision(decided)).toBe(false);
    }
    // A malformed `seen` that claims a higher counter of the deciding device is passed, so the decision is never covered at once.
    const claimsMore: PlanDateData = { ...cyclic, entries: [cyclic.entries[0]!, { device: B, seq: 1, seen: { [A]: 1, [C]: 5 }, segment: y }] };
    const byC = writeEntry(claimsMore, MON, C, x);
    expect(byC.entries.find((e) => e.device === C)!.seq).toBe(6);
    expect(candidatesOf(byC)).toEqual([x]);
  });

  it("a longer loop is a cycle too; ordinary coverage, conflicts, and decisions are unchanged (T-223, T-227)", () => {
    const loop: PlanDateData = {
      from: MON,
      entries: [
        { device: A, seq: 1, seen: { [C]: 1 }, segment: x },
        { device: B, seq: 1, seen: { [A]: 1 }, segment: y },
        { device: C, seq: 1, seen: { [B]: 1 }, segment: x },
      ],
      options: [],
    };
    expect(hasCoverageCycle(loop)).toBe(true);
    const conflict = dateOf(merge(one(A, MON, x), one(B, MON, y)));
    expect(hasCoverageCycle(conflict)).toBe(false);
    expect(isInconsistentDate(conflict)).toBe(false);
    expect(resolveDate(conflict, A)).toMatchObject({ kind: "conflict", segment: x });
    expect(decisionChoices(conflict)).toEqual(candidatesOf(conflict));
    const decided = writeEntry(conflict, MON, A, y);
    expect(decided.entries.find((e) => e.device === A)).toMatchObject({ seq: 2, seen: { [B]: 1 } }); // as before: own seq + 1
    expect(hasCoverageCycle(decided)).toBe(false);
    expect(resolveDate(decided, B)).toEqual({ kind: "settled", segment: y });
  });
});

describe("18. segment merge (T-227)", () => {
  it("segments with different dates merge: Monday and Tuesday use the phone's, Wednesday on the laptop's, with no conflict", () => {
    const phone = one(A, MON, x);
    const laptop = one(B, "2026-11-04", y);
    const merged = merge(phone, laptop);
    expect(conflictDates(merged)).toEqual([]);
    const on = (day: string) => appliedSegment(planDateOn([merged], day, A)!.resolution);
    expect([on(MON), on("2026-11-03"), on("2026-11-04"), on("2026-11-08")]).toEqual([x, x, y, y]);
    expect(merge(laptop, phone)).toEqual(merged); // order of arrival does not matter
  });

  it("the same date with different content is a conflict: each device keeps its own until the owner decides; a third device shows no data (T-228)", () => {
    const merged = merge(one(A, MON, x), one(B, MON, y));
    expect(conflictDates(merged)).toEqual([MON]);
    expect(resolveDate(dateOf(merged), A)).toMatchObject({ kind: "conflict", segment: x });
    expect(resolveDate(dateOf(merged), B)).toMatchObject({ kind: "conflict", segment: y });
    expect(resolveDate(dateOf(merged), C)).toMatchObject({ kind: "undecided" });
    expect(appliedSegment(resolveDate(dateOf(merged), C))).toBeNull();
    expect(dateOf(merged).options).toEqual(candidatesOf(dateOf(merged))); // both kept for a later change of choice
  });

  it("identical segments for the same date count once", () => {
    const merged = merge(one(A, MON, x), one(B, MON, x));
    expect(candidatesOf(dateOf(merged))).toEqual([x]);
    expect(conflictDates(merged)).toEqual([]);
  });

  it("segments are compared by exact canonical content, never by a hash alone", () => {
    const other: SegmentData = { state: "allocated", allocation: { num: 150, den: 1 }, source: "manual" };
    const merged = merge(one(A, MON, x), one(B, MON, other));
    expect(candidatesOf(dateOf(merged))).toHaveLength(2);
  });

  it("two edits on the phone leave only the later entry; a stale phone backup changes nothing, in any order", () => {
    const first = one(A, MON, x);
    const second = decide(first, A, y);
    expect(dateOf(second).entries).toEqual([{ device: A, seq: 2, segment: y, seen: {} }]);
    expect(merge(second, first)).toEqual(merge(second));
    expect(merge(first, second)).toEqual(second);
  });

  it("the same device and counter with different content is an integrity issue: nothing merges", () => {
    expect(mergePlans(one(A, MON, x), one(A, MON, y))).toBeNull();
  });

  it("re-merging the same file, or the original after a merge, changes nothing; two devices merging the same versions agree byte for byte", () => {
    const a = one(A, MON, x);
    const b = one(B, MON, y);
    const ab = merge(a, b);
    expect(merge(ab, a)).toEqual(ab);
    expect(merge(ab, b)).toEqual(ab);
    expect(canonicalize(merge(b, a))).toBe(canonicalize(ab));
  });

  it("two conflicting dates beside unconflicted ones: deciding one leaves the other undecided and every other date unchanged", () => {
    const a = record(writeEntry(undefined, MON, A, x), writeEntry(undefined, "2026-11-03", A, x), writeEntry(undefined, "2026-11-05", A, x));
    const b = record(writeEntry(undefined, MON, B, y), writeEntry(undefined, "2026-11-03", B, y));
    const merged = merge(a, b);
    expect(conflictDates(merged)).toEqual([MON, "2026-11-03"]);
    const decided = decide(merged, A, y);
    expect(conflictDates(decided)).toEqual(["2026-11-03"]);
    expect(dateOf(decided, "2026-11-05")).toEqual(dateOf(merged, "2026-11-05"));
  });
});

describe("18. decisions, options, and change of choice (T-223, T-237)", () => {
  // Monday, segments x and y, devices A, B, C.
  const conflicted = () => merge(one(A, MON, x), one(B, MON, y));

  it("choosing x on A replaces A's entry and covers B's: Monday is x on A, B, and C after import; options hold x and y", () => {
    const onA = decide(conflicted(), A, x);
    expect(dateOf(onA).entries.find((e) => e.device === A)).toEqual({ device: A, seq: 2, segment: x, seen: { [B]: 1 } });
    for (const device of [A, B, C]) expect(resolveDate(dateOf(merge(conflicted(), onA)), device)).toEqual({ kind: "settled", segment: x });
    expect(dateOf(onA).options).toEqual([y, x].sort((p, q) => (canonicalize(p) < canonicalize(q) ? -1 : 1)));
    expect(canChangeChoice(dateOf(onA))).toBe(true);
  });

  it("changing to y and back to x works with the next counters, no cycle and no conflict; x stays in options", () => {
    const toX = decide(conflicted(), A, x);
    const toY = decide(toX, A, y);
    expect(resolveDate(dateOf(toY), B)).toEqual({ kind: "settled", segment: y });
    expect(dateOf(toY).entries.find((e) => e.device === A)!.seq).toBe(3);
    expect(dateOf(toY).options).toEqual(dateOf(toX).options);
    const back = decide(toY, A, x);
    expect(resolveDate(dateOf(back), C)).toEqual({ kind: "settled", segment: x });
  });

  it("a date that never had a conflict offers no change of choice", () => {
    expect(canChangeChoice(dateOf(one(A, MON, x)))).toBe(false);
  });

  it("an older backup of A carrying the x choice, imported on B before or after the newer one, leaves y with the same options", () => {
    const older = decide(conflicted(), A, x);
    const newer = decide(older, A, y);
    const onB = conflicted();
    const first = merge(onB, older, newer);
    const second = merge(onB, newer, older);
    expect(first).toEqual(second);
    expect(resolveDate(dateOf(first), B)).toEqual({ kind: "settled", segment: y });
  });

  it("A choosing y and B choosing x without seeing each other is a conflict, settled by no timestamp; a later decision after seeing it settles all three", () => {
    const base = conflicted();
    const aChoice = decide(base, A, y);
    const bChoice = decide(base, B, x);
    const both = merge(aChoice, bChoice);
    expect(conflictDates(both)).toEqual([MON]);
    const settled = decide(both, B, y);
    for (const device of [A, B, C]) expect(resolveDate(dateOf(merge(aChoice, settled)), device)).toEqual({ kind: "settled", segment: y });
    expect(canChangeChoice(dateOf(settled))).toBe(true);
  });
});

describe("18. choice history (T-237)", () => {
  const event = (device: string, seq: number, chosen: SegmentData, seen: Record<string, number>, recordedAt: string, previous: SegmentData | null = null): GoalWeekPlanChoiceData => ({
    goalId: GOAL,
    weekStart: WEEK,
    from: MON,
    device,
    deviceName: device === A ? "Phone" : "Laptop",
    seq,
    previous,
    chosen,
    seen,
    recordedAt,
  });

  it("status: not applied here, current, replaced later, and an integrity issue when the counters are equal but the content differs", () => {
    const decided = decide(merge(one(A, MON, x), one(B, MON, y)), A, x);
    const ev = event(A, 2, x, { [B]: 1 }, "2026-11-02T10:00:00.000Z", x);
    expect(eventStatus(ev, [])).toBe("notApplied"); // plan merge skipped or not here yet
    expect(eventStatus(ev, [merge(one(A, MON, x), one(B, MON, y))])).toBe("notApplied"); // only an older entry
    expect(eventStatus(ev, [decided])).toBe("current");
    expect(eventStatus(ev, [decide(decided, A, y)])).toBe("replaced");
    expect(eventStatus(ev, [decide(decided, B, y)])).toBe("replaced"); // covered by B's later write
    expect(eventStatus({ ...ev, chosen: y }, [decided])).toBe("integrity");
    expect(eventStatus({ ...ev, seen: {} }, [decided])).toBe("integrity");
  });

  it("orders events by counter and seen, whatever the clocks say; independent events are marked uncertain", () => {
    const a1 = { data: event(A, 2, x, { [B]: 1 }, "2026-11-02T12:00:00.000Z") };
    const a2 = { data: event(A, 3, y, { [B]: 1 }, "2026-11-02T09:00:00.000Z") }; // A's clock went back
    const b1 = { data: event(B, 2, x, { [A]: 1 }, "2026-11-02T08:00:00.000Z") }; // B never saw A's choices
    const ordered = orderEvents([a2, b1, a1]);
    const indexOf = (e: unknown) => ordered.findIndex((o) => o.event === e);
    expect(indexOf(a1)).toBeLessThan(indexOf(a2));
    expect(ordered.every((o) => o.uncertain)).toBe(true);
    const b2 = { data: event(B, 3, y, { [A]: 3 }, "2026-11-01T00:00:00.000Z") }; // B saw both, clock far behind
    const withB2 = orderEvents([b2, a2, a1, b1]);
    expect(withB2.at(-1)!.event).toBe(b2);
    expect(withB2.find((o) => o.event === b2)!.uncertain).toBe(false);
  });
});
