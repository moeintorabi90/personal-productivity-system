/**
 * Reports: every built-in metric on one page for a chosen window (DECISIONS T-188 to T-197), with
 * the estimate and planned-versus-actual comparisons kept separate (T-188) and the metric
 * dictionary (source, window, formula) shown with them. Report-only: nothing is written.
 */
import { useId, useState } from "react";
import { useT } from "../app-context.tsx";
import { type CardWindow, WINDOW_PRESETS, type WindowPreset } from "../backup/registry.ts";
import type { MessageKey } from "../i18n/index.ts";
import { METRIC_CATALOG } from "../insights/metrics.ts";
import { estimateRows } from "../insights/reports.ts";
import { useInsights } from "./insights-hooks.ts";
import { EstimateTable, MetricBody } from "./metric-cards.tsx";
import { DateField } from "./planning-ui.tsx";

export function ReportsView() {
  const t = useT();
  const ctx = useInsights();
  const ids = { preset: useId() };
  const [window, setWindow] = useState<CardWindow>({ kind: "preset", preset: "last30" });
  const [custom, setCustom] = useState({ from: "", to: "" });
  if (!ctx) return null;
  const goals = ctx.goals.goals.filter((g) => g.data.archivedAt === null);
  const { rows } = estimateRows(ctx.tasks, ctx.captures, ctx.work.completions, ctx.work.sessions, ctx.zone, ctx.now);
  const open = rows.filter((r) => !r.completed && r.actualMinutes > 0);
  return (
    <>
      <section className="card" aria-labelledby="reports-title">
        <h1 id="reports-title">{t("report.title")}</h1>
        <p className="hint">{t("report.intro")}</p>
        <div className="filters">
          <div className="field">
            <label htmlFor={ids.preset}>{t("dash.window")}</label>
            <select
              id={ids.preset}
              value={window.kind === "preset" ? window.preset : "custom"}
              onChange={(e) => (e.target.value === "custom" ? setWindow({ kind: "custom", from: custom.from || ctx.today, to: custom.to || ctx.today }) : setWindow({ kind: "preset", preset: e.target.value as WindowPreset }))}
            >
              {WINDOW_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {t(`window.${p}` as MessageKey)}
                </option>
              ))}
              <option value="custom">{t("window.custom")}</option>
            </select>
          </div>
          {window.kind === "custom" ? (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (custom.from && custom.to && custom.to >= custom.from) setWindow({ kind: "custom", ...custom });
              }}
            >
              <DateField label={t("window.from")} value={custom.from} onChange={(from) => setCustom({ ...custom, from })} />
              <DateField label={t("window.to")} value={custom.to} onChange={(to) => setCustom({ ...custom, to })} />
              <button type="submit" disabled={!(custom.from && custom.to && custom.to >= custom.from)}>
                {t("dash.applyWindow")}
              </button>
            </form>
          ) : null}
        </div>
      </section>
      <ol className="dash-grid" data-testid="report-grid">
        {METRIC_CATALOG.filter((m) => !m.goal).map((m) => (
          <li key={m.id} className="dash-card" data-size="large" data-metric={m.id}>
            <h2>{t(`metric.${m.id}` as MessageKey)}</h2>
            <MetricBody ctx={ctx} metric={m.id} window={window} size="large" goalId={null} />
          </li>
        ))}
        {goals.flatMap((g) =>
          (["goalProgress", "goalStreaks"] as const).map((metric) => (
            <li key={`${g.id}/${metric}`} className="dash-card" data-size="medium" data-metric={metric}>
              <h2>{t(`metric.${metric}` as MessageKey)}</h2>
              <MetricBody ctx={ctx} metric={metric} window={window} size="medium" goalId={g.id} />
            </li>
          )),
        )}
      </ol>
      {open.length > 0 ? (
        <section className="card" aria-labelledby="ongoing-title">
          <h2 id="ongoing-title">{t("report.ongoing")}</h2>
          <p className="hint">{t("report.ongoingHint")}</p>
          <EstimateTable ctx={ctx} rows={open} />
        </section>
      ) : null}
      <section className="card" aria-labelledby="dictionary-title" data-testid="metric-dictionary">
        <h2 id="dictionary-title">{t("report.dictionary")}</h2>
        <dl className="field-list">
          {METRIC_CATALOG.map((m) => (
            <div key={m.id}>
              <dt>{t(`metric.${m.id}` as MessageKey)}</dt>
              <dd>
                {t(`metric.${m.id}.formula` as MessageKey)} <span className="hint">({m.source}; {m.windowed ? t("report.windowed") : t("report.wholeHistory")})</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
