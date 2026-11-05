/**
 * TESTING "Stage 6 acceptance tests" item 18 (DECISIONS "Segment merge", T-223, T-227, T-228,
 * T-237): per-device entries, `seen` coverage, candidates by exact canonical equality, options,
 * decisions and changes of choice, order independence, and the status and order of choice events.
 * Pure functions; the import path is tested in backup/stage6-backup.test.ts.
 */
import { describe, expect, it } from "vitest";
import { canonicalize } from "../backup/jcs.ts";
import { goalWeekPlanSchema, type GoalWeekPlanChoiceData, type GoalWeekPlanData, type PlanDateData, type PlanEntryData, type SegmentData } from "../backup/registry.ts";
import {
  appliedSegment,
  candidatesOf,
  canChangeChoice,
  conflictDates,
  decideEntry,
  decisionChoices,
  eventStatus,
  happenedAfter,
  hasCoverageCycle,
  isInconsistentDate,
  mergePlans,
  needsDecision,
  eventSeenVerified,
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
  return withDate(p, decideEntry(dateOf(p, from), from, device, chosen));
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
    expect(dateOf(merged).options).toEqual([]); // a merge adds no option; both are offered in the conflict list
    expect(decisionChoices(dateOf(merged))).toEqual(candidatesOf(dateOf(merged)));
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

describe("18. options do not depend on the order of merges (Codex review 2026-11-04)", () => {
  // A writes x and B writes y without seeing each other; C saw A's entry (not B's) and wrote z.
  const z = seg(90);
  const a = one(A, MON, x);
  const b = one(B, MON, y);
  const c = record(writeEntry(dateOf(a), MON, C, z));
  const sorted = (...list: SegmentData[]) => [...list].sort((p, q) => (canonicalize(p) < canonicalize(q) ? -1 : 1));

  it("A, B, and C merged in every order, grouping, and with repeated imports give the same record and the same choices", () => {
    const orders = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
    const results = orders.map((o) => canonicalize(merge(...o)));
    expect(new Set(results).size).toBe(1); // (A+B)+C and (A+C)+B included
    const final = merge(a, b, c);
    expect(canonicalize(mergePlans(a, mergePlans(b, c)!)!)).toBe(results[0]);
    expect(canonicalize(merge(final, a, c, b, merge(c, a)))).toBe(results[0]); // importing any file again changes nothing
    const date = dateOf(final);
    expect(date.entries.map((e) => e.device)).toEqual([A, B, C]);
    expect(candidatesOf(date)).toEqual(sorted(y, z)); // C covered A: x is not a candidate on any path
    expect(decisionChoices(date)).toEqual(sorted(y, z));
    expect(date.options).toEqual([]); // nothing added by merges alone
    expect(canChangeChoice(date)).toBe(false);
  });

  it("deciding after either order records the same options, so the later change of choice offers the same segments", () => {
    const viaAB = merge(merge(a, b), c);
    const viaAC = merge(merge(a, c), b);
    for (const device of [A, B, C]) {
      const first = decide(viaAB, device, z);
      const second = decide(viaAC, device, z);
      expect(canonicalize(first)).toBe(canonicalize(second));
      expect(dateOf(first).options).toEqual(sorted(y, z)); // the segments the owner chose between
      expect(canChangeChoice(dateOf(first))).toBe(true);
      expect(resolveDate(dateOf(first), device)).toEqual({ kind: "settled", segment: z });
    }
    // Two devices deciding differently without seeing each other: the union of their options, in either order.
    const onA = decide(viaAB, A, y);
    const onB = decide(viaAC, B, z);
    expect(canonicalize(merge(onA, onB))).toBe(canonicalize(merge(onB, onA)));
    expect(dateOf(merge(onA, onB)).options).toEqual(sorted(y, z));
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
  /** The plan entry an event wrote, and a plan for Monday holding the given entries. */
  const entryOf = (e: GoalWeekPlanChoiceData): PlanEntryData => ({ device: e.device, seq: e.seq, segment: e.chosen, seen: e.seen });
  const planOf = (...entries: PlanEntryData[]): GoalWeekPlanData => record({ from: MON, entries: [...entries].sort((p, q) => (p.device < q.device ? -1 : 1)), options: [] });
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
    // The plan here backs every event: each device's latest entry matches its latest event.
    const ordered = orderEvents([a2, b1, a1], [planOf(entryOf(a2.data), entryOf(b1.data))]);
    const indexOf = (e: unknown) => ordered.findIndex((o) => o.event === e);
    expect(indexOf(a1)).toBeLessThan(indexOf(a2));
    expect(ordered.every((o) => o.uncertain)).toBe(true);
    const b2 = { data: event(B, 3, y, { [A]: 3 }, "2026-11-01T00:00:00.000Z") }; // B saw both, clock far behind
    const withB2 = orderEvents([b2, a2, a1, b1], [planOf(entryOf(a2.data), entryOf(b2.data))]);
    expect(withB2.at(-1)!.event).toBe(b2);
    expect(withB2.find((o) => o.event === b2)!.uncertain).toBe(false);
    expect(withB2.some((o) => o.cyclic)).toBe(false); // ordinary history has no cycle
  });

  it("two events that each claim to have seen the other are a cycle: both marked cyclic and uncertain, never ordered as certain by their clocks (independent review)", () => {
    const a1 = { data: event(A, 2, x, { [B]: 2 }, "2026-11-02T08:00:00.000Z") }; // claims B's choice
    const b1 = { data: event(B, 2, y, { [A]: 2 }, "2026-11-02T09:00:00.000Z") }; // claims A's choice
    expect(happenedAfter(a1.data, b1.data) && happenedAfter(b1.data, a1.data)).toBe(true);
    // Whether or not a plan backs their claims (here a plan stored before the checks, with the same cycle).
    const legacy = planOf(entryOf(a1.data), entryOf(b1.data));
    for (const plans of [[], [legacy]]) {
      for (const list of [[a1, b1], [b1, a1]]) {
        const ordered = orderEvents(list, plans);
        expect(ordered).toHaveLength(2);
        expect(ordered.every((o) => o.cyclic && o.uncertain)).toBe(true);
      }
    }
    // Events outside the cycle keep their causal place and certainty: one both saw, one that saw both.
    // (The plan below, stored before the checks, backs every claim.)
    const before = { data: event(A, 1, y, {}, "2026-11-02T10:00:00.000Z") }; // clock after the cycle's
    const later = { data: event(C, 1, x, { [A]: 2, [B]: 2 }, "2026-11-01T00:00:00.000Z") }; // clock before it
    const ordered = orderEvents([later, b1, a1, before], [planOf(entryOf(a1.data), entryOf(b1.data), entryOf(later.data))]);
    expect(ordered.map((o) => o.event)).toEqual([before, a1, b1, later]); // the cycle's inner order is display only
    expect(ordered.map((o) => [o.cyclic, o.uncertain])).toEqual([[false, false], [true, true], [true, true], [false, false]]);
  });

  it("a cycle's events stay together: an independent event whose clock falls between them is not placed among them, and all three keep their marks", () => {
    const a1 = { data: event(A, 2, x, { [B]: 2 }, "2026-11-02T08:00:00.000Z") }; // claims B's choice
    const b1 = { data: event(B, 2, y, { [A]: 2 }, "2026-11-02T12:00:00.000Z") }; // claims A's choice
    const c1 = { data: event(C, 1, x, {}, "2026-11-02T10:00:00.000Z") }; // independent, clock between the two
    // With the cycle's claims backed by a plan stored before the checks, and with no plan at all.
    for (const plans of [[planOf(entryOf(a1.data), entryOf(b1.data), entryOf(c1.data))], []]) {
      for (const list of [[c1, b1, a1], [a1, c1, b1], [b1, a1, c1]]) {
        const ordered = orderEvents(list, plans);
        // The cycle comes first by its earliest clock (08:00), its events by clock, then C's (10:00).
        expect(ordered.map((o) => o.event)).toEqual([a1, b1, c1]);
        expect(ordered.map((o) => [o.cyclic, o.uncertain])).toEqual([[true, true], [true, true], [false, true]]);
      }
    }
    // A later independent event: the cycle as one block still keeps its place before it by clock.
    const c0 = { data: event(C, 1, x, {}, "2026-11-02T07:00:00.000Z") }; // clock before the whole cycle
    expect(orderEvents([a1, b1, c0], []).map((o) => o.event)).toEqual([c0, a1, b1]);
  });

  describe("claims that cannot be verified order nothing (independent review, 2026-11-05)", () => {
    // B's choice claims to have seen A's: with a plan that backs it, B's comes after A's for certain.
    const a1 = { data: event(A, 1, x, {}, "2026-11-02T10:00:00.000Z") };
    const b1 = { data: event(B, 1, y, { [A]: 1 }, "2026-11-02T08:00:00.000Z") }; // clock before A's
    const flags = (plans: GoalWeekPlanData[], list = [a1, b1]) => orderEvents(list, plans).map((o) => [o.event, o.uncertain, o.cyclic]);
    const certain = [[a1, false, false], [b1, false, false]];
    const unordered = [[b1, true, false], [a1, true, false]]; // placed by clock only, both marked

    it("a verified claim orders the events as before", () => {
      expect(eventSeenVerified(b1.data, [planOf(entryOf(a1.data), entryOf(b1.data))])).toBe(true);
      expect(flags([planOf(entryOf(a1.data), entryOf(b1.data))])).toEqual(certain);
    });

    it("an event whose seen differs from its same-seq plan entry is an integrity issue and its claim orders nothing", () => {
      const plan = planOf(entryOf(a1.data), { ...entryOf(b1.data), seen: {} });
      expect(eventStatus(b1.data, [plan])).toBe("integrity");
      expect(eventSeenVerified(b1.data, [plan])).toBe(false);
      expect(flags([plan])).toEqual(unordered);
    });

    it("an event with no plan entry yet orders nothing until the plan arrives; then it is verified on the next display", () => {
      const onlyA = planOf(entryOf(a1.data));
      expect(eventStatus(b1.data, [onlyA])).toBe("notApplied");
      expect(flags([onlyA])).toEqual(unordered);
      expect(flags([])).toEqual(unordered);
      const arrived = planOf(entryOf(a1.data), entryOf(b1.data));
      expect(eventStatus(b1.data, [arrived])).toBe("current");
      expect(flags([arrived])).toEqual(certain);
    });

    it("a choice event whose seen lists its own device orders nothing, even when its status is otherwise fine", () => {
      const own = { data: { ...b1.data, seen: { [A]: 1, [B]: 1 } } };
      // B has written again since, so the event is "replaced later", not an integrity issue by counters.
      const plan = planOf(entryOf(a1.data), { device: B, seq: 2, segment: x, seen: { [A]: 1 } });
      expect(eventStatus(own.data, [plan])).toBe("replaced");
      expect(eventSeenVerified(own.data, [plan])).toBe(false);
      expect(flags([plan], [a1, own])).toEqual([[own, true, false], [a1, true, false]]);
    });

    it("a claim the plan does not bear out (a counter above the device's entry) orders nothing", () => {
      const far = { data: { ...b1.data, seen: { [A]: 5 } } };
      const plan = planOf(entryOf(a1.data), { device: B, seq: 2, segment: x, seen: { [A]: 1 } });
      expect(eventSeenVerified(far.data, [plan])).toBe(false);
      expect(flags([plan], [a1, far])).toEqual([[far, true, false], [a1, true, false]]);
    });
  });

  it("matches the full closure on random histories: order, uncertainty, and cycles (verified claims order, all claims show cycles)", () => {
    // The earlier n × n closure, kept here as the reference for the faster ordering.
    function reference(events: { data: GoalWeekPlanChoiceData }[], plans: GoalWeekPlanData[]) {
      const n = events.length;
      const d = events.map((e) => e.data);
      const trusted = d.map((e) => eventSeenVerified(e, plans));
      const closure = (useClaim: (i: number) => boolean, extra: (i: number, j: number) => boolean = () => false) => {
        const r = d.map((b, i) =>
          d.map((a, j) => i !== j && ((a.device === b.device ? b.seq > a.seq : useClaim(i) && b.device !== a.device && (b.seen[a.device] ?? 0) >= a.seq) || extra(i, j))),
        );
        for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (r[i]![k] && r[k]![j]) r[i]![j] = true;
        return r;
      };
      const rawReach = closure(() => true);
      const reach = closure((i) => trusted[i]!);
      const tie = (i: number, j: number) => {
        const a = d[i]!;
        const b = d[j]!;
        return a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.device < b.device ? -1 : a.device > b.device ? 1 : a.seq - b.seq || i - j;
      };
      // Each cycle by any claim is one block: verified order plus "same cycle" both ways.
      const sameCycle = (i: number, j: number) => rawReach[i]![j]! && rawReach[j]![i]!;
      const together = closure((i) => trusted[i]!, sameCycle);
      // Keeping cycles together moves nothing outside them: no event outside a cycle joins its block.
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && together[i]![j] && together[j]![i]) expect(sameCycle(i, j)).toBe(true);
      // The block that is ready first by its earliest clock comes next, its events by clock.
      const placed: number[] = [];
      const left = new Set(d.map((_, i) => i));
      while (left.size > 0) {
        const ready = [...left].filter((i) => [...left].every((j) => j === i || !together[i]![j] || together[j]![i]));
        const next = ready.sort(tie)[0]!;
        const block = [...left].filter((j) => j === next || (together[next]![j] && together[j]![next])).sort(tie);
        for (const j of block) {
          placed.push(j);
          left.delete(j);
        }
      }
      return placed.map((i) => {
        const cyclic = rawReach[i]![i]!;
        return [i, cyclic, cyclic || reach[i]![i]! || d.some((_, j) => j !== i && !reach[i]![j] && !reach[j]![i])];
      });
    }
    let state = 12345;
    const rand = (m: number) => ((state = (state * 1103515245 + 12345) % 2147483648) % m);
    const devices = [A, B, C];
    for (let round = 0; round < 300; round++) {
      const events = Array.from({ length: 2 + rand(9) }, () => {
        const device = devices[rand(3)]!;
        const seen: Record<string, number> = {};
        for (const other of devices) if (rand(3) === 0 && (other !== device || rand(4) === 0)) seen[other] = 1 + rand(5);
        return { data: event(device, 1 + rand(5), rand(2) ? x : y, seen, `2026-11-02T${String(10 + rand(10))}:00:00.000Z`) };
      });
      // Sometimes no plan; else each device's entry from one of its events (which then matches it), or a later one.
      const entries = devices.flatMap((device) => {
        const own = events.filter((e) => e.data.device === device);
        if (own.length === 0 || rand(4) === 0) return [];
        const pick = own[rand(own.length)]!.data;
        return [rand(3) === 0 ? { ...entryOf(pick), seq: pick.seq + 1 + rand(3), seen: {} } : { ...entryOf(pick), seen: Object.fromEntries(Object.entries(pick.seen).filter(([k]) => k !== device)) }];
      });
      const plans = rand(5) === 0 ? [] : [planOf(...entries)];
      const fast = orderEvents(events, plans).map((o) => [events.indexOf(o.event as (typeof events)[number]), o.cyclic, o.uncertain]);
      expect(fast).toEqual(reference(events, plans));
    }
  });

  it("orders a long history quickly: 3,000 events of three devices, each after the one before, whatever the clocks", () => {
    const devices = [A, B, C];
    const counters: Record<string, number> = { [A]: 0, [B]: 0, [C]: 0 };
    const events: { data: GoalWeekPlanChoiceData }[] = [];
    for (let k = 0; k < 3000; k++) {
      const device = devices[k % 3]!;
      counters[device]! += 1;
      const seen = Object.fromEntries(devices.filter((d) => d !== device && counters[d]! > 0).map((d) => [d, counters[d]!]));
      // Clocks run backwards, so only counters and claims can give the order.
      events.push({ data: event(device, counters[device]!, k % 2 ? x : y, seen, new Date(Date.UTC(2026, 10, 2) - k * 1000).toISOString()) });
    }
    const latest = devices.map((d) => entryOf(events.filter((e) => e.data.device === d).at(-1)!.data));
    const shuffled = [...events].reverse();
    const started = performance.now();
    const ordered = orderEvents(shuffled, [planOf(...latest)]);
    const elapsed = performance.now() - started;
    expect(ordered.map((o) => o.event)).toEqual(events);
    expect(ordered.some((o) => o.uncertain || o.cyclic)).toBe(false);
    // The earlier closure needed 3,000³ steps here (minutes); this stays well under a second on this PC.
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("two week records with a date from the same day, after a change of week start (T-247)", () => {
  const seg = (n: number): SegmentData => ({ state: "allocated", allocation: { num: n, den: 1 }, source: "automatic" });
  const rec = (weekStart: string, from: string, n: number, takesOver?: string[]): GoalWeekPlanData => ({
    goalId: GOAL,
    weekStart,
    ...(takesOver ? { takesOver } : {}),
    dates: [writeEntry(undefined, from, A, seg(n))],
  });
  const weekOn = (plans: GoalWeekPlanData[], day: string) => planDateOn(plans, day, A)!.plan.weekStart;

  it("the record that takes over wins, whether its week key is smaller or larger; without it, the later key wins as before", () => {
    expect(weekOn([rec("2026-11-01", "2026-11-05", 1), rec("2026-10-31", "2026-11-05", 2, ["2026-11-01"])], "2026-11-05")).toBe("2026-10-31");
    expect(weekOn([rec("2026-10-31", "2026-11-05", 1), rec("2026-11-01", "2026-11-05", 2, ["2026-10-31"])], "2026-11-05")).toBe("2026-11-01");
    expect(weekOn([rec("2026-11-01", "2026-11-05", 1), rec("2026-10-31", "2026-11-05", 2)], "2026-11-05")).toBe("2026-11-01");
    // Each naming the other (devices that never saw each other): the later key, as before.
    expect(weekOn([rec("2026-11-01", "2026-11-05", 1, ["2026-10-31"]), rec("2026-10-31", "2026-11-05", 2, ["2026-11-01"])], "2026-11-05")).toBe("2026-11-01");
    // The order of the records does not matter.
    expect(weekOn([rec("2026-10-31", "2026-11-05", 2, ["2026-11-01"]), rec("2026-11-01", "2026-11-05", 1)], "2026-11-05")).toBe("2026-10-31");
  });

  it("a merge keeps the union of the taken-over keys, in either order, and adds none when neither has any", () => {
    const here = rec("2026-10-31", "2026-11-05", 2, ["2026-11-01"]);
    const incoming = rec("2026-10-31", "2026-11-05", 2, ["2026-11-02"]);
    expect(mergePlans(here, incoming)!.takesOver).toEqual(["2026-11-01", "2026-11-02"]);
    expect(mergePlans(incoming, here)!.takesOver).toEqual(["2026-11-01", "2026-11-02"]);
    expect(mergePlans(rec("2026-10-31", "2026-11-05", 2), rec("2026-10-31", "2026-11-05", 2))).not.toHaveProperty("takesOver");
    expect(mergePlans(rec("2026-10-31", "2026-11-05", 2), here)!.takesOver).toEqual(["2026-11-01"]);
  });

  it("the stored field is checked: distinct, ascending, never the record's own key, and only keys whose weeks can overlap it", () => {
    const ok = (takesOver: unknown) => goalWeekPlanSchema.safeParse({ ...rec("2026-10-31", "2026-11-05", 2), takesOver }).success;
    expect(ok(["2026-11-01"])).toBe(true);
    expect(ok(["2026-10-25", "2026-11-06"])).toBe(true); // six days either side
    expect(ok(["2026-10-31"])).toBe(false); // itself
    expect(ok(["2026-11-07"])).toBe(false); // its week cannot overlap
    expect(ok(["2026-10-24"])).toBe(false);
    expect(ok(["2026-11-02", "2026-11-01"])).toBe(false); // not ascending
    expect(ok(["2026-11-01", "2026-11-01"])).toBe(false); // not distinct
    expect(ok([])).toBe(false); // absent when unused
    expect(goalWeekPlanSchema.safeParse(rec("2026-10-31", "2026-11-05", 2)).success).toBe(true);
  });
});
