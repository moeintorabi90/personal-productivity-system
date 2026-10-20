import { type CalendarDisplay, type Language, RTL_LANGUAGES } from "@pps/shared";
import { en, type MessageKey, type Messages } from "./en.ts";
import { fa } from "./fa.ts";

const catalogs: Record<Language, Messages> = { en, fa };

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function createTranslator(language: Language): Translate {
  const catalog = catalogs[language];
  const numberFormat = new Intl.NumberFormat(language === "fa" ? "fa-IR" : "en-US");
  return (key, vars) =>
    catalog[key].replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = vars?.[name];
      if (value === undefined) return match;
      return typeof value === "number" ? numberFormat.format(value) : value;
    });
}

export function directionOf(language: Language): "rtl" | "ltr" {
  return RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
}

/**
 * Formats an instant for display. Calendar choice and language only change presentation;
 * the stored value is always a UTC ISO timestamp.
 */
export function formatDateTime(
  iso: string,
  options: { language: Language; calendarDisplay: CalendarDisplay; timeZone: string | null },
): string {
  const locale = options.language === "fa" ? "fa-IR" : "en-GB";
  const base: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  };
  const date = new Date(iso);
  const gregorian = new Intl.DateTimeFormat(`${locale}-u-ca-gregory`, base).format(date);
  const jalali = new Intl.DateTimeFormat(`${locale}-u-ca-persian`, base).format(date);
  if (options.calendarDisplay === "gregorian") return gregorian;
  if (options.calendarDisplay === "jalali") return jalali;
  return `${jalali} — ${gregorian}`;
}

export type { MessageKey } from "./en.ts";
