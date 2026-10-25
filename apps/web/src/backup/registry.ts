import { CALENDAR_DISPLAYS, isValidTimeZone, timeZoneSchema } from "@pps/shared";
import { z } from "zod";
import { isLocalDate, localDateOf } from "../planning/time.ts";
import { SHARED_PREFERENCES_ID } from "./limits.ts";

/** A reference from one record type to another, e.g. a task's `projectId`. */
export interface LinkDef {
  field: string;
  target: string;
}

/** Finds the data of a known version of another record (any version, or undefined if none is known). */
export type DataLookup = (type: string, id: string) => Record<string, unknown> | undefined;

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
   */
  rule?: (data: Record<string, unknown>, lookup: DataLookup) => string | null;
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

export const projectSchema = z
  .object({ name: nameSchema, description: textSchema, archivedAt: archivedAtSchema })
  .strict();
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

/**
 * A task definition: reusable task details, not evidence that work happened. Without a project it
 * is in the quick-capture inbox. `recurrence` (Stage 3, data schema version 3) is absent for a
 * task that does not recur — never null (T-025). Output metrics belong to Stage 5.
 */
export const taskDefinitionSchema = z
  .object({ ...taskDefinitionV2Shape, recurrence: recurrenceSchema.optional() })
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
  ],
  sinceDataSchemaVersion: 2,
  rule: taskDefinitionRule,
  olderSchemas: [{ untilDataSchemaVersion: 2, schema: taskDefinitionV2Schema as unknown as RecordTypeDef["schema"] }],
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

/**
 * A planned block (T-027, T-030, D-022): fixed UTC instants, the zone it was planned in and its
 * local date there, the recurring occurrence it schedules (if any), and planned/cancelled status.
 * Plans only: no completion or actual time (Stage 5).
 */
export const calendarBlockSchema = z
  .object({
    taskId: z.uuid(),
    startsAt: minuteInstantSchema,
    endsAt: minuteInstantSchema,
    timeZone: timeZoneSchema,
    localDate: localDateSchema,
    occurrenceDate: localDateSchema.nullable(),
    status: z.enum(["planned", "cancelled"]),
    snapshot: blockSnapshotSchema,
  })
  .strict()
  .superRefine((b, ctx) => {
    const minutes = (Date.parse(b.endsAt) - Date.parse(b.startsAt)) / 60_000;
    if (!(minutes > 0)) ctx.addIssue({ code: "custom", message: "endsAt must be after startsAt" });
    else if (minutes > BLOCK_MAX_MINUTES) ctx.addIssue({ code: "custom", message: "a block lasts at most 24 hours" });
    if (isValidTimeZone(b.timeZone) && isLocalDate(b.localDate) && localDateOf(b.startsAt, b.timeZone) !== b.localDate) {
      ctx.addIssue({ code: "custom", message: "localDate must be the local date of startsAt in timeZone" });
    }
  });
export type CalendarBlockData = z.infer<typeof calendarBlockSchema>;

/** Blocks link to a task definition; a task with live blocks cannot be deleted (restrict). */
export const calendarBlocksType: RecordTypeDef = {
  type: CALENDAR_BLOCKS,
  schema: calendarBlockSchema as unknown as RecordTypeDef["schema"],
  links: [{ field: "taskId", target: TASK_DEFINITIONS }],
  sinceDataSchemaVersion: 3,
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
export const goalSchema = z
  .object({
    name: nameSchema,
    description: textSchema,
    projectId: z.uuid().nullable(),
    startDate: localDateSchema,
    deadline: localDateSchema.nullable(),
    kind: z.enum(GOAL_KINDS),
    target: z.number().int().min(1),
    unit: z.string().max(UNIT_MAX).regex(/\S/, "must not be blank").optional(),
    status: z.enum(GOAL_STATUSES),
    archivedAt: archivedAtSchema,
  })
  .strict()
  .superRefine((g, ctx) => {
    if (g.deadline !== null && g.deadline < g.startDate) ctx.addIssue({ code: "custom", message: "deadline must not be before startDate" });
    if (g.target > TARGET_MAX[g.kind]) ctx.addIssue({ code: "custom", message: `target must be at most ${TARGET_MAX[g.kind]}` });
    if ((g.kind === "output") !== (g.unit !== undefined)) ctx.addIssue({ code: "custom", message: "a unit is present exactly for output goals" });
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
  links: [{ field: "projectId", target: PROJECTS }],
  sinceDataSchemaVersion: 4,
  immutableFields: ["kind"],
};

/** A milestone belongs to one goal for its whole life (T-083). */
export const milestonesType: RecordTypeDef = {
  type: MILESTONES,
  schema: milestoneSchema as unknown as RecordTypeDef["schema"],
  links: [{ field: "goalId", target: GOALS }],
  sinceDataSchemaVersion: 4,
  immutableFields: ["goalId"],
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
]);

/** Data of the frozen sync code; never exported, and a file containing it is refused. */
export const EXCLUDED_RECORD_TYPES: ReadonlySet<string> = new Set(["sync_probe", "probes", "outbox", "session"]);
