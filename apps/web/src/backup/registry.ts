import { CALENDAR_DISPLAYS, timeZoneSchema } from "@pps/shared";
import { z } from "zod";
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

/** The registry as seen by a file of `dataSchemaVersion`: types introduced later are unknown. */
export function registryForDataSchemaVersion(registry: Registry, dataSchemaVersion: number): Registry {
  const defs = [...registry.types.values()].filter((def) => (def.sinceDataSchemaVersion ?? 1) <= dataSchemaVersion);
  return defs.length === registry.types.size ? registry : createRegistry(defs);
}

/** Shared, transferable preferences (D-017). Language and theme are device-local and not here. */
export const sharedPreferencesSchema = z
  .object({
    timeZone: timeZoneSchema.nullable(),
    weekStart: z.number().int().min(0).max(6),
    calendarDisplay: z.enum(CALENDAR_DISPLAYS),
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

/**
 * A task definition: reusable task details, not evidence that work happened. Without a project it
 * is in the quick-capture inbox. Recurrence, active weekdays, and output metrics belong to later
 * stages (calendar, outputs) and are not fields yet.
 */
export const taskDefinitionSchema = z
  .object({
    title: nameSchema,
    notes: textSchema,
    projectId: z.uuid().nullable(),
    workstreamId: z.uuid().nullable(),
    nextAction: z.string().max(NEXT_ACTION_MAX),
    estimateMinutes: z.number().int().min(1).max(ESTIMATE_MAX_MINUTES).nullable(),
    archivedAt: archivedAtSchema,
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
};

/**
 * Record types allowed in format version 1 product backups. Later stages add their types here
 * (with schemas, links, and a new `dataSchemaVersion` when exported data changes).
 */
export const PRODUCT_REGISTRY = createRegistry([preferencesType, projectsType, workstreamsType, taskDefinitionsType]);

/** Data of the frozen sync code; never exported, and a file containing it is refused. */
export const EXCLUDED_RECORD_TYPES: ReadonlySet<string> = new Set(["sync_probe", "probes", "outbox", "session"]);
