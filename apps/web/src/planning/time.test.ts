/**
 * Stage 3 date/time (docs/TESTING.md "Stage 3 acceptance tests" 1–5): fixed dates and zones, so
 * results never depend on the machine's clock or zone.
 */
import { describe, expect, it } from "vitest";
import { createTranslator, formatLocalDate } from "../i18n/index.ts";
import {
  addDays,
  formatOffset,
  fromJalali,
  isLocalDate,
  localDateOf,
  localDayBounds,
  monthDates,
  offsetMinutesAt,
  resolveWallTime,
  shiftMonth,
  toJalali,
  wallTimeOf,
  weekDates,
  weekdayOf,
} from "./time.ts";

describe("1. local dates come from the configured zone", () => {
  it("one instant is a different local date in New York and Tehran", () => {
    const instant = "2026-11-02T03:00:00.000Z";
    expect(localDateOf(instant, "America/New_York")).toBe("2026-11-01");
    expect(localDateOf(instant, "Asia/Tehran")).toBe("2026-11-02");
    expect(wallTimeOf(instant, "Asia/Tehran")).toBe("06:30");
    expect(wallTimeOf(instant, "America/New_York")).toBe("22:00");
  });

  it("validates local dates strictly", () => {
    expect(isLocalDate("2026-02-28")).toBe(true);
    expect(isLocalDate("2026-02-29")).toBe(false);
    expect(isLocalDate("2028-02-29")).toBe(true);
    expect(isLocalDate("2026-2-1")).toBe(false);
    expect(isLocalDate("2026-13-01")).toBe(false);
  });
});

describe("2. weeks start on the configured week start", () => {
  it("covers every week start 0–6; Saturday (default) gives Saturday–Friday", () => {
    for (let start = 0; start < 7; start++) {
      const week = weekDates("2026-11-04", start); // a Wednesday
      expect(week).toHaveLength(7);
      expect(weekdayOf(week[0]!)).toBe(start);
      expect(week).toContain("2026-11-04");
      expect(week[6]).toBe(addDays(week[0]!, 6));
    }
    expect(weekDates("2026-11-04", 6)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]);
    expect(weekdayOf("2026-10-31")).toBe(6);
  });
});

describe("3–4. language and display calendar change only formatting", () => {
  it("dates, weeks, and months are the same whatever the language; labels differ", () => {
    // The calculations take no language at all; formatting is the only language-dependent part.
    const en = formatLocalDate("2026-11-02", { language: "en", calendarDisplay: "gregorian" });
    const fa = formatLocalDate("2026-11-02", { language: "fa", calendarDisplay: "gregorian" });
    expect(en).toContain("2026");
    expect(fa).not.toBe(en);
    expect(createTranslator("fa")("weekday.1")).toBe("دوشنبه");
  });

  it("Jalali conversion, month boundaries, and the leap year (30 Esfand 1403)", () => {
    expect(toJalali("2026-03-21")).toEqual({ year: 1405, month: 1, day: 1 });
    expect(fromJalali(1405, 1, 1)).toBe("2026-03-21");
    expect(fromJalali(1403, 12, 30)).toBe("2025-03-20"); // 1403 is a leap year
    expect(fromJalali(1404, 12, 30)).toBeNull(); // 1404 is not
    expect(fromJalali(1404, 7, 31)).toBeNull(); // Mehr has 30 days
    const esfand1403 = monthDates("2025-03-01", "jalali");
    expect(esfand1403[0]).toBe("2025-02-19");
    expect(esfand1403).toHaveLength(30);
    const esfand1404 = monthDates("2026-03-01", "jalali");
    expect(esfand1404).toHaveLength(29);
    const farvardin = monthDates("2026-04-01", "jalali");
    expect([farvardin[0], farvardin.at(-1), farvardin.length]).toEqual(["2026-03-21", "2026-04-20", 31]);
    expect(monthDates("2026-02-10", "gregorian")).toHaveLength(28);
    expect(shiftMonth("2026-03-25", "jalali", 1)).toBe("2026-04-21");
    expect(shiftMonth("2026-03-25", "jalali", -1)).toBe("2026-02-20");
    expect(shiftMonth("2026-01-31", "gregorian", 1)).toBe("2026-02-01");
  });

  it("Gregorian / Jalali / Both format the same stored date", () => {
    const opts = { language: "en" as const };
    const g = formatLocalDate("2026-03-21", { ...opts, calendarDisplay: "gregorian" });
    const j = formatLocalDate("2026-03-21", { ...opts, calendarDisplay: "jalali" });
    const both = formatLocalDate("2026-03-21", { ...opts, calendarDisplay: "both" });
    expect(g).toContain("2026");
    expect(j).toContain("1405");
    expect(both).toBe(`${j} — ${g}`);
  });
});

describe("5. daylight saving (Europe/London) and a zone without it (Asia/Tehran)", () => {
  it("a wall time in the spring gap is refused, not shifted", () => {
    // 2026-03-29: London clocks go from 01:00 to 02:00.
    expect(resolveWallTime("2026-03-29", "01:30", "Europe/London")).toEqual({ kind: "gap" });
    expect(resolveWallTime("2026-03-29", "02:00", "Europe/London")).toMatchObject({ kind: "ok", instant: "2026-03-29T01:00:00.000Z" });
  });

  it("an ambiguous wall time resolves to the earlier instant and reports its offset", () => {
    // 2026-10-25: London clocks go back from 02:00 BST to 01:00 GMT, so 01:30 happens twice.
    const r = resolveWallTime("2026-10-25", "01:30", "Europe/London");
    expect(r).toEqual({ kind: "ok", instant: "2026-10-25T00:30:00.000Z", offsetMinutes: 60, ambiguous: true });
    expect(formatOffset(60)).toBe("UTC+01:00");
    expect(formatOffset(210)).toBe("UTC+03:30");
    expect(formatOffset(-300)).toBe("UTC−05:00");
    expect(resolveWallTime("2026-10-25", "03:00", "Europe/London")).toMatchObject({ ambiguous: false, offsetMinutes: 0 });
  });

  it("23- and 25-hour days; Tehran days are always 24 hours", () => {
    const hours = (date: string, zone: string) => {
      const [s, e] = localDayBounds(date, zone);
      return (e - s) / 3_600_000;
    };
    expect(hours("2026-03-29", "Europe/London")).toBe(23);
    expect(hours("2026-10-25", "Europe/London")).toBe(25);
    expect(hours("2026-10-26", "Europe/London")).toBe(24);
    expect(hours("2026-03-22", "Asia/Tehran")).toBe(24);
    expect(offsetMinutesAt("2026-06-01T00:00:00Z", "Asia/Tehran")).toBe(210);
    expect(resolveWallTime("2026-03-22", "00:30", "Asia/Tehran")).toMatchObject({ kind: "ok", ambiguous: false });
  });

  it("a day that starts at 01:00 because of a DST change at midnight starts at its first instant", () => {
    // America/Havana springs forward at 00:00 → 01:00 (2026-03-08).
    const [start] = localDayBounds("2026-03-08", "America/Havana");
    expect(localDateOf(start, "America/Havana")).toBe("2026-03-08");
    expect(localDateOf(start - 60_000, "America/Havana")).toBe("2026-03-07");
    expect(wallTimeOf(start, "America/Havana")).toBe("01:00");
  });
});
