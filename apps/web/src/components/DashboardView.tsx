/**
 * Dashboards (PRODUCT_SPEC "Dashboards"; DECISIONS T-197 to T-202): the main dashboard starts with
 * an editable suggested layout and cannot be deleted; optional dashboards can be added. Cards are
 * catalog metrics only (no formulas), each with its own preset or custom window, and can be added,
 * removed, reordered, and resized. Layout, names, and windows travel in backups; the presentation
 * adapts to the screen (four columns wide, two below 560 px; stored order kept).
 */
import { useId, useState } from "react";
import { useServices, useT } from "../app-context.tsx";
import {
  CARD_SIZES,
  type CardSize,
  type CardWindow,
  type DashboardCard,
  type DashboardData,
  MAIN_DASHBOARD_ID,
  type MetricId,
  WINDOW_PRESETS,
  type WindowPreset,
} from "../backup/registry.ts";
import type { MessageKey } from "../i18n/index.ts";
import { METRIC_CATALOG, metricDefinition } from "../insights/metrics.ts";
import { createDashboard, deleteDashboard, mainDashboard, updateDashboard } from "../local/insights.ts";
import { DateField } from "./planning-ui.tsx";
import { type InsightsCtx, useInsights } from "./insights-hooks.ts";
import { MetricBody } from "./metric-cards.tsx";

export function DashboardView() {
  const t = useT();
  const ctx = useInsights();
  const [selected, setSelected] = useState(MAIN_DASHBOARD_ID);
  if (!ctx) return null;
  const optional = ctx.records.dashboards.filter((d) => d.id !== MAIN_DASHBOARD_ID).sort((a, b) => a.data.name.localeCompare(b.data.name));
  const current = selected === MAIN_DASHBOARD_ID ? mainDashboard(ctx.records.dashboards) : optional.find((d) => d.id === selected)?.data;
  const shownId = current ? selected : MAIN_DASHBOARD_ID;
  const data = current ?? mainDashboard(ctx.records.dashboards);
  return (
    <section className="card" aria-labelledby="dash-title">
      <h1 id="dash-title">{t("dash.title")}</h1>
      <div className="filters">
        <DashboardPicker value={shownId} onChange={setSelected} optional={optional.map((d) => ({ id: d.id, name: d.data.name }))} />
        <NewDashboard onCreated={setSelected} />
      </div>
      <Dashboard key={shownId} ctx={ctx} id={shownId} data={data} onDeleted={() => setSelected(MAIN_DASHBOARD_ID)} />
    </section>
  );
}

function DashboardPicker({ value, onChange, optional }: { value: string; onChange: (id: string) => void; optional: { id: string; name: string }[] }) {
  const t = useT();
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{t("dash.choose")}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value={MAIN_DASHBOARD_ID}>{t("dash.main")}</option>
        {optional.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function NewDashboard({ onCreated }: { onCreated: (id: string) => void }) {
  const t = useT();
  const { db } = useServices();
  const id = useId();
  const [name, setName] = useState("");
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onCreated(await createDashboard(db, name));
        setName("");
      }}
    >
      <label htmlFor={id}>{t("dash.newName")}</label>
      <input id={id} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      <button type="submit" disabled={!name.trim()}>
        {t("dash.create")}
      </button>
    </form>
  );
}

const windowLabel = (t: ReturnType<typeof useT>, w: CardWindow) => (w.kind === "preset" ? t(`window.${w.preset}` as MessageKey) : t("window.customRange", { from: w.from, to: w.to }));

function Dashboard({ ctx, id, data, onDeleted }: { ctx: InsightsCtx; id: string; data: DashboardData; onDeleted: () => void }) {
  const t = useT();
  const { db } = useServices();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const main = id === MAIN_DASHBOARD_ID;
  const name = main && data.name === "Main" ? t("dash.main") : data.name;
  // Every edit applies to the stored dashboard, so quick successive edits never use a stale copy.
  const edit = async (fn: (current: DashboardData) => DashboardData) => {
    setError(null);
    try {
      await updateDashboard(db, id, fn);
    } catch {
      setError(t("org.error.generic"));
    }
  };
  const save = (next: DashboardData) => edit((current) => ({ ...current, name: next.name }));
  const update = (fn: (cards: DashboardCard[]) => DashboardCard[]) => edit((current) => ({ ...current, cards: fn(current.cards) }));
  const move = (cardId: string, delta: -1 | 1) =>
    update((cards) => {
      const next = [...cards];
      const i = next.findIndex((c) => c.id === cardId);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= next.length) return cards;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  return (
    <div data-testid="dashboard" data-dashboard-id={id}>
      <h2>{name}</h2>
      <div className="button-row">
        <button type="button" className="secondary" aria-pressed={editing} onClick={() => setEditing(!editing)}>
          {editing ? t("dash.doneEditing") : t("dash.edit")}
        </button>
        {!main && editing ? (
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              if (!window.confirm(t("dash.deleteConfirm", { name }))) return;
              await deleteDashboard(db, id);
              onDeleted();
            }}
          >
            {t("dash.delete")}
          </button>
        ) : null}
      </div>
      {editing ? <RenameDashboard data={data} onSave={save} main={main} /> : null}
      {data.cards.length === 0 ? <p className="muted">{t("dash.empty")}</p> : null}
      <ol className="dash-grid" data-testid="dash-grid">
        {data.cards.map((card, i) => {
          const def = metricDefinition(card.metric);
          return (
            <li key={card.id} className="dash-card" data-size={card.size} data-metric={card.metric} data-testid="dash-card">
              <h3>{t(`metric.${card.metric}` as MessageKey)}</h3>
              {def.windowed ? <p className="hint">{windowLabel(t, card.window)}</p> : null}
              <MetricBody ctx={ctx} metric={card.metric} window={card.window} size={card.size} goalId={card.goalId} />
              {editing ? (
                <CardControls
                  ctx={ctx}
                  card={card}
                  first={i === 0}
                  last={i === data.cards.length - 1}
                  onChange={(next) => update((cards) => cards.map((c) => (c.id === card.id ? next : c)))}
                  onRemove={() => update((cards) => cards.filter((c) => c.id !== card.id))}
                  onMove={(d) => move(card.id, d)}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {editing ? <AddCard ctx={ctx} onAdd={(card) => update((cards) => [...cards, card])} /> : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function RenameDashboard({ data, onSave, main }: { data: DashboardData; onSave: (d: DashboardData) => void; main: boolean }) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(main && data.name === "Main" ? t("dash.main") : data.name);
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave({ ...data, name });
      }}
    >
      <label htmlFor={id}>{t("dash.name")}</label>
      <input id={id} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      <button type="submit" className="secondary" disabled={!name.trim()}>
        {t("dash.rename")}
      </button>
    </form>
  );
}

function WindowFields({ value, onChange }: { value: CardWindow; onChange: (w: CardWindow) => void }) {
  const t = useT();
  const id = useId();
  const kind = value.kind === "preset" ? value.preset : "custom";
  return (
    <div className="inline-form">
      <label htmlFor={id}>{t("dash.window")}</label>
      <select
        id={id}
        value={kind}
        onChange={(e) =>
          onChange(e.target.value === "custom" ? { kind: "custom", from: value.kind === "custom" ? value.from : "", to: value.kind === "custom" ? value.to : "" } : { kind: "preset", preset: e.target.value as WindowPreset })
        }
      >
        {WINDOW_PRESETS.map((p) => (
          <option key={p} value={p}>
            {t(`window.${p}` as MessageKey)}
          </option>
        ))}
        <option value="custom">{t("window.custom")}</option>
      </select>
      {value.kind === "custom" ? (
        <>
          <DateField label={t("window.from")} value={value.from} onChange={(from) => onChange({ ...value, from })} />
          <DateField label={t("window.to")} value={value.to} onChange={(to) => onChange({ ...value, to })} />
        </>
      ) : null}
    </div>
  );
}

const windowValid = (w: CardWindow) => w.kind === "preset" || (!!w.from && !!w.to && w.to >= w.from);

function GoalField({ ctx, value, onChange }: { ctx: InsightsCtx; value: string | null; onChange: (id: string | null) => void }) {
  const t = useT();
  const id = useId();
  const goals = ctx.goals.goals.filter((g) => g.data.archivedAt === null || g.id === value);
  return (
    <div className="inline-form">
      <label htmlFor={id}>{t("dash.goal")}</label>
      <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{t("dash.chooseGoal")}</option>
        {goals.map((g) => (
          <option key={g.id} value={g.id}>
            {g.data.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function CardControls({ ctx, card, first, last, onChange, onRemove, onMove }: { ctx: InsightsCtx; card: DashboardCard; first: boolean; last: boolean; onChange: (c: DashboardCard) => void; onRemove: () => void; onMove: (d: -1 | 1) => void }) {
  const t = useT();
  const id = useId();
  const [window, setWindow] = useState<CardWindow>(card.window);
  const def = metricDefinition(card.metric);
  return (
    <div className="dash-controls" data-testid="card-controls">
      <div className="inline-form">
        <label htmlFor={id}>{t("dash.size")}</label>
        <select id={id} value={card.size} onChange={(e) => onChange({ ...card, size: e.target.value as CardSize })}>
          {CARD_SIZES.map((s) => (
            <option key={s} value={s}>
              {t(`dash.size.${s}` as MessageKey)}
              {s === def.recommendedSize ? ` (${t("dash.recommended")})` : ""}
            </option>
          ))}
        </select>
      </div>
      {def.windowed ? (
        <>
          <WindowFields value={window} onChange={setWindow} />
          <button type="button" className="secondary" disabled={!windowValid(window)} onClick={() => onChange({ ...card, window })}>
            {t("dash.applyWindow")}
          </button>
        </>
      ) : null}
      {def.goal ? <GoalField ctx={ctx} value={card.goalId} onChange={(goalId) => onChange({ ...card, goalId })} /> : null}
      <div className="button-row">
        <button type="button" className="secondary" disabled={first} onClick={() => onMove(-1)} aria-label={t("dash.moveUpLabel", { name: t(`metric.${card.metric}` as MessageKey) })}>
          {t("dash.moveUp")}
        </button>
        <button type="button" className="secondary" disabled={last} onClick={() => onMove(1)} aria-label={t("dash.moveDownLabel", { name: t(`metric.${card.metric}` as MessageKey) })}>
          {t("dash.moveDown")}
        </button>
        <button type="button" className="secondary" onClick={onRemove} aria-label={t("dash.removeLabel", { name: t(`metric.${card.metric}` as MessageKey) })}>
          {t("dash.remove")}
        </button>
      </div>
    </div>
  );
}

function AddCard({ ctx, onAdd }: { ctx: InsightsCtx; onAdd: (card: DashboardCard) => void }) {
  const t = useT();
  const ids = { metric: useId(), size: useId() };
  const [metric, setMetric] = useState<MetricId>("workTime");
  const def = metricDefinition(metric);
  const [size, setSize] = useState<CardSize | "">("");
  const [window, setWindow] = useState<CardWindow>({ kind: "preset", preset: "last7" });
  const [goalId, setGoalId] = useState<string | null>(null);
  const ready = windowValid(window) && (!def.goal || goalId !== null);
  return (
    <form
      className="day-panel"
      aria-label={t("dash.addCard")}
      data-testid="add-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onAdd({ id: crypto.randomUUID(), metric, size: size || def.recommendedSize, window, goalId: def.goal ? goalId : null });
      }}
    >
      <h3>{t("dash.addCard")}</h3>
      <div className="inline-form">
        <label htmlFor={ids.metric}>{t("dash.metric")}</label>
        <select id={ids.metric} value={metric} onChange={(e) => setMetric(e.target.value as MetricId)}>
          {METRIC_CATALOG.map((m) => (
            <option key={m.id} value={m.id}>
              {t(`metric.${m.id}` as MessageKey)}
            </option>
          ))}
        </select>
      </div>
      <div className="inline-form">
        <label htmlFor={ids.size}>{t("dash.size")}</label>
        <select id={ids.size} value={size} onChange={(e) => setSize(e.target.value as CardSize | "")}>
          <option value="">{t("dash.recommendedSize", { size: t(`dash.size.${def.recommendedSize}` as MessageKey) })}</option>
          {CARD_SIZES.map((s) => (
            <option key={s} value={s}>
              {t(`dash.size.${s}` as MessageKey)}
            </option>
          ))}
        </select>
      </div>
      {def.windowed ? <WindowFields value={window} onChange={setWindow} /> : null}
      {def.goal ? <GoalField ctx={ctx} value={goalId} onChange={setGoalId} /> : null}
      <p className="hint">{t(`metric.${metric}.formula` as MessageKey)}</p>
      <button type="submit" disabled={!ready}>
        {t("dash.add")}
      </button>
    </form>
  );
}
