/**
 * Data integrity of weekly plan records (DECISIONS "Entries that cover one another", "`seen`
 * claims"): coverage cycles and `seen` claims that no entry of the date bears out. Pure, with only
 * type imports from the registry, so the registry's write check, the import, and the views share it.
 */
import { canonicalize } from "../backup/jcs.ts";
import type { GoalWeekPlanData, PlanDateData, PlanEntryData } from "../backup/registry.ts";

type Entries = Pick<PlanDateData, "entries">;

/**
 * Entries that lie on a coverage cycle (A covered by B and B by A, or a longer loop). An entry can
 * only cover one written before it, so a cycle never arises from the app's own writes: it is
 * malformed data, a data-integrity issue.
 */
export function cyclicEntries(date: Entries): PlanEntryData[] {
  const entries = date.entries;
  // reach[i][j]: entry i is covered by entry j, directly or through others.
  const reach = entries.map((e) => entries.map((o) => o.device !== e.device && (o.seen[e.device] ?? 0) >= e.seq));
  for (let k = 0; k < entries.length; k++)
    for (let i = 0; i < entries.length; i++) for (let j = 0; j < entries.length; j++) if (reach[i]![k] && reach[k]![j]) reach[i]![j] = true;
  return entries.filter((_, i) => reach[i]![i]);
}

/** Whether the entries of a date cover one another in a cycle. */
export const hasCoverageCycle = (date: Entries) => cyclicEntries(date).length > 0;

/**
 * `seen` claims of a date that no entry bears out (DECISIONS "`seen` claims"): `seen` records the
 * highest `seq` its device had actually seen of another device's entry for that date, and a date
 * keeps each device's highest entry, so every claim names a device with an entry on the date and
 * is at most that entry's `seq`. Each problem is described with the claiming entry, the claim, and
 * the claimed device's entry here (or "absent"), so the same problem can be recognized later.
 */
export function seenProblems(date: Entries): string[] {
  const out: string[] = [];
  for (const entry of date.entries) {
    for (const [device, claimed] of Object.entries(entry.seen)) {
      const target = date.entries.find((e) => e.device === device);
      if (!target || claimed > target.seq) out.push(`${entry.device}:${entry.seq} saw ${device}:${claimed} of ${target ? target.seq : "absent"}`);
    }
  }
  return out.sort();
}

/** Whether `entry` has a `seen` claim that no entry of the date bears out. */
function hasUnfoundedClaim(entry: PlanEntryData, entries: readonly PlanEntryData[]): boolean {
  return Object.entries(entry.seen).some(([device, claimed]) => {
    const target = entries.find((e) => e.device === device);
    return !target || claimed > target.seq;
  });
}

/**
 * Whether a date holds a stored `seen` claim no entry bears out (from before these checks) that
 * the owner has not settled: the entry with the claim is not covered by any entry whose own claims
 * are all borne out. Like a coverage cycle, it is a data-integrity issue for the owner to decide
 * (DECISIONS "`seen` claims"); the owner's decision writes such an entry, which settles the date.
 */
export function hasUnsettledSeenAnomaly(date: Entries): boolean {
  const entries = date.entries;
  const sound = entries.filter((e) => !hasUnfoundedClaim(e, entries));
  return entries.some(
    (e) => hasUnfoundedClaim(e, entries) && !sound.some((o) => o.device !== e.device && (o.seen[e.device] ?? 0) >= e.seq),
  );
}

export type PlanIntegrityProblem = "cycle" | "seen";

const entryKey = (entry: PlanEntryData) => canonicalize(entry);

/**
 * For each stored claim no entry bears out, the entry it covers (the claimed device's entry with a
 * `seq` up to the claim), or null when it covers none; keyed by the claiming entry and device.
 */
function unfoundedClaimCover(date: Entries): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const entry of date.entries) {
    for (const [device, claimed] of Object.entries(entry.seen)) {
      const target = date.entries.find((e) => e.device === device);
      if (!target || claimed > target.seq) out.set(`${entryKey(entry)}|${device}`, target && target.seq <= claimed ? entryKey(target) : null);
    }
  }
  return out;
}

/**
 * The first integrity problem that `after` brings over `before` (`undefined` for a record new
 * here), or null: on some date, an entry on a coverage cycle that was not already on one there in
 * exactly that form, a `seen` claim not borne out that was not already there in the same form
 * (the claimed device's entry included), or a claim stored here that no entry bore out coming to
 * cover an entry it did not cover before (such as the claimed device's real entry arriving with a
 * `seq` up to the claim, which would make the claim look borne out and silently cover it).
 * Problems already stored (from before these checks) do not block a write that leaves them as they
 * are, so the owner can still settle such a date.
 */
export function newPlanIntegrityProblem(before: GoalWeekPlanData | undefined, after: GoalWeekPlanData): PlanIntegrityProblem | null {
  for (const date of after.dates) {
    const old = before?.dates.find((d) => d.from === date.from);
    const cyclicBefore = new Set((old ? cyclicEntries(old) : []).map(entryKey));
    if (cyclicEntries(date).some((e) => !cyclicBefore.has(entryKey(e)))) return "cycle";
    const seenBefore = new Set(old ? seenProblems(old) : []);
    if (seenProblems(date).some((p) => !seenBefore.has(p))) return "seen";
    const unfounded = old ? unfoundedClaimCover(old) : new Map<string, string | null>();
    for (const entry of date.entries) {
      for (const [device, claimed] of Object.entries(entry.seen)) {
        const key = `${entryKey(entry)}|${device}`;
        if (!unfounded.has(key)) continue;
        const target = date.entries.find((e) => e.device === device);
        const covers = target && target.seq <= claimed ? entryKey(target) : null;
        if (covers !== null && covers !== unfounded.get(key)) return "seen";
      }
    }
  }
  return null;
}
