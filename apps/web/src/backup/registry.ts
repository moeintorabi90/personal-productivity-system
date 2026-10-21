import { CALENDAR_DISPLAYS, timeZoneSchema } from "@pps/shared";
import { z } from "zod";
import { SHARED_PREFERENCES_ID } from "./limits.ts";

/** A reference from one record type to another, e.g. a task's `projectId`. */
export interface LinkDef {
  field: string;
  target: string;
}

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

/**
 * Record types allowed in format version 1 product backups. Later stages add their types here
 * (with schemas, links, and a new `dataSchemaVersion` when exported data changes).
 */
export const PRODUCT_REGISTRY = createRegistry([preferencesType]);

/** Data of the frozen sync code; never exported, and a file containing it is refused. */
export const EXCLUDED_RECORD_TYPES: ReadonlySet<string> = new Set(["sync_probe", "probes", "outbox", "session"]);
