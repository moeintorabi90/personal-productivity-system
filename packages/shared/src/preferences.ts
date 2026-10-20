import { z } from "zod";

export const LANGUAGES = ["en", "fa"] as const;
export const THEMES = ["system", "light", "dark"] as const;
export const CALENDAR_DISPLAYS = ["gregorian", "jalali", "both"] as const;

export type Language = (typeof LANGUAGES)[number];
export type Theme = (typeof THEMES)[number];
export type CalendarDisplay = (typeof CALENDAR_DISPLAYS)[number];

/** Right-to-left languages. Direction follows language; it never changes date arithmetic. */
export const RTL_LANGUAGES: ReadonlySet<Language> = new Set<Language>(["fa"]);

// IANA names only ("Asia/Tehran", "UTC"); rejects raw offsets such as "+03:30",
// which some Intl implementations accept but which do not follow DST rules.
const IANA_NAME = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;

export function isValidTimeZone(value: string): boolean {
  if (!IANA_NAME.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: "Must be an IANA time zone name, e.g. Asia/Tehran" });

export const preferenceFieldsSchema = z.object({
  language: z.enum(LANGUAGES),
  theme: z.enum(THEMES),
  calendarDisplay: z.enum(CALENDAR_DISPLAYS),
  /** 0 = Sunday … 6 = Saturday. */
  weekStart: z.number().int().min(0).max(6),
  /** Null until the owner explicitly chooses one; a browser suggestion is never imposed silently. */
  timeZone: timeZoneSchema.nullable(),
});

export type PreferenceFields = z.infer<typeof preferenceFieldsSchema>;

/** Defaults from docs/DECISIONS.md open decision 5 (proposal); the owner can change all of them. */
export const DEFAULT_PREFERENCES: PreferenceFields = {
  language: "en",
  theme: "system",
  calendarDisplay: "gregorian",
  weekStart: 6,
  timeZone: null,
};

export const preferencePatchSchema = preferenceFieldsSchema
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "At least one field is required" });

export type PreferencePatch = z.infer<typeof preferencePatchSchema>;

export const preferencesRecordSchema = preferenceFieldsSchema.extend({
  revision: z.number().int().min(1),
  updatedAt: z.string(),
});

export type PreferencesRecord = z.infer<typeof preferencesRecordSchema>;

export const updatePreferencesRequestSchema = z.object({
  baseRevision: z.number().int().min(1),
  changes: preferencePatchSchema,
});
