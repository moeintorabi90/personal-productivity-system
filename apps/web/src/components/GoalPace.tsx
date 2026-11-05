/**
 * Stage 6 goal page sections (PRODUCT_SPEC "Goals and pace", "Goal streaks"; DECISIONS T-180 to
 * T-187, T-206 to T-237): progress, today's, this week's, and this month's targets, the cap
 * warning, the allocation mismatch, both streaks (shown by default, T-186), the weekly allocations
 * with edit, automatic, and move, the plan history, and the weekly-plan decisions with their
 * history. Nothing changes without an explicit action; values are calculated on display.
 */
import { type FormEvent, useId, useState } from "react";
import { usePreferences, useServices, useT } from "../app-context.tsx";
import { canonicalize } from "../backup/jcs.ts";
import { type GoalData, type GoalWeekPlanData, type OutputDefinitionData, type PlanDateData, type SegmentData } from "../backup/registry.ts";
import { formatLocalDate, type MessageKey, type Translate } from "../i18n/index.ts";
import { type Fraction, roundForDisplay, toNumber } from "../insights/fraction.ts";
import { goalWeekStarts, workdaysIn } from "../insights/goal-plan.ts";
import { appliedSegment, canChangeChoice, canWriteEntry, decisionChoices, eventStatus, needsDecision, orderEvents, resolveDate } from "../insights/plan-merge.ts";
import { decidePlanDate, GoalPlanError, manualAmountOn, manualAmounts, moveWeekAllocation, planWriteLimit, planWriteStep, setWeekAllocation, weekTakesManual } from "../local/goal-plans.ts";
import { addDays } from "../planning/time.ts";
import { goalUnit } from "../local/work.ts";
import { goalInsight, type InsightsCtx } from "./insights-hooks.ts";

export function goalPlanError(t: Translate, error: unknown): string {
  if (error instanceof GoalPlanError) return t(`pace.error.${error.code}` as MessageKey);
  return t("org.error.generic");
}

/** An amount in the goal's measure, at most two decimals (DECISIONS "Rounding"). */
export function formatAmount(t: Translate, goal: GoalData, value: number | Fraction, definitions: ReadonlyMap<string, OutputDefinitionData>): string {
  const n = typeof value === "number" ? Math.round(value * 100) / 100 : roundForDisplay(value);
  if (goal.kind === "time") return t("pace.amount.time", { n });
  if (goal.kind === "taskCount") return t("pace.amount.count", { n });
  return t("pace.amount.output", { n, unit: goalUnit(goal, definitions) ?? "" });
}

const percent = (ratio: number | null) => (ratio === null ? null : Math.round(ratio * 100));

export function GoalPacePanel({ ctx, goalId, goal, definitions }: { ctx: InsightsCtx; goalId: string; goal: GoalData; definitions: ReadonlyMap<string, OutputDefinitionData> }) {
  const t = useT();
  const g = goalInsight(ctx, goalId, goal);
  const amount = (v: number | Fraction) => formatAmount(t, goal, v, definitions);
  const result = g.allocation.result;
  const ratio = goal.target > 0 ? g.progress / goal.target : null;
  // Today's plan differs from the recorded one but this device's counter cannot go higher (refreshWeekPlans leaves it).
  const limit = planWriteLimit(ctx.planning.plans, ctx.deviceId, new Date(ctx.now).toISOString());
  const step = planWriteStep(goal, g.allocation, manualAmounts(ctx.planning.allocations, goalId), g.plans, ctx.today, ctx.deviceId, limit);
  return (
    <section className="card" aria-labelledby="pace-title" data-testid="goal-pace">
      <h2 id="pace-title">{t("pace.title")}</h2>
      <p data-testid="goal-progress">
        {t("pace.progress", { progress: amount(g.progress), target: amount(goal.target), percent: percent(ratio) ?? 0 })}
      </p>
      <progress max={goal.target} value={Math.min(g.progress, goal.target)} aria-label={t("pace.progressLabel")} />
      {g.deadlinePassed ? (
        <p className="notice notice-warn" data-testid="deadline-passed">
          {t("pace.deadlinePassed")}
        </p>
      ) : null}
      {g.pacingHidden ? (
        <p className="notice notice-info" data-testid="pace-hidden" data-status={goal.status}>
          {t(goal.status === "paused" ? "pace.hiddenPaused" : "pace.hiddenAbandoned")}
        </p>
      ) : null}
      {g.pacingHidden ? null : (
        <>
      {result.kind === "inactive" ? <p className="notice notice-info">{t("pace.inactive")}</p> : null}
      {result.kind === "mismatch" ? (
        <div className="notice notice-warn" role="status" data-testid="mismatch-warning">
          <p>{result.discrepancy > 0 ? t("pace.mismatch", { amount: amount(result.discrepancy) }) : t("pace.mismatchOutOfRange")}</p>
          <p className="hint">{t("pace.mismatchHint")}</p>
        </div>
      ) : null}
      {step.kind === "blocked" ? (
        <p className="notice notice-warn" role="status" data-testid="plan-not-updated" data-reason={step.reason}>
          {t(
            step.reason === "size"
              ? "pace.planNotUpdatedSize"
              : step.reason === "devices"
                ? "pace.planNotUpdatedDevices"
                : step.reason === "versionCounter"
                  ? "pace.planNotUpdatedVersion"
                  : "pace.planNotUpdated",
          )}
        </p>
      ) : null}
      {g.cap?.unreachable ? (
        <p className="notice notice-warn" role="status" data-testid="cap-warning">
          {t("pace.capWarning", { max: amount(g.cap.maxProjected), target: amount(goal.target), days: g.cap.remainingWorkdays })}
        </p>
      ) : null}
      <dl className="field-list">
        <div>
          <dt>{t("pace.today")}</dt>
          <dd data-testid="today-target">
            {g.today.kind === "target"
              ? `${amount(g.today.target)}${g.today.capped ? `${t("stage6.sep")}${t("pace.capped", { required: amount(g.today.uncapped) })}` : ""}`
              : t(`pace.noTarget.${g.today.reason}` as MessageKey)}
          </dd>
        </div>
        <div>
          <dt>{t("pace.week")}</dt>
          <dd data-testid="week-target">
            {g.week ? t("pace.periodValue", { target: amount(g.week.target), progress: amount(g.week.progress), percent: percent(g.week.ratio) ?? 100 }) : t("pace.noPeriodTarget")}
          </dd>
        </div>
        <div>
          <dt>{t("pace.month")}</dt>
          <dd data-testid="month-target">
            {g.month
              ? `${t("pace.periodValue", { target: amount(g.month.target), progress: amount(g.month.progress), percent: percent(g.month.ratio) ?? 100 })}${g.month.partial ? `${t("stage6.sep")}${t("pace.partial")}` : ""}`
              : t("pace.noPeriodTarget")}
          </dd>
        </div>
      </dl>
        </>
      )}
      <h3>{t("pace.streaks")}</h3>
      <ul className="count-list" data-testid="goal-streaks">
        <li>{t("pace.consistencyStreak", { current: g.consistency.current, longest: g.consistency.longest, count: g.consistency.counted })}</li>
        {g.pacingHidden ? null : <li>{t("pace.paceStreak", { current: g.pace.current, longest: g.pace.longest, count: g.pace.counted })}</li>}
      </ul>
      <p className="hint">{t("pace.streakNote")}</p>
      {g.pacingHidden ? null : <AllocationTable ctx={ctx} goalId={goalId} goal={goal} definitions={definitions} />}
      <PlanHistory goal={goal} definitions={definitions} />
      <WeeklyPlans ctx={ctx} goalId={goalId} goal={goal} definitions={definitions} plans={g.plans} />
    </section>
  );
}

/* ---------------- weekly allocations (T-206, T-207, T-211 to T-220) ---------------- */

function AllocationTable({ ctx, goalId, goal, definitions }: { ctx: InsightsCtx; goalId: string; goal: GoalData; definitions: ReadonlyMap<string, OutputDefinitionData> }) {
  const t = useT();
  const prefs = usePreferences();
  const { db } = useServices();
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const g = goalInsight(ctx, goalId, goal);
  const result = g.allocation.result;
  const amount = (v: number | Fraction) => formatAmount(t, goal, v, definitions);
  const archived = goal.archivedAt !== null;
  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(goalPlanError(t, e));
    }
  };
  if (result.kind === "ended") return <p className="hint">{t("pace.noOpenWeeks")}</p>;
  const weeks = result.kind === "inactive" ? [] : result.weeks;
  const outOfRange = result.kind === "inactive" ? [] : result.outOfRange;
  const week = (w: string) => t("pace.weekOf", { start: formatLocalDate(w, prefs, "medium"), end: formatLocalDate(addDays(w, 6), prefs, "medium") });
  return (
    <div data-testid="allocations">
      <h3>{t("pace.allocations")}</h3>
      {result.kind === "inactive" && result.inactiveManual.length > 0 ? <p className="hint">{t("pace.inactiveManual", { count: result.inactiveManual.length })}</p> : null}
      {weeks.length > 0 ? (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t("pace.weekColumn")}</th>
              <th scope="col">{t("pace.workdays")}</th>
              <th scope="col">{t("pace.amount")}</th>
              <th scope="col">{t("pace.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.weekStart} data-testid="allocation-row" data-week={w.weekStart}>
                <th scope="row" title={week(w.weekStart)}>
                  {t("pace.weekStarting", { start: formatLocalDate(w.weekStart, prefs, "medium") })}
                </th>
                <td>{w.workdays}</td>
                <td>
                  {w.allocation ? amount(w.allocation) : t("pace.noAmount")} <span className="pill pill-muted">{w.manual !== null ? t("pace.manual") : t("pace.automatic")}</span>
                </td>
                <td>
                  {archived ? null : (
                    <AllocationActions
                      week={w.weekStart}
                      manual={w.manual}
                      canEdit={w.workdays > 0}
                      onSet={(value) => act(() => setWeekAllocation(db, goalId, w.weekStart, value))}
                      onMove={() => setMoving(w.weekStart)}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {outOfRange.length > 0 ? (
        <div className="notice notice-warn" data-testid="out-of-range">
          <p>{t("pace.outOfRangeTitle")}</p>
          <ul className="count-list">
            {outOfRange.map((o) => (
              <li key={o.weekStart}>
                {week(o.weekStart)}: {amount(o.amount)} {o.historical ? <span className="pill pill-muted">{t("pace.historicalWarning")}</span> : null}{" "}
                {archived || o.historical ? null : (
                  <AllocationActions week={o.weekStart} manual={o.amount} canEdit onSet={(value) => act(() => setWeekAllocation(db, goalId, o.weekStart, value))} onMove={() => setMoving(o.weekStart)} />
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {moving ? <MoveAllocation ctx={ctx} goalId={goalId} goal={goal} from={moving} onDone={() => setMoving(null)} /> : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AllocationActions({ week, manual, canEdit, onSet, onMove }: { week: string; manual: number | null; canEdit: boolean; onSet: (v: number | null) => void; onMove: () => void }) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState(manual === null ? "" : String(manual));
  const value = /^\d+$/.test(draft.trim()) ? Number(draft.trim()) : null;
  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (value !== null) onSet(value);
      }}
    >
      {canEdit ? (
        <>
          <label htmlFor={id} className="visually-hidden">
            {t("pace.manualAmountFor", { week })}
          </label>
          <input id={id} inputMode="numeric" size={6} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="secondary" disabled={value === null}>
            {t("pace.setManual")}
          </button>
        </>
      ) : null}
      {manual !== null ? (
        <>
          <button type="button" className="secondary" onClick={() => onSet(null)}>
            {t("pace.setAutomatic")}
          </button>
          <button type="button" className="secondary" onClick={onMove}>
            {t("pace.move")}
          </button>
        </>
      ) : null}
    </form>
  );
}

/** An explicit move to a chosen open week (T-218); a destination with its own amount asks first (T-220). */
function MoveAllocation({ ctx, goalId, goal, from, onDone }: { ctx: InsightsCtx; goalId: string; goal: GoalData; from: string; onDone: () => void }) {
  const t = useT();
  const prefs = usePreferences();
  const { db } = useServices();
  const id = useId();
  const options = goalWeekStarts(goal, { target: goal.target, deadline: goal.deadline, workdays: goal.workdays ?? [], dailyCap: goal.dailyCap ?? null }, ctx.weekStart).filter(
    (w) => w !== from && weekTakesManual(goal, w, ctx.today, ctx.weekStart),
  );
  const [to, setTo] = useState(options[0] ?? "");
  const [askMode, setAskMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const destination = ctx.planning.allocations.find((a) => a.data.goalId === goalId && a.data.weekStart === to);
  const destAmount = destination ? destination.data.revisions.at(-1)!.amount : null;
  const run = async (mode?: "replace" | "add") => {
    setError(null);
    try {
      await moveWeekAllocation(db, goalId, from, to, mode);
      onDone();
    } catch (e) {
      if (e instanceof GoalPlanError && e.code === "NEEDS_CHOICE") setAskMode(true);
      else setError(goalPlanError(t, e));
    }
  };
  return (
    <div className="day-panel" role="dialog" aria-labelledby={`${id}-h`} data-testid="move-allocation">
      <h4 id={`${id}-h`}>{t("pace.moveTitle", { week: formatLocalDate(from, prefs, "medium") })}</h4>
      {options.length === 0 ? (
        <p className="hint">{t("pace.moveNoWeeks")}</p>
      ) : (
        <div className="field">
          <label htmlFor={id}>{t("pace.moveTo")}</label>
          <select id={id} value={to} onChange={(e) => (setTo(e.target.value), setAskMode(false))}>
            {options.map((w) => (
              <option key={w} value={w}>
                {formatLocalDate(w, prefs, "medium")}
              </option>
            ))}
          </select>
        </div>
      )}
      {askMode || destAmount !== null ? (
        <p className="notice notice-warn" data-testid="move-choice">
          {t("pace.moveDestinationHas", { amount: destAmount ?? 0 })}
        </p>
      ) : null}
      <div className="button-row">
        {destAmount !== null ? (
          <>
            <button type="button" onClick={() => run("replace")}>
              {t("pace.moveReplace")}
            </button>
            <button type="button" onClick={() => run("add")}>
              {t("pace.moveAdd")}
            </button>
          </>
        ) : (
          <button type="button" disabled={!to} onClick={() => run()}>
            {t("pace.moveConfirm")}
          </button>
        )}
        <button type="button" className="secondary" onClick={onDone}>
          {t("org.cancel")}
        </button>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* ---------------- plan history (T-182, T-224) ---------------- */

function PlanHistory({ goal, definitions }: { goal: GoalData; definitions: ReadonlyMap<string, OutputDefinitionData> }) {
  const t = useT();
  const prefs = usePreferences();
  const history = goal.planHistory ?? [];
  if (history.length === 0) return null;
  return (
    <details data-testid="plan-history">
      <summary>{t("pace.planHistory")}</summary>
      <ol className="count-list">
        {history.map((p) => (
          <li key={p.effectiveFrom}>
            {t("pace.planEntry", {
              from: formatLocalDate(p.effectiveFrom, prefs, "medium"),
              target: formatAmount(t, goal, p.target, definitions),
              deadline: p.deadline ? formatLocalDate(p.deadline, prefs, "medium") : t("pace.noDeadline"),
              workdays: p.workdays.length,
              cap: p.dailyCap === null ? t("pace.noCap") : formatAmount(t, goal, p.dailyCap, definitions),
            })}
          </li>
        ))}
      </ol>
    </details>
  );
}

/* ---------------- recorded weekly plans and decisions (T-223, T-227, T-228, T-237) ---------------- */

function segmentText(t: Translate, goal: GoalData, s: SegmentData | null, definitions: ReadonlyMap<string, OutputDefinitionData>): string {
  if (s === null) return t("pace.noData");
  if (s.state === "allocated" && s.allocation) return `${formatAmount(t, goal, s.allocation, definitions)} (${t(s.source === "manual" ? "pace.manual" : "pace.automatic")})`;
  return t(`pace.segment.${s.state}` as MessageKey);
}

function WeeklyPlans({ ctx, goalId, goal, definitions, plans }: { ctx: InsightsCtx; goalId: string; goal: GoalData; definitions: ReadonlyMap<string, OutputDefinitionData>; plans: GoalWeekPlanData[] }) {
  const t = useT();
  const prefs = usePreferences();
  const sorted = [...plans].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  if (sorted.length === 0) return <p className="hint" data-testid="weekly-plans-empty">{t("pace.noRecordedPlans")}</p>;
  return (
    <details open={sorted.some((p) => p.dates.some(needsDecision))} data-testid="weekly-plans">
      <summary>{t("pace.recordedPlans")}</summary>
      {sorted.map((plan) => (
        <div key={plan.weekStart} className="day-panel">
          <h4>{t("pace.weekOf", { start: formatLocalDate(plan.weekStart, prefs, "medium"), end: formatLocalDate(addDays(plan.weekStart, 6), prefs, "medium") })}</h4>
          <ul className="item-list">
            {plan.dates.map((date) => (
              <PlanDateRow key={date.from} ctx={ctx} goalId={goalId} goal={goal} plan={plan} date={date} definitions={definitions} />
            ))}
          </ul>
          <p className="hint">{t("pace.workdaysThisWeek", { count: workdaysIn(goal, { target: goal.target, deadline: goal.deadline, workdays: goal.workdays ?? [], dailyCap: null }, plan.weekStart).length })}</p>
        </div>
      ))}
    </details>
  );
}

function PlanDateRow({ ctx, goalId, goal, plan, date, definitions }: { ctx: InsightsCtx; goalId: string; goal: GoalData; plan: GoalWeekPlanData; date: PlanDateData; definitions: ReadonlyMap<string, OutputDefinitionData> }) {
  const t = useT();
  const prefs = usePreferences();
  const { db } = useServices();
  const [choosing, setChoosing] = useState<SegmentData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolution = resolveDate(date, ctx.deviceId);
  const conflict = needsDecision(date);
  const changeable = canChangeChoice(date);
  const offered = conflict ? decisionChoices(date) : changeable ? date.options : [];
  // A choice needs a new entry; with this device's counter at its maximum none can be written here.
  const blocked = offered.length > 0 && !canWriteEntry(date, ctx.deviceId);
  const applied = appliedSegment(resolution);
  const events = ctx.planning.choices.filter((c) => c.data.goalId === goalId && c.data.weekStart === plan.weekStart && c.data.from === date.from);
  const planId = ctx.planning.plans.find((p) => p.data.goalId === goalId && p.data.weekStart === plan.weekStart)!.id;
  return (
    <li className="item" data-testid="plan-date" data-from={date.from}>
      <div className="item-main">
        <span className="item-title">{t("pace.fromDate", { date: formatLocalDate(date.from, prefs, "medium") })}</span> {segmentText(t, goal, applied, definitions)}
        {conflict ? (
          <p className="notice notice-warn" data-testid="plan-conflict" data-kind={resolution.kind}>
            {resolution.kind === "inconsistent"
              ? t(resolution.segment ? "pace.inconsistentOwn" : "pace.inconsistentNoData")
              : resolution.kind === "undecided"
                ? t("pace.conflictNoData")
                : t("pace.conflictOwn")}
          </p>
        ) : null}
        {blocked && goal.archivedAt === null ? (
          <p className="notice notice-warn" data-testid="decision-blocked">
            {t("pace.decisionBlocked")}
          </p>
        ) : null}
        {offered.length > 0 && !blocked && goal.archivedAt === null ? (
          <div data-testid={conflict ? "decide" : "change-choice"}>
            <p className="hint">{conflict ? t("pace.chooseVersion") : t("pace.changeChoice")}</p>
            {/* An automatic write may have replaced the chosen segment with one that is not in `options`
                (writes never add to them); it is shown as applying but is not one of the choices (T-237). */}
            {!conflict && applied !== null && !offered.some((s) => canonicalize(s) === canonicalize(applied)) ? (
              <p data-testid="choice-current">
                {segmentText(t, goal, applied, definitions)} <span className="pill pill-ok">{t("pace.applying")}</span> <span className="hint">{t("pace.applyingNotListed")}</span>
              </p>
            ) : null}
            <ul className="count-list">
              {offered.map((s) => {
                const key = canonicalize(s);
                const current = applied !== null && canonicalize(applied) === key;
                return (
                  <li key={key}>
                    {segmentText(t, goal, s, definitions)} {current ? <span className="pill pill-ok">{t("pace.applying")}</span> : null}{" "}
                    {!current || conflict ? (
                      <button type="button" className="secondary" onClick={() => setChoosing(s)}>
                        {t("pace.choose")}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {choosing ? (
              <div className="button-row" data-testid="confirm-choice">
                <span>{t("pace.confirmChoice", { choice: segmentText(t, goal, choosing, definitions) })}</span>
                <button
                  type="button"
                  onClick={async () => {
                    setError(null);
                    try {
                      await decidePlanDate(db, planId, date.from, choosing, canonicalize(date));
                      setChoosing(null);
                    } catch (e) {
                      setError(goalPlanError(t, e));
                    }
                  }}
                >
                  {t("pace.confirm")}
                </button>
                <button type="button" className="secondary" onClick={() => setChoosing(null)}>
                  {t("org.cancel")}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {events.length > 0 ? (
          <details data-testid="choice-history">
            <summary>{t("pace.choiceHistory", { count: events.length })}</summary>
            <ol className="count-list">
              {orderEvents(events, ctx.planning.plans.map((p) => p.data)).map(({ event, uncertain, cyclic }) => {
                const status = eventStatus(event.data, ctx.planning.plans.map((p) => p.data));
                return (
                  <li key={event.id} data-testid="choice-event" data-status={status} data-cyclic={cyclic ? "true" : undefined}>
                    {t("pace.choiceEvent", {
                      previous: segmentText(t, goal, event.data.previous, definitions),
                      chosen: segmentText(t, goal, event.data.chosen, definitions),
                      device: event.data.deviceName || event.data.device.slice(0, 8),
                      time: new Date(event.data.recordedAt).toLocaleString(prefs.language === "fa" ? "fa-IR" : "en-GB"),
                    })}{" "}
                    <span className={status === "integrity" ? "pill pill-warn" : "pill pill-muted"}>{t(`pace.eventStatus.${status}` as MessageKey)}</span>
                    {uncertain ? <span className="pill pill-muted"> {t("pace.orderUncertain")}</span> : null}
                    {cyclic ? <span className="pill pill-warn"> {t("pace.orderCycle")}</span> : null}
                  </li>
                );
              })}
            </ol>
          </details>
        ) : null}
        {error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** Amount before and after for the allocation history of a week key (T-224), for the goal page. */
export function allocationOn(ctx: InsightsCtx, goalId: string, weekKey: string, date: string): number | null {
  const a = ctx.planning.allocations.find((x) => x.data.goalId === goalId && x.data.weekStart === weekKey);
  return a ? manualAmountOn(a.data, date) : null;
}

export const fractionValue = (f: Fraction) => toNumber(f);
