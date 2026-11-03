/**
 * The metric catalog and card date windows (DECISIONS T-193, T-197 to T-202; ARCHITECTURE "Metric
 * catalog"). A card stores only a catalog ID, its size, its window, and a goal for goal metrics;
 * every value is computed on display from records. The dictionary below is the documented source,
 * window, and formula of each metric (TESTING "metric dictionary").
 */
import type { CardWindow, DashboardCard, DashboardData, MetricId, WindowPreset } from "../backup/registry.ts";
import { addDays, type MonthCalendar, monthDates, shiftMonth, weekDates } from "../planning/time.ts";
import type { DateRange } from "./reports.ts";

export interface MetricDefinition {
  id: MetricId;
  /** Needs a goal on the card. */
  goal: boolean;
  /** Uses the card's date window (streaks and goal progress are whole-history values). */
  windowed: boolean;
  recommendedSize: DashboardCard["size"];
  /** Records it reads (documentation, shown in the metric dictionary). */
  source: string;
  formula: string;
}

export const METRIC_CATALOG: readonly MetricDefinition[] = [
  { id: "appUseStreak", goal: false, windowed: false, recommendedSize: "small", source: "appUseDays", formula: "consecutive use dates ending today (or yesterday until today is recorded); longest run of all dates" },
  { id: "workTime", goal: false, windowed: true, recommendedSize: "medium", source: "sessions (ended, not in the trash)", formula: "active work minutes split at local midnight, by project, with No project and No task kept; sample = sessions" },
  { id: "plannedVsActual", goal: false, windowed: true, recommendedSize: "medium", source: "calendarBlocks (comparison plan), sessions", formula: "planned minutes of planned blocks and actual minutes of sessions per task and local day; links are not used" },
  { id: "completions", goal: false, windowed: true, recommendedSize: "small", source: "taskCompletions (not reopened)", formula: "completed tasks and occurrences shown on a date in the window" },
  { id: "estimateAccuracy", goal: false, windowed: true, recommendedSize: "medium", source: "taskEstimateCaptures, sessions, taskCompletions", formula: "per completed occurrence: actual − captured estimate in minutes and ÷ estimate; mean over the window; sample = occurrences" },
  { id: "outputRate", goal: false, windowed: true, recommendedSize: "large", source: "outputRecords, sessions", formula: "per definition: recorded output ÷ active hours of the sessions that recorded it; weekly trend; sample = sessions" },
  { id: "goalProgress", goal: true, windowed: false, recommendedSize: "medium", source: "goal, sessions, outputRecords, taskCompletions, goalWeekPlans", formula: "actual progress ÷ target; today's, this week's, and this month's targets when allocations match" },
  { id: "goalStreaks", goal: true, windowed: false, recommendedSize: "small", source: "goal, its attributed records, goalWeekPlans", formula: "consistency and daily pace streaks: current and longest over selected opportunities" },
];

export const metricDefinition = (id: MetricId) => METRIC_CATALOG.find((m) => m.id === id)!;

/** Inclusive local-date range of a card window on `today` (week start and display calendar apply). */
export function windowRange(window: CardWindow, today: string, weekStart: number, calendar: MonthCalendar): DateRange {
  if (window.kind === "custom") return { from: window.from, to: window.to };
  return presetRange(window.preset, today, weekStart, calendar);
}

export function presetRange(preset: WindowPreset, today: string, weekStart: number, calendar: MonthCalendar): DateRange {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "last7":
      return { from: addDays(today, -6), to: today };
    case "last30":
      return { from: addDays(today, -29), to: today };
    case "last90":
      return { from: addDays(today, -89), to: today };
    case "thisWeek": {
      const days = weekDates(today, weekStart);
      return { from: days[0]!, to: days[6]! };
    }
    case "lastWeek": {
      const days = weekDates(addDays(today, -7), weekStart);
      return { from: days[0]!, to: days[6]! };
    }
    case "thisMonth": {
      const days = monthDates(today, calendar);
      return { from: days[0]!, to: days[days.length - 1]! };
    }
    case "lastMonth": {
      const days = monthDates(shiftMonth(today, calendar, -1), calendar);
      return { from: days[0]!, to: days[days.length - 1]! };
    }
    case "all":
      return { from: null, to: today };
  }
}

const card = (id: string, metric: MetricId, size: DashboardCard["size"], preset: WindowPreset): DashboardCard => ({ id, metric, size, window: { kind: "preset", preset }, goalId: null });

/**
 * The suggested layout of the main dashboard (T-198, derived during implementation): the app-use
 * streak first (T-202), then this week's work and plan, completions, estimates, and output rates.
 * Fixed card IDs, so two devices showing the untouched layout agree.
 */
export const SUGGESTED_MAIN_DASHBOARD: DashboardData = {
  name: "Main",
  cards: [
    card("00000000-0000-4000-8000-0000000000a1", "appUseStreak", "small", "all"),
    card("00000000-0000-4000-8000-0000000000a2", "completions", "small", "last7"),
    card("00000000-0000-4000-8000-0000000000a3", "workTime", "medium", "last7"),
    card("00000000-0000-4000-8000-0000000000a4", "plannedVsActual", "medium", "last7"),
    card("00000000-0000-4000-8000-0000000000a5", "estimateAccuracy", "medium", "last30"),
    card("00000000-0000-4000-8000-0000000000a6", "outputRate", "large", "last30"),
  ],
};
