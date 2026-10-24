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

const localeOf = (language: Language) => (language === "fa" ? "fa-IR" : "en-GB");

/**
 * Formats a local date (`YYYY-MM-DD`, no zone involved) in the display calendar. "Both" shows
 * the Jalali date first, then the Gregorian one, as `formatDateTime` does.
 */
export function formatLocalDate(
  date: string,
  options: { language: Language; calendarDisplay: CalendarDisplay },
  style: "long" | "medium" = "long",
): string {
  const locale = localeOf(options.language);
  const base: Intl.DateTimeFormatOptions =
    style === "long"
      ? { timeZone: "UTC", weekday: "long", year: "numeric", month: "long", day: "numeric" }
      : { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" };
  const instant = new Date(`${date}T12:00:00Z`);
  const gregorian = new Intl.DateTimeFormat(`${locale}-u-ca-gregory`, base).format(instant);
  const jalali = new Intl.DateTimeFormat(`${locale}-u-ca-persian`, base).format(instant);
  if (options.calendarDisplay === "gregorian") return gregorian;
  if (options.calendarDisplay === "jalali") return jalali;
  return `${jalali} — ${gregorian}`;
}

/** Month and year heading of a month view (T-035): Jalali for "Jalali", Gregorian otherwise. */
export function formatMonthHeading(date: string, options: { language: Language; calendarDisplay: CalendarDisplay }): string {
  const calendar = options.calendarDisplay === "jalali" ? "persian" : "gregory";
  return new Intl.DateTimeFormat(`${localeOf(options.language)}-u-ca-${calendar}`, {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
  }).format(new Date(`${date}T12:00:00Z`));
}

/** Day number of a date in a calendar, in the language's digits. */
export function formatDayNumber(date: string, calendar: "gregorian" | "jalali", language: Language): string {
  return new Intl.DateTimeFormat(`${localeOf(language)}-u-ca-${calendar === "jalali" ? "persian" : "gregory"}`, {
    timeZone: "UTC",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00Z`));
}

/** `HH:MM` of an instant in a zone (24-hour clock, language digits). */
export function formatTime(instant: string | number, zone: string, language: Language): string {
  return new Intl.DateTimeFormat(`${localeOf(language)}-u-ca-gregory`, {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
}

/** Short weekday name of a weekday number (0 = Sunday). */
export function formatWeekdayShort(weekday: number, language: Language): string {
  // 2023-01-01 was a Sunday.
  return new Intl.DateTimeFormat(localeOf(language), { timeZone: "UTC", weekday: "short" }).format(
    new Date(Date.UTC(2023, 0, 1 + weekday, 12)),
  );
}

export type { MessageKey } from "./en.ts";
