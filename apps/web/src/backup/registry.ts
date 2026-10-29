import { CALENDAR_DISPLAYS, isValidTimeZone, timeZoneSchema } from "@pps/shared";
import { z } from "zod";
import { isLocalDate, localDateOf } from "../planning/time.ts";
import { sessionTimesProblem } from "../work/session-time.ts";
import { SHARED_PREFERENCES_ID } from "./limits.ts";

/**
 * A reference from one record type to another, e.g. a task's `projectId`. The field holds one ID
 * (or null/absent), a list of IDs, or — with `key` — a list of objects holding the ID in `key`
 * (data schema version 6: task `goalIds`, expected outputs' `definitionId`).
 */
export interface LinkDef {
  field: string;
  target: string;
  key?: string;
}

/** The raw target values of one link in `data` (null/absent: none). Non-string values are returned as they are, so callers can refuse them. */
export function linkTargets(link: LinkDef, data: Record<string, unknown>): unknown[] {
  const value = data[link.field];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return [value];
  return link.key ? value.map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>)[link.key!] : item)) : value;
}

/** Finds the data of a known version of another record (any version, or undefined if none is known). */
export type DataLookup = (type: string, id: string) => Record<string, unknown> | undefined;
/** Every known version of another record (an imported file's history check); empty if none is known. */
export type DataLookupAll = (type: string, id: string) => Record<string, unknown>[];

export interface RecordTypeDef {
  type: string;
  /** Validates `data`; must reject unknown fields. */
  schema: z.ZodType<Record<string, unknown>>;
  links: LinkDef[];
  /** Reserved constant ID for singleton types (only one record, never "keep both"). */
  singletonId?: string;
  /** Untouched default data of a singleton (compared as an empty version vector). */
  singletonDefault?: Record<string, unknown>;
  /** Append-only history: data never changes after creation. */
  appendOnly?: boolean;
  /** `dataSchemaVersion` that introduced this type (default 1); older files may not contain it. */
  sinceDataSchemaVersion?: number;
  /**
   * Schemas of older `dataSchemaVersion`s whose fields differ (T-025): a file is validated against
   * the fields of ITS version, so a version-2 task containing `recurrence` is refused. Keyed by
   * the last version that used the schema; `schema` is the current one.
   */
  olderSchemas?: { untilDataSchemaVersion: number; schema: z.ZodType<Record<string, unknown>> }[];
  /**
   * Fields that never change after creation (e.g. a workstream's project). Every version of one
   * ID — on the device and in a backup — must agree on them; otherwise the file is refused.
   */
  immutableFields?: readonly string[];
  /**
   * Relationship rule across records (DATA_MODEL "Ownership and relationships"), checked for
   * typed-in data and for every version in an imported file. Returns a problem, or null. A target
   * whose data is unknown (e.g. only a deletion marker) is skipped here; link checks cover it.
   * `lookupAll` is passed for the file-wide check, where a target may have several versions: a
   * rule that reads a field that is not immutable must accept a target if any version satisfies it.
   */
  rule?: (data: Record<string, unknown>, lookup: DataLookup, lookupAll?: DataLookupAll) => string | null;
}

export interface Registry {
  types: ReadonlyMap<string, RecordTypeDef>;
  get(type: string): RecordTypeDef | undefined;
  /** No links in either direction (docs/BACKUP_FORMAT.md, "Links"). */
  isIndependent(type: string): boolean;
  /** "Keep both" is offered only for independent, non-singleton, non-history types (D-015). */
  allowsKeepBoth(type: string): boolean;
}

export function createRegistry(defs: RecordTypeDef[]): Registry {
  const types = new Map(defs.map((def) => [def.type, def]));
  const linkedTargets = new Set(defs.flatMap((def) => def.links.map((link) => link.target)));
  const isIndependent = (type: string) => {
    const def = types.get(type);
    return !!def && def.links.length === 0 && !linkedTargets.has(type);
  };
  return {
    types,
    get: (type) => types.get(type),
    isIndependent,
    allowsKeepBoth: (type) => {
      const def = types.get(type);
      return !!def && isIndependent(type) && !def.singletonId && !def.appendOnly;
    },
  };
}

/**
 * The registry as seen by a file of `dataSchemaVersion`: types introduced later are unknown, and
 * types whose fields changed use the schema of that version.
 */
export function registryForDataSchemaVersion(registry: Registry, dataSchemaVersion: number): Registry {
  let changed = false;
  const defs: RecordTypeDef[] = [];
  for (const def of registry.types.values()) {
    if ((def.sinceDataSchemaVersion ?? 1) > dataSchemaVersion) {
      changed = true;
      continue;
    }
    const older = (def.olderSchemas ?? [])
      .filter((o) => dataSchemaVersion <= o.untilDataSchemaVersion)
      .sort((a, b) => a.untilDataSchemaVersion - b.untilDataSchemaVersion)[0];
    if (older) changed = true;
    defs.push(older ? { ...def, schema: older.schema } : def);
  }
  return changed ? createRegistry(defs) : registry;
}

/* ---------- Stage 3 value formats (DATA_MODEL "Stage 3 record types and fields") ---------- */

/** ISO Gregorian `YYYY-MM-DD`, a real calendar date. */
export const localDateSchema = z.string().refine(isLocalDate, { message: "must be a calendar date YYYY-MM-DD" });

/** Whole minutes of daily capacity (T-031): one value for every day. */
export const CAPACITY_MAX_MINUTES = 24 * 60;

const sharedPreferencesV1Shape = {
  timeZone: timeZoneSchema.nullable(),
  weekStart: z.number().int().min(0).max(6),
  calendarDisplay: z.enum(CALENDAR_DISPLAYS),
};

/** Shared preferences as written by data schema versions 1 and 2 (no capacity). */
const sharedPreferencesV1Schema = z.object(sharedPreferencesV1Shape).strict();

/**
 * Shared, transferable preferences (D-017). Language and theme are device-local and not here.
 * `dailyCapacityMinutes` (version 3) is absent when not set — never null — so existing records
 * keep their content hash (T-025).
 */
export const sharedPreferencesSchema = z
  .object({
    ...sharedPreferencesV1Shape,
    dailyCapacityMinutes: z.number().int().min(1).max(CAPACITY_MAX_MINUTES).optional(),
  })
  .strict();

export type SharedPreferences = z.infer<typeof sharedPreferencesSchema>;

export const DEFAULT_SHARED_PREFERENCES: SharedPreferences = {
  timeZone: null,
  weekStart: 6,
  calendarDisplay: "gregorian",
};

export const preferencesType: RecordTypeDef = {
  type: "preferences",
  schema: sharedPreferencesSchema as unknown as z.ZodType<Record<string, unknown>>,
  links: [],
  singletonId: SHARED_PREFERENCES_ID,
  singletonDefault: DEFAULT_SHARED_PREFERENCES,
  olderSchemas: [{ untilDataSchemaVersion: 2, schema: sharedPreferencesV1Schema as unknown as z.ZodType<Record<string, unknown>> }],
};

/* ---------- Stage 2: organization (dataSchemaVersion 2) ---------- */

export const NAME_MAX = 200;
export const TEXT_MAX = 20_000;
export const NEXT_ACTION_MAX = 500;
export const ESTIMATE_MAX_MINUTES = 7 * 24 * 60;

/** A required short name: 1–200 characters and not only whitespace (stored as entered). */
const nameSchema = z.string().max(NAME_MAX).regex(/\S/, "must not be blank");
const textSchema = z.string().max(TEXT_MAX);
/** Archive state is data (it merges and conflicts like any edit); it is never a deletion. */
const archivedAtSchema = z.iso.datetime().nullable();

/**
 * Palette identifiers a project may choose (T-088), fixed for data schema version 5; theme values
 * are presentation (styles.css). Changing or adding an identifier is a data-version step.
 */
export const PALETTE_IDS = ["blue", "teal", "green", "amber", "orange", "red", "pink", "purple"] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];

const projectV2Shape = { name: nameSchema, description: textSchema, archivedAt: archivedAtSchema };

/** A project as written by data schema versions 2 to 4 (no color). */
const projectV2Schema = z.object(projectV2Shape).strict();

/**
 * A project. `color` (data schema version 5, T-068 to T-070) is absent when the owner has not
 * chosen one — never null — so existing projects keep their content hash (T-025); the default
 * color is derived from the project ID on display and never written.
 */
export const projectSchema = z.object({ ...projectV2Shape, color: z.enum(PALETTE_IDS).optional() }).strict();
export type ProjectData = z.infer<typeof projectSchema>;

export const workstreamSchema = z
  .object({ projectId: z.uuid(), name: nameSchema, description: textSchema, archivedAt: archivedAtSchema })
  .strict();
export type WorkstreamData = z.infer<typeof workstreamSchema>;

const taskDefinitionV2Shape = {
  title: nameSchema,
  notes: textSchema,
  projectId: z.uuid().nullable(),
  workstreamId: z.uuid().nullable(),
  nextAction: z.string().max(NEXT_ACTION_MAX),
  estimateMinutes: z.number().int().min(1).max(ESTIMATE_MAX_MINUTES).nullable(),
  archivedAt: archivedAtSchema,
};

/** A task definition as written by data schema version 2 (no recurrence). */
const taskDefinitionV2Schema = z.object(taskDefinitionV2Shape).strict();

/**
 * Weekly recurrence on selected weekdays (T-029): 1–7 distinct weekdays (0 = Sunday … 6 =
 * Saturday) in ascending order, a required start date, and an optional inclusive end date.
 */
export const recurrenceSchema = z
  .object({
    kind: z.literal("weekdays"),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => days.every((d, i) => i === 0 || d > days[i - 1]!), { message: "weekdays must be distinct and ascending" }),
    startDate: localDateSchema,
    endDate: localDateSchema.nullable(),
  })
  .strict()
  .refine((r) => r.endDate === null || r.endDate >= r.startDate, { message: "endDate must not be before startDate" });
export type Recurrence = z.infer<typeof recurrenceSchema>;

/** A task definition as written by data schema versions 3 to 5 (recurrence; no goal links or suggestions). */
const taskDefinitionV5Schema = z.object({ ...taskDefinitionV2Shape, recurrence: recurrenceSchema.optional() }).strict();

/** A non-empty list of distinct IDs (fields added in data schema version 6 are absent when empty, T-025). */
const idListSchema = (max: number) =>
  z
    .array(z.uuid())
    .min(1)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, { message: "IDs must be distinct" });

/**
 * A task definition: reusable task details, not evidence that work happened. Without a project it
 * is in the quick-capture inbox. `recurrence` (Stage 3, data schema version 3) is absent for a
 * task that does not recur — never null (T-025). Data schema version 6 (Stage 5) adds `goalIds`
 * (explicit links to goals of any kind, T-120, T-126) and `outputDefinitionIds` (suggested output
 * definitions, the T-024 output-metric field, T-138), both absent when empty.
 */
export const taskDefinitionSchema = z
  .object({
    ...taskDefinitionV2Shape,
    recurrence: recurrenceSchema.optional(),
    goalIds: idListSchema(100).optional(),
    outputDefinitionIds: idListSchema(50).optional(),
  })
  .strict();
export type TaskDefinitionData = z.infer<typeof taskDefinitionSchema>;

export const PROJECTS = "projects";
export const WORKSTREAMS = "workstreams";
export const TASK_DEFINITIONS = "taskDefinitions";

export const projectsType: RecordTypeDef = {
  type: PROJECTS,
  schema: projectSchema as unknown as RecordTypeDef["schema"],
  links: [],
  sinceDataSchemaVersion: 2,
  olderSchemas: [{ untilDataSchemaVersion: 4, schema: projectV2Schema as unknown as RecordTypeDef["schema"] }],
};

/** A workstream belongs to one project for its whole life (moving it is not supported). */
export const workstreamsType: RecordTypeDef = {
  type: WORKSTREAMS,
  schema: workstreamSchema as unknown as RecordTypeDef["schema"],
  links: [{ field: "projectId", target: PROJECTS }],
  sinceDataSchemaVersion: 2,
  immutableFields: ["projectId"],
};

/** A task's workstream must belong to the task's project; a workstream needs a project. */
export function taskDefinitionRule(data: Record<string, unknown>, lookup: DataLookup): string | null {
  const workstreamId = data.workstreamId as string | null;
  if (workstreamId === null) return null;
  if (data.projectId === null) return "a task in the inbox (no project) cannot have a workstream";
  const workstream = lookup(WORKSTREAMS, workstreamId);
  if (workstream && workstream.projectId !== data.projectId) return "the task's workstream belongs to another project";
  return null;
}

export const taskDefinitionsType: RecordTypeDef = {
  type: TASK_DEFINITIONS,
  schema: taskDefinitionSchema as unknown as RecordTypeDef["schema"],
  links: [
    { field: "projectId", target: PROJECTS },
    { field: "workstreamId", target: WORKSTREAMS },
    { field: "goalIds", target: "goals" },
    { field: "outputDefinitionIds", target: "outputDefinitions" },
  ],
  sinceDataSchemaVersion: 2,
  rule: taskDefinitionRule,
  olderSchemas: [
    { untilDataSchemaVersion: 2, schema: taskDefinitionV2Schema as unknown as RecordTypeDef["schema"] },
    { untilDataSchemaVersion: 5, schema: taskDefinitionV5Schema as unknown as RecordTypeDef["schema"] },
  ],
};

/* ---------- Stage 3: calendar and planning (dataSchemaVersion 3) ---------- */

export const CALENDAR_BLOCKS = "calendarBlocks";
export const BLOCK_MAX_MINUTES = 24 * 60;

/** A UTC instant at minute precision, exactly as `Date.prototype.toISOString` writes it. */
const minuteInstantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/, "must be a UTC instant at whole minutes")
  .refine((s) => new Date(s).toISOString() === s, { message: "must be a real instant" });

/** Names and IDs at the time the block was created or last edited (T-036). History, not links. */
const blockSnapshotSchema = z
  .object({
    taskTitle: nameSchema,
    projectId: z.uuid().nullable(),
    projectName: z.string().max(NAME_MAX).nullable(),
    workstreamId: z.uuid().nullable(),
    workstreamName: z.string().max(NAME_MAX).nullable(),
  })
  .strict()
  .refine((s) => (s.projectId === null) === (s.projectName === null) && (s.workstreamId === null) === (s.workstreamName === null), {
    message: "a snapshot name is present exactly when its ID is",
  })
  .refine((s) => s.workstreamId === null || s.projectId !== null, { message: "a snapshot workstream needs a project" });

/** Largest output value, expected amount, and output-goal target (T-085, T-104). */
export const OUTPUT_VALUE_MAX = 1_000_000_000;

/**
 * Expected output amounts (T-125, T-128, T-141, T-150): at most one entry per definition; a whole
 * number of 0 or more, where 0 means "0 expected" and no entry means unset (T-163).
 */
const expectedOutputsShape = (min: number) =>
  z
    .array(z.object({ definitionId: z.uuid(), amount: z.number().int().min(0).max(OUTPUT_VALUE_MAX) }).strict())
    .min(min)
    .max(50)
    .refine((list) => new Set(list.map((e) => e.definitionId)).size === list.length, { message: "one expected amount per definition" });
export type ExpectedOutput = { definitionId: string; amount: number };

const calendarBlockV3Shape = {
  taskId: z.uuid(),
  startsAt: minuteInstantSchema,
  endsAt: minuteInstantSchema,
  timeZone: timeZoneSchema,
  localDate: localDateSchema,
  occurrenceDate: localDateSchema.nullable(),
  status: z.enum(["planned", "cancelled"]),
  snapshot: blockSnapshotSchema,
};

function checkBlock(b: { startsAt: string; endsAt: string; timeZone: string; localDate: string }, ctx: z.RefinementCtx) {
  const minutes = (Date.parse(b.endsAt) - Date.parse(b.startsAt)) / 60_000;
  if (!(minutes > 0)) ctx.addIssue({ code: "custom", message: "endsAt must be after startsAt" });
  else if (minutes > BLOCK_MAX_MINUTES) ctx.addIssue({ code: "custom", message: "a block lasts at most 24 hours" });
  if (isValidTimeZone(b.timeZone) && isLocalDate(b.localDate) && localDateOf(b.startsAt, b.timeZone) !== b.localDate) {
    ctx.addIssue({ code: "custom", message: "localDate must be the local date of startsAt in timeZone" });
  }
}

/** A block as written by data schema versions 3 to 5 (no expected outputs). */
const calendarBlockV3Schema = z.object(calendarBlockV3Shape).strict().superRefine(checkBlock);

/**
 * A planned block (T-027, T-030, D-022): fixed UTC instants, the zone it was planned in and its
 * local date there, the recurring occurrence it schedules (if any), and planned/cancelled status.
 * Plans only: no completion or actual time. Data schema version 6 adds the optional
 * `expectedOutputs` (T-141, T-150), absent when none — a plan, never an output.
 */
export const calendarBlockSchema = z
  .object({ ...calendarBlockV3Shape, expectedOutputs: expectedOutputsShape(1).optional() })
  .strict()
  .superRefine(checkBlock);
export type CalendarBlockData = z.infer<typeof calendarBlockSchema>;

/** Blocks link to a task definition; a task with live blocks cannot be deleted (restrict). */
export const calendarBlocksType: RecordTypeDef = {
  type: CALENDAR_BLOCKS,
  schema: calendarBlockSchema as unknown as RecordTypeDef["schema"],
  links: [
    { field: "taskId", target: TASK_DEFINITIONS },
    { field: "expectedOutputs", target: "outputDefinitions", key: "definitionId" },
  ],
  // A block's task is part of its identity (owner, T-171): sessions linked to it belong to that task (T-094, T-135).
  immutableFields: ["taskId"],
  sinceDataSchemaVersion: 3,
  olderSchemas: [{ untilDataSchemaVersion: 5, schema: calendarBlockV3Schema as unknown as RecordTypeDef["schema"] }],
};

/* ---------- Stage 4: goals and milestones (dataSchemaVersion 4) ---------- */

export const GOALS = "goals";
export const MILESTONES = "milestones";
export const GOAL_KINDS = ["output", "time", "taskCount"] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];
export const GOAL_STATUSES = ["active", "paused", "completed"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const UNIT_MAX = 50;
/** Largest target per kind (T-085): output amount, minutes of a time goal, completed tasks. */
export const TARGET_MAX: Record<GoalKind, number> = { output: 1_000_000_000, time: 1_000_000, taskCount: 1_000_000 };

/**
 * A goal (T-037 to T-065, T-077 to T-087): one overall target of a fixed kind (`time` in whole
 * minutes), a date range, and a status. Archive is separate from status, so restoring returns to
 * the pre-archive status (T-065). No progress is stored (Stage 5 derives it).
 */
const unitSchema = z.string().max(UNIT_MAX).regex(/\S/, "must not be blank");

const goalV4Shape = {
  name: nameSchema,
  description: textSchema,
  projectId: z.uuid().nullable(),
  startDate: localDateSchema,
  deadline: localDateSchema.nullable(),
  kind: z.enum(GOAL_KINDS),
  target: z.number().int().min(1),
  unit: unitSchema.optional(),
  status: z.enum(GOAL_STATUSES),
  archivedAt: archivedAtSchema,
};

function checkGoalBasics(g: { deadline: string | null; startDate: string; target: number; kind: GoalKind }, ctx: z.RefinementCtx) {
  if (g.deadline !== null && g.deadline < g.startDate) ctx.addIssue({ code: "custom", message: "deadline must not be before startDate" });
  if (g.target > TARGET_MAX[g.kind]) ctx.addIssue({ code: "custom", message: `target must be at most ${TARGET_MAX[g.kind]}` });
}

/** A goal as written by data schema versions 4 and 5: an output goal has its own unit label (T-050). */
const goalV4Schema = z
  .object(goalV4Shape)
  .strict()
  .superRefine((g, ctx) => {
    checkGoalBasics(g, ctx);
    if ((g.kind === "output") !== (g.unit !== undefined)) ctx.addIssue({ code: "custom", message: "a unit is present exactly for output goals" });
  });

/**
 * A goal (T-037 to T-065, T-077 to T-087): one overall target of a fixed kind (`time` in whole
 * minutes), a date range, and a status. Archive is separate from status, so restoring returns to
 * the pre-archive status (T-065). No progress is stored (derived, T-116). Data schema version 6:
 * an output goal tracks one output definition (`definitionId`, T-137) whose unit it shows (T-154);
 * it has `definitionId` or a legacy `unit` (or both); goals created from Stage 5 on omit `unit`,
 * and a stored legacy unit is never rewritten (T-161). Other kinds have neither.
 */
export const goalSchema = z
  .object({ ...goalV4Shape, definitionId: z.uuid().optional() })
  .strict()
  .superRefine((g, ctx) => {
    checkGoalBasics(g, ctx);
    if (g.kind === "output" && g.unit === undefined && g.definitionId === undefined) {
      ctx.addIssue({ code: "custom", message: "an output goal needs a definition or a unit" });
    }
    if (g.kind !== "output" && (g.unit !== undefined || g.definitionId !== undefined)) {
      ctx.addIssue({ code: "custom", message: "only output goals have a unit or an output definition" });
    }
  });
export type GoalData = z.infer<typeof goalSchema>;

/** A milestone of one goal (T-040, T-055 to T-059); `completedAt` null means incomplete. */
export const milestoneSchema = z
  .object({
    goalId: z.uuid(),
    name: nameSchema,
    description: textSchema,
    deadline: localDateSchema.nullable(),
    completedAt: archivedAtSchema,
  })
  .strict();
export type MilestoneData = z.infer<typeof milestoneSchema>;

/** The kind never changes (T-079). The milestone date range is not an import rule (T-084). */
export const goalsType: RecordTypeDef = {
  type: GOALS,
  schema: goalSchema as unknown as RecordTypeDef["schema"],
  links: [
    { field: "projectId", target: PROJECTS },
    { field: "definitionId", target: "outputDefinitions" },
  ],
  sinceDataSchemaVersion: 4,
  immutableFields: ["kind"],
  olderSchemas: [{ untilDataSchemaVersion: 5, schema: goalV4Schema as unknown as RecordTypeDef["schema"] }],
};

/** A milestone belongs to one goal for its whole life (T-083). */
export const milestonesType: RecordTypeDef = {
  type: MILESTONES,
  schema: milestoneSchema as unknown as RecordTypeDef["schema"],
  links: [{ field: "goalId", target: GOALS }],
  sinceDataSchemaVersion: 4,
  immutableFields: ["goalId"],
};

/* ---------- Stage 5: actual work sessions and outputs (dataSchemaVersion 6) ---------- */

export const SESSIONS = "sessions";
export const OUTPUT_DEFINITIONS = "outputDefinitions";
export const OUTPUT_RECORDS = "outputRecords";
export const CORRECTIONS = "corrections";
export const TASK_COMPLETIONS = "taskCompletions";
export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const REASON_MAX = 2_000;
const instantSchema = z.iso.datetime();

/**
 * One period of actual work (T-091 to T-099, T-110, T-117, T-136, T-140, T-158): whole-minute UTC
 * instants, pause intervals (paused time is not work time), the zone and local date at start, an
 * optional task and a planned block of that task, the one time goal its work time counts toward
 * (`null` = none, T-127, T-129), expected output amounts (T-125, T-128), names at recording time
 * (`null` without a task, T-036 pattern), the device that started it, an optional note and 1–5
 * energy/focus ratings, and the deletion state of the trash (T-103, T-142). Every field is
 * present; `null` means none (new type, T-109). No end status (T-098).
 */
export const sessionSchema = z
  .object({
    taskId: z.uuid().nullable(),
    blockId: z.uuid().nullable(),
    startedAt: minuteInstantSchema,
    endedAt: minuteInstantSchema.nullable(),
    pauses: z.array(z.object({ start: minuteInstantSchema, end: minuteInstantSchema.nullable() }).strict()).max(1_000),
    timeZone: timeZoneSchema,
    localDate: localDateSchema,
    goalId: z.uuid().nullable(),
    expectedOutputs: expectedOutputsShape(0),
    snapshot: blockSnapshotSchema.nullable(),
    startedOnDevice: z.uuid(),
    notes: textSchema,
    energy: z.number().int().min(RATING_MIN).max(RATING_MAX).nullable(),
    focus: z.number().int().min(RATING_MIN).max(RATING_MAX).nullable(),
    deletedAt: instantSchema.nullable(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const problem = sessionTimesProblem(s);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
    if (s.blockId !== null && s.taskId === null) ctx.addIssue({ code: "custom", message: "a block link needs a task" });
    if ((s.taskId === null) !== (s.snapshot === null)) ctx.addIssue({ code: "custom", message: "a snapshot is present exactly when a task is linked" });
    if (isValidTimeZone(s.timeZone) && isLocalDate(s.localDate) && localDateOf(s.startedAt, s.timeZone) !== s.localDate) {
      ctx.addIssue({ code: "custom", message: "localDate must be the local date of startedAt in timeZone" });
    }
  });
export type SessionData = z.infer<typeof sessionSchema>;

/**
 * A session's block is of the same task (T-094, T-135); its goal is a time goal (T-122). Both read
 * only fields that never change (a block's task, a goal's kind).
 */
export function sessionRule(data: Record<string, unknown>, lookup: DataLookup): string | null {
  if (data.blockId) {
    const block = lookup(CALENDAR_BLOCKS, data.blockId as string);
    if (block && block.taskId !== data.taskId) return "a session can be linked only to a block of its own task";
  }
  if (data.goalId) {
    const goal = lookup(GOALS, data.goalId as string);
    if (goal && goal.kind !== "time") return "a session's work time counts toward a time goal only";
  }
  return null;
}

/**
 * A reusable, user-defined measure (T-104, T-107, T-111): revisions of name and unit, all of the
 * SAME unit (a different unit is a new definition, T-165); outputs point to the revision current
 * when they were recorded. Archived: kept for history, not offered for new sessions.
 */
export const outputDefinitionSchema = z
  .object({
    revisions: z.array(z.object({ name: nameSchema, unit: unitSchema }).strict()).min(1).max(100),
    archivedAt: archivedAtSchema,
  })
  .strict();
export type OutputDefinitionData = z.infer<typeof outputDefinitionSchema>;

/**
 * One measured result of a session (T-099, T-104, T-105, T-112, T-137, T-143, T-159): a whole
 * number of 0 or more (0 is a recorded result, unlike no record), the definition and revision,
 * the goals it is explicitly attributed to (output goals of the same definition), and its own
 * trash state for a deletion of this output alone (T-153).
 */
export const outputRecordSchema = z
  .object({
    sessionId: z.uuid(),
    definitionId: z.uuid(),
    revision: z.number().int().min(0).max(99),
    value: z.number().int().min(0).max(OUTPUT_VALUE_MAX),
    goalIds: z
      .array(z.uuid())
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, { message: "IDs must be distinct" }),
    deletedAt: instantSchema.nullable(),
  })
  .strict();
export type OutputRecordData = z.infer<typeof outputRecordSchema>;

/**
 * Every attributed goal is an output goal that tracks the output's own definition (T-112, T-137);
 * an output goal without `definitionId` tracks none. A goal's `definitionId` is set once but may
 * differ between versions (two devices linking the same earlier goal), so the file-wide check
 * accepts the goal if any known version tracks the definition; active versions are checked
 * against the live goal.
 */
export function outputRecordRule(data: Record<string, unknown>, lookup: DataLookup, lookupAll?: DataLookupAll): string | null {
  for (const goalId of data.goalIds as string[]) {
    const versions = lookupAll ? lookupAll(GOALS, goalId) : [lookup(GOALS, goalId)].filter((g) => g !== undefined);
    if (versions.length === 0) continue; // an unknown target is a link error, reported by the link checks
    if (versions.some((g) => g.kind !== "output")) return "an output counts toward output goals only";
    if (!versions.some((g) => g.definitionId === data.definitionId)) return "an output counts only toward goals that track its definition";
  }
  return null;
}

/**
 * The outputs among `outputs` that count toward goal `goalId` but would not fit its version
 * `goalData` (another definition, or none), sorted by ID. Used before a goal version becomes
 * current: the owner changes those attributions first; they are never changed automatically.
 */
export function outputsMisfittingGoal(
  goalId: string,
  goalData: Record<string, unknown>,
  outputs: readonly { id: string; data: Record<string, unknown> }[],
): string[] {
  const lookup: DataLookup = (type, id) => (type === GOALS && id === goalId ? goalData : undefined);
  return outputs
    .filter((o) => (o.data.goalIds as string[]).includes(goalId) && outputRecordRule(o.data, lookup) !== null)
    .map((o) => o.id)
    .sort();
}

export const CORRECTION_FIELDS = ["times", "value", "goal", "goals", "added", "deleted", "restored"] as const;
export type CorrectionField = (typeof CORRECTION_FIELDS)[number];

/**
 * History of one change (T-102, T-113, T-131, T-148, T-157): session times, an output's value or
 * goal attribution, an output added to an ended session, or a single output deleted or restored.
 * `outputId` is null for changes of the session itself. Append-only: never edited, appended on
 * import. Other edits (note, ratings, expected amounts, task or block link) keep no history.
 */
export const correctionSchema = z
  .object({
    sessionId: z.uuid(),
    outputId: z.uuid().nullable(),
    field: z.enum(CORRECTION_FIELDS),
    before: z.json(),
    after: z.json(),
    reason: z.string().max(REASON_MAX).nullable(),
    device: z.uuid(),
    at: instantSchema,
  })
  .strict();
export type CorrectionData = z.infer<typeof correctionSchema>;

/**
 * An explicit completion of a one-off task (`occurrenceDate` null) or of one occurrence of a
 * recurring task (T-108, T-118, T-119): its ID is derived from the task and the occurrence date,
 * so the same completion made on two devices is one record. `goalId` is the one task-count goal it
 * counts toward (null = none, T-123, T-130). Reopening sets `reopenedAt` on the same record (T-133,
 * T-147); completing again clears it. The task definition itself never changes.
 */
export const taskCompletionSchema = z
  .object({
    taskId: z.uuid(),
    occurrenceDate: localDateSchema.nullable(),
    completedAt: instantSchema,
    goalId: z.uuid().nullable(),
    reopenedAt: instantSchema.nullable(),
  })
  .strict();
export type TaskCompletionData = z.infer<typeof taskCompletionSchema>;

export function taskCompletionRule(data: Record<string, unknown>, lookup: DataLookup): string | null {
  if (!data.goalId) return null;
  const goal = lookup(GOALS, data.goalId as string);
  return goal && goal.kind !== "taskCount" ? "a completion counts toward a task-count goal only" : null;
}

export const sessionsType: RecordTypeDef = {
  type: SESSIONS,
  schema: sessionSchema as unknown as RecordTypeDef["schema"],
  links: [
    { field: "taskId", target: TASK_DEFINITIONS },
    { field: "blockId", target: CALENDAR_BLOCKS },
    { field: "goalId", target: GOALS },
    { field: "expectedOutputs", target: OUTPUT_DEFINITIONS, key: "definitionId" },
  ],
  sinceDataSchemaVersion: 6,
  rule: sessionRule,
};

export const outputDefinitionsType: RecordTypeDef = {
  type: OUTPUT_DEFINITIONS,
  schema: outputDefinitionSchema as unknown as RecordTypeDef["schema"],
  links: [],
  sinceDataSchemaVersion: 6,
};

export const outputRecordsType: RecordTypeDef = {
  type: OUTPUT_RECORDS,
  schema: outputRecordSchema as unknown as RecordTypeDef["schema"],
  links: [
    { field: "sessionId", target: SESSIONS },
    { field: "definitionId", target: OUTPUT_DEFINITIONS },
    { field: "goalIds", target: GOALS },
  ],
  sinceDataSchemaVersion: 6,
  immutableFields: ["sessionId", "definitionId"],
  rule: outputRecordRule,
};

export const correctionsType: RecordTypeDef = {
  type: CORRECTIONS,
  schema: correctionSchema as unknown as RecordTypeDef["schema"],
  links: [
    { field: "sessionId", target: SESSIONS },
    { field: "outputId", target: OUTPUT_RECORDS },
  ],
  sinceDataSchemaVersion: 6,
  appendOnly: true,
};

export const taskCompletionsType: RecordTypeDef = {
  type: TASK_COMPLETIONS,
  schema: taskCompletionSchema as unknown as RecordTypeDef["schema"],
  links: [
    { field: "taskId", target: TASK_DEFINITIONS },
    { field: "goalId", target: GOALS },
  ],
  sinceDataSchemaVersion: 6,
  immutableFields: ["taskId", "occurrenceDate"],
  rule: taskCompletionRule,
};

/**
 * Record types allowed in format version 1 product backups. Later stages add their types here
 * (with schemas, links, and a new `dataSchemaVersion` when exported data changes).
 */
export const PRODUCT_REGISTRY = createRegistry([
  preferencesType,
  projectsType,
  workstreamsType,
  taskDefinitionsType,
  calendarBlocksType,
  goalsType,
  milestonesType,
  outputDefinitionsType,
  sessionsType,
  outputRecordsType,
  correctionsType,
  taskCompletionsType,
]);

/** Data of the frozen sync code; never exported, and a file containing it is refused. */
export const EXCLUDED_RECORD_TYPES: ReadonlySet<string> = new Set(["sync_probe", "probes", "outbox", "session"]);
