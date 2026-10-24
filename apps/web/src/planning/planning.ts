/**
 * Stage 3 derived planning data (docs/DATA_MODEL.md "Derived, not stored"). Pure functions over
 * tasks, blocks, and the configured zone; nothing here writes, and nothing runs on its own
 * (D-019, D-021, T-026): unscheduled items and capacity are recomputed whenever they are shown.
 */
import type { CalendarBlockData, Recurrence, TaskDefinitionData } from "../backup/registry.ts";
import { normalizeForSearch } from "../local/organization.ts";
import { localDayBounds, MINUTE_MS, weekdayOf } from "./time.ts";

export interface TaskItem {
  id: string;
  data: TaskDefinitionData;
}

export interface BlockItem {
  id: string;
  data: CalendarBlockData;
}

/** Does the recurrence put an occurrence on local date `date`? */
export function recursOn(recurrence: Recurrence, date: string): boolean {
  return (
    recurrence.startDate <= date &&
    (recurrence.endDate === null || date <= recurrence.endDate) &&
    recurrence.weekdays.includes(weekdayOf(date))
  );
}

/**
 * The occurrence (task, date) is scheduled while AT LEAST ONE block for that task and occurrence
 * date is planned (D-023) — wherever that block is displayed (D-022): the display date of a block
 * never schedules anything; only `occurrenceDate` does.
 */
export function isOccurrenceScheduled(blocks: readonly BlockItem[], taskId: string, date: string): boolean {
  return blocks.some((b) => b.data.taskId === taskId && b.data.occurrenceDate === date && b.data.status === "planned");
}

export interface UnscheduledItem {
  taskId: string;
  date: string;
}

/**
 * Unscheduled items of local date `date`: every live, non-archived recurring task whose
 * recurrence covers the date and whose occurrence has no planned block. An item stays on its own
 * date and is never carried forward (T-026, T-034).
 */
export function unscheduledItemsOn(tasks: readonly TaskItem[], blocks: readonly BlockItem[], date: string): UnscheduledItem[] {
  return tasks
    .filter((t) => t.data.archivedAt === null && t.data.recurrence && recursOn(t.data.recurrence, date))
    .filter((t) => !isOccurrenceScheduled(blocks, t.id, date))
    .map((t) => ({ taskId: t.id, date }));
}

/** The part of a block inside local date `date` in `zone`, in ms, or null when it does not touch it. */
export function blockSegmentOn(block: CalendarBlockData, date: string, zone: string): [number, number] | null {
  const [dayStart, dayEnd] = localDayBounds(date, zone);
  const start = Math.max(Date.parse(block.startsAt), dayStart);
  const end = Math.min(Date.parse(block.endsAt), dayEnd);
  return end > start ? [start, end] : null;
}

/** Blocks displayed on local date `date` (placed by their instants in the CONFIGURED zone, D-022). */
export function blocksOn<T extends BlockItem>(blocks: readonly T[], date: string, zone: string): T[] {
  return blocks
    .filter((b) => blockSegmentOn(b.data, date, zone) !== null)
    .sort((a, b) => a.data.startsAt.localeCompare(b.data.startsAt) || a.data.endsAt.localeCompare(b.data.endsAt) || a.id.localeCompare(b.id));
}

/** Planned minutes of a date: planned (not cancelled) blocks clipped to the day; overlaps each count (T-031). */
export function plannedMinutesOn(blocks: readonly BlockItem[], date: string, zone: string): number {
  let ms = 0;
  for (const b of blocks) {
    if (b.data.status !== "planned") continue;
    const seg = blockSegmentOn(b.data, date, zone);
    if (seg) ms += seg[1] - seg[0];
  }
  return Math.round(ms / MINUTE_MS);
}

/** IDs of planned blocks on the date that overlap another planned block there. */
export function overlappingBlockIds(blocks: readonly BlockItem[], date: string, zone: string): Set<string> {
  const segs = blocks
    .filter((b) => b.data.status === "planned")
    .map((b) => ({ id: b.id, seg: blockSegmentOn(b.data, date, zone) }))
    .filter((s): s is { id: string; seg: [number, number] } => s.seg !== null);
  const out = new Set<string>();
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (segs[i]!.seg[0] < segs[j]!.seg[1] && segs[j]!.seg[0] < segs[i]!.seg[1]) {
        out.add(segs[i]!.id);
        out.add(segs[j]!.id);
      }
    }
  }
  return out;
}

/**
 * Splits a date's displayed blocks (already in time order) into groups shown side by side: a
 * planned block joins the current planned group when it starts before a planned block of that
 * group ends. Cancelled blocks never overlap anything: each stands alone in time order and does
 * not interrupt a planned group (a group is placed where its first block is). Display only.
 */
export function overlapGroups<T extends BlockItem>(blocks: readonly T[], date: string, zone: string): T[][] {
  const groups: T[][] = [];
  let planned: T[] | null = null;
  let groupEnd = -Infinity;
  for (const block of blocks) {
    const seg = block.data.status === "planned" ? blockSegmentOn(block.data, date, zone) : null;
    if (!seg) {
      groups.push([block]);
      continue;
    }
    if (planned && seg[0] < groupEnd) {
      planned.push(block);
      groupEnd = Math.max(groupEnd, seg[1]);
    } else {
      planned = [block];
      groups.push(planned);
      groupEnd = seg[1];
    }
  }
  return groups;
}

export type CapacityStatus =
  | { kind: "unset"; planned: number }
  | { kind: "ok" | "notice" | "warning"; planned: number; capacity: number; excess: number; withUnscheduled: number; noEstimate: string[] };

/**
 * Capacity of one date (D-021, T-031). Without a capacity: no warning or notice. A WARNING when
 * planned minutes exceed capacity; otherwise a softer NOTICE when planned minutes plus the
 * estimates of that date's unscheduled items exceed it. Items without an estimate are not
 * counted; their task IDs are listed in `noEstimate`. Informational only: never changes data.
 */
export function capacityStatus(
  capacity: number | undefined,
  planned: number,
  unscheduled: readonly UnscheduledItem[],
  tasks: ReadonlyMap<string, TaskDefinitionData>,
): CapacityStatus {
  if (capacity === undefined) return { kind: "unset", planned };
  let estimates = 0;
  const noEstimate: string[] = [];
  for (const item of unscheduled) {
    const minutes = tasks.get(item.taskId)?.estimateMinutes ?? null;
    if (minutes === null) noEstimate.push(item.taskId);
    else estimates += minutes;
  }
  const withUnscheduled = planned + estimates;
  const kind = planned > capacity ? "warning" : withUnscheduled > capacity ? "notice" : "ok";
  return { kind, planned, capacity, excess: Math.max(0, planned - capacity), withUnscheduled, noEstimate };
}

/* ---------------- search and filters ---------------- */

export interface PlanFilter {
  query: string;
  /** "" = all projects, "inbox" = tasks without a project, otherwise a project ID. */
  project: string;
  /** "" = all workstreams, otherwise a workstream ID. */
  workstream: string;
  showCancelled: boolean;
  onlyUnscheduled: boolean;
}

export const NO_FILTER: PlanFilter = { query: "", project: "", workstream: "", showCancelled: false, onlyUnscheduled: false };

/** Title and project/workstream of a block: the current task when it is on this device, else its snapshot (T-036). */
export function blockLabel(block: CalendarBlockData, tasks: ReadonlyMap<string, TaskDefinitionData>) {
  const task = tasks.get(block.taskId);
  return task
    ? { title: task.title, projectId: task.projectId, workstreamId: task.workstreamId, fromSnapshot: false }
    : { title: block.snapshot.taskTitle, projectId: block.snapshot.projectId, workstreamId: block.snapshot.workstreamId, fromSnapshot: true };
}

function matchesOrg(filter: PlanFilter, projectId: string | null, workstreamId: string | null): boolean {
  if (filter.project === "inbox" && projectId !== null) return false;
  if (filter.project && filter.project !== "inbox" && projectId !== filter.project) return false;
  if (filter.workstream && workstreamId !== filter.workstream) return false;
  return true;
}

function matchesQuery(query: string, ...texts: string[]): boolean {
  const q = normalizeForSearch(query.trim());
  return !q || texts.some((text) => normalizeForSearch(text).includes(q));
}

/** Blocks shown under a filter: search by current title and snapshot title (PRODUCT_SPEC "Calendar views"). */
export function filterBlocks<T extends BlockItem>(blocks: readonly T[], filter: PlanFilter, tasks: ReadonlyMap<string, TaskDefinitionData>): T[] {
  if (filter.onlyUnscheduled) return [];
  return blocks.filter((b) => {
    if (b.data.status === "cancelled" && !filter.showCancelled) return false;
    const label = blockLabel(b.data, tasks);
    return matchesOrg(filter, label.projectId, label.workstreamId) && matchesQuery(filter.query, label.title, b.data.snapshot.taskTitle);
  });
}

export function filterUnscheduled(items: readonly UnscheduledItem[], filter: PlanFilter, tasks: ReadonlyMap<string, TaskDefinitionData>): UnscheduledItem[] {
  return items.filter((item) => {
    const task = tasks.get(item.taskId);
    return !!task && matchesOrg(filter, task.projectId, task.workstreamId) && matchesQuery(filter.query, task.title);
  });
}
