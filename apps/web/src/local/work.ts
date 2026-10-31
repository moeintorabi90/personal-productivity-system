/**
 * Stage 5 — actual work sessions and outputs (docs/ROADMAP.md; PRODUCT_SPEC "Actual work and
 * outputs"; DECISIONS T-091 to T-169). Sessions, output definitions, output records, corrections,
 * and task completions are ordinary product records, exported, merged, and resolved by the backup
 * code like any other type (BACKUP_FORMAT "Data schema version 6").
 *
 * Every write is an explicit user action. Nothing here ends, pauses, completes, or deletes on its
 * own, except removing items whose 30 days in the trash have passed (T-142, T-153). Sessions never
 * create or change planned blocks (principle 1). The Stage 6 planned-versus-actual comparison and
 * drag corrections are not here (T-145).
 */
import { nowIso } from "../backup/envelope.ts";
import {
  CALENDAR_BLOCKS,
  type CalendarBlockData,
  CORRECTIONS,
  type CorrectionData,
  type CorrectionField,
  type ExpectedOutput,
  type GoalData,
  GOALS,
  NAME_MAX,
  OUTPUT_DEFINITIONS,
  OUTPUT_RECORDS,
  OUTPUT_VALUE_MAX,
  type OutputDefinitionData,
  type OutputRecordData,
  PRODUCT_REGISTRY,
  PROJECTS,
  type ProjectData,
  RATING_MAX,
  RATING_MIN,
  REASON_MAX,
  type Registry,
  type SessionData,
  SESSIONS,
  TASK_COMPLETIONS,
  TASK_DEFINITIONS,
  type TaskCompletionData,
  type TaskDefinitionData,
  UNIT_MAX,
  WORKSTREAMS,
  type WorkstreamData,
} from "../backup/registry.ts";
import { MINUTE_MS, localDateOf, resolveWallTime } from "../planning/time.ts";
import { recursOn } from "../planning/planning.ts";
import { completionId, occurrenceHasHappened } from "../work/completions.ts";
import {
  LONG_PAUSE_MINUTES,
  minuteOf,
  type Pause,
  SESSION_MAX_WORK_MINUTES,
  sessionsOverlap,
  sessionState,
  type SessionTimes,
  sessionTimesProblem,
  withImportedPause,
  workMs,
} from "../work/session-time.ts";
import { matchUnits } from "../work/units.ts";
import type { LocalDb, RecordRow, VersionEntry } from "./db.ts";
import type { Item } from "./organization.ts";
import { getSharedPreferences } from "./settings.ts";
import { deleteRecord, deviceIdentity, putRecord } from "./records.ts";

export type Session = Item<SessionData>;
export type OutputDefinition = Item<OutputDefinitionData>;
export type OutputRecord = Item<OutputRecordData>;
export type Correction = Item<CorrectionData>;
export type TaskCompletion = Item<TaskCompletionData>;

/** Days a deleted session or output stays recoverable (T-114, T-142, T-153). */
export const TRASH_DAYS = 30;
const TRASH_MS = TRASH_DAYS * 24 * 60 * MINUTE_MS;
/** Device-local marks of running sessions received by import: id → backup creation time (T-152). */
export const IMPORTED_PAUSED_KEY = "importedPausedSessions";

export interface WorkData {
  sessions: Session[];
  definitions: OutputDefinition[];
  outputs: OutputRecord[];
  corrections: Correction[];
  completions: TaskCompletion[];
  /** Sessions this device treats as paused since a backup's creation time (T-144, T-152). */
  importedPaused: Record<string, string>;
}

/** A Stage 5 write that was refused; nothing was changed. */
export type WorkErrorCode =
  | "NO_TIME_ZONE"
  | "NOT_FOUND"
  /** Another session is open on this device (T-092, T-117). */
  | "SESSION_OPEN"
  /** Two open sessions after an import: end or delete one first (T-144, T-152). */
  | "TWO_OPEN_SESSIONS"
  | "NOT_OPEN"
  | "NOT_RUNNING"
  | "NOT_PAUSED"
  | "NOT_ENDED"
  | "DST_GAP"
  | "INVALID_TIME"
  /** A finished session cannot be in the future (T-096). */
  | "FUTURE"
  /** More than 24 hours of work time (T-136, T-158). */
  | "TOO_LONG"
  | "BLOCK_OTHER_TASK"
  | "BLOCK_CANCELLED"
  /** The goal is not one the user may choose here (T-129, T-130, T-137). */
  | "GOAL_NOT_ALLOWED"
  | "DEFINITION_ARCHIVED"
  | "INVALID_VALUE"
  | "INVALID_RATING"
  | "DELETED"
  | "SESSION_DELETED"
  | "NOT_DELETED"
  | "TRASH_EXPIRED"
  | "NOT_AN_OCCURRENCE"
  /** A future occurrence cannot be completed before it happens (T-133, T-155). */
  | "FUTURE_OCCURRENCE"
  | "ALREADY_COMPLETED"
  | "NOT_COMPLETED"
  /** A different unit needs a new output definition (T-165, T-167). */
  | "DIFFERENT_UNIT"
  /** Legacy-goal migration: a recognized mismatch (T-166). */
  | "UNIT_MISMATCH"
  /** Legacy-goal migration: an unrecognized pair needs the owner's explicit yes (T-169). */
  | "NEEDS_CONFIRMATION"
  | "NOT_OUTPUT_GOAL"
  | "ALREADY_LINKED"
  | "ARCHIVED";

export class WorkError extends Error {
  readonly code: WorkErrorCode;
  constructor(code: WorkErrorCode, message: string) {
    super(message);
    this.name = "WorkError";
    this.code = code;
  }
}

const tables = (db: LocalDb) => [db.records, db.tombstones, db.meta];

function itemOf<T>(row: RecordRow): Item<T> {
  return { id: row.id, data: row.data as T, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

async function rowsOf<T>(db: LocalDb, type: string): Promise<Item<T>[]> {
  return (await db.records.where("type").equals(type).toArray()).map((row) => itemOf<T>(row));
}

async function importedPaused(db: LocalDb): Promise<Record<string, string>> {
  return ((await db.meta.get(IMPORTED_PAUSED_KEY))?.value as Record<string, string> | undefined) ?? {};
}

async function setImportedPaused(db: LocalDb, value: Record<string, string>): Promise<void> {
  await db.meta.put({ key: IMPORTED_PAUSED_KEY, value });
}

/** Everything Stage 5 shows, read in one transaction (live records only). */
export async function loadWork(db: LocalDb): Promise<WorkData> {
  return db.transaction("r", [db.records, db.meta], async () => {
    const [sessions, definitions, outputs, corrections, completions] = await Promise.all([
      rowsOf<SessionData>(db, SESSIONS),
      rowsOf<OutputDefinitionData>(db, OUTPUT_DEFINITIONS),
      rowsOf<OutputRecordData>(db, OUTPUT_RECORDS),
      rowsOf<CorrectionData>(db, CORRECTIONS),
      rowsOf<TaskCompletionData>(db, TASK_COMPLETIONS),
    ]);
    return { sessions, definitions, outputs, corrections, completions, importedPaused: await importedPaused(db) };
  });
}

/* ---------- shared checks ---------- */

async function requireZone(db: LocalDb): Promise<string> {
  const zone = (await getSharedPreferences(db)).timeZone;
  if (!zone) throw new WorkError("NO_TIME_ZONE", "set a time zone first (sessions use it like planning, T-028)");
  return zone;
}

async function get<T>(db: LocalDb, type: string, id: string): Promise<T> {
  const row = await db.records.get([type, id]);
  if (!row) throw new WorkError("NOT_FOUND", `${type}/${id} is not on this device`);
  return row.data as T;
}

/** Open sessions on this device (not in the trash): running or paused (T-117). */
export function openSessions<T extends { data: SessionData }>(sessions: readonly T[]): T[] {
  return sessions.filter((s) => s.data.deletedAt === null && s.data.endedAt === null);
}

async function openSessionIds(db: LocalDb): Promise<string[]> {
  return openSessions(await rowsOf<SessionData>(db, SESSIONS)).map((s) => s.id);
}

/** Names at recording time (principle 2, T-036 pattern); null without a task. */
async function snapshotOf(db: LocalDb, taskId: string | null): Promise<SessionData["snapshot"]> {
  if (taskId === null) return null;
  const task = await get<TaskDefinitionData>(db, TASK_DEFINITIONS, taskId);
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
 * Time goals the user may choose for a session (T-100, T-122, T-129): the task's linked time goals
 * when it has any (or "none"); otherwise any time goal (manual attribution), including paused,
 * completed, or archived ones (T-101).
 */
export function allowedTimeGoals(taskId: string | null, tasks: ReadonlyMap<string, TaskDefinitionData>, goals: readonly { id: string; data: GoalData }[]): string[] {
  const linked = new Set(taskId ? (tasks.get(taskId)?.goalIds ?? []) : []);
  const time = goals.filter((g) => g.data.kind === "time");
  const linkedTime = time.filter((g) => linked.has(g.id));
  return (linkedTime.length > 0 ? linkedTime : time).map((g) => g.id);
}

/** Task-count goals the user may choose at completion (T-123, T-130): linked ones, else any (no link is added). */
export function allowedTaskCountGoals(taskId: string, tasks: ReadonlyMap<string, TaskDefinitionData>, goals: readonly { id: string; data: GoalData }[]): string[] {
  const linked = new Set(tasks.get(taskId)?.goalIds ?? []);
  const count = goals.filter((g) => g.data.kind === "taskCount");
  const linkedCount = count.filter((g) => linked.has(g.id));
  return (linkedCount.length > 0 ? linkedCount : count).map((g) => g.id);
}

/** Output goals an output of `definitionId` may be attributed to (T-049, T-105, T-137): those tracking that definition. */
export function allowedOutputGoals(definitionId: string, goals: readonly { id: string; data: GoalData }[]): string[] {
  return goals.filter((g) => g.data.kind === "output" && g.data.definitionId === definitionId).map((g) => g.id);
}

async function goalsAndTasks(db: LocalDb) {
  const goals = await rowsOf<GoalData>(db, GOALS);
  const tasks = new Map((await rowsOf<TaskDefinitionData>(db, TASK_DEFINITIONS)).map((t) => [t.id, t.data]));
  return { goals, tasks };
}

async function checkTimeGoal(db: LocalDb, taskId: string | null, goalId: string | null): Promise<void> {
  if (goalId === null) return;
  const { goals, tasks } = await goalsAndTasks(db);
  if (!allowedTimeGoals(taskId, tasks, goals).includes(goalId)) throw new WorkError("GOAL_NOT_ALLOWED", "not a time goal this session may count toward");
}

async function checkOutputGoals(db: LocalDb, definitionId: string, goalIds: readonly string[]): Promise<void> {
  if (goalIds.length === 0) return;
  const allowed = allowedOutputGoals(definitionId, await rowsOf<GoalData>(db, GOALS));
  if (new Set(goalIds).size !== goalIds.length || goalIds.some((id) => !allowed.includes(id))) {
    throw new WorkError("GOAL_NOT_ALLOWED", "an output counts only toward output goals of its own definition");
  }
}

function checkValue(value: number, allowZero = true): void {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > OUTPUT_VALUE_MAX) throw new WorkError("INVALID_VALUE", "whole number expected");
}

function checkRating(value: number | null | undefined): void {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < RATING_MIN || value > RATING_MAX) throw new WorkError("INVALID_RATING", "rating 1–5");
}

async function liveDefinition(db: LocalDb, definitionId: string, forNewEntry: boolean): Promise<OutputDefinitionData> {
  const def = await get<OutputDefinitionData>(db, OUTPUT_DEFINITIONS, definitionId);
  if (forNewEntry && def.archivedAt !== null) throw new WorkError("DEFINITION_ARCHIVED", "archived definitions are not offered for new entries (T-107)");
  return def;
}

async function checkExpected(db: LocalDb, expected: readonly ExpectedOutput[]): Promise<ExpectedOutput[]> {
  const seen = new Set<string>();
  for (const e of expected) {
    if (seen.has(e.definitionId)) throw new WorkError("INVALID_VALUE", "one expected amount per definition");
    seen.add(e.definitionId);
    checkValue(e.amount);
    await liveDefinition(db, e.definitionId, true);
  }
  return expected.map((e) => ({ definitionId: e.definitionId, amount: e.amount }));
}

function checkTimes(times: SessionTimes, now: number): void {
  if (times.endedAt !== null && Date.parse(times.endedAt) > now) throw new WorkError("FUTURE", "a finished session cannot be in the future");
  if (times.endedAt !== null && workMs(times) > SESSION_MAX_WORK_MINUTES * MINUTE_MS) throw new WorkError("TOO_LONG", "at most 24 hours of work time");
  const problem = sessionTimesProblem(times);
  if (problem) throw new WorkError("INVALID_TIME", problem);
}

async function appendCorrection(
  db: LocalDb,
  registry: Registry,
  input: { sessionId: string; outputId: string | null; field: CorrectionField; before: unknown; after: unknown; reason?: string | null },
): Promise<void> {
  const reason = input.reason?.trim() ? input.reason.trim().slice(0, REASON_MAX) : null;
  const device = await deviceIdentity(db);
  const data: CorrectionData = {
    sessionId: input.sessionId,
    outputId: input.outputId,
    field: input.field,
    before: (input.before ?? null) as CorrectionData["before"],
    after: (input.after ?? null) as CorrectionData["after"],
    reason,
    device: device.id,
    at: nowIso(),
  };
  await putRecord(db, registry, CORRECTIONS, crypto.randomUUID(), data);
}

/* ---------- sessions ---------- */

export interface OutputInput {
  definitionId: string;
  value: number;
  goalIds?: string[];
}

/**
 * Starts a session now (T-091, T-092, T-095): with or without a task, or from a planned block of
 * the same task, which links it and copies the block's expected amounts (T-094, T-141). Refused
 * while another session is open on this device, also a paused one (T-117).
 */
export async function startSession(
  db: LocalDb,
  input: { taskId?: string | null; blockId?: string | null; expectedOutputs?: ExpectedOutput[] } = {},
  now: number = Date.now(),
  registry: Registry = PRODUCT_REGISTRY,
): Promise<string> {
  return db.transaction("rw", tables(db), async () => {
    const zone = await requireZone(db);
    if ((await openSessionIds(db)).length > 0) throw new WorkError("SESSION_OPEN", "end the open session first");
    let taskId = input.taskId ?? null;
    let expected = input.expectedOutputs;
    if (input.blockId) {
      const block = await get<CalendarBlockData>(db, CALENDAR_BLOCKS, input.blockId);
      if (block.status !== "planned") throw new WorkError("BLOCK_CANCELLED", "a cancelled block cannot start a session");
      if (taskId !== null && taskId !== block.taskId) throw new WorkError("BLOCK_OTHER_TASK", "the block is for another task");
      taskId = block.taskId;
      if (expected === undefined) {
        // A copy of the block's expected amounts (T-141, T-150), for definitions still offered (T-128).
        expected = [];
        for (const e of block.expectedOutputs ?? []) {
          const def = (await db.records.get([OUTPUT_DEFINITIONS, e.definitionId]))?.data as OutputDefinitionData | undefined;
          if (def && def.archivedAt === null) expected.push({ ...e });
        }
      }
    }
    const device = await deviceIdentity(db);
    const startedAt = minuteOf(now);
    const id = crypto.randomUUID();
    const data: SessionData = {
      taskId,
      blockId: input.blockId ?? null,
      startedAt,
      endedAt: null,
      pauses: [],
      timeZone: zone,
      localDate: localDateOf(startedAt, zone),
      goalId: null,
      expectedOutputs: await checkExpected(db, expected ?? []),
      snapshot: await snapshotOf(db, taskId),
      startedOnDevice: device.id,
      notes: "",
      energy: null,
      focus: null,
      deletedAt: null,
    };
    await putRecord(db, registry, SESSIONS, id, data);
    return id;
  });
}

async function openSession(db: LocalDb, id: string): Promise<SessionData> {
  const s = await get<SessionData>(db, SESSIONS, id);
  if (s.deletedAt !== null) throw new WorkError("DELETED", "the session is in the trash");
  if (s.endedAt !== null) throw new WorkError("NOT_OPEN", "the session has ended");
  return s;
}

/** Pauses a running session; paused time is not work time (T-092). */
export async function pauseSession(db: LocalDb, id: string, now: number = Date.now(), registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", tables(db), async () => {
    const s = await openSession(db, id);
    const marks = await importedPaused(db);
    if (sessionState(s, marks[id]).kind !== "running") throw new WorkError("NOT_RUNNING", "the session is not running");
    const at = minuteOf(Math.max(now, Date.parse(s.pauses.at(-1)?.end ?? s.startedAt)));
    await putRecord(db, registry, SESSIONS, id, { ...s, pauses: [...s.pauses, { start: at, end: null }] });
  });
}

/**
 * Resumes a paused session. A session received by import while running elsewhere is paused here
 * from the backup's creation time; resuming writes that pause (T-152). Refused while this device
 * holds two open sessions (T-144).
 */
export async function resumeSession(db: LocalDb, id: string, now: number = Date.now(), registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", tables(db), async () => {
    const s = await openSession(db, id);
    if ((await openSessionIds(db)).length > 1) throw new WorkError("TWO_OPEN_SESSIONS", "end or delete one of the open sessions first");
    const marks = await importedPaused(db);
    const state = sessionState(s, marks[id]);
    if (state.kind !== "paused") throw new WorkError("NOT_PAUSED", "the session is not paused");
    const at = minuteOf(Math.max(now, state.since));
    const pauses: Pause[] = state.imported ? withImportedPause(s, marks[id]!, at) : s.pauses.map((p, i) => (i === s.pauses.length - 1 ? { start: p.start, end: at } : p));
    await putRecord(db, registry, SESSIONS, id, { ...s, pauses });
    if (state.imported) {
      const { [id]: _done, ...rest } = marks;
      await setImportedPaused(db, rest);
    }
  });
}

export interface EndInput {
  /** Defaults to now. For a forgotten session the user enters it (T-093). */
  endedAt?: string;
  goalId?: string | null;
  outputs?: OutputInput[];
  expectedOutputs?: ExpectedOutput[];
  notes?: string;
  energy?: number | null;
  focus?: number | null;
}

async function writeOutputs(db: LocalDb, registry: Registry, sessionId: string, outputs: readonly OutputInput[]): Promise<string[]> {
  const ids: string[] = [];
  for (const o of outputs) {
    checkValue(o.value);
    const def = await liveDefinition(db, o.definitionId, true);
    const goalIds = [...(o.goalIds ?? [])];
    await checkOutputGoals(db, o.definitionId, goalIds);
    const id = crypto.randomUUID();
    const data: OutputRecordData = { sessionId, definitionId: o.definitionId, revision: def.revisions.length - 1, value: o.value, goalIds, deletedAt: null };
    await putRecord(db, registry, OUTPUT_RECORDS, id, data);
    ids.push(id);
  }
  return ids;
}

/**
 * Ends an open session (T-098): no status label; outputs (none, several, or 0 values, T-104,
 * T-159), the time goal it counts toward (a linked one, a manual one, or none, T-129), expected
 * amounts, a note and 1–5 energy/focus ratings (T-140). Paused time stays excluded. The end may
 * not lie in the future and work time is at most 24 hours (T-096, T-136, T-158). Ending does not
 * complete the task (T-091). These are choices while recording, not corrections.
 */
export async function endSession(db: LocalDb, id: string, input: EndInput = {}, now: number = Date.now(), registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", tables(db), async () => {
    const s = await openSession(db, id);
    const marks = await importedPaused(db);
    const state = sessionState(s, marks[id]);
    const endedAt = minuteOf(Date.parse(input.endedAt ?? new Date(now).toISOString()));
    if (Date.parse(endedAt) > now) throw new WorkError("FUTURE", "a finished session cannot be in the future");
    const last = s.pauses.at(-1);
    // The last moment the stored record shows: an open pause's start, else the last resume, else the start.
    const lastActivity = Date.parse(last && last.end === null ? last.start : (last?.end ?? s.startedAt));
    if (Date.parse(endedAt) < lastActivity) throw new WorkError("INVALID_TIME", "the end cannot be before the session's last activity");
    let pauses = s.pauses;
    if (state.kind === "paused" && !state.imported) {
      pauses = s.pauses.map((p, i) => (i === s.pauses.length - 1 ? { start: p.start, end: endedAt } : p));
    } else if (state.kind === "paused" && state.imported && Date.parse(endedAt) > state.since) {
      // Paused here since the backup was made (T-152): the time after it is not work time.
      pauses = withImportedPause(s, marks[id]!, endedAt);
    }
    const ended: SessionData = { ...s, endedAt, pauses };
    checkTimes(ended, now);
    checkRating(input.energy);
    checkRating(input.focus);
    const goalId = input.goalId ?? null;
    await checkTimeGoal(db, s.taskId, goalId);
    await putRecord(db, registry, SESSIONS, id, {
      ...ended,
      goalId,
      expectedOutputs: input.expectedOutputs ? await checkExpected(db, input.expectedOutputs) : s.expectedOutputs,
      notes: (input.notes ?? s.notes).trim(),
      energy: input.energy !== undefined ? input.energy : s.energy,
      focus: input.focus !== undefined ? input.focus : s.focus,
    });
    await writeOutputs(db, registry, id, input.outputs ?? []);
    if (marks[id]) {
      const { [id]: _done, ...rest } = marks;
      await setImportedPaused(db, rest);
    }
  });
}

export interface PastSessionInput {
  /** Local date and wall time of the start in the configured zone, and the duration (T-096). */
  date: string;
  startTime: string;
  durationMinutes: number;
  taskId?: string | null;
  goalId?: string | null;
  outputs?: OutputInput[];
  expectedOutputs?: ExpectedOutput[];
  notes?: string;
  energy?: number | null;
  focus?: number | null;
}

/** Start and end instants of a past entry: a daylight-saving gap is refused; an ambiguous time takes the earlier instant (T-030). */
export function pastSessionTimes(input: Pick<PastSessionInput, "date" | "startTime" | "durationMinutes">, zone: string): SessionTimes {
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1) throw new WorkError("INVALID_TIME", "duration in whole minutes");
  if (input.durationMinutes > SESSION_MAX_WORK_MINUTES) throw new WorkError("TOO_LONG", "at most 24 hours of work time");
  const start = resolveWallTime(input.date, input.startTime, zone);
  if (start.kind === "gap") throw new WorkError("DST_GAP", `${input.date} ${input.startTime} does not exist in ${zone}`);
  const endedAt = new Date(Date.parse(start.instant) + input.durationMinutes * MINUTE_MS).toISOString();
  return { startedAt: start.instant, endedAt, pauses: [] };
}

/**
 * Sessions whose work time overlaps the given times (T-097): a warning before saving, never a
 * refusal. Sessions in the trash are ignored.
 */
export function overlappingSessions(sessions: readonly Session[], times: SessionTimes, excludeId?: string, now: number = Date.now()): Session[] {
  return sessions.filter((s) => s.id !== excludeId && s.data.deletedAt === null && sessionsOverlap(s.data, times, now));
}

/** Records a finished past session from start plus duration (T-096): any past date, never in the future. Overlaps are allowed (T-097). */
export async function recordPastSession(db: LocalDb, input: PastSessionInput, now: number = Date.now(), registry: Registry = PRODUCT_REGISTRY): Promise<string> {
  return db.transaction("rw", tables(db), async () => {
    const zone = await requireZone(db);
    const times = pastSessionTimes(input, zone);
    checkTimes(times, now);
    checkRating(input.energy);
    checkRating(input.focus);
    const taskId = input.taskId ?? null;
    const goalId = input.goalId ?? null;
    await checkTimeGoal(db, taskId, goalId);
    const device = await deviceIdentity(db);
    const id = crypto.randomUUID();
    const data: SessionData = {
      taskId,
      blockId: null,
      ...times,
      timeZone: zone,
      localDate: localDateOf(times.startedAt, zone),
      goalId,
      expectedOutputs: await checkExpected(db, input.expectedOutputs ?? []),
      snapshot: await snapshotOf(db, taskId),
      startedOnDevice: device.id,
      notes: (input.notes ?? "").trim(),
      energy: input.energy ?? null,
      focus: input.focus ?? null,
      deletedAt: null,
    };
    await putRecord(db, registry, SESSIONS, id, data);
    await writeOutputs(db, registry, id, input.outputs ?? []);
    return id;
  });
}

/**
 * Edits that keep NO history (T-157): note, ratings, expected amounts, task association, and
 * planned-block association. Changing the task refreshes the names snapshot; a linked block of
 * another task is unlinked in the same save. A block may be linked later only if it is of the
 * session's task (T-135); linking never changes the session's times.
 */
export async function updateSessionDetails(
  db: LocalDb,
  id: string,
  patch: { notes?: string; energy?: number | null; focus?: number | null; expectedOutputs?: ExpectedOutput[]; taskId?: string | null; blockId?: string | null },
  registry: Registry = PRODUCT_REGISTRY,
): Promise<void> {
  await db.transaction("rw", tables(db), async () => {
    const s = await get<SessionData>(db, SESSIONS, id);
    if (s.deletedAt !== null) throw new WorkError("DELETED", "restore the session first");
    checkRating(patch.energy);
    checkRating(patch.focus);
    const next: SessionData = { ...s };
    if (patch.notes !== undefined) next.notes = patch.notes.trim();
    if (patch.energy !== undefined) next.energy = patch.energy;
    if (patch.focus !== undefined) next.focus = patch.focus;
    if (patch.expectedOutputs !== undefined) next.expectedOutputs = await checkExpected(db, patch.expectedOutputs);
    if (patch.taskId !== undefined && patch.taskId !== s.taskId) {
      next.taskId = patch.taskId;
      next.snapshot = await snapshotOf(db, patch.taskId);
      if (next.blockId !== null) next.blockId = null;
      if (next.goalId !== null) {
        // The time goal stays only if it is still allowed for the new task.
        const { goals, tasks } = await goalsAndTasks(db);
        if (!allowedTimeGoals(next.taskId, tasks, goals).includes(next.goalId)) next.goalId = null;
      }
    }
    if (patch.blockId !== undefined) {
      if (patch.blockId === null) next.blockId = null;
      else {
        const block = await get<CalendarBlockData>(db, CALENDAR_BLOCKS, patch.blockId);
        if (next.taskId === null || block.taskId !== next.taskId) throw new WorkError("BLOCK_OTHER_TASK", "only a block of the same task (T-094, T-135)");
        if (block.status !== "planned") throw new WorkError("BLOCK_CANCELLED", "a cancelled block cannot be linked");
        next.blockId = patch.blockId;
      }
    }
    await putRecord(db, registry, SESSIONS, id, next);
  });
}

/**
 * Corrects the times of an ENDED session (T-102): start and end as instants; pauses are kept and
 * must still fit. The old and new times are kept in the correction history with an optional
 * reason. Not in the future; at most 24 hours of work time.
 */
export async function correctSessionTimes(
  db: LocalDb,
  id: string,
  times: { startedAt: string; endedAt: string },
  reason: string | null = null,
  now: number = Date.now(),
  registry: Registry = PRODUCT_REGISTRY,
): Promise<void> {
  await db.transaction("rw", tables(db), async () => {
    const s = await get<SessionData>(db, SESSIONS, id);
    if (s.deletedAt !== null) throw new WorkError("DELETED", "restore the session first");
    if (s.endedAt === null) throw new WorkError("NOT_ENDED", "end the session first");
    const startedAt = minuteOf(Date.parse(times.startedAt));
    const endedAt = minuteOf(Date.parse(times.endedAt));
    if (startedAt === s.startedAt && endedAt === s.endedAt) return;
    const next: SessionData = { ...s, startedAt, endedAt, localDate: localDateOf(startedAt, s.timeZone) };
    checkTimes(next, now);
    await putRecord(db, registry, SESSIONS, id, next);
    await appendCorrection(db, registry, {
      sessionId: id,
      outputId: null,
      field: "times",
      before: { startedAt: s.startedAt, endedAt: s.endedAt, pauses: s.pauses },
      after: { startedAt, endedAt, pauses: s.pauses },
      reason,
    });
  });
}

/**
 * Sets the one time goal a session's work time counts toward (T-129). While the session is open
 * this is the recording choice; after it ended it is a correction with history (T-131).
 */
export async function setSessionGoal(db: LocalDb, id: string, goalId: string | null, reason: string | null = null, registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", tables(db), async () => {
    const s = await get<SessionData>(db, SESSIONS, id);
    if (s.deletedAt !== null) throw new WorkError("DELETED", "restore the session first");
    if (s.goalId === goalId) return;
    await checkTimeGoal(db, s.taskId, goalId);
    await putRecord(db, registry, SESSIONS, id, { ...s, goalId });
    if (s.endedAt !== null) await appendCorrection(db, registry, { sessionId: id, outputId: null, field: "goal", before: s.goalId, after: goalId, reason });
  });
}

/** Moves a session (and with it its outputs) to the trash for 30 days (T-103, T-142). An open session frees the device's slot. */
export async function deleteSession(db: LocalDb, id: string, now: number = Date.now(), registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", tables(db), async () => {
    const s = await get<SessionData>(db, SESSIONS, id);
    if (s.deletedAt !== null) return;
    await putRecord(db, registry, SESSIONS, id, { ...s, deletedAt: new Date(now).toISOString() });
  });
}

/** Restores a session from the trash within 30 days. An open session may not join another open one (T-117). */
export async function restoreSession(db: LocalDb, id: string, now: number = Date.now(), registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", tables(db), async () => {
    const s = await get<SessionData>(db, SESSIONS, id);
    if (s.deletedAt === null) throw new WorkError("NOT_DELETED", "the session is not in the trash");
    if (now - Date.parse(s.deletedAt) > TRASH_MS) throw new WorkError("TRASH_EXPIRED", "more than 30 days in the trash");
    if (s.endedAt === null && (await openSessionIds(db)).length > 0) throw new WorkError("SESSION_OPEN", "end the open session first");
    await putRecord(db, registry, SESSIONS, id, { ...s, deletedAt: null });
  });
}

/* ---------- outputs ---------- */

async function sessionOfOutput(db: LocalDb, output: OutputRecordData): Promise<SessionData> {
  const s = await get<SessionData>(db, SESSIONS, output.sessionId);
  if (s.deletedAt !== null) throw new WorkError("SESSION_DELETED", "restore the session first");
  return s;
}

/**
 * Adds outputs to a session (T-104): only within a session. Added after the session ended, each
 * one is recorded in the correction history ("added").
 */
export async function addOutputs(db: LocalDb, sessionId: string, outputs: OutputInput[], reason: string | null = null, registry: Registry = PRODUCT_REGISTRY): Promise<string[]> {
  return db.transaction("rw", tables(db), async () => {
    const s = await get<SessionData>(db, SESSIONS, sessionId);
    if (s.deletedAt !== null) throw new WorkError("SESSION_DELETED", "restore the session first");
    const ids = await writeOutputs(db, registry, sessionId, outputs);
    if (s.endedAt !== null) {
      for (const [i, outputId] of ids.entries()) {
        await appendCorrection(db, registry, { sessionId, outputId, field: "added", before: null, after: outputs[i]!.value, reason });
      }
    }
    return ids;
  });
}

async function liveOutput(db: LocalDb, id: string): Promise<OutputRecordData> {
  const o = await get<OutputRecordData>(db, OUTPUT_RECORDS, id);
  if (o.deletedAt !== null) throw new WorkError("DELETED", "restore the output first");
  return o;
}

/** Corrects an output's value (T-102): old and new value kept with an optional reason once the session ended. 0 is valid (T-159). */
export async function correctOutputValue(db: LocalDb, id: string, value: number, reason: string | null = null, registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", tables(db), async () => {
    const o = await liveOutput(db, id);
    const s = await sessionOfOutput(db, o);
    checkValue(value);
    if (o.value === value) return;
    await putRecord(db, registry, OUTPUT_RECORDS, id, { ...o, value });
    if (s.endedAt !== null) await appendCorrection(db, registry, { sessionId: o.sessionId, outputId: id, field: "value", before: o.value, after: value, reason });
  });
}

/** Sets the goals an output counts toward (T-049, T-137); after the session ended it is a correction with history (T-131). */
export async function setOutputGoals(db: LocalDb, id: string, goalIds: string[], reason: string | null = null, registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", tables(db), async () => {
    const o = await liveOutput(db, id);
    const s = await sessionOfOutput(db, o);
    await checkOutputGoals(db, o.definitionId, goalIds);
    const before = [...o.goalIds].sort();
    const after = [...goalIds].sort();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    await putRecord(db, registry, OUTPUT_RECORDS, id, { ...o, goalIds: [...goalIds] });
    if (s.endedAt !== null) await appendCorrection(db, registry, { sessionId: o.sessionId, outputId: id, field: "goals", before, after, reason });
  });
}

/** Deletes one output on its own (T-143, T-153): to the trash for 30 days, recorded in history, no longer counted. */
export async function deleteOutput(db: LocalDb, id: string, reason: string | null = null, now: number = Date.now(), registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", tables(db), async () => {
    const o = await get<OutputRecordData>(db, OUTPUT_RECORDS, id);
    if (o.deletedAt !== null) return;
    await sessionOfOutput(db, o);
    await putRecord(db, registry, OUTPUT_RECORDS, id, { ...o, deletedAt: new Date(now).toISOString() });
    await appendCorrection(db, registry, { sessionId: o.sessionId, outputId: id, field: "deleted", before: o.value, after: null, reason });
  });
}

/** Restores a separately deleted output within 30 days (T-153, T-160); its session must not be in the trash. */
export async function restoreOutput(db: LocalDb, id: string, now: number = Date.now(), registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", tables(db), async () => {
    const o = await get<OutputRecordData>(db, OUTPUT_RECORDS, id);
    if (o.deletedAt === null) throw new WorkError("NOT_DELETED", "the output is not in the trash");
    if (now - Date.parse(o.deletedAt) > TRASH_MS) throw new WorkError("TRASH_EXPIRED", "more than 30 days in the trash");
    await sessionOfOutput(db, o);
    await putRecord(db, registry, OUTPUT_RECORDS, id, { ...o, deletedAt: null });
    await appendCorrection(db, registry, { sessionId: o.sessionId, outputId: id, field: "restored", before: null, after: o.value, reason: null });
  });
}

/* ---------- trash ---------- */

async function tombstoneOutputTree(db: LocalDb, outputId: string, corrections: Correction[]): Promise<void> {
  for (const c of corrections) if (c.data.outputId === outputId) await deleteRecord(db, CORRECTIONS, c.id);
  await deleteRecord(db, OUTPUT_RECORDS, outputId);
}

/**
 * Permanently deletes what has been in the trash for more than 30 days — or everything in it
 * when `emptyNow` (the owner empties the trash, T-142). A session goes with its outputs and its
 * corrections; a separately deleted output with its corrections. They become tombstones, which
 * travel in backups and never expire, so an older backup cannot bring them back (T-115, T-160).
 */
export async function purgeTrash(db: LocalDb, options: { emptyNow?: boolean; now?: number } = {}): Promise<number> {
  const now = options.now ?? Date.now();
  const expired = (deletedAt: string | null) => deletedAt !== null && (options.emptyNow || now - Date.parse(deletedAt) > TRASH_MS);
  return db.transaction("rw", tables(db), async () => {
    const work = await loadWork(db);
    let removed = 0;
    for (const s of work.sessions) {
      if (!expired(s.data.deletedAt)) continue;
      for (const o of work.outputs) if (o.data.sessionId === s.id) await tombstoneOutputTree(db, o.id, work.corrections);
      for (const c of work.corrections) if (c.data.sessionId === s.id && (await db.records.get([CORRECTIONS, c.id]))) await deleteRecord(db, CORRECTIONS, c.id);
      await deleteRecord(db, SESSIONS, s.id);
      removed++;
    }
    for (const o of work.outputs) {
      if (!expired(o.data.deletedAt) || !(await db.records.get([OUTPUT_RECORDS, o.id]))) continue;
      await tombstoneOutputTree(db, o.id, work.corrections);
      removed++;
    }
    const marks = await importedPaused(db);
    const live = Object.fromEntries(Object.entries(marks).filter(([id]) => work.sessions.some((s) => s.id === id && s.data.endedAt === null && !expired(s.data.deletedAt))));
    if (Object.keys(live).length !== Object.keys(marks).length) await setImportedPaused(db, live);
    return removed;
  });
}

/* ---------- output definitions ---------- */

function checkLabel(name: string, unit: string): { name: string; unit: string } {
  const n = name.trim();
  const u = unit.trim();
  if (!n || n.length > NAME_MAX || !u || u.length > UNIT_MAX) throw new WorkError("INVALID_VALUE", "a name (1–200) and a unit (1–50) are required");
  return { name: n, unit: u };
}

/** Creates a reusable output definition with a user-entered name and unit (T-104). */
export async function createOutputDefinition(db: LocalDb, input: { name: string; unit: string }, registry: Registry = PRODUCT_REGISTRY): Promise<string> {
  const id = crypto.randomUUID();
  await putRecord(db, registry, OUTPUT_DEFINITIONS, id, { revisions: [checkLabel(input.name, input.unit)], archivedAt: null } satisfies OutputDefinitionData);
  return id;
}

/** Whether one version of a record references the definition (T-167). */
function referencesDefinition(type: string, data: Record<string, unknown>, id: string): boolean {
  switch (type) {
    case OUTPUT_RECORDS:
    case GOALS:
      return data.definitionId === id;
    case SESSIONS:
    case CALENDAR_BLOCKS:
      return ((data.expectedOutputs as ExpectedOutput[] | undefined) ?? []).some((e) => e.definitionId === id);
    case TASK_DEFINITIONS:
      return ((data.outputDefinitionIds as string[] | undefined) ?? []).includes(id);
    default:
      return false;
  }
}

/**
 * Whether any version the app can show, select, or restore references the definition (T-107,
 * T-167): outputs, goals, expected amounts, task suggestions, in live records, in pending conflicts
 * (both versions), and in the archive of replaced versions. Tombstones hold no data, and purged
 * records are gone, so they do not count; set-aside versions (T-172) can never become current.
 */
export async function definitionInUse(db: LocalDb, id: string): Promise<boolean> {
  return db.transaction("r", [db.records, db.pendingConflicts, db.replacedVersions], async () => {
    const [records, conflicts, replaced] = await Promise.all([db.records.toArray(), db.pendingConflicts.toArray(), db.replacedVersions.toArray()]);
    const inEntry = (type: string, entry: VersionEntry | null) => !!entry && !entry.deleted && referencesDefinition(type, entry.envelope.data, id);
    return (
      records.some((r) => referencesDefinition(r.type, r.data, id)) ||
      conflicts.some((c) => inEntry(c.type, c.local) || inEntry(c.type, c.incoming)) ||
      replaced.some((r) => inEntry(r.type, r.entry))
    );
  });
}

/**
 * Edits a definition's name or unit. An unused definition changes in place. For a definition in
 * use, the owner chose whether history takes the new label ("applyToHistory": the current revision
 * changes) or keeps it ("keepPrevious": a new revision) (T-107, T-111). A unit change of a used
 * definition is allowed only as a new wording of the SAME unit, which the owner confirms
 * (`sameUnit`); a different unit is a new definition (T-165, T-167).
 */
export async function editOutputDefinition(
  db: LocalDb,
  id: string,
  input: { name: string; unit: string; history?: "applyToHistory" | "keepPrevious"; sameUnit?: boolean },
  registry: Registry = PRODUCT_REGISTRY,
): Promise<void> {
  await db.transaction("rw", [...tables(db), db.pendingConflicts, db.replacedVersions], async () => {
    const def = await get<OutputDefinitionData>(db, OUTPUT_DEFINITIONS, id);
    const label = checkLabel(input.name, input.unit);
    const current = def.revisions.at(-1)!;
    if (label.name === current.name && label.unit === current.unit) return;
    const inUse = await definitionInUse(db, id);
    if (inUse && label.unit !== current.unit && !input.sameUnit) throw new WorkError("DIFFERENT_UNIT", "a different unit is a new output definition (T-165)");
    const keep = inUse && input.history === "keepPrevious";
    const revisions = keep ? [...def.revisions, label] : [...def.revisions.slice(0, -1), label];
    await putRecord(db, registry, OUTPUT_DEFINITIONS, id, { ...def, revisions });
  });
}

/** Archives or restores a definition: kept for history, not offered for new sessions (T-107). */
export async function setOutputDefinitionArchived(db: LocalDb, id: string, archived: boolean, registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", tables(db), async () => {
    const def = await get<OutputDefinitionData>(db, OUTPUT_DEFINITIONS, id);
    if (archived === (def.archivedAt !== null)) return;
    await putRecord(db, registry, OUTPUT_DEFINITIONS, id, { ...def, archivedAt: archived ? nowIso() : null });
  });
}

/** The current label of a definition, and the one an output was recorded with (T-111). */
export function definitionLabel(def: OutputDefinitionData, revision?: number): { name: string; unit: string } {
  return def.revisions[Math.min(revision ?? def.revisions.length - 1, def.revisions.length - 1)]!;
}

/* ---------- goals and tasks ---------- */

/**
 * Links a pre-Stage-5 output goal to an output definition (T-139, T-166 to T-169). The units are
 * compared (work/units.ts): a match links; a recognized mismatch is refused; an unrecognized pair
 * links only after the owner explicitly confirms it is only singular/plural forms of the same unit
 * (`confirmedSameUnit`). Writes only `definitionId`: the target, the stored legacy unit, and every
 * output value stay unchanged; no alias or rule is saved.
 */
export async function linkGoalDefinition(
  db: LocalDb,
  goalId: string,
  definitionId: string,
  confirmedSameUnit = false,
  registry: Registry = PRODUCT_REGISTRY,
): Promise<"match" | "confirmed"> {
  return db.transaction("rw", tables(db), async () => {
    const goal = await get<GoalData>(db, GOALS, goalId);
    if (goal.kind !== "output") throw new WorkError("NOT_OUTPUT_GOAL", "only output goals track a definition");
    if (goal.archivedAt !== null) throw new WorkError("ARCHIVED", "restore the goal first (T-082)");
    if (goal.definitionId) throw new WorkError("ALREADY_LINKED", "the goal already tracks a definition");
    const def = await liveDefinition(db, definitionId, true);
    let outcome: "match" | "confirmed" = "match";
    if (goal.unit !== undefined) {
      const result = matchUnits(goal.unit, definitionLabel(def).unit);
      if (result === "mismatch") throw new WorkError("UNIT_MISMATCH", "the definition measures a different unit (T-166)");
      if (result === "unknown") {
        if (!confirmedSameUnit) throw new WorkError("NEEDS_CONFIRMATION", "ask the owner whether these are singular/plural forms of the same unit (T-169)");
        outcome = "confirmed";
      }
    }
    await putRecord(db, registry, GOALS, goalId, { ...goal, definitionId });
    return outcome;
  });
}

/** The unit a goal shows: its definition's current unit (T-154), else the legacy label until it is linked. */
export function goalUnit(goal: GoalData, definitions: ReadonlyMap<string, OutputDefinitionData>): string | null {
  if (goal.kind !== "output") return null;
  const def = goal.definitionId ? definitions.get(goal.definitionId) : undefined;
  return def ? definitionLabel(def).unit : (goal.unit ?? null);
}

async function setTaskList(db: LocalDb, taskId: string, field: "goalIds" | "outputDefinitionIds", ids: string[], registry: Registry): Promise<void> {
  await db.transaction("rw", tables(db), async () => {
    const task = await get<TaskDefinitionData>(db, TASK_DEFINITIONS, taskId);
    const next: Record<string, unknown> = { ...task };
    const unique = [...new Set(ids)];
    if (unique.length === 0) delete next[field];
    else next[field] = unique;
    await putRecord(db, registry, TASK_DEFINITIONS, taskId, next);
  });
}

/** Links a task to goals of any kind (T-120); never inherited from its project (T-121); affects later records only (T-132). */
export async function setTaskGoals(db: LocalDb, taskId: string, goalIds: string[], registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await setTaskList(db, taskId, "goalIds", goalIds, registry);
}

/** Suggested output definitions of a task (T-138): suggestions only, never a restriction. */
export async function setTaskSuggestedDefinitions(db: LocalDb, taskId: string, definitionIds: string[], registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await setTaskList(db, taskId, "outputDefinitionIds", definitionIds, registry);
}

/* ---------- task completions ---------- */

/**
 * Marks a one-off task, or one occurrence of a recurring task, complete (T-108, T-118): one
 * completion record with a derived ID (T-119), counting toward at most one task-count goal — a
 * linked one, a manual one without adding a link, or none (T-123, T-130). A future-date
 * occurrence cannot be completed; today's can at any time of the day (T-133, T-155). Completing
 * again after a reopen edits the same record (T-147). The task itself never changes.
 */
export async function completeTask(
  db: LocalDb,
  taskId: string,
  input: { occurrenceDate?: string | null; goalId?: string | null } = {},
  now: number = Date.now(),
  registry: Registry = PRODUCT_REGISTRY,
): Promise<string> {
  return db.transaction("rw", tables(db), async () => {
    const task = await get<TaskDefinitionData>(db, TASK_DEFINITIONS, taskId);
    const occurrenceDate = input.occurrenceDate ?? null;
    if (task.recurrence) {
      if (occurrenceDate === null || !recursOn(task.recurrence, occurrenceDate)) throw new WorkError("NOT_AN_OCCURRENCE", "choose an occurrence of the recurring task");
      if (!occurrenceHasHappened(occurrenceDate, await requireZone(db), now)) throw new WorkError("FUTURE_OCCURRENCE", "a future occurrence cannot be completed yet");
    } else if (occurrenceDate !== null) {
      throw new WorkError("NOT_AN_OCCURRENCE", "a one-off task has no occurrences");
    }
    const goalId = input.goalId ?? null;
    if (goalId !== null) {
      const { goals, tasks } = await goalsAndTasks(db);
      if (!allowedTaskCountGoals(taskId, tasks, goals).includes(goalId)) throw new WorkError("GOAL_NOT_ALLOWED", "not a task-count goal this completion may count toward");
    }
    const id = completionId(taskId, occurrenceDate);
    const existing = (await db.records.get([TASK_COMPLETIONS, id]))?.data as TaskCompletionData | undefined;
    if (existing && existing.reopenedAt === null) throw new WorkError("ALREADY_COMPLETED", "already completed");
    const data: TaskCompletionData = { taskId, occurrenceDate, completedAt: new Date(now).toISOString(), goalId, reopenedAt: null };
    await putRecord(db, registry, TASK_COMPLETIONS, id, data);
    return id;
  });
}

/** Reopens a completed one-off task or one occurrence: its task-count progress is reversed (T-133, T-147). */
export async function reopenTask(db: LocalDb, taskId: string, occurrenceDate: string | null = null, now: number = Date.now(), registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", tables(db), async () => {
    const id = completionId(taskId, occurrenceDate);
    const row = await db.records.get([TASK_COMPLETIONS, id]);
    const data = row?.data as TaskCompletionData | undefined;
    if (!data || data.reopenedAt !== null) throw new WorkError("NOT_COMPLETED", "not completed");
    await putRecord(db, registry, TASK_COMPLETIONS, id, { ...data, reopenedAt: new Date(now).toISOString() });
  });
}

/* ---------- import of open sessions (T-144, T-152) ---------- */

const isRunning = (data: Record<string, unknown>) => {
  const s = data as unknown as SessionData;
  const last = s.pauses?.at(-1);
  return s.endedAt === null && s.deletedAt === null && !(last && last.end === null);
};

/**
 * Called by the import inside its transaction for every session it wrote (added or updated): a
 * session that is running in the backup is treated here as paused from the backup's creation
 * time, or from the earlier pause the backup carries for it (T-144, T-152, T-173); its timer does
 * not run. Nothing in the record changes. The mark itself is device-local.
 */
export async function markImportedSessions(
  db: LocalDb,
  written: { type: string; id: string; data: Record<string, unknown> }[],
  backupCreatedAt: string,
  carriedPauses: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  const sessions = written.filter((w) => w.type === SESSIONS);
  if (sessions.length === 0) return;
  const marks = await importedPaused(db);
  for (const s of sessions) {
    if (isRunning(s.data)) marks[s.id] = carriedPauses.get(s.id) ?? backupCreatedAt;
    else delete marks[s.id];
  }
  await setImportedPaused(db, marks);
}

/* ---------- prompts when the app opens (T-093, T-149, T-162, T-164) ---------- */

export type SessionPrompt = { sessionId: string; kind: "leftRunning" | "workLimit" | "longPause" };

/**
 * What to ask about open sessions: a session left running before the app opened asks for its end
 * time (T-093); a running session with 24 hours of work time asks for an end time within the
 * limit (T-149); a session paused for more than 24 hours gets a reminder (T-162). Nothing is ended
 * or changed automatically.
 */
export function sessionPrompts(work: Pick<WorkData, "sessions" | "importedPaused">, appOpenedAt: number, now: number = Date.now()): SessionPrompt[] {
  const out: SessionPrompt[] = [];
  for (const s of openSessions(work.sessions)) {
    const state = sessionState(s.data, work.importedPaused[s.id]);
    if (state.kind === "running") {
      if (workMs(s.data, now) >= SESSION_MAX_WORK_MINUTES * MINUTE_MS) out.push({ sessionId: s.id, kind: "workLimit" });
      else if (state.since < appOpenedAt) out.push({ sessionId: s.id, kind: "leftRunning" });
    } else if (state.kind === "paused" && now - state.since > LONG_PAUSE_MINUTES * MINUTE_MS) {
      out.push({ sessionId: s.id, kind: "longPause" });
    }
  }
  return out;
}
