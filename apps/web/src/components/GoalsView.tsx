/**
 * Stage 4 — goals and milestones (PRODUCT_SPEC "Goals and measures"; DECISIONS T-037 to T-065,
 * T-077 to T-087). Every write is an explicit user action. No progress is shown: it needs the
 * recorded work and outputs of Stage 5 (T-037, T-087).
 */
import { type FormEvent, useId, useState } from "react";
import { usePreferences, useServices, useT } from "../app-context.tsx";
import { type GoalData, type GoalKind, NAME_MAX, TARGET_MAX, TEXT_MAX, UNIT_MAX } from "../backup/registry.ts";
import { formatLocalDate, type MessageKey, type Translate } from "../i18n/index.ts";
import {
  createGoal,
  createMilestone,
  defaultStartDate,
  deleteMilestone,
  filterGoals,
  type Goal,
  GoalError,
  type GoalFilter,
  type Goals,
  type Milestone,
  milestonesOfGoal,
  milestonesOutside,
  setGoalArchived,
  setGoalStatus,
  setMilestoneCompleted,
  updateGoal,
  updateMilestone,
} from "../local/goals.ts";
import type { Organization } from "../local/organization.ts";
import { RecordRuleError } from "../local/records.ts";
import { useGoals, useOrganization } from "./data-hooks.ts";
import { ArchivedPill } from "./organization-ui.tsx";
import { DateField, formatMinutes, useSharedPreferences } from "./planning-ui.tsx";

export function goalError(t: Translate, error: unknown): string {
  if (error instanceof GoalError) return t(`goal.error.${error.code}` as MessageKey, { names: error.milestoneNames.join(t("goals.nameSeparator")) });
  if (error instanceof RecordRuleError) return t(`org.error.${error.code}` as MessageKey);
  return t("org.error.generic");
}

function ErrorNotice({ error }: { error: string | null }) {
  return error ? (
    <p className="notice notice-error" role="alert">
      {error}
    </p>
  ) : null;
}

export function formatTarget(t: Translate, goal: Pick<GoalData, "kind" | "target" | "unit">): string {
  if (goal.kind === "time") return formatMinutes(t, goal.target);
  if (goal.kind === "taskCount") return t("goals.targetCount", { count: goal.target });
  return t("goals.targetOutput", { amount: goal.target, unit: goal.unit ?? "" });
}

function StatusPill({ goal }: { goal: GoalData }) {
  const t = useT();
  return (
    <>
      <span className={goal.status === "active" ? "pill" : goal.status === "completed" ? "pill pill-ok" : "pill pill-muted"}>{t(`goals.status.${goal.status}`)}</span>
      {goal.archivedAt ? <> <ArchivedPill /></> : null}
    </>
  );
}

/** Goals list and detail (Stage 4). */
export function GoalsView() {
  const goals = useGoals();
  const org = useOrganization();
  const [openId, setOpenId] = useState<string | null>(null);
  if (!goals || !org) return null;
  const open = openId ? goals.goals.find((g) => g.id === openId) : undefined;
  return open ? (
    <GoalDetail goal={open} goals={goals} org={org} onBack={() => setOpenId(null)} />
  ) : (
    <GoalList goals={goals} org={org} onOpen={setOpenId} />
  );
}

const FILTERS: GoalFilter[] = ["current", "active", "paused", "completed", "archived", "all"];

function GoalList({ goals, org, onOpen }: { goals: Goals; org: Organization; onOpen: (id: string) => void }) {
  const t = useT();
  const prefs = usePreferences();
  const filterId = useId();
  const [filter, setFilter] = useState<GoalFilter>("current");
  const shown = filterGoals(goals.goals, filter);
  const projectName = (id: string | null) => (id ? org.projects.find((p) => p.id === id)?.data.name : undefined);
  return (
    <>
      <section className="card" aria-labelledby="goals-title">
        <h1 id="goals-title">{t("goals.title")}</h1>
        <p className="hint">{t("goals.progressNote")}</p>
        <div className="filters">
          <div className="field">
            <label htmlFor={filterId}>{t("goals.filter")}</label>
            <select id={filterId} value={filter} onChange={(e) => setFilter(e.target.value as GoalFilter)}>
              {FILTERS.map((f) => (
                <option key={f} value={f}>
                  {t(`goals.filter.${f}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="muted">{goals.goals.length === 0 ? t("goals.empty") : t("goals.noMatches")}</p>
        ) : (
          <ul className="item-list" data-testid="goal-list">
            {shown.map((g) => (
              <li key={g.id} className="item">
                <div className="item-main">
                  <span className="item-title">{g.data.name}</span> <StatusPill goal={g.data} />
                  <p className="hint">
                    {[t(`goals.kind.${g.data.kind}`), formatTarget(t, g.data), projectName(g.data.projectId), goalDates(t, g.data, prefs)].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <button type="button" className="secondary" aria-label={t("goals.openLabel", { name: g.data.name })} onClick={() => onOpen(g.id)}>
                  {t("goals.open")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <NewGoal org={org} onCreated={onOpen} />
    </>
  );
}

function goalDates(t: Translate, goal: Pick<GoalData, "startDate" | "deadline">, prefs: Parameters<typeof formatLocalDate>[1]): string {
  const start = formatLocalDate(goal.startDate, prefs, "medium");
  return goal.deadline ? t("goals.dates", { start, end: formatLocalDate(goal.deadline, prefs, "medium") }) : t("goals.datesOpen", { start });
}

/* ---------------- target entry ---------------- */

interface TargetDraft {
  amount: string;
  unit: string;
  hours: string;
  minutes: string;
}

const draftOfTarget = (goal?: Pick<GoalData, "kind" | "target" | "unit">): TargetDraft =>
  goal
    ? {
        amount: goal.kind === "time" ? "" : String(goal.target),
        unit: goal.unit ?? "",
        hours: goal.kind === "time" ? String(Math.floor(goal.target / 60)) : "",
        minutes: goal.kind === "time" ? String(goal.target % 60) : "",
      }
    : { amount: "", unit: "", hours: "", minutes: "" };

const wholeNumber = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

/** The target in stored form (whole minutes for time, T-077), or null when the entry is not valid. */
function targetOf(kind: GoalKind, d: TargetDraft): number | null {
  if (kind === "time") {
    const h = d.hours.trim() === "" ? 0 : wholeNumber(d.hours);
    const m = d.minutes.trim() === "" ? 0 : wholeNumber(d.minutes);
    if (h === null || m === null || m > 59) return null;
    const total = h * 60 + m;
    return total >= 1 && total <= TARGET_MAX.time ? total : null;
  }
  const n = wholeNumber(d.amount);
  return n !== null && n >= 1 && n <= TARGET_MAX[kind] ? n : null;
}

function TargetFields({ kind, draft, onChange }: { kind: GoalKind; draft: TargetDraft; onChange: (d: TargetDraft) => void }) {
  const t = useT();
  const ids = { amount: useId(), unit: useId(), hours: useId(), minutes: useId() };
  const touched = kind === "time" ? draft.hours !== "" || draft.minutes !== "" : draft.amount !== "";
  const invalid = touched && targetOf(kind, draft) === null;
  if (kind === "time") {
    return (
      <fieldset className="field date-parts">
        <legend>{t("goals.target.time")}</legend>
        <div className="date-parts-row">
          <label htmlFor={ids.hours}>{t("goals.target.hours")}</label>
          <input id={ids.hours} inputMode="numeric" size={6} value={draft.hours} aria-invalid={invalid} onChange={(e) => onChange({ ...draft, hours: e.target.value })} />
          <label htmlFor={ids.minutes}>{t("goals.target.minutes")}</label>
          <input id={ids.minutes} inputMode="numeric" size={3} value={draft.minutes} aria-invalid={invalid} onChange={(e) => onChange({ ...draft, minutes: e.target.value })} />
        </div>
        {invalid ? <p className="hint hint-error">{t("goals.target.timeInvalid")}</p> : null}
      </fieldset>
    );
  }
  return (
    <>
      <div className="field">
        <label htmlFor={ids.amount}>{t(kind === "output" ? "goals.target.amount" : "goals.target.count")}</label>
        <input id={ids.amount} inputMode="numeric" value={draft.amount} aria-invalid={invalid} onChange={(e) => onChange({ ...draft, amount: e.target.value })} />
        {invalid ? <p className="hint hint-error">{t("goals.target.invalid", { max: TARGET_MAX[kind] })}</p> : null}
      </div>
      {kind === "output" ? (
        <div className="field">
          <label htmlFor={ids.unit}>{t("goals.target.unit")}</label>
          <input id={ids.unit} value={draft.unit} maxLength={UNIT_MAX} onChange={(e) => onChange({ ...draft, unit: e.target.value })} />
        </div>
      ) : null}
    </>
  );
}

function ProjectSelect({ org, value, current, onChange }: { org: Organization; value: string; current: string | null; onChange: (v: string) => void }) {
  const t = useT();
  const id = useId();
  // Active projects, plus the current one even if archived (editing never silently unlinks).
  const projects = org.projects.filter((p) => p.data.archivedAt === null || p.id === current);
  return (
    <div className="field">
      <label htmlFor={id}>{t("goals.project")}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("goals.noProject")}</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.data.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ---------------- create and edit ---------------- */

function NewGoal({ org, onCreated }: { org: Organization; onCreated: (id: string) => void }) {
  const t = useT();
  const { db } = useServices();
  const shared = useSharedPreferences();
  const ids = { title: useId(), name: useId(), description: useId(), kind: useId() };
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<GoalKind>("output");
  const [target, setTarget] = useState<TargetDraft>(draftOfTarget());
  const [projectId, setProjectId] = useState("");
  const [startDate, setStartDate] = useState<string | null>(null); // null = today's default (T-086)
  const [deadline, setDeadline] = useState("");
  const [error, setError] = useState<string | null>(null);
  const start = startDate ?? defaultStartDate(shared.timeZone);
  const value = targetOf(kind, target);
  const ready = !!name.trim() && value !== null && !!start && (kind !== "output" || !!target.unit.trim());

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (value === null) return;
    try {
      const id = await createGoal(db, { name, description, kind, target: value, unit: target.unit, projectId: projectId || null, startDate: start, deadline: deadline || null });
      onCreated(id);
    } catch (e) {
      setError(goalError(t, e));
    }
  }

  return (
    <section className="card" aria-labelledby={ids.title}>
      <h2 id={ids.title}>{t("goals.new")}</h2>
      <form onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor={ids.name}>{t("goals.name")}</label>
          <input id={ids.name} value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.description}>{t("goals.description")}</label>
          <textarea id={ids.description} value={description} maxLength={TEXT_MAX} rows={2} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.kind}>{t("goals.kind")}</label>
          <select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value as GoalKind)}>
            {(["output", "time", "taskCount"] as const).map((k) => (
              <option key={k} value={k}>
                {t(`goals.kind.${k}`)}
              </option>
            ))}
          </select>
          <p className="hint">{t("goals.kindFixed")}</p>
        </div>
        <TargetFields kind={kind} draft={target} onChange={setTarget} />
        <ProjectSelect org={org} value={projectId} current={null} onChange={setProjectId} />
        <DateField label={t("goals.startDate")} value={start} onChange={setStartDate} required />
        <DateField label={t("goals.deadline")} value={deadline} onChange={setDeadline} hint={t("goals.deadlineHint")} />
        <ErrorNotice error={error} />
        <button type="submit" disabled={!ready}>
          {t("goals.create")}
        </button>
      </form>
    </section>
  );
}

function GoalEditor({ goal, org, onDone }: { goal: Goal; org: Organization; onDone: () => void }) {
  const t = useT();
  const { db } = useServices();
  const ids = { name: useId(), description: useId() };
  const [name, setName] = useState(goal.data.name);
  const [description, setDescription] = useState(goal.data.description);
  const [target, setTarget] = useState<TargetDraft>(draftOfTarget(goal.data));
  const [projectId, setProjectId] = useState(goal.data.projectId ?? "");
  const [startDate, setStartDate] = useState(goal.data.startDate);
  const [deadline, setDeadline] = useState(goal.data.deadline ?? "");
  const [error, setError] = useState<string | null>(null);
  const kind = goal.data.kind;
  const value = targetOf(kind, target);
  const ready = !!name.trim() && value !== null && !!startDate && (kind !== "output" || !!target.unit.trim());

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (value === null) return;
    try {
      await updateGoal(db, goal.id, {
        name,
        description,
        target: value,
        ...(kind === "output" ? { unit: target.unit } : {}),
        projectId: projectId || null,
        startDate,
        deadline: deadline || null,
      });
      onDone();
    } catch (e) {
      setError(goalError(t, e));
    }
  }

  return (
    <form className="editor" aria-label={t("goals.editLabel", { name: goal.data.name })} onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor={ids.name}>{t("goals.name")}</label>
        <input id={ids.name} value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={ids.description}>{t("goals.description")}</label>
        <textarea id={ids.description} value={description} maxLength={TEXT_MAX} rows={2} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <p className="hint">
        {t("goals.kind")}: {t(`goals.kind.${kind}`)} — {t("goals.kindFixed")}
      </p>
      <TargetFields kind={kind} draft={target} onChange={setTarget} />
      <ProjectSelect org={org} value={projectId} current={goal.data.projectId} onChange={setProjectId} />
      <DateField label={t("goals.startDate")} value={startDate} onChange={setStartDate} required />
      <DateField label={t("goals.deadline")} value={deadline} onChange={setDeadline} hint={t("goals.deadlineHint")} />
      <ErrorNotice error={error} />
      <div className="button-row">
        <button type="submit" disabled={!ready}>
          {t("org.save")}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          {t("org.cancel")}
        </button>
      </div>
    </form>
  );
}

/* ---------------- detail ---------------- */

function GoalDetail({ goal, goals, org, onBack }: { goal: Goal; goals: Goals; org: Organization; onBack: () => void }) {
  const t = useT();
  const prefs = usePreferences();
  const { db } = useServices();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archived = goal.data.archivedAt !== null;
  const status = goal.data.status;
  const project = goal.data.projectId ? org.projects.find((p) => p.id === goal.data.projectId) : undefined;
  const milestones = milestonesOfGoal(goals.milestones, goal.id);
  const outside = new Set(milestonesOutside(goals.milestones, goal.id, goal.data).map((m) => m.id));

  const act = (action: () => Promise<void>) => async () => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(goalError(t, e));
    }
  };

  return (
    <>
      <section className="card" aria-labelledby="goal-title">
        <button type="button" className="link-button" onClick={onBack}>
          {t("goals.back")}
        </button>
        <h1 id="goal-title">
          {goal.data.name} <StatusPill goal={goal.data} />
        </h1>
        {editing ? (
          <GoalEditor goal={goal} org={org} onDone={() => setEditing(false)} />
        ) : (
          <>
            {goal.data.description ? <p className="preserve-lines">{goal.data.description}</p> : null}
            <dl className="field-list">
              <div>
                <dt>{t("goals.field.kind")}</dt>
                <dd>{t(`goals.kind.${goal.data.kind}`)}</dd>
              </div>
              <div>
                <dt>{t("goals.field.target")}</dt>
                <dd>{formatTarget(t, goal.data)}</dd>
              </div>
              <div>
                <dt>{t("goals.field.project")}</dt>
                <dd>{project ? project.data.name : goal.data.projectId ? t("org.unknownItem") : t("goals.noProject")}</dd>
              </div>
              <div>
                <dt>{t("goals.field.dates")}</dt>
                <dd>{goalDates(t, goal.data, prefs)}</dd>
              </div>
            </dl>
            <p className="notice notice-info">{t("goals.progressNote")}</p>
            {archived ? (
              <>
                <p className="hint">{t("goals.archivedHint")}</p>
                <div className="button-row">
                  <button type="button" onClick={act(() => setGoalArchived(db, goal.id, false))}>
                    {t("goals.restore")}
                  </button>
                </div>
              </>
            ) : (
              <div className="button-row">
                <button type="button" className="secondary" onClick={() => setEditing(true)}>
                  {t("org.edit")}
                </button>
                {status === "active" ? (
                  <button type="button" className="secondary" onClick={act(() => setGoalStatus(db, goal.id, "paused"))}>
                    {t("goals.pause")}
                  </button>
                ) : null}
                {status === "paused" ? (
                  <button type="button" className="secondary" onClick={act(() => setGoalStatus(db, goal.id, "active"))}>
                    {t("goals.resume")}
                  </button>
                ) : null}
                {status !== "completed" ? (
                  <button type="button" className="secondary" onClick={act(() => setGoalStatus(db, goal.id, "completed"))}>
                    {t("goals.complete")}
                  </button>
                ) : (
                  <button type="button" className="secondary" onClick={act(() => setGoalStatus(db, goal.id, "active"))}>
                    {t("goals.reopen")}
                  </button>
                )}
                <button type="button" className="secondary" onClick={act(() => setGoalArchived(db, goal.id, true))}>
                  {t("goals.archive")}
                </button>
              </div>
            )}
            <ErrorNotice error={error} />
          </>
        )}
      </section>

      <section className="card" aria-labelledby="milestones-title" data-testid="milestones">
        <h2 id="milestones-title">{t("goals.milestones")}</h2>
        {milestones.length === 0 ? <p className="muted">{t("goals.milestones.empty")}</p> : null}
        <ul className="item-list">
          {milestones.map((m) => (
            <MilestoneRow key={m.id} milestone={m} readOnly={archived} outside={outside.has(m.id)} />
          ))}
        </ul>
        {archived ? null : <NewMilestone goal={goal} />}
      </section>
    </>
  );
}

function MilestoneRow({ milestone, readOnly, outside }: { milestone: Milestone; readOnly: boolean; outside: boolean }) {
  const t = useT();
  const prefs = usePreferences();
  const { db } = useServices();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = milestone.data.name;
  const completed = milestone.data.completedAt !== null;

  const act = (action: () => Promise<void>) => async () => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(goalError(t, e));
    }
  };

  if (editing) {
    return (
      <li className="item">
        <MilestoneEditor milestone={milestone} onDone={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li className="item" data-testid="milestone">
      <div className="item-main">
        <span className="item-title">{name}</span> {completed ? <span className="pill pill-ok">{t("milestones.completed")}</span> : null}{" "}
        {outside ? <span className="pill pill-warn">{t("milestones.outside")}</span> : null}
        {milestone.data.deadline ? <p className="hint">{t("milestones.due", { date: formatLocalDate(milestone.data.deadline, prefs, "medium") })}</p> : null}
        {milestone.data.description ? <p className="hint preserve-lines">{milestone.data.description}</p> : null}
        {outside ? <p className="hint">{t("milestones.outsideHint")}</p> : null}
        {confirming ? (
          <div className="notice notice-warn" role="alertdialog" aria-label={t("milestones.deleteLabel", { name })}>
            <p>{t("milestones.confirmDelete", { name })}</p>
            <div className="button-row">
              <button type="button" onClick={act(() => deleteMilestone(db, milestone.id))}>
                {t("milestones.confirmDeleteYes")}
              </button>
              <button type="button" className="secondary" onClick={() => setConfirming(false)}>
                {t("milestones.confirmDeleteNo")}
              </button>
            </div>
          </div>
        ) : null}
        <ErrorNotice error={error} />
      </div>
      {readOnly || confirming ? null : (
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            aria-label={t(completed ? "milestones.reopenLabel" : "milestones.completeLabel", { name })}
            onClick={act(() => setMilestoneCompleted(db, milestone.id, !completed))}
          >
            {t(completed ? "milestones.reopen" : "milestones.complete")}
          </button>
          <button type="button" className="secondary" aria-label={t("milestones.editLabel", { name })} onClick={() => setEditing(true)}>
            {t("org.edit")}
          </button>
          <button type="button" className="secondary" aria-label={t("milestones.deleteLabel", { name })} onClick={() => setConfirming(true)}>
            {t("milestones.delete")}
          </button>
        </div>
      )}
    </li>
  );
}

function MilestoneFields({
  name,
  description,
  deadline,
  onChange,
}: {
  name: string;
  description: string;
  deadline: string;
  onChange: (v: { name?: string; description?: string; deadline?: string }) => void;
}) {
  const t = useT();
  const ids = { name: useId(), description: useId() };
  return (
    <>
      <div className="field">
        <label htmlFor={ids.name}>{t("milestones.name")}</label>
        <input id={ids.name} value={name} maxLength={NAME_MAX} onChange={(e) => onChange({ name: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={ids.description}>{t("milestones.description")}</label>
        <textarea id={ids.description} value={description} maxLength={TEXT_MAX} rows={2} onChange={(e) => onChange({ description: e.target.value })} />
      </div>
      <DateField label={t("milestones.deadline")} value={deadline} onChange={(v) => onChange({ deadline: v })} hint={t("milestones.deadlineHint")} />
    </>
  );
}

function MilestoneEditor({ milestone, onDone }: { milestone: Milestone; onDone: () => void }) {
  const t = useT();
  const { db } = useServices();
  const [draft, setDraft] = useState({ name: milestone.data.name, description: milestone.data.description, deadline: milestone.data.deadline ?? "" });
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="editor"
      aria-label={t("milestones.editLabel", { name: milestone.data.name })}
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await updateMilestone(db, milestone.id, { name: draft.name, description: draft.description, deadline: draft.deadline || null });
          onDone();
        } catch (e) {
          setError(goalError(t, e));
        }
      }}
    >
      <MilestoneFields {...draft} onChange={(v) => setDraft((d) => ({ ...d, ...v }))} />
      <ErrorNotice error={error} />
      <div className="button-row">
        <button type="submit" disabled={!draft.name.trim()}>
          {t("org.save")}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          {t("org.cancel")}
        </button>
      </div>
    </form>
  );
}

function NewMilestone({ goal }: { goal: Goal }) {
  const t = useT();
  const { db } = useServices();
  const titleId = useId();
  const empty = { name: "", description: "", deadline: "" };
  const [draft, setDraft] = useState(empty);
  const [added, setAdded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      key={added}
      aria-labelledby={titleId}
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await createMilestone(db, { goalId: goal.id, name: draft.name, description: draft.description, deadline: draft.deadline || null });
          setDraft(empty);
          setAdded((n) => n + 1); // a fresh form also clears Jalali date parts
        } catch (e) {
          setError(goalError(t, e));
        }
      }}
    >
      <h3 id={titleId}>{t("milestones.new")}</h3>
      <MilestoneFields {...draft} onChange={(v) => setDraft((d) => ({ ...d, ...v }))} />
      <ErrorNotice error={error} />
      <button type="submit" disabled={!draft.name.trim()}>
        {t("milestones.add")}
      </button>
    </form>
  );
}
