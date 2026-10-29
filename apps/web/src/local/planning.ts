/**
 * Stage 3 — calendar and planning commands (docs/PRODUCT_SPEC.md "Stage 3 planning contract").
 * Every write here is an explicit user action on one block, one task's recurrence, or the
 * capacity setting; nothing creates, moves, or cancels a block on its own (D-019, D-021).
 * Blocks are ordinary product records, so they are exported, merged, and resolved like any other
 * linked type. There is no delete: blocks are cancelled and restored (T-027).
 */
import {
  BLOCK_MAX_MINUTES,
  CALENDAR_BLOCKS,
  type CalendarBlockData,
  type ExpectedOutput,
  PRODUCT_REGISTRY,
  PROJECTS,
  type ProjectData,
  type Recurrence,
  type Registry,
  TASK_DEFINITIONS,
  type TaskDefinitionData,
  WORKSTREAMS,
  type WorkstreamData,
} from "../backup/registry.ts";
import { canonicalize } from "../backup/jcs.ts";
import type { VersionVector } from "../backup/versions.ts";
import { localDateOf, MINUTE_MS, resolveWallTime } from "../planning/time.ts";
import type { LocalDb, RecordRow } from "./db.ts";
import { createTask, updateTask } from "./organization.ts";
import { PlanningError, requireZone } from "./planning-error.ts";
import { putRecord } from "./records.ts";

export { PlanningError, type PlanningErrorCode } from "./planning-error.ts";

/** Date, start time (wall clock in the configured zone), and duration of a block as entered. */
export interface BlockTimeInput {
  date: string;
  startTime: string;
  durationMinutes: number;
}

const planningTables = (db: LocalDb) => [db.records, db.tombstones, db.meta];

/**
 * Optional expected output amounts of a block (T-141, T-150): absent when none (field added in
 * data schema version 6, T-025); 0 is a stored amount, distinct from no entry (T-163).
 */
function withExpected(data: Record<string, unknown>, expected: readonly ExpectedOutput[] | undefined): Record<string, unknown> {
  if (expected === undefined) return data;
  const next = { ...data };
  if (expected.length === 0) delete next.expectedOutputs;
  else next.expectedOutputs = expected.map((e) => ({ definitionId: e.definitionId, amount: e.amount }));
  return next;
}

/** Instants of the entered time in `zone`: a daylight-saving gap is refused, never shifted (T-030). */
export function blockInstants(input: BlockTimeInput, zone: string): { startsAt: string; endsAt: string; localDate: string } {
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > BLOCK_MAX_MINUTES) {
    throw new PlanningError("INVALID_DURATION", `duration must be 1–${BLOCK_MAX_MINUTES} whole minutes`);
  }
  const start = resolveWallTime(input.date, input.startTime, zone);
  if (start.kind === "gap") throw new PlanningError("DST_GAP", `${input.date} ${input.startTime} does not exist in ${zone}`);
  const endsAt = new Date(Date.parse(start.instant) + input.durationMinutes * MINUTE_MS).toISOString();
  return { startsAt: start.instant, endsAt, localDate: localDateOf(start.instant, zone) };
}

/** Current names of the task's task, project, and workstream (T-036). Read inside the caller's transaction. */
async function snapshotOf(db: LocalDb, taskId: string): Promise<CalendarBlockData["snapshot"]> {
  const task = (await db.records.get([TASK_DEFINITIONS, taskId]))?.data as TaskDefinitionData | undefined;
  if (!task) throw new PlanningError("NOT_FOUND", `task ${taskId} is not on this device`);
  const project = task.projectId ? ((await db.records.get([PROJECTS, task.projectId]))?.data as ProjectData | undefined) : undefined;
  const workstream = task.workstreamId ? ((await db.records.get([WORKSTREAMS, task.workstreamId]))?.data as WorkstreamData | undefined) : undefined;
  return {
    taskTitle: task.title,
    projectId: project ? task.projectId : null,
    projectName: project?.name ?? null,
    workstreamId: project && workstream ? task.workstreamId : null,
    workstreamName: project && workstream ? workstream.name : null,
  };
}

/**
 * Creates a planned block for an existing task, at the time the user entered. `occurrenceDate`
 * links it to a recurring occurrence ("Schedule" on an unscheduled item); the block may lie on
 * another date, and one occurrence may have several blocks (T-033, D-023).
 */
export async function createBlock(
  db: LocalDb,
  input: BlockTimeInput & { taskId: string; occurrenceDate?: string | null; expectedOutputs?: ExpectedOutput[] },
  registry: Registry = PRODUCT_REGISTRY,
): Promise<string> {
  return db.transaction("rw", planningTables(db), async () => {
    const zone = await requireZone(db);
    const id = crypto.randomUUID();
    const data: CalendarBlockData = {
      taskId: input.taskId,
      ...blockInstants(input, zone),
      timeZone: zone,
      occurrenceDate: input.occurrenceDate ?? null,
      status: "planned",
      snapshot: await snapshotOf(db, input.taskId),
    };
    await putRecord(db, registry, CALENDAR_BLOCKS, id, withExpected(data, input.expectedOutputs));
    return id;
  });
}

/** Quick add (T-032): a new inbox task and its planned block, in ONE transaction. */
export async function quickAddBlock(
  db: LocalDb,
  input: BlockTimeInput & { title: string; expectedOutputs?: ExpectedOutput[] },
  registry: Registry = PRODUCT_REGISTRY,
): Promise<{ taskId: string; blockId: string }> {
  return db.transaction("rw", planningTables(db), async () => {
    const zone = await requireZone(db);
    blockInstants(input, zone); // refuse a bad time before the task is created
    const taskId = await createTask(db, { title: input.title }, registry);
    const blockId = await createBlock(db, { ...input, taskId }, registry);
    return { taskId, blockId };
  });
}

async function currentBlock(db: LocalDb, id: string): Promise<CalendarBlockData> {
  const row = await db.records.get([CALENDAR_BLOCKS, id]);
  if (!row) throw new PlanningError("NOT_FOUND", `block ${id} is not on this device`);
  return row.data as CalendarBlockData;
}

/**
 * Moves or resizes a block (an edit of the block itself): new instants from the entered wall time
 * in the configured zone, which becomes its planning zone, and a refreshed snapshot (T-036). Its
 * task, occurrence link, and status never change here.
 */
export async function updateBlock(
  db: LocalDb,
  id: string,
  input: BlockTimeInput & { expectedOutputs?: ExpectedOutput[] },
  registry: Registry = PRODUCT_REGISTRY,
): Promise<void> {
  await db.transaction("rw", planningTables(db), async () => {
    const zone = await requireZone(db);
    const current = await currentBlock(db, id);
    const next = {
      ...current,
      ...blockInstants(input, zone),
      timeZone: zone,
      snapshot: await snapshotOf(db, current.taskId),
    };
    await putRecord(db, registry, CALENDAR_BLOCKS, id, withExpected(next, input.expectedOutputs));
  });
}

/** The times a drag changes, kept so Undo can write them back (T-090). */
export type BlockTimes = Pick<CalendarBlockData, "startsAt" | "endsAt" | "timeZone" | "localDate">;

const timesOf = (b: CalendarBlockData): BlockTimes => ({ startsAt: b.startsAt, endsAt: b.endsAt, timeZone: b.timeZone, localDate: b.localDate });

/**
 * Moves or resizes a block by drag on the time grid (T-067, T-089): an edit of the block with the
 * EXACT instants the grid resolved (planning/grid.ts: snapped wall time; a gap refused; an
 * ambiguous time on the earlier instant, T-030), so an edge that was not dragged keeps its instant.
 * As with `updateBlock`, the configured zone becomes its planning zone and the snapshot is
 * refreshed; task and occurrence link are kept; a cancelled block is refused. Returns the times
 * before and after, the version before the drag, and the version it wrote (which guards Undo;
 * null when nothing changed).
 */
export async function dragBlockTimes(
  db: LocalDb,
  id: string,
  instants: Pick<CalendarBlockData, "startsAt" | "endsAt">,
  registry: Registry = PRODUCT_REGISTRY,
): Promise<{ previous: BlockTimes; after: BlockTimes; previousVersion: VersionVector; version: VersionVector | null }> {
  return db.transaction("rw", planningTables(db), async () => {
    const zone = await requireZone(db);
    const before = await db.records.get([CALENDAR_BLOCKS, id]);
    if (!before) throw new PlanningError("NOT_FOUND", `block ${id} is not on this device`);
    const current = before.data as CalendarBlockData;
    if (current.status === "cancelled") throw new PlanningError("CANCELLED", "a cancelled block cannot be dragged");
    const minutes = (Date.parse(instants.endsAt) - Date.parse(instants.startsAt)) / MINUTE_MS;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > BLOCK_MAX_MINUTES) {
      throw new PlanningError("INVALID_DURATION", `duration must be 1–${BLOCK_MAX_MINUTES} whole minutes`);
    }
    const row = await putRecord(db, registry, CALENDAR_BLOCKS, id, {
      ...current,
      startsAt: instants.startsAt,
      endsAt: instants.endsAt,
      timeZone: zone,
      localDate: localDateOf(instants.startsAt, zone),
      snapshot: await snapshotOf(db, current.taskId),
    });
    return {
      previous: timesOf(current),
      after: timesOf(row.data as CalendarBlockData),
      previousVersion: before.version,
      version: row.contentHash === before.contentHash ? null : row.version,
    };
  });
}

/**
 * Undo of a drag (T-090): an ordinary edit that writes the previous instants, zone, and local date
 * back as a NEW version (history moves forward; nothing is erased) and refreshes the snapshot like
 * any edit of the block (T-036). Refused when the block changed after the drag (its version is no
 * longer the one the drag wrote) or was cancelled meanwhile.
 */
export async function undoBlockTimes(
  db: LocalDb,
  id: string,
  previous: BlockTimes,
  expectedVersion: VersionVector,
  registry: Registry = PRODUCT_REGISTRY,
): Promise<void> {
  await db.transaction("rw", planningTables(db), async () => {
    const row = await db.records.get([CALENDAR_BLOCKS, id]);
    if (!row) throw new PlanningError("NOT_FOUND", `block ${id} is not on this device`);
    if (canonicalize(row.version) !== canonicalize(expectedVersion)) throw new PlanningError("CHANGED", "the block changed after the drag");
    const current = row.data as CalendarBlockData;
    if (current.status === "cancelled") throw new PlanningError("CANCELLED", "the block was cancelled after the drag");
    await putRecord(db, registry, CALENDAR_BLOCKS, id, { ...current, ...previous, snapshot: await snapshotOf(db, current.taskId) });
  });
}

/**
 * Cancels or restores a block (T-027: ordinary edits of the block). Its instants, task, and
 * occurrence link never change; as with any edit of the block, its planning zone becomes the
 * configured one (local date recomputed from the same instant) and its snapshot is refreshed
 * (T-030, T-036). Needs the task on this device (live link). The occurrence stays scheduled while
 * another planned block for it remains (D-023).
 */
export async function setBlockCancelled(db: LocalDb, id: string, cancelled: boolean, registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", planningTables(db), async () => {
    const zone = await requireZone(db);
    const current = await currentBlock(db, id);
    const status = cancelled ? "cancelled" : "planned";
    if (current.status === status) return;
    await putRecord(db, registry, CALENDAR_BLOCKS, id, {
      ...current,
      status,
      timeZone: zone,
      localDate: localDateOf(current.startsAt, zone),
      snapshot: await snapshotOf(db, current.taskId),
    });
  });
}

/**
 * Sets or removes a task's weekly recurrence (T-029). Removing deletes the field (never `null`,
 * T-025). Existing blocks are never touched.
 */
export async function setRecurrence(db: LocalDb, taskId: string, recurrence: Recurrence | null, registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await updateTask(db, taskId, { recurrence }, registry);
}

export interface PlanningData {
  blocks: { id: string; data: CalendarBlockData; version: VersionVector }[];
}

/** Every block on this device (live records; cancelled ones included), with its stored version. */
export async function loadBlocks(db: LocalDb): Promise<PlanningData["blocks"]> {
  const rows: RecordRow[] = await db.records.where("type").equals(CALENDAR_BLOCKS).toArray();
  return rows.map((row) => ({ id: row.id, data: row.data as CalendarBlockData, version: row.version }));
}
