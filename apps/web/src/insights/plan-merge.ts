/**
 * Weekly plan records and their merge (DECISIONS "Segment merge", T-223, T-227 to T-229, T-237).
 * Each effective date holds one entry per device `{ device, seq, segment, seen }`; an entry is
 * covered when another device's entry has seen it; the candidates of a date are the distinct
 * segments of uncovered entries, compared by exact canonical JSON (JCS). Pure functions: the
 * import and the decide commands call them, and the goal views read them.
 */
import { canonicalize } from "../backup/jcs.ts";
import { type GoalWeekPlanChoiceData, type GoalWeekPlanData, PLAN_SEQ_MAX, type PlanDateData, type PlanEntryData, type SegmentData } from "../backup/registry.ts";
import { addDays } from "../planning/time.ts";
import { hasCoverageCycle, hasUnsettledSeenAnomaly } from "./plan-integrity.ts";

const key = (value: unknown) => canonicalize(value);

/** Whether `entry` is covered: another device's entry saw it (or a later one of the same device). */
export function isCovered(entry: PlanEntryData, entries: readonly PlanEntryData[]): boolean {
  return entries.some((other) => other.device !== entry.device && (other.seen[entry.device] ?? 0) >= entry.seq);
}

/** Distinct segments of the uncovered entries, sorted by canonical JSON. */
export function candidatesOf(date: Pick<PlanDateData, "entries">): SegmentData[] {
  const out = new Map<string, SegmentData>();
  for (const entry of date.entries) if (!isCovered(entry, date.entries)) out.set(key(entry.segment), entry.segment);
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s);
}

export { hasCoverageCycle };

/** Whether any date of a weekly plan record has a coverage cycle (refused on import as an integrity issue). */
export const planHasCoverageCycle = (plan: GoalWeekPlanData) => plan.dates.some(hasCoverageCycle);

/**
 * Malformed entries the owner has to settle: no candidate at all (every entry is covered, which
 * only a coverage cycle can cause), or a stored `seen` claim no entry bears out that no sound entry
 * has covered yet. Shown as a data-integrity issue for the owner to settle, never as a silent
 * "no data" or a silently chosen plan.
 */
export const isInconsistentDate = (date: Pick<PlanDateData, "entries">) =>
  date.entries.length > 0 && (candidatesOf(date).length === 0 || hasUnsettledSeenAnomaly(date));

/** Distinct segments of all entries of a date, sorted by canonical JSON (the choices for an inconsistent date). */
function entrySegments(date: Pick<PlanDateData, "entries">): SegmentData[] {
  const out = new Map<string, SegmentData>();
  for (const entry of date.entries) out.set(key(entry.segment), entry.segment);
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s);
}

export type DateResolution =
  /** One candidate: the same on every device. */
  | { kind: "settled"; segment: SegmentData }
  /** Several candidates: this device's own entry applies while it is a candidate (T-227). */
  | { kind: "conflict"; segment: SegmentData; candidates: SegmentData[] }
  /** Several candidates and none of this device's own: no data until decided (T-228). */
  | { kind: "undecided"; candidates: SegmentData[] }
  /**
   * Malformed entries (`isInconsistentDate`): a data-integrity issue. This device's own entry still
   * applies if it has one (null otherwise), shown with a warning, and the owner chooses among the
   * segments of all entries.
   */
  | { kind: "inconsistent"; segment: SegmentData | null; candidates: SegmentData[] };

export function resolveDate(date: PlanDateData, thisDevice: string): DateResolution {
  if (isInconsistentDate(date)) {
    const own = date.entries.find((e) => e.device === thisDevice);
    return { kind: "inconsistent", segment: own?.segment ?? null, candidates: entrySegments(date) };
  }
  const candidates = candidatesOf(date);
  if (candidates.length === 1) return { kind: "settled", segment: candidates[0]! };
  const own = date.entries.find((e) => e.device === thisDevice);
  if (own && candidates.length > 1 && !isCovered(own, date.entries)) return { kind: "conflict", segment: own.segment, candidates };
  return { kind: "undecided", candidates };
}

/** The segment that applies from a date on this device, or null ("no data", T-228). */
export const appliedSegment = (r: DateResolution): SegmentData | null => (r.kind === "undecided" ? null : r.segment);

/** Whether a date waits for the owner: several candidates (T-223, T-227), or an inconsistent date. */
export const needsDecision = (date: Pick<PlanDateData, "entries">) => candidatesOf(date).length > 1 || isInconsistentDate(date);

/** The segments the owner can choose for a date that needs a decision. */
export const decisionChoices = (date: Pick<PlanDateData, "entries">) => (isInconsistentDate(date) ? entrySegments(date) : candidatesOf(date));

function unionOptions(...lists: readonly SegmentData[][]): SegmentData[] {
  const out = new Map<string, SegmentData>();
  for (const list of lists) for (const s of list) out.set(key(s), s);
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s);
}

const sortEntries = (entries: PlanEntryData[]) => [...entries].sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));

/**
 * Merges two versions of one date: per device, the entry with the higher `seq`, and the union of
 * `options`. Both are commutative, associative, and idempotent, so the result depends only on the
 * versions merged, never on their order or on repeats. A merge adds no option of its own: which
 * candidates met in an intermediate merge depends on the order of imports, so options come only
 * from the owner's decisions (`decideEntry`). The same device and `seq` with different content is
 * an integrity issue (returned as null: nothing changes).
 */
export function mergeDate(a: PlanDateData, b: PlanDateData): PlanDateData | null {
  const byDevice = new Map<string, PlanEntryData>();
  for (const entry of [...a.entries, ...b.entries]) {
    const seen = byDevice.get(entry.device);
    if (!seen || entry.seq > seen.seq) byDevice.set(entry.device, entry);
    else if (entry.seq === seen.seq && key(entry) !== key(seen)) return null;
  }
  return { from: a.from, entries: sortEntries([...byDevice.values()]), options: unionOptions(a.options, b.options) };
}

/**
 * Merges two versions of a weekly plan record date by date (T-227): dates on one side only are
 * kept, the same date is merged per device. Deterministic and independent of order and repeats.
 * Null when any date has an integrity issue: the record is then left unchanged.
 */
export function mergePlans(local: GoalWeekPlanData, incoming: GoalWeekPlanData): GoalWeekPlanData | null {
  const dates = new Map<string, PlanDateData>();
  for (const d of local.dates) dates.set(d.from, d);
  for (const d of incoming.dates) {
    const here = dates.get(d.from);
    if (!here) dates.set(d.from, { ...d, entries: sortEntries(d.entries), options: unionOptions(d.options) });
    else {
      const merged = mergeDate(here, d);
      if (!merged) return null;
      dates.set(d.from, merged);
    }
  }
  return { goalId: local.goalId, weekStart: local.weekStart, dates: [...dates.values()].sort((x, y) => (x.from < y.from ? -1 : 1)) };
}

/** Dates of a record that need the owner's decision: undecided or in conflict, or inconsistent. */
export function conflictDates(plan: GoalWeekPlanData): string[] {
  return plan.dates.filter(needsDecision).map((d) => d.from);
}

/**
 * The `seq` of this device's next entry for a date: one more than its previous entry. In
 * well-formed data no other entry has seen a higher `seq` of this device than its own; if
 * malformed data claims one, the next `seq` goes past it, so the new entry is never covered at once.
 */
export function nextSeq(date: Pick<PlanDateData, "entries"> | undefined, device: string): number {
  const entries = date?.entries ?? [];
  const own = entries.find((e) => e.device === device);
  return Math.max(own?.seq ?? 0, ...entries.filter((e) => e.device !== device).map((e) => e.seen[device] ?? 0)) + 1;
}

/**
 * Whether this device can still write an entry for a date: the next `seq` stays within the
 * schema's maximum. It cannot only when this device's counter, or a malformed claim about it, is
 * already at `PLAN_SEQ_MAX`; nothing is then written (a decision is refused, a plan write skipped).
 */
export const canWriteEntry = (date: Pick<PlanDateData, "entries"> | undefined, device: string) => nextSeq(date, device) <= PLAN_SEQ_MAX;

/**
 * Writes this device's entry for a date (a plan write or an owner decision): `seq` from `nextSeq`,
 * `seen` = every other device's entry now on this device, so the entries the owner saw are covered
 * (DECISIONS "Deciding a date"). Callers check `canWriteEntry` first.
 */
export function writeEntry(date: PlanDateData | undefined, from: string, device: string, segment: SegmentData): PlanDateData {
  const entries = date?.entries ?? [];
  const seen: Record<string, number> = {};
  for (const e of entries) if (e.device !== device) seen[e.device] = e.seq;
  const entry: PlanEntryData = { device, seq: nextSeq(date, device), segment, seen };
  return { from, entries: sortEntries([...entries.filter((e) => e.device !== device), entry]), options: unionOptions(date?.options ?? []) };
}

/**
 * The owner's decision for a date (DECISIONS "Deciding a date"): this device's entry as
 * `writeEntry` writes it, and `options` grown by the segments the owner chose between (the
 * candidates, or the segment that applied before a change of choice) and the chosen one, so a later
 * change of choice can return to any of them. Options are only ever added, never removed.
 */
export function decideEntry(date: PlanDateData, from: string, device: string, chosen: SegmentData): PlanDateData {
  const next = writeEntry(date, from, device, chosen);
  return { ...next, options: unionOptions(next.options, decisionChoices(date), [chosen]) };
}

/** The record's dates with one date replaced or added, in order. */
export function withDate(plan: GoalWeekPlanData, date: PlanDateData): GoalWeekPlanData {
  const dates = [...plan.dates.filter((d) => d.from !== date.from), date].sort((x, y) => (x.from < y.from ? -1 : 1));
  return { ...plan, dates };
}

/** Whether "Change choice" is offered for a settled date: the owner has chosen between more than one segment. */
export const canChangeChoice = (date: PlanDateData) => date.options.length > 1 && candidatesOf(date).length === 1;

/* ---------- which segment applies on a day ---------- */

export interface AppliedPlan {
  plan: GoalWeekPlanData;
  date: PlanDateData;
  resolution: DateResolution;
}

/**
 * The plan date in effect on `day`: among the goal's records whose seven days include it, the date
 * with the latest `from` on or before `day` (later week keys win a tie). Null: no recorded plan.
 */
export function planDateOn(plans: readonly GoalWeekPlanData[], day: string, thisDevice: string): AppliedPlan | null {
  let best: { plan: GoalWeekPlanData; date: PlanDateData } | null = null;
  for (const plan of plans) {
    if (!(plan.weekStart <= day && day <= addDays(plan.weekStart, 6))) continue;
    for (const date of plan.dates) {
      if (date.from > day) continue;
      if (!best || date.from > best.date.from || (date.from === best.date.from && plan.weekStart > best.plan.weekStart)) best = { plan, date };
    }
  }
  return best ? { ...best, resolution: resolveDate(best.date, thisDevice) } : null;
}

/* ---------- choice history (T-237) ---------- */

export type EventStatus = "notApplied" | "current" | "replaced" | "integrity";

/**
 * Status of a choice event, computed on display from this device's plan record (never stored):
 * not applied here, current, replaced later, or a data-integrity issue when the counters are equal
 * but the event does not match the entry.
 */
export function eventStatus(event: GoalWeekPlanChoiceData, plans: readonly GoalWeekPlanData[]): EventStatus {
  const plan = plans.find((p) => p.goalId === event.goalId && p.weekStart === event.weekStart);
  const date = plan?.dates.find((d) => d.from === event.from);
  const entry = date?.entries.find((e) => e.device === event.device);
  if (!date || !entry || entry.seq < event.seq) return "notApplied";
  if (entry.seq > event.seq) return "replaced";
  if (key(entry.segment) !== key(event.chosen) || key(entry.seen) !== key(event.seen)) return "integrity";
  return isCovered(entry, date.entries) ? "replaced" : "current";
}

/** Whether event `b` came after `a`: the same device with a higher counter, or `b` had seen `a`. */
export function happenedAfter(b: GoalWeekPlanChoiceData, a: GoalWeekPlanChoiceData): boolean {
  if (a.device === b.device) return b.seq > a.seq;
  return (b.seen[a.device] ?? 0) >= a.seq;
}

/**
 * Whether an event's `seen` can be relied on to order it (DECISIONS "Order of events"): this
 * device's plan for the date has the event's device at its `seq` or later, an entry at the same
 * `seq` matches it exactly (`eventStatus` is not an integrity issue), its `seen` does not list its
 * own device, and every claim is borne out by an entry of the date with at least that `seq`. An
 * event not applied here yet, or with a claim the plan contradicts, cannot be verified; once the
 * plan arrives, the next display verifies it.
 */
export function eventSeenVerified(event: GoalWeekPlanChoiceData, plans: readonly GoalWeekPlanData[]): boolean {
  if (event.device in event.seen) return false;
  const date = plans.find((p) => p.goalId === event.goalId && p.weekStart === event.weekStart)?.dates.find((d) => d.from === event.from);
  const entry = date?.entries.find((e) => e.device === event.device);
  if (!date || !entry || entry.seq < event.seq) return false;
  if (entry.seq === event.seq && (key(entry.segment) !== key(event.chosen) || key(entry.seen) !== key(event.seen))) return false;
  return Object.entries(event.seen).every(([device, claimed]) => (date.entries.find((e) => e.device === device)?.seq ?? 0) >= claimed);
}

export interface OrderedEvent<T> {
  event: T;
  /**
   * Another event of the date neither came before nor after it as far as the counters and verified
   * `seen` claims tell (T-237), or the event is `cyclic`.
   */
  uncertain: boolean;
  /**
   * The event both came before and after another by the events' claims (each claims in `seen` to
   * have seen the other): malformed history, a data-integrity issue, whether or not the claims are
   * verified. An app device can only see an event written before.
   */
  cyclic: boolean;
}

/**
 * Strongly connected components of a graph given as adjacency lists (iterative Tarjan, so long
 * chains need no deep recursion). Components come out in reverse topological order: each after
 * every component it reaches.
 */
function components(adjacency: readonly number[][]): { comp: number[]; order: number[][] } {
  const n = adjacency.length;
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const comp = new Array<number>(n).fill(-1);
  const stack: number[] = [];
  const order: number[][] = [];
  let counter = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work: [number, number][] = [[root, 0]];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = true;
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const [v, i] = frame;
      if (i < adjacency[v]!.length) {
        frame[1] = i + 1;
        const w = adjacency[v]![i]!;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = true;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]![0];
        low[parent] = Math.min(low[parent]!, low[v]!);
      }
      if (low[v] === index[v]) {
        const members: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = false;
          comp[w] = order.length;
          members.push(w);
        } while (w !== v);
        order.push(members);
      }
    }
  }
  return { comp, order };
}

/**
 * The events of one date oldest first: by counter, and by `seen` where it is verified
 * (`eventSeenVerified`); independent events, and events whose claims cannot be verified, are
 * placed by their device clocks only to keep them near each other, and marked uncertain where no
 * counter or verified claim orders them. Events in a causal cycle (by any of their claims) are
 * marked cyclic and uncertain and kept together as one block, after what they all came after and
 * before what came after them, placed among themselves by their clocks only for display; this never
 * changes the order of an event outside the cycle. No clock decides which of two events came first.
 *
 * Runs in about O(n·D² + n log n) for n events of D devices (choice history has no count limit): an
 * event depends directly only on its device's previous event and, per claimed device, on that
 * device's latest event the claim reaches; what each event came after is a vector of counters per
 * device, so no n × n closure is built.
 */
export function orderEvents<T extends { data: GoalWeekPlanChoiceData }>(events: readonly T[], plans: readonly GoalWeekPlanData[]): OrderedEvent<T>[] {
  const n = events.length;
  const data = events.map((e) => e.data);
  // Display order only; the input order last, so even repeated events have one fixed place.
  const tie = (i: number, j: number) => {
    const a = data[i]!;
    const b = data[j]!;
    return a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.device < b.device ? -1 : a.device > b.device ? 1 : a.seq - b.seq || i - j;
  };
  // Each device's events by counter.
  const byDevice = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const list = byDevice.get(data[i]!.device);
    if (list) list.push(i);
    else byDevice.set(data[i]!.device, [i]);
  }
  for (const list of byDevice.values()) list.sort((i, j) => data[i]!.seq - data[j]!.seq || tie(i, j));
  /** The position in `list` of the first event with a `seq` above `seq` (at or above it when `inclusive`). */
  const firstPast = (list: readonly number[], seq: number, inclusive = false): number => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const s = data[list[mid]!]!.seq;
      if (inclusive ? s < seq : s <= seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  /**
   * The events of `device` with the highest `seq` at most `max` (strictly below it when `strict`):
   * one event, or several should malformed data repeat a counter (event IDs derive from it).
   */
  const latest = (device: string, max: number, strict = false): number[] => {
    const list = byDevice.get(device);
    if (!list) return [];
    let at = firstPast(list, max, strict) - 1;
    if (at < 0) return [];
    const out: number[] = [];
    for (const seq = data[list[at]!]!.seq; at >= 0 && data[list[at]!]!.seq === seq; at--) out.push(list[at]!);
    return out;
  };
  /** Direct dependencies: the device's previous event, and per claim the latest event it reaches. */
  const dependencies = (useClaims: (i: number) => boolean) =>
    data.map((e, i) => {
      const out = latest(e.device, e.seq, true);
      if (useClaims(i)) for (const [device, claimed] of Object.entries(e.seen)) if (device !== e.device) out.push(...latest(device, claimed));
      return out;
    });

  // Cycles by every claim, verified or not: a data-integrity issue either way.
  const raw = components(dependencies(() => true));
  const rawSize = raw.order.map((members) => members.length);
  // Order by counters and verified claims only.
  const verified = data.map((e) => eventSeenVerified(e, plans));
  const edges = dependencies((i) => verified[i]!);
  const { comp, order } = components(edges);

  // What each component came after: per device, the highest counter (dependencies come first in `order`).
  const known: Map<string, number>[] = [];
  for (const members of order) {
    const vector = new Map<string, number>();
    const raise = (device: string, seq: number) => vector.set(device, Math.max(vector.get(device) ?? 0, seq));
    for (const i of members) {
      raise(data[i]!.device, data[i]!.seq);
      for (const j of edges[i]!) if (comp[j] !== comp[i]) for (const [device, seq] of known[comp[j]!]!) raise(device, seq);
    }
    known.push(vector);
  }
  const cameAfter = (i: number, j: number) =>
    comp[i] !== comp[j] && !(data[i]!.device === data[j]!.device && data[i]!.seq === data[j]!.seq) && (known[comp[i]!]!.get(data[j]!.device) ?? 0) >= data[j]!.seq;

  // Uncertain: some other event is neither before nor after it. Per device, the events after it are a
  // suffix of that device's events (each knows at least what its previous one knew), so checking the
  // first event past what it came after is enough.
  const uncertainAt = (i: number): boolean => {
    if (rawSize[raw.comp[i]!]! > 1 || order[comp[i]!]!.length > 1) return true;
    for (const [device, list] of byDevice) {
      const own = device === data[i]!.device;
      const reached = own ? data[i]!.seq : (known[comp[i]!]!.get(device) ?? 0);
      const next = firstPast(list, reached);
      // Its own device with the same counter twice: neither came first.
      if (own && next - firstPast(list, reached, true) > 1) return true;
      if (next < list.length && !cameAfter(list[next]!, i)) return true;
    }
    return false;
  };

  // Display blocks: the events of each cycle (by any of their claims) kept together, placed by verified
  // order and inside the block by clock only. Every verified dependency is also a claim, so an event
  // that verified order puts after one event of a cycle and before another is itself on that cycle:
  // keeping a cycle together never moves an event outside it. The blocks are the components by all claims.
  const rawCyclic = (i: number) => rawSize[raw.comp[i]!]! > 1;

  // Topological order of the blocks by verified dependencies; among the blocks ready, the one with the
  // earliest clock first, its events one after another by clock.
  const members = raw.order.map((list) => [...list].sort(tie));
  const pending = members.map(() => 0);
  const followers: number[][] = members.map(() => []);
  for (let i = 0; i < n; i++) {
    for (const j of edges[i]!) {
      if (raw.comp[j] === raw.comp[i]) continue;
      pending[raw.comp[i]!]! += 1;
      followers[raw.comp[j]!]!.push(raw.comp[i]!);
    }
  }
  const before = (g: number, h: number) => tie(members[g]![0]!, members[h]![0]!);
  const heap: number[] = [];
  const push = (g: number) => {
    heap.push(g);
    for (let c = heap.length - 1; c > 0; ) {
      const p = (c - 1) >> 1;
      if (before(heap[c]!, heap[p]!) >= 0) break;
      [heap[c], heap[p]] = [heap[p]!, heap[c]!];
      c = p;
    }
  };
  const pop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let p = 0; ; ) {
        const l = 2 * p + 1;
        const r = l + 1;
        let m = p;
        if (l < heap.length && before(heap[l]!, heap[m]!) < 0) m = l;
        if (r < heap.length && before(heap[r]!, heap[m]!) < 0) m = r;
        if (m === p) break;
        [heap[m], heap[p]] = [heap[p]!, heap[m]!];
        p = m;
      }
    }
    return top;
  };
  members.forEach((_, g) => {
    if (pending[g] === 0) push(g);
  });
  const placed: number[] = [];
  while (heap.length > 0) {
    const g = pop();
    placed.push(...members[g]!);
    for (const f of followers[g]!) if (--pending[f]! === 0) push(f);
  }
  return placed.map((i) => ({ event: events[i]!, cyclic: rawCyclic(i), uncertain: uncertainAt(i) }));
}
