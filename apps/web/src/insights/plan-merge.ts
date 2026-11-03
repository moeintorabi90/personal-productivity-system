/**
 * Weekly plan records and their merge (DECISIONS "Segment merge", T-223, T-227 to T-229, T-237).
 * Each effective date holds one entry per device `{ device, seq, segment, seen }`; an entry is
 * covered when another device's entry has seen it; the candidates of a date are the distinct
 * segments of uncovered entries, compared by exact canonical JSON (JCS). Pure functions: the
 * import and the decide commands call them, and the goal views read them.
 */
import { canonicalize } from "../backup/jcs.ts";
import type { GoalWeekPlanChoiceData, GoalWeekPlanData, PlanDateData, PlanEntryData, SegmentData } from "../backup/registry.ts";
import { addDays } from "../planning/time.ts";

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

export type DateResolution =
  /** One candidate: the same on every device. */
  | { kind: "settled"; segment: SegmentData }
  /** Several candidates: this device's own entry applies while it is a candidate (T-227). */
  | { kind: "conflict"; segment: SegmentData; candidates: SegmentData[] }
  /** Several candidates and none of this device's own: no data until decided (T-228). */
  | { kind: "undecided"; candidates: SegmentData[] };

export function resolveDate(date: PlanDateData, thisDevice: string): DateResolution {
  const candidates = candidatesOf(date);
  if (candidates.length === 1) return { kind: "settled", segment: candidates[0]! };
  const own = date.entries.find((e) => e.device === thisDevice);
  if (own && candidates.length > 1 && !isCovered(own, date.entries)) return { kind: "conflict", segment: own.segment, candidates };
  return { kind: "undecided", candidates };
}

/** The segment that applies from a date on this device, or null ("no data", T-228). */
export const appliedSegment = (r: DateResolution): SegmentData | null => (r.kind === "undecided" ? null : r.segment);

function unionOptions(...lists: readonly SegmentData[][]): SegmentData[] {
  const out = new Map<string, SegmentData>();
  for (const list of lists) for (const s of list) out.set(key(s), s);
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s);
}

const sortEntries = (entries: PlanEntryData[]) => [...entries].sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));

/** Adds the candidates to `options` when more than one is left (they can be chosen again later). */
function withConflictOptions(date: PlanDateData): PlanDateData {
  const candidates = candidatesOf(date);
  return { ...date, options: candidates.length > 1 ? unionOptions(date.options, candidates) : unionOptions(date.options) };
}

/**
 * Merges two versions of one date: per device, the entry with the higher `seq`; the same device
 * and `seq` with different content is an integrity issue (returned as null: nothing changes).
 */
export function mergeDate(a: PlanDateData, b: PlanDateData): PlanDateData | null {
  const byDevice = new Map<string, PlanEntryData>();
  for (const entry of [...a.entries, ...b.entries]) {
    const seen = byDevice.get(entry.device);
    if (!seen || entry.seq > seen.seq) byDevice.set(entry.device, entry);
    else if (entry.seq === seen.seq && key(entry) !== key(seen)) return null;
  }
  return withConflictOptions({ from: a.from, entries: sortEntries([...byDevice.values()]), options: unionOptions(a.options, b.options) });
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
    if (!here) dates.set(d.from, withConflictOptions({ ...d, entries: sortEntries(d.entries), options: unionOptions(d.options) }));
    else {
      const merged = mergeDate(here, d);
      if (!merged) return null;
      dates.set(d.from, merged);
    }
  }
  return { goalId: local.goalId, weekStart: local.weekStart, dates: [...dates.values()].sort((x, y) => (x.from < y.from ? -1 : 1)) };
}

/** Dates of a record that are undecided or in conflict (more than one candidate). */
export function conflictDates(plan: GoalWeekPlanData): string[] {
  return plan.dates.filter((d) => candidatesOf(d).length > 1).map((d) => d.from);
}

/**
 * Writes this device's entry for a date (a plan write or an owner decision): `seq` one more than
 * its previous entry for the date, `seen` = every other device's entry now on this device, so the
 * entries the owner saw are covered (DECISIONS "Deciding a date").
 */
export function writeEntry(date: PlanDateData | undefined, from: string, device: string, segment: SegmentData): PlanDateData {
  const entries = date?.entries ?? [];
  const own = entries.find((e) => e.device === device);
  const seen: Record<string, number> = {};
  for (const e of entries) if (e.device !== device) seen[e.device] = e.seq;
  const entry: PlanEntryData = { device, seq: (own?.seq ?? 0) + 1, segment, seen };
  const next: PlanDateData = { from, entries: sortEntries([...entries.filter((e) => e.device !== device), entry]), options: date?.options ?? [] };
  return withConflictOptions(next);
}

/** The record's dates with one date replaced or added, in order. */
export function withDate(plan: GoalWeekPlanData, date: PlanDateData): GoalWeekPlanData {
  const dates = [...plan.dates.filter((d) => d.from !== date.from), date].sort((x, y) => (x.from < y.from ? -1 : 1));
  return { ...plan, dates };
}

/** Whether "Change choice" is offered for a settled date: more than one segment has been a candidate. */
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

export interface OrderedEvent<T> {
  event: T;
  /** Another event of the date neither came before nor after it (T-237). */
  uncertain: boolean;
}

/**
 * The events of one date oldest first: by counter and `seen` where they tell; independent events
 * are placed by their device clocks only to keep them near each other, and marked uncertain.
 */
export function orderEvents<T extends { data: GoalWeekPlanChoiceData }>(events: readonly T[]): OrderedEvent<T>[] {
  const n = events.length;
  const after = (i: number, j: number) => happenedAfter(events[i]!.data, events[j]!.data);
  // Transitive closure of "came after" (small lists).
  const reach = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i !== j && after(i, j)));
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (reach[i]![k] && reach[k]![j]) reach[i]![j] = true;
  const tie = (i: number, j: number) => {
    const a = events[i]!.data;
    const b = events[j]!.data;
    return a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.device < b.device ? -1 : a.device > b.device ? 1 : a.seq - b.seq;
  };
  const placed: number[] = [];
  const left = new Set(events.map((_, i) => i));
  while (left.size > 0) {
    const ready = [...left].filter((i) => [...left].every((j) => j === i || !reach[i]![j]));
    const next = (ready.length > 0 ? ready : [...left]).sort(tie)[0]!;
    placed.push(next);
    left.delete(next);
  }
  return placed.map((i) => ({ event: events[i]!, uncertain: events.some((_, j) => j !== i && !reach[i]![j] && !reach[j]![i]) }));
}
