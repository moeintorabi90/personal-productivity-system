/**
 * Built-in metric cards (DECISIONS T-193, T-195 to T-202): each card computes its catalog metric on
 * display from records, in its own date window, and shows its sample count; "no data for this
 * period" is shown apart from a real zero. Small cards show the number and label, medium a short
 * chart, large the full chart and table (derived "Recommended card sizes").
 */
import { usePreferences, useT } from "../app-context.tsx";
import type { CardSize, CardWindow, GoalData, MetricId, OutputDefinitionData } from "../backup/registry.ts";
import { formatLocalDate, type MessageKey } from "../i18n/index.ts";
import { minutesByLocalDay } from "../insights/actuals.ts";
import { roundForDisplay } from "../insights/fraction.ts";
import { windowRange } from "../insights/metrics.ts";
import { appUseStreak, type DateRange, estimateRows, estimateSummary, inRange, outputRates, plannedVersusActual, reportSessions, workTotals } from "../insights/reports.ts";
import { definitionLabel } from "../local/work.ts";
import { addDays, datesBetween } from "../planning/time.ts";
import { completionDate } from "../work/completions.ts";
import { BarChart, LineChart } from "./charts.tsx";
import { formatAmount } from "./GoalPace.tsx";
import { goalInsight, type InsightsCtx } from "./insights-hooks.ts";
import { formatMinutes } from "./planning-ui.tsx";

/** A window with a concrete first day: "all" starts at the first recorded day (or today). */
export function concreteRange(ctx: InsightsCtx, window: CardWindow): { from: string; to: string } {
  const r: DateRange = windowRange(window, ctx.today, ctx.weekStart, ctx.calendar);
  if (r.from !== null) return { from: r.from, to: r.to };
  const firstSession = ctx.work.sessions.map((s) => s.data.localDate).sort()[0];
  const firstUse = ctx.records.appUseDates[0];
  const first = [firstSession, firstUse].filter((d): d is string => !!d).sort()[0] ?? ctx.today;
  return { from: first < r.to ? first : r.to, to: r.to };
}

/** At most this many points on a chart: longer windows are grouped by week. */
const MAX_POINTS = 31;

function dayBuckets(range: { from: string; to: string }): { from: string; to: string }[] {
  const days = datesBetween(range.from, range.to);
  if (days.length <= MAX_POINTS) return days.map((d) => ({ from: d, to: d }));
  const out: { from: string; to: string }[] = [];
  for (let i = 0; i < days.length; i += 7) out.push({ from: days[i]!, to: days[Math.min(i + 6, days.length - 1)]! });
  return out;
}

export function MetricBody({ ctx, metric, window, size, goalId }: { ctx: InsightsCtx; metric: MetricId; window: CardWindow; size: CardSize; goalId: string | null }) {
  const t = useT();
  const prefs = usePreferences();
  const range = concreteRange(ctx, window);
  const buckets = dayBuckets(range);
  const label = (b: { from: string; to: string }) => formatLocalDate(b.from, prefs, "medium");
  const chart = size !== "small";
  const definitions = new Map<string, OutputDefinitionData>(ctx.work.definitions.map((d) => [d.id, d.data]));

  switch (metric) {
    case "appUseStreak": {
      const s = appUseStreak(ctx.records.appUseDates, ctx.today);
      return (
        <div data-testid="metric-appUseStreak">
          <p className="metric-number">{t("metric.days", { n: s.current })}</p>
          <p className="hint">{t("metric.appUse.detail", { longest: s.longest, days: s.days })}</p>
        </div>
      );
    }
    case "workTime": {
      const totals = workTotals(ctx.work.sessions, range, ctx.zone, ctx.tasks, ctx.projectNames);
      if (totals.sessions === 0) return <NoData />;
      const points = buckets.map((b) => ({ label: label(b), value: workTotals(ctx.work.sessions, b, ctx.zone, ctx.tasks, ctx.projectNames).minutes }));
      return (
        <div data-testid="metric-workTime">
          <p className="metric-number">{formatMinutes(t, totals.minutes)}</p>
          <p className="hint">{t("metric.samples", { count: totals.sessions })}</p>
          {chart ? <BarChart points={points} title={t("metric.workTime")} columns={[t("report.date"), t("report.minutes")]} compact={size === "medium"} /> : null}
          {size === "large" || size === "medium" ? (
            <ul className="count-list">
              {totals.byProject.map((p) => (
                <li key={p.projectId ?? ""}>
                  {p.projectId ? (p.name ?? t("org.unknownItem")) : t("report.noProject")}: {formatMinutes(t, p.minutes)} ({t("metric.samples", { count: p.sessions })})
                </li>
              ))}
              <li>
                {t("work.noTask")}: {formatMinutes(t, totals.noTaskMinutes)} ({t("metric.samples", { count: totals.noTaskSessions })})
              </li>
            </ul>
          ) : null}
        </div>
      );
    }
    case "plannedVsActual": {
      const rows = plannedVersusActual(ctx.blocks, ctx.work.sessions, range, ctx.zone, ctx.tasks);
      if (rows.length === 0) return <NoData />;
      const planned = rows.reduce((s, r) => s + r.plannedMinutes, 0);
      const actual = rows.reduce((s, r) => s + r.actualMinutes, 0);
      const points = buckets.map((b) => {
        const inB = rows.filter((r) => r.date >= b.from && r.date <= b.to);
        return { label: label(b), value: inB.reduce((s, r) => s + r.plannedMinutes, 0), value2: inB.reduce((s, r) => s + r.actualMinutes, 0) };
      });
      return (
        <div data-testid="metric-plannedVsActual">
          <p className="metric-number">{t("metric.plannedActual", { planned: formatMinutes(t, planned), actual: formatMinutes(t, actual) })}</p>
          <p className="hint">{t("metric.samples", { count: rows.length })}</p>
          {chart ? <BarChart points={points} title={t("metric.plannedVsActual")} columns={[t("report.date"), t("grid.planned"), t("grid.actual")]} compact={size === "medium"} /> : null}
          {size === "large" ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t("report.date")}</th>
                  <th scope="col">{t("report.task")}</th>
                  <th scope="col">{t("grid.planned")}</th>
                  <th scope="col">{t("grid.actual")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.date}/${r.taskId}`}>
                    <td>{formatLocalDate(r.date, prefs, "medium")}</td>
                    <td>{r.title ?? t("work.noTask")}</td>
                    <td>{formatMinutes(t, r.plannedMinutes)}</td>
                    <td>{formatMinutes(t, r.actualMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      );
    }
    case "completions": {
      const done = ctx.work.completions.filter((c) => c.data.reopenedAt === null && inRange(completionDate(c.data, ctx.zone), range));
      const points = buckets.map((b) => ({ label: label(b), value: done.filter((c) => { const d = completionDate(c.data, ctx.zone); return d >= b.from && d <= b.to; }).length }));
      return (
        <div data-testid="metric-completions">
          <p className="metric-number">{done.length}</p>
          <p className="hint">{t("metric.completions.detail")}</p>
          {chart ? <BarChart points={points} title={t("metric.completions")} columns={[t("report.date"), t("metric.completions")]} compact={size === "medium"} /> : null}
        </div>
      );
    }
    case "estimateAccuracy": {
      const { rows, unassignedSessions } = estimateRows(ctx.tasks, ctx.captures, ctx.work.completions, ctx.work.sessions, ctx.zone, ctx.now);
      const summary = estimateSummary(rows, range);
      if (summary.samples === 0) return <NoData extra={unassignedSessions ? t("report.unassigned", { count: unassignedSessions }) : undefined} />;
      return (
        <div data-testid="metric-estimateAccuracy">
          <p className="metric-number">{t("metric.estimate.mean", { minutes: Math.round(summary.meanDifference!), percent: Math.round(summary.meanRatio! * 100) })}</p>
          <p className="hint">{t("metric.samples", { count: summary.samples })}</p>
          {size === "large" ? <EstimateTable ctx={ctx} rows={rows.filter((r) => r.completed && r.completedOn !== null && inRange(r.completedOn, range))} /> : null}
          {unassignedSessions ? <p className="hint">{t("report.unassigned", { count: unassignedSessions })}</p> : null}
        </div>
      );
    }
    case "outputRate": {
      const rates = outputRates(ctx.work.outputs, ctx.work.sessions, range);
      if (rates.length === 0) return <NoData />;
      return (
        <div data-testid="metric-outputRate">
          {rates.map((r) => {
            const def = definitions.get(r.definitionId);
            const unit = def ? definitionLabel(def).unit : "";
            const name = def ? definitionLabel(def).name : t("org.unknownItem");
            return (
              <div key={r.definitionId} className="metric-rate">
                <p>
                  <strong>{name}</strong>: {r.perHour === null ? t("report.noData") : t("metric.rate", { rate: Math.round(r.perHour * 100) / 100, unit })}{" "}
                  <span className="hint">({t("metric.samples", { count: r.samples })})</span>
                </p>
                {chart ? (
                  <LineChart
                    points={r.trend.map((b) => ({ label: formatLocalDate(b.from, prefs, "medium"), value: b.perHour === null ? null : Math.round(b.perHour * 100) / 100 }))}
                    title={t("metric.rateTrend", { name })}
                    columns={[t("report.week"), t("metric.ratePerHour", { unit })]}
                    compact={size === "medium"}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      );
    }
    case "goalProgress":
    case "goalStreaks": {
      const goal = goalId ? ctx.goals.goals.find((g) => g.id === goalId) : undefined;
      if (!goal) return <p className="hint" data-testid="goal-unavailable">{t("metric.goalUnavailable")}</p>;
      const g = goalInsight(ctx, goal.id, goal.data);
      return metric === "goalProgress" ? (
        <GoalProgressBody goal={goal.data} name={goal.data.name} g={g} definitions={definitions} size={size} />
      ) : (
        <div data-testid="metric-goalStreaks">
          <p className="metric-number">{t("metric.days", { n: g.consistency.current })}</p>
          <p className="hint">{goal.data.name}</p>
          <p className="hint">{t("pace.consistencyStreak", { current: g.consistency.current, longest: g.consistency.longest, count: g.consistency.counted })}</p>
          <p className="hint">{t("pace.paceStreak", { current: g.pace.current, longest: g.pace.longest, count: g.pace.counted })}</p>
        </div>
      );
    }
  }
}

function GoalProgressBody({ goal, name, g, definitions, size }: { goal: GoalData; name: string; g: ReturnType<typeof goalInsight>; definitions: Map<string, OutputDefinitionData>; size: CardSize }) {
  const t = useT();
  const amount = (v: Parameters<typeof formatAmount>[2]) => formatAmount(t, goal, v, definitions);
  return (
    <div data-testid="metric-goalProgress">
      <p className="metric-number">{goal.target > 0 ? `${Math.round((g.progress / goal.target) * 100)}%` : "—"}</p>
      <p className="hint">
        {name}: {amount(g.progress)} / {amount(goal.target)}
      </p>
      {size !== "small" ? (
        <p className="hint">
          {t("pace.today")}: {g.today.kind === "target" ? amount(g.today.target) : t(`pace.noTarget.${g.today.reason}` as MessageKey)}
          {t("stage6.sep")}
          {t("pace.week")}:{" "}
          {g.week ? amount(g.week.target) : t("pace.noPeriodTarget")}
        </p>
      ) : null}
      {g.cap?.unreachable ? <p className="notice notice-warn">{t("pace.capWarning", { max: amount(g.cap.maxProjected), target: amount(goal.target), days: g.cap.remainingWorkdays })}</p> : null}
      {g.allocation.result.kind === "mismatch" ? <p className="notice notice-warn">{t("pace.mismatchShort")}</p> : null}
    </div>
  );
}

export function EstimateTable({ ctx, rows }: { ctx: InsightsCtx; rows: ReturnType<typeof estimateRows>["rows"] }) {
  const t = useT();
  const prefs = usePreferences();
  return (
    <table className="data-table" data-testid="estimate-table">
      <thead>
        <tr>
          <th scope="col">{t("report.task")}</th>
          <th scope="col">{t("report.occurrence")}</th>
          <th scope="col">{t("report.estimate")}</th>
          <th scope="col">{t("report.actual")}</th>
          <th scope="col">{t("report.difference")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.taskId}/${r.occurrenceDate}`}>
            <td>{r.title || t("org.unknownItem")}</td>
            <td>{r.occurrenceDate ? formatLocalDate(r.occurrenceDate, prefs, "medium") : t("report.oneOff")}</td>
            <td>{r.estimateMinutes === null ? t("report.noData") : formatMinutes(t, r.estimateMinutes)}</td>
            <td>
              {formatMinutes(t, r.actualMinutes)}
              {r.completed ? "" : ` (${t("report.elapsed")})`}
            </td>
            <td>
              {r.differenceMinutes === null
                ? r.completed
                  ? t("report.noData")
                  : t("report.notCompleted")
                : t("report.differenceValue", { minutes: r.differenceMinutes, percent: Math.round(r.differenceRatio! * 100) })}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NoData({ extra }: { extra?: string }) {
  const t = useT();
  return (
    <div>
      <p className="metric-number muted" data-testid="no-data">
        {t("report.noData")}
      </p>
      {extra ? <p className="hint">{extra}</p> : null}
    </div>
  );
}

/** Sessions shown on a day, for the reports' table of work without a task (T-192). */
export const sessionsOn = (ctx: InsightsCtx, date: string) => reportSessions(ctx.work.sessions).filter((s) => minutesByLocalDay(s.data, ctx.zone).has(date));

export const roundAmount = roundForDisplay;
export const lastDays = (today: string, n: number) => ({ from: addDays(today, -(n - 1)), to: today });
