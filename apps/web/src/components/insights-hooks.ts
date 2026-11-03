/**
 * Live data for the Stage 6 screens (dashboards, reports, goal pace): everything is read from the
 * device and every value is computed on display (DECISIONS T-196; ARCHITECTURE "Pure domain
 * modules"). Also records app-use dates while the app is visible (T-203).
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo } from "react";
import { usePreferences, useServices } from "../app-context.tsx";
import type { GoalData, TaskDefinitionData, TaskEstimateCaptureData } from "../backup/registry.ts";
import { goalDays } from "../insights/actuals.ts";
import { allocationState, loadGoalPlanning, type GoalPlanning } from "../local/goal-plans.ts";
import { loadInsightRecords, recordAppUse, type InsightRecords } from "../local/insights.ts";
import { getDevice } from "../local/repository.ts";
import { getSharedPreferences } from "../local/settings.ts";
import type { Goals } from "../local/goals.ts";
import type { Organization } from "../local/organization.ts";
import type { WorkData } from "../local/work.ts";
import { localDateOf } from "../planning/time.ts";
import { capProjection, consistencyStreak, dailyTargetOn, monthTarget, paceStreak, type PaceInput, weekTarget } from "../insights/pace.ts";
import { monthDates } from "../planning/time.ts";
import { goalProgress } from "../work/progress.ts";
import { useGoals, useOrganization, useWork } from "./data-hooks.ts";
import { useBlocks } from "./planning-ui.tsx";
import { useNow } from "./work-ui.tsx";

export interface InsightsCtx {
  org: Organization;
  goals: Goals;
  work: WorkData;
  blocks: NonNullable<ReturnType<typeof useBlocks>>;
  planning: GoalPlanning;
  records: InsightRecords;
  tasks: Map<string, TaskDefinitionData>;
  captures: Map<string, TaskEstimateCaptureData>;
  projectNames: Map<string, string>;
  deviceId: string;
  zone: string;
  today: string;
  now: number;
  weekStart: number;
  calendar: "gregorian" | "jalali";
}

/** Everything the Stage 6 screens read, or null while loading. Without a zone, the device's is used (T-086). */
export function useInsights(): InsightsCtx | null {
  const { db } = useServices();
  const org = useOrganization();
  const goals = useGoals();
  const work = useWork();
  const blocks = useBlocks();
  const planning = useLiveQuery(() => loadGoalPlanning(db), [db]);
  const records = useLiveQuery(() => loadInsightRecords(db), [db]);
  const device = useLiveQuery(() => getDevice(db), [db]);
  // The stored preferences, not the defaults shown while loading: weeks and days depend on them.
  const shared = useLiveQuery(() => getSharedPreferences(db), [db]);
  const prefs = usePreferences();
  const now = useNow(60_000);
  return useMemo(() => {
    if (!org || !goals || !work || !blocks || !planning || !records || !device || !shared) return null;
    const zone = shared.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    return {
      org,
      goals,
      work,
      blocks,
      planning,
      records,
      tasks: new Map(org.tasks.map((t) => [t.id, t.data])),
      captures: new Map(records.captures.map((c) => [c.id, c.data])),
      projectNames: new Map(org.projects.map((p) => [p.id, p.data.name])),
      deviceId: device.id,
      zone,
      today: localDateOf(now, zone),
      now,
      weekStart: shared.weekStart,
      calendar: prefs.calendarDisplay === "jalali" ? "jalali" : "gregorian",
    };
  }, [org, goals, work, blocks, planning, records, device, shared, prefs.calendarDisplay, now]);
}

/** Everything the goal page and goal cards show for one goal, derived on display. */
export function goalInsight(ctx: InsightsCtx, goalId: string, goal: GoalData) {
  const days = goalDays(goalId, goal, ctx.work, ctx.zone);
  const progress = goalProgress(goalId, goal, ctx.work);
  const plans = ctx.planning.plans.filter((p) => p.data.goalId === goalId).map((p) => p.data);
  const input: PaceInput = { goalId, goal, plans, thisDevice: ctx.deviceId, amounts: days.amounts, today: ctx.today };
  const allocation = allocationState(goalId, goal, days.amounts, ctx.planning.allocations, ctx.today, ctx.weekStart);
  return {
    progress,
    days,
    plans,
    allocation,
    today: dailyTargetOn(input, ctx.today),
    week: weekTarget(input, ctx.weekStart),
    month: monthTarget(input, allocation.result, monthDates(ctx.today, ctx.calendar), ctx.weekStart),
    cap: capProjection(goal, progress, ctx.today),
    pace: paceStreak(input),
    consistency: consistencyStreak(goal, days.attributed, ctx.today),
    deadlinePassed: goal.deadline !== null && goal.deadline < ctx.today && goal.status !== "completed",
    input,
  };
}

/**
 * Writes today's use date while the app is visible: when it is first shown, when it becomes
 * visible again, and at local midnight while it stays open (checked every minute), at most once
 * per date; nothing is written while hidden (T-203; derived).
 */
export function useAppUseRecording(): void {
  const { db } = useServices();
  const { db: zoneDb } = useServices();
  const zone = useLiveQuery(() => getSharedPreferences(zoneDb), [zoneDb])?.timeZone ?? null;
  useEffect(() => {
    let last = "";
    const record = () => {
      if (document.visibilityState !== "visible") return;
      const key = localDateOf(Date.now(), zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
      if (key === last) return;
      last = key;
      recordAppUse(db).catch((e: unknown) => console.error("Could not record app use", e));
    };
    record();
    const onVisible = () => {
      last = "";
      record();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(record, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [db, zone]);
}
