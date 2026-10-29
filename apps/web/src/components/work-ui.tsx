/**
 * Stage 5 screens: actual work sessions and outputs (PRODUCT_SPEC "Actual work and outputs";
 * DECISIONS T-091 to T-169). Every write is an explicit user action; nothing is ended, paused, or
 * completed on its own. Planned-versus-actual comparison and drag corrections are Stage 6 (T-145).
 */
import type { CalendarDisplay, Language } from "@pps/shared";
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { usePreferences, useServices, useT } from "../app-context.tsx";
import {
  type CalendarBlockData,
  type GoalData,
  NAME_MAX,
  OUTPUT_VALUE_MAX,
  type OutputDefinitionData,
  type ProjectData,
  RATING_MAX,
  RATING_MIN,
  REASON_MAX,
  type SessionData,
  type TaskDefinitionData,
  TEXT_MAX,
  UNIT_MAX,
} from "../backup/registry.ts";
import { formatLocalDate, formatTime, type Translate } from "../i18n/index.ts";
import type { Goals } from "../local/goals.ts";
import type { Organization } from "../local/organization.ts";
import {
  addOutputs,
  allowedOutputGoals,
  allowedTimeGoals,
  correctOutputValue,
  correctSessionTimes,
  createOutputDefinition,
  definitionInUse,
  definitionLabel,
  deleteOutput,
  deleteSession,
  editOutputDefinition,
  endSession,
  openSessions,
  type OutputInput,
  overlappingSessions,
  pastSessionTimes,
  pauseSession,
  purgeTrash,
  recordPastSession,
  restoreOutput,
  restoreSession,
  resumeSession,
  type Session,
  sessionPrompts,
  setOutputDefinitionArchived,
  setOutputGoals,
  setSessionGoal,
  startSession,
  TRASH_DAYS,
  updateSessionDetails,
  type WorkData,
  WorkError,
} from "../local/work.ts";
import { type ColorKey, itemColor } from "../planning/colors.ts";
import { isLocalDate, isWallTime, localDateOf, resolveWallTime, wallTimeOf } from "../planning/time.ts";
import { MINUTE, sessionState, workMinutes } from "../work/session-time.ts";
import { useGoals, useOrganization, useWork } from "./data-hooks.ts";
import { DateField, formatMinutes, TimeZonePrompt, useSharedPreferences } from "./planning-ui.tsx";
import { ErrorLine, type ExpectedDraft, ExpectedEditor, expectedDraftsOf, expectedOf, GoalSelect, workError } from "./work-actions.tsx";

/* ---------------- context ---------------- */

export interface WorkCtx {
  work: WorkData;
  org: Organization;
  goals: Goals;
  tasks: Map<string, TaskDefinitionData>;
  projects: Map<string, ProjectData>;
  defs: Map<string, OutputDefinitionData>;
  zone: string;
  language: Language;
  calendarDisplay: CalendarDisplay;
}

export function useWorkCtx(): { ctx: WorkCtx | null; loading: boolean; zone: string | null } {
  const work = useWork();
  const org = useOrganization();
  const goals = useGoals();
  const shared = useSharedPreferences();
  const prefs = usePreferences();
  const ctx = useMemo(() => {
    if (!work || !org || !goals || !shared.timeZone) return null;
    return {
      work,
      org,
      goals,
      tasks: new Map(org.tasks.map((t) => [t.id, t.data])),
      projects: new Map(org.projects.map((p) => [p.id, p.data])),
      defs: new Map(work.definitions.map((d) => [d.id, d.data])),
      zone: shared.timeZone,
      language: prefs.language,
      calendarDisplay: prefs.calendarDisplay,
    };
  }, [work, org, goals, shared.timeZone, prefs.language, prefs.calendarDisplay]);
  return { ctx, loading: !work || !org || !goals, zone: shared.timeZone };
}

/** The current time, re-read every 20 seconds (only for display; nothing is written). */
export function useNow(interval = 20_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

/* ---------------- labels ---------------- */

export function sessionTitle(t: Translate, ctx: WorkCtx, s: SessionData): string {
  if (s.taskId === null) return t("work.noTask");
  return ctx.tasks.get(s.taskId)?.title ?? s.snapshot?.taskTitle ?? t("org.unknownItem");
}

/** Project color of a session: its task's current project, else the snapshot's, else neutral (T-069). */
function sessionColor(ctx: WorkCtx, s: SessionData): ColorKey {
  return itemColor({ taskId: s.taskId ?? "", snapshotProjectId: s.snapshot?.projectId ?? null }, ctx.tasks, ctx.projects);
}

function outputText(t: Translate, ctx: WorkCtx, definitionId: string, value: number, revision?: number): string {
  const def = ctx.defs.get(definitionId);
  if (!def) return t("work.output.value", { value, unit: "", name: t("org.unknownItem") });
  const label = definitionLabel(def, revision);
  return t("work.output.value", { value, unit: label.unit, name: label.name });
}

const goalName = (ctx: WorkCtx, id: string | null) => (id ? (ctx.goals.goals.find((g) => g.id === id)?.data.name ?? "") : "");

function timeRange(ctx: WorkCtx, s: SessionData): string {
  const start = formatTime(s.startedAt, ctx.zone, ctx.language);
  const end = s.endedAt ? formatTime(s.endedAt, ctx.zone, ctx.language) : "…";
  const date = formatLocalDate(localDateOf(s.startedAt, ctx.zone), ctx, "medium");
  return `${date} ${start}–${end}`;
}

const wholeNumber = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

/* ---------------- shared fields ---------------- */

/** A date and a wall time in the configured zone → an instant (a daylight-saving gap is refused). */
function instantOf(date: string, time: string, zone: string): string | "gap" | null {
  if (!isLocalDate(date) || !isWallTime(time)) return null;
  const r = resolveWallTime(date, time, zone);
  return r.kind === "gap" ? "gap" : r.instant;
}

function InstantFields({ legend, date, time, onDate, onTime, zone }: { legend: string; date: string; time: string; onDate: (d: string) => void; onTime: (t: string) => void; zone: string }) {
  const t = useT();
  const id = useId();
  const value = instantOf(date, time, zone);
  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      <DateField label={t("plan.form.date")} value={date} onChange={onDate} required />
      <label htmlFor={id}>{t("work.time")}</label>
      <input id={id} type="time" step={60} value={time} required onChange={(e) => onTime(e.target.value.slice(0, 5))} />
      {value === "gap" ? <p className="hint hint-error">{t("plan.form.gap", { zone })}</p> : <p className="hint">{t("plan.form.startHint", { zone })}</p>}
    </fieldset>
  );
}

function ReasonField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{t("work.reason")}</label>
      <input id={id} value={value} maxLength={REASON_MAX} onChange={(e) => onChange(e.target.value)} />
      <p className="hint">{t("work.reasonHint")}</p>
    </div>
  );
}

function RatingSelect({ label, value, onChange }: { label: string; value: number | null; onChange: (v: number | null) => void }) {
  const t = useT();
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
        <option value="">{t("work.rating.none")}</option>
        {Array.from({ length: RATING_MAX - RATING_MIN + 1 }, (_, i) => RATING_MIN + i).map((n) => (
          <option key={n} value={n}>
            {t("work.rating.value", { n })}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Note and the 1–5 energy and focus ratings (T-140). */
function NoteAndRatings({ notes, energy, focus, onChange }: { notes: string; energy: number | null; focus: number | null; onChange: (v: { notes: string; energy: number | null; focus: number | null }) => void }) {
  const t = useT();
  const id = useId();
  return (
    <>
      <div className="field">
        <label htmlFor={id}>{t("work.note")}</label>
        <textarea id={id} rows={2} value={notes} maxLength={TEXT_MAX} onChange={(e) => onChange({ notes: e.target.value, energy, focus })} />
      </div>
      <div className="filters">
        <RatingSelect label={t("work.energy")} value={energy} onChange={(v) => onChange({ notes, energy: v, focus })} />
        <RatingSelect label={t("work.focus")} value={focus} onChange={(v) => onChange({ notes, energy, focus: v })} />
      </div>
    </>
  );
}

/** Definitions offered for a new entry (not archived, T-107); a task's suggestions first (T-138), never a restriction. */
function definitionOptions(ctx: WorkCtx, taskId: string | null) {
  const suggested = new Set(taskId ? (ctx.tasks.get(taskId)?.outputDefinitionIds ?? []) : []);
  return ctx.work.definitions
    .filter((d) => d.data.archivedAt === null)
    .map((d) => ({ id: d.id, label: `${definitionLabel(d.data).name} (${definitionLabel(d.data).unit})`, suggested: suggested.has(d.id) }))
    .sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.label.localeCompare(b.label));
}

function DefinitionSelect({ ctx, taskId, value, onChange, label }: { ctx: WorkCtx; taskId: string | null; value: string; onChange: (v: string) => void; label: string }) {
  const t = useT();
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("work.output.choose")}</option>
        {definitionOptions(ctx, taskId).map((o) => (
          <option key={o.id} value={o.id}>
            {o.suggested ? t("work.output.suggested", { label: o.label }) : o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface OutputDraft {
  key: string;
  definitionId: string;
  value: string;
  goalIds: string[];
}

const newOutputDraft = (): OutputDraft => ({ key: crypto.randomUUID(), definitionId: "", value: "", goalIds: [] });

/** Outputs as entered: whole numbers of 0 or more (T-104, T-159); explicit goals of the same definition only (T-049, T-137). */
function outputsOf(drafts: OutputDraft[]): OutputInput[] | null {
  const out: OutputInput[] = [];
  for (const d of drafts) {
    if (!d.definitionId && d.value.trim() === "") continue;
    const value = wholeNumber(d.value);
    if (!d.definitionId || value === null || value > OUTPUT_VALUE_MAX) return null;
    out.push({ definitionId: d.definitionId, value, goalIds: d.goalIds });
  }
  return out;
}

function GoalChecks({ ctx, definitionId, value, onChange }: { ctx: WorkCtx; definitionId: string; value: string[]; onChange: (v: string[]) => void }) {
  const t = useT();
  const allowed = new Set(allowedOutputGoals(definitionId, ctx.goals.goals));
  const goals = ctx.goals.goals.filter((g) => allowed.has(g.id));
  if (!definitionId || goals.length === 0) return null;
  return (
    <fieldset className="field">
      <legend>{t("work.output.goals")}</legend>
      {goals.map((g) => (
        <label key={g.id} className="check">
          <input type="checkbox" checked={value.includes(g.id)} onChange={(e) => onChange(e.target.checked ? [...value, g.id] : value.filter((id) => id !== g.id))} />{" "}
          {g.data.archivedAt ? t("work.goal.archived", { name: g.data.name }) : g.data.name}
        </label>
      ))}
      <p className="hint">{t("work.output.goalsHint")}</p>
    </fieldset>
  );
}

function OutputsEditor({ ctx, taskId, drafts, onChange }: { ctx: WorkCtx; taskId: string | null; drafts: OutputDraft[]; onChange: (d: OutputDraft[]) => void }) {
  const t = useT();
  const set = (key: string, patch: Partial<OutputDraft>) => onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch, ...(patch.definitionId !== undefined ? { goalIds: [] } : {}) } : d)));
  return (
    <fieldset className="field">
      <legend>{t("work.outputs")}</legend>
      <p className="hint">{t("work.outputsHint")}</p>
      {drafts.map((d, i) => (
        <OutputDraftRow key={d.key} ctx={ctx} taskId={taskId} index={i} draft={d} onChange={(patch) => set(d.key, patch)} onRemove={() => onChange(drafts.filter((x) => x.key !== d.key))} />
      ))}
      <button type="button" className="secondary" onClick={() => onChange([...drafts, newOutputDraft()])}>
        {t("work.output.add")}
      </button>
    </fieldset>
  );
}

function OutputDraftRow({ ctx, taskId, index, draft, onChange, onRemove }: { ctx: WorkCtx; taskId: string | null; index: number; draft: OutputDraft; onChange: (p: Partial<OutputDraft>) => void; onRemove: () => void }) {
  const t = useT();
  const id = useId();
  const invalid = draft.value !== "" && wholeNumber(draft.value) === null;
  return (
    <div className="editor" role="group" aria-label={t("work.output.row", { n: index + 1 })} data-testid="output-row">
      <DefinitionSelect ctx={ctx} taskId={taskId} value={draft.definitionId} onChange={(v) => onChange({ definitionId: v })} label={t("work.output.definition")} />
      <div className="field">
        <label htmlFor={id}>{t("work.output.amount")}</label>
        <input id={id} inputMode="numeric" value={draft.value} aria-invalid={invalid} onChange={(e) => onChange({ value: e.target.value })} />
        {invalid ? <p className="hint hint-error">{t("work.output.invalid")}</p> : <p className="hint">{t("work.output.zeroHint")}</p>}
      </div>
      <GoalChecks ctx={ctx} definitionId={draft.definitionId} value={draft.goalIds} onChange={(goalIds) => onChange({ goalIds })} />
      <button type="button" className="secondary" onClick={onRemove}>
        {t("work.output.remove")}
      </button>
    </div>
  );
}

function TaskSelect({ ctx, value, onChange, current }: { ctx: WorkCtx; value: string; onChange: (v: string) => void; current?: string | null }) {
  const t = useT();
  const id = useId();
  const tasks = ctx.org.tasks.filter((task) => task.data.archivedAt === null || task.id === current).sort((a, b) => a.data.title.localeCompare(b.data.title));
  return (
    <div className="field">
      <label htmlFor={id}>{t("work.task")}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("work.noTask")}</option>
        {tasks.map((task) => (
          <option key={task.id} value={task.id}>
            {task.data.title}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The time goals offered for a session (T-129): the task's linked ones, else any; a single linked one is pre-selected. */
function timeGoalChoice(ctx: WorkCtx, taskId: string | null) {
  const allowed = new Set(allowedTimeGoals(taskId, ctx.tasks, ctx.goals.goals));
  const goals = ctx.goals.goals.filter((g) => allowed.has(g.id)).sort((a, b) => a.data.name.localeCompare(b.data.name));
  const linked = (taskId ? (ctx.tasks.get(taskId)?.goalIds ?? []) : []).filter((id) => allowed.has(id));
  return { goals, linked, preselect: linked.length === 1 ? linked[0]! : "" };
}

function TimeGoalField({ ctx, taskId, value, onChange }: { ctx: WorkCtx; taskId: string | null; value: string; onChange: (v: string) => void }) {
  const t = useT();
  const choice = timeGoalChoice(ctx, taskId);
  if (choice.goals.length === 0) return null;
  return (
    <GoalSelect
      label={t("work.timeGoal")}
      goals={choice.goals}
      value={value}
      onChange={onChange}
      hint={choice.linked.length > 0 ? t("work.timeGoal.linkedHint") : t("work.timeGoal.manualHint")}
    />
  );
}

/* ---------------- current session ---------------- */

/**
 * The open session(s) on this device with pause, resume, and end (T-092, T-117). Two open sessions
 * can only come from an import: one must be ended or deleted first (T-144, T-152).
 */
export function CurrentSessions({ ctx }: { ctx: WorkCtx }) {
  const t = useT();
  const open = openSessions(ctx.work.sessions);
  if (open.length === 0) return null;
  return (
    <section className="card" aria-labelledby="current-session-title" data-testid="current-session">
      <h2 id="current-session-title">{t("work.current")}</h2>
      {open.length > 1 ? (
        <p className="notice notice-warn" role="alert" data-testid="two-open">
          {t("work.twoOpen")}
        </p>
      ) : null}
      <ul className="item-list">
        {open.map((s) => (
          <OpenSessionRow key={s.id} ctx={ctx} session={s} twoOpen={open.length > 1} />
        ))}
      </ul>
    </section>
  );
}

function OpenSessionRow({ ctx, session, twoOpen }: { ctx: WorkCtx; session: Session; twoOpen: boolean }) {
  const t = useT();
  const { db } = useServices();
  const now = useNow();
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = session.data;
  const state = sessionState(s, ctx.work.importedPaused[session.id]);
  const title = sessionTitle(t, ctx, s);
  const minutes = workMinutes(state.kind === "paused" ? { ...s, endedAt: new Date(state.since).toISOString(), pauses: s.pauses.filter((p) => p.end !== null) } : s, now);
  const act = (action: () => Promise<void>) => async () => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(workError(t, e));
    }
  };
  if (ending) {
    return (
      <li className="item">
        <EndSessionForm ctx={ctx} session={session} onDone={() => setEnding(false)} />
      </li>
    );
  }
  return (
    <li className="item session-row colored" data-color={sessionColor(ctx, s)} data-testid="open-session" data-state={state.kind}>
      <div className="item-main">
        <span className="item-title">{title}</span>{" "}
        <span className={state.kind === "running" ? "pill pill-ok" : "pill pill-muted"}>
          {state.kind === "running" ? t("work.state.running") : state.kind === "paused" && state.imported ? t("work.state.pausedImported") : t("work.state.paused")}
        </span>
        <p className="hint" data-testid="work-time">
          {t("work.workTime", { time: formatMinutes(t, minutes) })} · {t("work.startedAt", { time: formatTime(s.startedAt, ctx.zone, ctx.language) })}
        </p>
        <ErrorLine error={error} />
      </div>
      <div className="button-row">
        {state.kind === "running" ? (
          <button type="button" className="secondary" onClick={act(() => pauseSession(db, session.id))}>
            {t("work.pause")}
          </button>
        ) : (
          <button type="button" className="secondary" disabled={twoOpen} onClick={act(() => resumeSession(db, session.id))}>
            {t("work.resume")}
          </button>
        )}
        <button type="button" onClick={() => setEnding(true)}>
          {t("work.end")}
        </button>
        {twoOpen ? (
          <button type="button" className="secondary" onClick={act(() => deleteSession(db, session.id))}>
            {t("work.delete")}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Ends a session (T-098): end time (now by default), the time goal (T-129), outputs (T-104,
 * T-159), expected amounts (T-125), a note and ratings (T-140). No status label is asked.
 */
export function EndSessionForm({ ctx, session, onDone, endedAt: fixedEnd, intro }: { ctx: WorkCtx; session: Session; onDone: () => void; endedAt?: string; intro?: ReactNode }) {
  const t = useT();
  const { db } = useServices();
  const s = session.data;
  const nowMs = Date.now();
  const [date, setDate] = useState(localDateOf(fixedEnd ?? nowMs, ctx.zone));
  const [time, setTime] = useState(wallTimeOf(fixedEnd ?? new Date(nowMs).toISOString(), ctx.zone));
  const [goal, setGoal] = useState(s.goalId ?? timeGoalChoice(ctx, s.taskId).preselect);
  const [outputs, setOutputs] = useState<OutputDraft[]>([]);
  const [expected, setExpected] = useState<ExpectedDraft[]>(expectedDraftsOf(s.expectedOutputs));
  const [details, setDetails] = useState({ notes: s.notes, energy: s.energy, focus: s.focus });
  const [error, setError] = useState<string | null>(null);
  const end = instantOf(date, time, ctx.zone);
  const outputList = outputsOf(outputs);
  const expectedList = expectedOf(expected);
  const ready = !!end && end !== "gap" && outputList !== null && expectedList !== null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setError(null);
    try {
      await endSession(db, session.id, { endedAt: end as string, goalId: goal || null, outputs: outputList!, expectedOutputs: expectedList!, ...details });
      onDone();
    } catch (e) {
      setError(workError(t, e));
    }
  }

  return (
    <form className="editor" onSubmit={onSubmit} aria-label={t("work.endLabel", { title: sessionTitle(t, ctx, s) })} data-testid="end-form">
      <p className="item-title">{t("work.endLabel", { title: sessionTitle(t, ctx, s) })}</p>
      {intro}
      <InstantFields legend={t("work.endTime")} date={date} time={time} onDate={setDate} onTime={setTime} zone={ctx.zone} />
      <p className="hint">{t("work.endHint")}</p>
      <TimeGoalField ctx={ctx} taskId={s.taskId} value={goal} onChange={setGoal} />
      <OutputsEditor ctx={ctx} taskId={s.taskId} drafts={outputs} onChange={setOutputs} />
      <ExpectedEditor defs={ctx.work.definitions} tasks={ctx.tasks} taskId={s.taskId} drafts={expected} onChange={setExpected} />
      <NoteAndRatings {...details} onChange={setDetails} />
      <ErrorLine error={error} />
      <div className="button-row">
        <button type="submit" disabled={!ready}>
          {t("work.endConfirm")}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          {t("org.cancel")}
        </button>
      </div>
    </form>
  );
}

/** Starts a session now, with or without a task (T-095), with optional expected amounts (T-125). */
export function StartSessionForm({ ctx }: { ctx: WorkCtx }) {
  const t = useT();
  const { db } = useServices();
  const [taskId, setTaskId] = useState("");
  const [expected, setExpected] = useState<ExpectedDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const open = openSessions(ctx.work.sessions).length > 0;
  const expectedList = expectedOf(expected);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (expectedList === null) return;
    setError(null);
    try {
      await startSession(db, { taskId: taskId || null, expectedOutputs: expectedList });
      setTaskId("");
      setExpected([]);
    } catch (e) {
      setError(workError(t, e));
    }
  }

  return (
    <section className="card" aria-labelledby="start-title">
      <h2 id="start-title">{t("work.start.title")}</h2>
      {open ? (
        <p className="hint">{t("work.start.openHint")}</p>
      ) : (
        <form onSubmit={onSubmit}>
          <TaskSelect ctx={ctx} value={taskId} onChange={setTaskId} />
          <ExpectedEditor defs={ctx.work.definitions} tasks={ctx.tasks} taskId={taskId || null} drafts={expected} onChange={setExpected} />
          <ErrorLine error={error} />
          <button type="submit" disabled={expectedList === null}>
            {t("work.start")}
          </button>
        </form>
      )}
    </section>
  );
}

/**
 * A finished past session from start plus duration (T-096): any past date, never in the future,
 * at most 24 hours. Overlapping work shows a warning; the user may still save (T-097).
 */
export function PastSessionForm({ ctx }: { ctx: WorkCtx }) {
  const t = useT();
  const { db } = useServices();
  const ids = { title: useId(), start: useId(), duration: useId() };
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(localDateOf(Date.now(), ctx.zone));
  const [start, setStart] = useState("");
  const [duration, setDuration] = useState("");
  const [taskId, setTaskId] = useState("");
  const [goal, setGoal] = useState("");
  const [outputs, setOutputs] = useState<OutputDraft[]>([]);
  const [expected, setExpected] = useState<ExpectedDraft[]>([]);
  const [details, setDetails] = useState<{ notes: string; energy: number | null; focus: number | null }>({ notes: "", energy: null, focus: null });
  const [confirmOverlap, setConfirmOverlap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const minutes = wholeNumber(duration);
  const outputList = outputsOf(outputs);
  const expectedList = expectedOf(expected);
  let times: ReturnType<typeof pastSessionTimes> | null = null;
  try {
    times = isLocalDate(date) && isWallTime(start) && minutes !== null ? pastSessionTimes({ date, startTime: start, durationMinutes: minutes }, ctx.zone) : null;
  } catch {
    times = null;
  }
  const overlaps = times ? overlappingSessions(ctx.work.sessions, times) : [];
  const ready = !!times && outputList !== null && expectedList !== null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    if (overlaps.length > 0 && !confirmOverlap) {
      setConfirmOverlap(true);
      return;
    }
    setError(null);
    try {
      await recordPastSession(db, { date, startTime: start, durationMinutes: minutes!, taskId: taskId || null, goalId: goal || null, outputs: outputList!, expectedOutputs: expectedList!, ...details });
      setOpen(false);
      setStart("");
      setDuration("");
      setOutputs([]);
      setExpected([]);
      setConfirmOverlap(false);
    } catch (e) {
      setError(workError(t, e));
    }
  }

  return (
    <section className="card" aria-labelledby={ids.title}>
      <h2 id={ids.title}>{t("work.past.title")}</h2>
      {!open ? (
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          {t("work.past.open")}
        </button>
      ) : (
        <form onSubmit={onSubmit} data-testid="past-form">
          <DateField label={t("plan.form.date")} value={date} onChange={setDate} required />
          <div className="field">
            <label htmlFor={ids.start}>{t("plan.form.start")}</label>
            <input id={ids.start} type="time" step={60} value={start} required onChange={(e) => setStart(e.target.value.slice(0, 5))} />
            <p className="hint">{t("plan.form.startHint", { zone: ctx.zone })}</p>
          </div>
          <div className="field">
            <label htmlFor={ids.duration}>{t("work.past.duration")}</label>
            <input id={ids.duration} inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} />
            <p className="hint">{t("work.past.durationHint")}</p>
          </div>
          <TaskSelect
            ctx={ctx}
            value={taskId}
            onChange={(v) => {
              setTaskId(v);
              setGoal(timeGoalChoice(ctx, v || null).preselect);
            }}
          />
          <TimeGoalField ctx={ctx} taskId={taskId || null} value={goal} onChange={setGoal} />
          <OutputsEditor ctx={ctx} taskId={taskId || null} drafts={outputs} onChange={setOutputs} />
          <ExpectedEditor defs={ctx.work.definitions} tasks={ctx.tasks} taskId={taskId || null} drafts={expected} onChange={setExpected} />
          <NoteAndRatings {...details} onChange={setDetails} />
          {overlaps.length > 0 ? (
            <p className="notice notice-warn" data-testid="overlap-warning">
              {t("work.past.overlap", { count: overlaps.length })}
            </p>
          ) : null}
          <ErrorLine error={error} />
          <div className="button-row">
            <button type="submit" disabled={!ready}>
              {overlaps.length > 0 && confirmOverlap ? t("work.past.saveAnyway") : t("org.save")}
            </button>
            <button type="button" className="secondary" onClick={() => setOpen(false)}>
              {t("org.cancel")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/* ---------------- history ---------------- */

/** Ended sessions, newest first, grouped by local date; recorded work uses the stronger color with a label (T-069). */
export function SessionHistory({ ctx }: { ctx: WorkCtx }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const now = useNow(60_000);
  const ended = ctx.work.sessions.filter((s) => s.data.deletedAt === null && s.data.endedAt !== null).sort((a, b) => b.data.startedAt.localeCompare(a.data.startedAt));
  const cutoff = now - 30 * 24 * 60 * MINUTE;
  const shown = all ? ended : ended.filter((s) => Date.parse(s.data.startedAt) >= cutoff);
  const byDate = new Map<string, Session[]>();
  for (const s of shown) {
    const date = localDateOf(s.data.startedAt, ctx.zone);
    byDate.set(date, [...(byDate.get(date) ?? []), s]);
  }
  return (
    <section className="card" aria-labelledby="history-title" data-testid="session-history">
      <h2 id="history-title">{t("work.history")}</h2>
      {ended.length === 0 ? <p className="muted">{t("work.history.empty")}</p> : null}
      {[...byDate.entries()].map(([date, list]) => (
        <section key={date} aria-label={formatLocalDate(date, ctx)}>
          <h3>{formatLocalDate(date, ctx)}</h3>
          <ul className="item-list">
            {list.map((s) => (
              <SessionRow key={s.id} ctx={ctx} session={s} />
            ))}
          </ul>
        </section>
      ))}
      {!all && shown.length < ended.length ? (
        <button type="button" className="secondary" onClick={() => setAll(true)}>
          {t("work.history.showAll", { count: ended.length })}
        </button>
      ) : null}
    </section>
  );
}

function SessionRow({ ctx, session }: { ctx: WorkCtx; session: Session }) {
  const t = useT();
  const { db } = useServices();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = session.data;
  const outputs = ctx.work.outputs.filter((o) => o.data.sessionId === session.id && o.data.deletedAt === null);
  const title = sessionTitle(t, ctx, s);
  if (editing) {
    return (
      <li className="item">
        <SessionEditor ctx={ctx} session={session} onDone={() => setEditing(false)} />
      </li>
    );
  }
  const details = [
    t("work.workTime", { time: formatMinutes(t, workMinutes(s)) }),
    s.goalId ? t("work.countsToward", { name: goalName(ctx, s.goalId) }) : null,
    s.energy !== null ? t("work.energyValue", { n: s.energy }) : null,
    s.focus !== null ? t("work.focusValue", { n: s.focus }) : null,
  ].filter(Boolean);
  return (
    <li className="item session-row colored" data-color={sessionColor(ctx, s)} data-testid="session-row">
      <div className="item-main">
        <span className="block-time">{timeRange(ctx, s)}</span> <span className="item-title">{title}</span> <span className="pill pill-actual">{t("work.actual")}</span>
        <p className="hint">{details.join(" · ")}</p>
        {outputs.length > 0 ? (
          <ul className="output-list" aria-label={t("work.outputs")}>
            {outputs.map((o) => (
              <li key={o.id}>{outputText(t, ctx, o.data.definitionId, o.data.value, o.data.revision)}</li>
            ))}
          </ul>
        ) : null}
        {s.expectedOutputs.length > 0 ? (
          <p className="hint">{t("work.expectedList", { list: s.expectedOutputs.map((e) => outputText(t, ctx, e.definitionId, e.amount)).join(ctx.language === "fa" ? "، " : ", ") })}</p>
        ) : null}
        {s.notes ? <p className="preserve-lines">{s.notes}</p> : null}
        <ErrorLine error={error} />
      </div>
      <div className="button-row">
        <button type="button" className="secondary" aria-label={t("work.editLabel", { title })} onClick={() => setEditing(true)}>
          {t("org.edit")}
        </button>
        <button
          type="button"
          className="secondary"
          aria-label={t("work.deleteLabel", { title })}
          onClick={async () => {
            setError(null);
            try {
              await deleteSession(db, session.id);
            } catch (e) {
              setError(workError(t, e));
            }
          }}
        >
          {t("work.delete")}
        </button>
      </div>
    </li>
  );
}

/**
 * Edits an ended session. Times, output values, goal attribution, and output deletions keep a
 * history with an optional reason (T-102, T-131, T-143); note, ratings, expected amounts, and the
 * task or block association keep only the current value (T-157).
 */
function SessionEditor({ ctx, session, onDone }: { ctx: WorkCtx; session: Session; onDone: () => void }) {
  const t = useT();
  const s = session.data;
  return (
    <div className="editor" role="group" aria-label={t("work.editLabel", { title: sessionTitle(t, ctx, s) })} data-testid="session-editor">
      <p className="item-title">{t("work.editLabel", { title: sessionTitle(t, ctx, s) })}</p>
      <TimesCorrection ctx={ctx} session={session} />
      <GoalCorrection ctx={ctx} session={session} />
      <OutputsCorrection ctx={ctx} session={session} />
      <DetailsEdit ctx={ctx} session={session} />
      <button type="button" className="secondary" onClick={onDone}>
        {t("work.done")}
      </button>
    </div>
  );
}

function TimesCorrection({ ctx, session }: { ctx: WorkCtx; session: Session }) {
  const t = useT();
  const { db } = useServices();
  const s = session.data;
  const [startDate, setStartDate] = useState(localDateOf(s.startedAt, ctx.zone));
  const [startTime, setStartTime] = useState(wallTimeOf(s.startedAt, ctx.zone));
  const [endDate, setEndDate] = useState(localDateOf(s.endedAt!, ctx.zone));
  const [endTime, setEndTime] = useState(wallTimeOf(s.endedAt!, ctx.zone));
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = instantOf(startDate, startTime, ctx.zone);
  const end = instantOf(endDate, endTime, ctx.zone);
  const ready = !!start && start !== "gap" && !!end && end !== "gap";
  return (
    <form
      className="editor"
      aria-label={t("work.correct.times")}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready) return;
        setError(null);
        setStatus(null);
        try {
          await correctSessionTimes(db, session.id, { startedAt: start as string, endedAt: end as string }, reason);
          setStatus(t("work.saved"));
        } catch (err) {
          setError(workError(t, err));
        }
      }}
    >
      <p className="item-title">{t("work.correct.times")}</p>
      <InstantFields legend={t("work.startTime")} date={startDate} time={startTime} onDate={setStartDate} onTime={setStartTime} zone={ctx.zone} />
      <InstantFields legend={t("work.endTime")} date={endDate} time={endTime} onDate={setEndDate} onTime={setEndTime} zone={ctx.zone} />
      {s.pauses.length > 0 ? <p className="hint">{t("work.correct.pausesKept")}</p> : null}
      <ReasonField value={reason} onChange={setReason} />
      <ErrorLine error={error} />
      <p className="hint" role="status">
        {status ?? ""}
      </p>
      <button type="submit" disabled={!ready}>
        {t("work.correct.save")}
      </button>
    </form>
  );
}

function GoalCorrection({ ctx, session }: { ctx: WorkCtx; session: Session }) {
  const t = useT();
  const { db } = useServices();
  const s = session.data;
  const [goal, setGoal] = useState(s.goalId ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const choice = timeGoalChoice(ctx, s.taskId);
  if (choice.goals.length === 0 && !s.goalId) return null;
  return (
    <form
      className="editor"
      aria-label={t("work.correct.goal")}
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await setSessionGoal(db, session.id, goal || null, reason);
        } catch (err) {
          setError(workError(t, err));
        }
      }}
    >
      <TimeGoalField ctx={ctx} taskId={s.taskId} value={goal} onChange={setGoal} />
      <ReasonField value={reason} onChange={setReason} />
      <ErrorLine error={error} />
      <button type="submit" disabled={(goal || null) === s.goalId}>
        {t("work.correct.save")}
      </button>
    </form>
  );
}

function OutputsCorrection({ ctx, session }: { ctx: WorkCtx; session: Session }) {
  const t = useT();
  const { db } = useServices();
  const [adding, setAdding] = useState<OutputDraft[]>([]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const outputs = ctx.work.outputs.filter((o) => o.data.sessionId === session.id && o.data.deletedAt === null);
  const additions = outputsOf(adding);
  return (
    <fieldset className="editor">
      <legend>{t("work.outputs")}</legend>
      {outputs.length === 0 ? <p className="muted">{t("work.outputs.none")}</p> : null}
      {outputs.map((o) => (
        <OutputCorrectionRow key={o.id} ctx={ctx} output={o} />
      ))}
      <OutputsEditor ctx={ctx} taskId={session.data.taskId} drafts={adding} onChange={setAdding} />
      {adding.length > 0 ? (
        <>
          <ReasonField value={reason} onChange={setReason} />
          <ErrorLine error={error} />
          <button
            type="button"
            disabled={additions === null || additions.length === 0}
            onClick={async () => {
              setError(null);
              try {
                await addOutputs(db, session.id, additions!, reason);
                setAdding([]);
                setReason("");
              } catch (err) {
                setError(workError(t, err));
              }
            }}
          >
            {t("work.output.saveAdded")}
          </button>
        </>
      ) : null}
    </fieldset>
  );
}

function OutputCorrectionRow({ ctx, output }: { ctx: WorkCtx; output: WorkData["outputs"][number] }) {
  const t = useT();
  const { db } = useServices();
  const id = useId();
  const [value, setValue] = useState(String(output.data.value));
  const [goals, setGoals] = useState(output.data.goalIds);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const n = wholeNumber(value);
  const run = (action: () => Promise<void>) => async () => {
    setError(null);
    try {
      await action();
      setReason("");
    } catch (err) {
      setError(workError(t, err));
    }
  };
  return (
    <div className="editor" role="group" aria-label={outputText(t, ctx, output.data.definitionId, output.data.value, output.data.revision)} data-testid="output-correction">
      <p className="item-title">{outputText(t, ctx, output.data.definitionId, output.data.value, output.data.revision)}</p>
      <div className="field">
        <label htmlFor={id}>{t("work.output.amount")}</label>
        <input id={id} inputMode="numeric" value={value} aria-invalid={n === null} onChange={(e) => setValue(e.target.value)} />
      </div>
      <GoalChecks ctx={ctx} definitionId={output.data.definitionId} value={goals} onChange={setGoals} />
      <ReasonField value={reason} onChange={setReason} />
      <ErrorLine error={error} />
      <div className="button-row">
        <button type="button" disabled={n === null || n === output.data.value} onClick={run(() => correctOutputValue(db, output.id, n!, reason))}>
          {t("work.correct.value")}
        </button>
        <button type="button" className="secondary" disabled={JSON.stringify([...goals].sort()) === JSON.stringify([...output.data.goalIds].sort())} onClick={run(() => setOutputGoals(db, output.id, goals, reason))}>
          {t("work.correct.goals")}
        </button>
        <button type="button" className="secondary" onClick={run(() => deleteOutput(db, output.id, reason))}>
          {t("work.output.delete")}
        </button>
      </div>
    </div>
  );
}

/** Note, ratings, expected amounts, and task/block association: current values only, no history (T-157). */
function DetailsEdit({ ctx, session }: { ctx: WorkCtx; session: Session }) {
  const t = useT();
  const { db } = useServices();
  const id = useId();
  const s = session.data;
  const [taskId, setTaskId] = useState(s.taskId ?? "");
  const [blockId, setBlockId] = useState(s.blockId ?? "");
  const [expected, setExpected] = useState<ExpectedDraft[]>(expectedDraftsOf(s.expectedOutputs));
  const [details, setDetails] = useState({ notes: s.notes, energy: s.energy, focus: s.focus });
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const expectedList = expectedOf(expected);
  // Planned blocks of the same task within a week of the session (T-135).
  const blocks = useBlocksOfTask(ctx, taskId || null, s.startedAt);
  return (
    <form
      className="editor"
      aria-label={t("work.details")}
      onSubmit={async (e) => {
        e.preventDefault();
        if (expectedList === null) return;
        setError(null);
        setStatus(null);
        try {
          const taskChanged = (taskId || null) !== s.taskId;
          await updateSessionDetails(db, session.id, {
            ...details,
            expectedOutputs: expectedList,
            ...(taskChanged ? { taskId: taskId || null } : {}),
            ...(!taskChanged && (blockId || null) !== s.blockId ? { blockId: blockId || null } : {}),
          });
          setStatus(t("work.saved"));
        } catch (err) {
          setError(workError(t, err));
        }
      }}
    >
      <p className="item-title">{t("work.details")}</p>
      <p className="hint">{t("work.detailsHint")}</p>
      <TaskSelect ctx={ctx} value={taskId} current={s.taskId} onChange={setTaskId} />
      {taskId && taskId === s.taskId ? (
        <div className="field">
          <label htmlFor={id}>{t("work.block")}</label>
          <select id={id} value={blockId} onChange={(e) => setBlockId(e.target.value)}>
            <option value="">{t("work.block.none")}</option>
            {blocks.map((b) => (
              <option key={b.id} value={b.id}>
                {`${formatLocalDate(localDateOf(b.data.startsAt, ctx.zone), ctx, "medium")} ${formatTime(b.data.startsAt, ctx.zone, ctx.language)}–${formatTime(b.data.endsAt, ctx.zone, ctx.language)}`}
              </option>
            ))}
          </select>
          <p className="hint">{t("work.block.hint")}</p>
        </div>
      ) : taskId !== (s.taskId ?? "") && s.blockId ? (
        <p className="hint">{t("work.block.unlinkOnTaskChange")}</p>
      ) : null}
      <ExpectedEditor defs={ctx.work.definitions} tasks={ctx.tasks} taskId={taskId || null} drafts={expected} onChange={setExpected} />
      <NoteAndRatings {...details} onChange={setDetails} />
      <ErrorLine error={error} />
      <p className="hint" role="status">
        {status ?? ""}
      </p>
      <button type="submit" disabled={expectedList === null}>
        {t("org.save")}
      </button>
    </form>
  );
}

function useBlocksOfTask(ctx: WorkCtx, taskId: string | null, around: string) {
  const { db } = useServices();
  const [blocks, setBlocks] = useState<{ id: string; data: CalendarBlockData }[]>([]);
  useEffect(() => {
    let alive = true;
    if (!taskId) {
      setBlocks([]);
      return;
    }
    void db.records
      .where("type")
      .equals("calendarBlocks")
      .toArray()
      .then((rows) => {
        if (!alive) return;
        const center = Date.parse(around);
        setBlocks(
          rows
            .map((r) => ({ id: r.id, data: r.data as CalendarBlockData }))
            .filter((b) => b.data.taskId === taskId && b.data.status === "planned" && Math.abs(Date.parse(b.data.startsAt) - center) <= 7 * 24 * 60 * MINUTE)
            .sort((a, b) => a.data.startsAt.localeCompare(b.data.startsAt)),
        );
      });
    return () => {
      alive = false;
    };
  }, [db, taskId, around, ctx.work]);
  return blocks;
}

/* ---------------- trash ---------------- */

/** Deleted sessions and separately deleted outputs: restore within 30 days, or empty the trash now (T-142, T-153). */
export function TrashSection({ ctx }: { ctx: WorkCtx }) {
  const t = useT();
  const { db } = useServices();
  const now = useNow(60_000);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessions = ctx.work.sessions.filter((s) => s.data.deletedAt !== null);
  const deletedSessionIds = new Set(sessions.map((s) => s.id));
  const outputs = ctx.work.outputs.filter((o) => o.data.deletedAt !== null && !deletedSessionIds.has(o.data.sessionId));
  const daysLeft = (deletedAt: string) => Math.max(0, TRASH_DAYS - Math.floor((now - Date.parse(deletedAt)) / (24 * 60 * MINUTE)));
  const run = (action: () => Promise<unknown>) => async () => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(workError(t, e));
    }
  };
  return (
    <section className="card" aria-labelledby="trash-title" data-testid="trash">
      <h2 id="trash-title">{t("work.trash")}</h2>
      <p className="hint">{t("work.trashHint", { days: TRASH_DAYS })}</p>
      {sessions.length === 0 && outputs.length === 0 ? <p className="muted">{t("work.trash.empty")}</p> : null}
      <ul className="item-list">
        {sessions.map((s) => (
          <li key={s.id} className="item" data-testid="trash-session">
            <div className="item-main">
              <span className="item-title">{sessionTitle(t, ctx, s.data)}</span> <span className="block-time">{timeRange(ctx, s.data)}</span>
              <p className="hint">{t("work.trash.daysLeft", { days: daysLeft(s.data.deletedAt!) })}</p>
            </div>
            <button type="button" className="secondary" onClick={run(() => restoreSession(db, s.id))}>
              {t("work.restore")}
            </button>
          </li>
        ))}
        {outputs.map((o) => (
          <li key={o.id} className="item" data-testid="trash-output">
            <div className="item-main">
              <span className="item-title">{outputText(t, ctx, o.data.definitionId, o.data.value, o.data.revision)}</span>
              <p className="hint">{t("work.trash.daysLeft", { days: daysLeft(o.data.deletedAt!) })}</p>
            </div>
            <button type="button" className="secondary" onClick={run(() => restoreOutput(db, o.id))}>
              {t("work.restore")}
            </button>
          </li>
        ))}
      </ul>
      <ErrorLine error={error} />
      {sessions.length + outputs.length > 0 ? (
        confirming ? (
          <div className="notice notice-warn" role="alertdialog" aria-label={t("work.trash.emptyConfirm")}>
            <p>{t("work.trash.emptyConfirm")}</p>
            <div className="button-row">
              <button type="button" onClick={run(async () => (await purgeTrash(db, { emptyNow: true }), setConfirming(false)))}>
                {t("work.trash.emptyNow")}
              </button>
              <button type="button" className="secondary" onClick={() => setConfirming(false)}>
                {t("org.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="secondary" onClick={() => setConfirming(true)}>
            {t("work.trash.empty.action")}
          </button>
        )
      ) : null}
    </section>
  );
}

/* ---------------- output definitions ---------------- */

/** Reusable output definitions: create, rename, reword the unit, archive and restore (T-104, T-107, T-165). */
export function DefinitionsSection({ ctx }: { ctx: WorkCtx }) {
  const t = useT();
  const { db } = useServices();
  const ids = { title: useId(), name: useId(), unit: useId() };
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const defs = [...ctx.work.definitions].sort((a, b) => Number(a.data.archivedAt !== null) - Number(b.data.archivedAt !== null) || definitionLabel(a.data).name.localeCompare(definitionLabel(b.data).name));
  return (
    <section className="card" aria-labelledby={ids.title} data-testid="definitions">
      <h2 id={ids.title}>{t("work.defs")}</h2>
      <p className="hint">{t("work.defsHint")}</p>
      <ul className="item-list">
        {defs.map((d) => (
          <DefinitionRow key={d.id} definition={d} />
        ))}
      </ul>
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await createOutputDefinition(db, { name, unit });
            setName("");
            setUnit("");
          } catch (err) {
            setError(workError(t, err));
          }
        }}
      >
        <label htmlFor={ids.name}>{t("work.def.name")}</label>
        <input id={ids.name} value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} />
        <label htmlFor={ids.unit}>{t("work.def.unit")}</label>
        <input id={ids.unit} value={unit} maxLength={UNIT_MAX} onChange={(e) => setUnit(e.target.value)} />
        <button type="submit" disabled={!name.trim() || !unit.trim()}>
          {t("work.def.create")}
        </button>
      </form>
      <ErrorLine error={error} />
    </section>
  );
}

function DefinitionRow({ definition }: { definition: WorkData["definitions"][number] }) {
  const t = useT();
  const { db } = useServices();
  const ids = { name: useId(), unit: useId(), same: useId() };
  const label = definitionLabel(definition.data);
  const archived = definition.data.archivedAt !== null;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(label.name);
  const [unit, setUnit] = useState(label.unit);
  const [inUse, setInUse] = useState<boolean | null>(null);
  const [history, setHistory] = useState<"applyToHistory" | "keepPrevious">("keepPrevious");
  const [sameUnit, setSameUnit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (editing) void definitionInUse(db, definition.id).then(setInUse);
  }, [editing, db, definition.id]);
  const unitChanged = unit.trim() !== label.unit;
  if (!editing) {
    return (
      <li className="item" data-testid="definition-row">
        <div className="item-main">
          <span className="item-title">{label.name}</span> <span className="hint">({label.unit})</span> {archived ? <span className="pill pill-muted">{t("org.archived")}</span> : null}
        </div>
        <div className="button-row">
          <button type="button" className="secondary" aria-label={t("work.def.editLabel", { name: label.name })} onClick={() => setEditing(true)}>
            {t("org.edit")}
          </button>
          <button type="button" className="secondary" onClick={() => setOutputDefinitionArchived(db, definition.id, !archived)}>
            {t(archived ? "org.restore" : "org.archive")}
          </button>
        </div>
      </li>
    );
  }
  return (
    <li className="item">
      <form
        className="editor"
        aria-label={t("work.def.editLabel", { name: label.name })}
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await editOutputDefinition(db, definition.id, { name, unit, history, sameUnit });
            setEditing(false);
          } catch (err) {
            setError(err instanceof WorkError && err.code === "DIFFERENT_UNIT" ? t("work.def.differentUnit") : workError(t, err));
          }
        }}
      >
        <div className="field">
          <label htmlFor={ids.name}>{t("work.def.name")}</label>
          <input id={ids.name} value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.unit}>{t("work.def.unit")}</label>
          <input id={ids.unit} value={unit} maxLength={UNIT_MAX} onChange={(e) => setUnit(e.target.value)} />
        </div>
        {inUse ? (
          <>
            <fieldset className="field">
              <legend>{t("work.def.history")}</legend>
              <label className="check">
                <input type="radio" name={`${definition.id}-history`} checked={history === "applyToHistory"} onChange={() => setHistory("applyToHistory")} /> {t("work.def.applyToHistory")}
              </label>
              <label className="check">
                <input type="radio" name={`${definition.id}-history`} checked={history === "keepPrevious"} onChange={() => setHistory("keepPrevious")} /> {t("work.def.keepPrevious")}
              </label>
            </fieldset>
            {unitChanged ? (
              <div className="field">
                <label className="check" htmlFor={ids.same}>
                  <input id={ids.same} type="checkbox" checked={sameUnit} onChange={(e) => setSameUnit(e.target.checked)} /> {t("work.def.sameUnit")}
                </label>
                <p className="hint">{t("work.def.sameUnitHint")}</p>
              </div>
            ) : null}
          </>
        ) : null}
        <ErrorLine error={error} />
        <div className="button-row">
          <button type="submit" disabled={!name.trim() || !unit.trim() || inUse === null}>
            {t("org.save")}
          </button>
          <button type="button" className="secondary" onClick={() => setEditing(false)}>
            {t("org.cancel")}
          </button>
        </div>
      </form>
    </li>
  );
}

/* ---------------- prompts when the app opens ---------------- */

/** When this page was loaded: sessions running from before it were left running (T-093). */
export const APP_OPENED_AT = Date.now();

/**
 * Questions about open sessions when the app opens (T-093, T-149, T-162): the end time of a
 * session left running, an end time within 24 hours of work, and a reminder about a long pause.
 * Nothing is ended or changed automatically; "Still working" and "Later" only hide the question
 * until the app is opened again (a session at the 24-hour limit cannot be dismissed).
 */
export function SessionPrompts() {
  const t = useT();
  const { db } = useServices();
  const { ctx } = useWorkCtx();
  const now = useNow(60_000);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [ending, setEnding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!ctx) return null;
  const prompts = sessionPrompts(ctx.work, APP_OPENED_AT, now).filter((p) => !dismissed.has(`${p.kind}/${p.sessionId}`));
  if (prompts.length === 0) return null;
  return (
    <section className="card" aria-label={t("work.prompts")} data-testid="session-prompts">
      {prompts.map((p) => {
        const session = ctx.work.sessions.find((s) => s.id === p.sessionId)!;
        const title = sessionTitle(t, ctx, session.data);
        const key = `${p.kind}/${p.sessionId}`;
        if (ending === p.sessionId) {
          return (
            <EndSessionForm
              key={key}
              ctx={ctx}
              session={session}
              onDone={() => setEnding(null)}
              endedAt={p.kind === "workLimit" ? new Date(Date.parse(session.data.startedAt) + 24 * 60 * MINUTE + pausedBefore(session.data)).toISOString() : undefined}
            />
          );
        }
        return (
          <div key={key} className="notice notice-warn" role="alert" data-testid={`prompt-${p.kind}`}>
            <p>{t(`work.prompt.${p.kind}`, { title, since: formatTime(session.data.startedAt, ctx.zone, ctx.language) })}</p>
            <ErrorLine error={error} />
            <div className="button-row">
              {p.kind === "longPause" ? (
                <button
                  type="button"
                  onClick={async () => {
                    setError(null);
                    try {
                      await resumeSession(db, session.id);
                    } catch (e) {
                      setError(workError(t, e));
                    }
                  }}
                >
                  {t("work.resume")}
                </button>
              ) : null}
              <button type="button" onClick={() => setEnding(session.id)}>
                {t("work.prompt.enterEnd")}
              </button>
              {p.kind !== "workLimit" ? (
                <button type="button" className="secondary" onClick={() => setDismissed(new Set([...dismissed, key]))}>
                  {t(p.kind === "leftRunning" ? "work.prompt.stillWorking" : "work.prompt.later")}
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function pausedBefore(s: SessionData): number {
  return s.pauses.reduce((ms, p) => ms + (p.end ? Date.parse(p.end) - Date.parse(p.start) : 0), 0);
}

/** Removes trash older than 30 days when the app opens (T-142, T-153); nothing else runs on its own. */
export function useTrashMaintenance(): void {
  const { db } = useServices();
  useEffect(() => {
    void purgeTrash(db).catch((error: unknown) => console.error("Trash maintenance failed", error));
  }, [db]);
}

/* ---------------- the Work screen ---------------- */

export function WorkScreen({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const t = useT();
  const { ctx, loading, zone } = useWorkCtx();
  return (
    <>
      <section className="card" aria-labelledby="work-title">
        <h1 id="work-title">{t("work.title")}</h1>
        <p className="hint">{t("work.intro")}</p>
        {!zone && !loading ? <TimeZonePrompt onOpenSettings={onOpenSettings} /> : null}
      </section>
      {ctx ? (
        <>
          <CurrentSessions ctx={ctx} />
          <StartSessionForm ctx={ctx} />
          <PastSessionForm ctx={ctx} />
          <SessionHistory ctx={ctx} />
          <DefinitionsSection ctx={ctx} />
          <TrashSection ctx={ctx} />
        </>
      ) : null}
    </>
  );
}
