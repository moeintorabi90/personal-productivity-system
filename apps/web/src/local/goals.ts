/**
 * Stage 4 — goals and milestones (docs/ROADMAP.md, PRODUCT_SPEC "Goals and measures"; DECISIONS
 * T-037 to T-065, T-077 to T-087). Goals and milestones are ordinary product records, exported,
 * merged, and resolved by the backup code like any other type.
 *
 * Nothing here computes progress: that needs Stage 5 records (T-037, T-087). Goals are never
 * deleted, only archived (T-063); an archived goal and its milestones are read-only (T-082).
 */
import { nowIso } from "../backup/envelope.ts";
import {
  type GoalData,
  type GoalKind,
  GOALS,
  type GoalStatus,
  type MilestoneData,
  MILESTONES,
  PRODUCT_REGISTRY,
  type Registry,
  TARGET_MAX,
} from "../backup/registry.ts";
import { localDateOf } from "../planning/time.ts";
import type { LocalDb, RecordRow } from "./db.ts";
import type { Item } from "./organization.ts";
import { deleteRecord, putRecord } from "./records.ts";

export type Goal = Item<GoalData>;
export type Milestone = Item<MilestoneData>;

export interface Goals {
  goals: Goal[];
  milestones: Milestone[];
}

/** A goal or milestone write that was refused; nothing was changed. */
export type GoalErrorCode =
  | "NOT_FOUND"
  | "ARCHIVED"
  | "INVALID_STATUS_CHANGE"
  | "INVALID_TARGET"
  | "DEADLINE_BEFORE_START"
  | "DEADLINE_OUTSIDE_GOAL"
  | "MILESTONES_OUTSIDE_RANGE"
  /** An output goal needs its output definition (T-137, T-151). */
  | "NO_DEFINITION";

export class GoalError extends Error {
  readonly code: GoalErrorCode;
  /** Names of the milestones to adjust first (MILESTONES_OUTSIDE_RANGE, T-078). */
  readonly milestoneNames: string[];
  constructor(code: GoalErrorCode, message: string, milestoneNames: string[] = []) {
    super(message);
    this.name = "GoalError";
    this.code = code;
    this.milestoneNames = milestoneNames;
  }
}

function itemOf<T>(row: RecordRow): Item<T> {
  return { id: row.id, data: row.data as T, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/** Every goal and milestone on this device (live records only). */
export async function loadGoals(db: LocalDb): Promise<Goals> {
  return db.transaction("r", db.records, async () => {
    const [goals, milestones] = await Promise.all([GOALS, MILESTONES].map((type) => db.records.where("type").equals(type).toArray()));
    return { goals: goals!.map((row) => itemOf<GoalData>(row)), milestones: milestones!.map((row) => itemOf<MilestoneData>(row)) };
  });
}

/* ---------- pure rules (unit-tested) ---------- */

/** Whether a milestone deadline lies within a goal's date range (T-057); no deadline always does. */
export function deadlineWithinGoal(deadline: string | null, goal: Pick<GoalData, "startDate" | "deadline">): boolean {
  if (deadline === null) return true;
  return deadline >= goal.startDate && (goal.deadline === null || deadline <= goal.deadline);
}

/** Milestones of a goal whose deadline falls outside the given range (shown with a warning, T-078). */
export function milestonesOutside(milestones: Milestone[], goalId: string, range: Pick<GoalData, "startDate" | "deadline">): Milestone[] {
  return milestones.filter((m) => m.data.goalId === goalId && !deadlineWithinGoal(m.data.deadline, range));
}

const TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  active: ["paused", "completed"], // pause; complete (T-043, T-044)
  paused: ["active", "completed"], // resume; complete without resuming (T-062)
  completed: ["active"], // reopen (T-060)
};

export function canChangeStatus(from: GoalStatus, to: GoalStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Today's local date: in the configured zone, else on the device's calendar (T-086). */
export function defaultStartDate(zone: string | null, now: number = Date.now()): string {
  if (zone) return localDateOf(now, zone);
  const d = new Date(now);
  return `${String(d.getFullYear()).padStart(4, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function checkTarget(kind: GoalKind, target: number): void {
  if (!Number.isInteger(target) || target < 1 || target > TARGET_MAX[kind]) throw new GoalError("INVALID_TARGET", `target out of range for ${kind}`);
}

function requireDefinition(definitionId: string | undefined): string {
  if (!definitionId) throw new GoalError("NO_DEFINITION", "an output goal tracks one output definition (T-137)");
  return definitionId;
}

function checkDates(startDate: string, deadline: string | null): void {
  if (deadline !== null && deadline < startDate) throw new GoalError("DEADLINE_BEFORE_START", "deadline before start date");
}

/* ---------- commands ---------- */

export interface GoalInput {
  name: string;
  description?: string;
  projectId?: string | null;
  startDate: string;
  deadline?: string | null;
  kind: GoalKind;
  /** Whole number; whole minutes for a time goal (T-077). */
  target: number;
  /**
   * Required for output goals, ignored otherwise: the one output definition the goal tracks and
   * whose unit it shows (T-137, T-151, T-154). Goals created from Stage 5 on have no own unit (T-161).
   */
  definitionId?: string;
}

export async function createGoal(db: LocalDb, input: GoalInput, registry: Registry = PRODUCT_REGISTRY): Promise<string> {
  checkTarget(input.kind, input.target);
  checkDates(input.startDate, input.deadline ?? null);
  const id = crypto.randomUUID();
  const data: GoalData = {
    name: input.name.trim(),
    description: (input.description ?? "").trim(),
    projectId: input.projectId ?? null,
    startDate: input.startDate,
    deadline: input.deadline ?? null,
    kind: input.kind,
    target: input.target,
    ...(input.kind === "output" ? { definitionId: requireDefinition(input.definitionId) } : {}),
    status: "active",
    archivedAt: null,
  };
  await putRecord(db, registry, GOALS, id, data);
  return id;
}

async function liveGoal(db: LocalDb, id: string): Promise<GoalData> {
  const row = await db.records.get([GOALS, id]);
  if (!row) throw new GoalError("NOT_FOUND", `goal ${id} does not exist`);
  return row.data as GoalData;
}

async function editableGoal(db: LocalDb, id: string): Promise<GoalData> {
  const goal = await liveGoal(db, id);
  if (goal.archivedAt !== null) throw new GoalError("ARCHIVED", "restore the goal before changing it");
  return goal;
}

async function milestonesOf(db: LocalDb, goalId: string): Promise<Milestone[]> {
  const rows = await db.records.where("type").equals(MILESTONES).toArray();
  return rows.filter((row) => row.data.goalId === goalId).map((row) => itemOf<MilestoneData>(row));
}

const WRITE_TABLES = (db: LocalDb) => [db.records, db.tombstones, db.meta];

/**
 * Edits a goal. The kind never changes (T-079). From Stage 5 the unit is not edited on the goal:
 * it comes from the goal's output definition (T-154), and a stored legacy unit is never rewritten
 * (T-161); linking the definition is `linkGoalDefinition` (local/work.ts). A date change that would
 * put a milestone deadline outside the goal's range is refused and names those milestones (T-078).
 * Status and archive have their own commands.
 */
export async function updateGoal(
  db: LocalDb,
  id: string,
  patch: Partial<Pick<GoalData, "name" | "description" | "projectId" | "startDate" | "deadline" | "target">>,
  registry: Registry = PRODUCT_REGISTRY,
): Promise<void> {
  await db.transaction("rw", WRITE_TABLES(db), async () => {
    const goal = await editableGoal(db, id);
    const { name, description, projectId, startDate, deadline, target } = patch;
    const next: GoalData = { ...goal };
    if (name !== undefined) next.name = name.trim();
    if (description !== undefined) next.description = description.trim();
    if (projectId !== undefined) next.projectId = projectId;
    if (startDate !== undefined) next.startDate = startDate;
    if (deadline !== undefined) next.deadline = deadline;
    if (target !== undefined) next.target = target;
    checkTarget(next.kind, next.target);
    checkDates(next.startDate, next.deadline);
    if (next.startDate !== goal.startDate || next.deadline !== goal.deadline) {
      const outside = milestonesOutside(await milestonesOf(db, id), id, next);
      if (outside.length > 0) {
        throw new GoalError("MILESTONES_OUTSIDE_RANGE", "milestone deadlines outside the new dates", outside.map((m) => m.data.name));
      }
    }
    await putRecord(db, registry, GOALS, id, next);
  });
}

/** Pause, resume, complete (also from paused), or reopen (T-043, T-044, T-060, T-062). Dates never change (T-045). */
export async function setGoalStatus(db: LocalDb, id: string, status: GoalStatus, registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", WRITE_TABLES(db), async () => {
    const goal = await editableGoal(db, id);
    if (goal.status === status) return;
    if (!canChangeStatus(goal.status, status)) throw new GoalError("INVALID_STATUS_CHANGE", `${goal.status} → ${status}`);
    await putRecord(db, registry, GOALS, id, { ...goal, status });
  });
}

/** Archives or restores a goal. The status is kept, so restore returns to it (T-063 to T-065). */
export async function setGoalArchived(db: LocalDb, id: string, archived: boolean, registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", WRITE_TABLES(db), async () => {
    const goal = await liveGoal(db, id);
    if (archived === (goal.archivedAt !== null)) return;
    await putRecord(db, registry, GOALS, id, { ...goal, archivedAt: archived ? nowIso() : null });
  });
}

export interface MilestoneInput {
  goalId: string;
  name: string;
  description?: string;
  deadline?: string | null;
}

/** Adds a milestone to a goal that is not archived; its deadline must lie within the goal's dates (T-057). */
export async function createMilestone(db: LocalDb, input: MilestoneInput, registry: Registry = PRODUCT_REGISTRY): Promise<string> {
  const id = crypto.randomUUID();
  await db.transaction("rw", WRITE_TABLES(db), async () => {
    const goal = await editableGoal(db, input.goalId);
    const deadline = input.deadline ?? null;
    if (!deadlineWithinGoal(deadline, goal)) throw new GoalError("DEADLINE_OUTSIDE_GOAL", "milestone deadline outside the goal's dates");
    const data: MilestoneData = {
      goalId: input.goalId,
      name: input.name.trim(),
      description: (input.description ?? "").trim(),
      deadline,
      completedAt: null,
    };
    await putRecord(db, registry, MILESTONES, id, data);
  });
  return id;
}

async function editableMilestone(db: LocalDb, id: string): Promise<{ milestone: MilestoneData; goal: GoalData }> {
  const row = await db.records.get([MILESTONES, id]);
  if (!row) throw new GoalError("NOT_FOUND", `milestone ${id} does not exist`);
  const milestone = row.data as MilestoneData;
  return { milestone, goal: await editableGoal(db, milestone.goalId) };
}

/** Edits a milestone's name, description, or deadline (within the goal's dates, T-057). */
export async function updateMilestone(
  db: LocalDb,
  id: string,
  patch: Partial<Pick<MilestoneData, "name" | "description" | "deadline">>,
  registry: Registry = PRODUCT_REGISTRY,
): Promise<void> {
  await db.transaction("rw", WRITE_TABLES(db), async () => {
    const { milestone, goal } = await editableMilestone(db, id);
    const next: MilestoneData = { ...milestone, ...patch };
    next.name = next.name.trim();
    next.description = next.description.trim();
    // A merged milestone may already be outside (T-078); only a changed deadline is checked.
    if (next.deadline !== milestone.deadline && !deadlineWithinGoal(next.deadline, goal)) {
      throw new GoalError("DEADLINE_OUTSIDE_GOAL", "milestone deadline outside the goal's dates");
    }
    await putRecord(db, registry, MILESTONES, id, next);
  });
}

/** Marks a milestone complete or incomplete; other milestones are not involved (T-038, T-058, T-059). */
export async function setMilestoneCompleted(db: LocalDb, id: string, completed: boolean, registry: Registry = PRODUCT_REGISTRY): Promise<void> {
  await db.transaction("rw", WRITE_TABLES(db), async () => {
    const { milestone } = await editableMilestone(db, id);
    if (completed === (milestone.completedAt !== null)) return;
    await putRecord(db, registry, MILESTONES, id, { ...milestone, completedAt: completed ? nowIso() : null });
  });
}

/** Deletes a milestone (the UI confirms first); a tombstone keeps older backups from restoring it (T-080). */
export async function deleteMilestone(db: LocalDb, id: string): Promise<void> {
  await db.transaction("rw", WRITE_TABLES(db), async () => {
    await editableMilestone(db, id);
    await deleteRecord(db, MILESTONES, id);
  });
}

/* ---------- queries (pure; unit-tested) ---------- */

export type GoalFilter = "current" | GoalStatus | "archived" | "all";

/** Goals for a list: "current" = not archived; a status = not archived with that status. Sorted by name. */
export function filterGoals(goals: Goal[], filter: GoalFilter): Goal[] {
  return goals
    .filter((g) => {
      const archived = g.data.archivedAt !== null;
      if (filter === "all") return true;
      if (filter === "archived") return archived;
      if (archived) return false;
      return filter === "current" || g.data.status === filter;
    })
    .sort((a, b) => a.data.name.localeCompare(b.data.name));
}

/** Milestones of a goal: dated ones by deadline, then undated ones, each by name. */
export function milestonesOfGoal(milestones: Milestone[], goalId: string): Milestone[] {
  return milestones
    .filter((m) => m.data.goalId === goalId)
    .sort((a, b) => {
      const da = a.data.deadline ?? "9999-99-99";
      const dbb = b.data.deadline ?? "9999-99-99";
      return da === dbb ? a.data.name.localeCompare(b.data.name) : da.localeCompare(dbb);
    });
}
