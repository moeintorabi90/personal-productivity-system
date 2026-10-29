/** Shared pieces of the Stage 2 screens (Inbox, Projects): task editing, task rows, filters. */
import { type FormEvent, useId, useState } from "react";
import { usePreferences, useServices, useT } from "../app-context.tsx";
import { ESTIMATE_MAX_MINUTES, NAME_MAX, NEXT_ACTION_MAX, type Recurrence, TASK_DEFINITIONS, TEXT_MAX } from "../backup/registry.ts";
import { formatLocalDate, formatWeekdayShort, type MessageKey, type Translate } from "../i18n/index.ts";
import { type Organization, setArchived, type StatusFilter, type TaskDefinition, updateTask } from "../local/organization.ts";
import { PlanningError } from "../local/planning.ts";
import { RecordRuleError } from "../local/records.ts";
import { isLocalDate, localDateOf } from "../planning/time.ts";
import { setTaskGoals, setTaskSuggestedDefinitions, definitionLabel } from "../local/work.ts";
import { useCompletedTaskIds, useGoals, useWork } from "./data-hooks.ts";
import { BlockForm, DateField, usePlanning, useSharedPreferences } from "./planning-ui.tsx";
import { CompleteControl, ReopenButton } from "./work-actions.tsx";

export { useOrganization } from "./data-hooks.ts";

export function organizationError(t: Translate, error: unknown): string {
  if (error instanceof RecordRuleError) return t(`org.error.${error.code}` as MessageKey);
  if (error instanceof PlanningError) return t(`plan.error.${error.code}` as MessageKey);
  return t("org.error.generic");
}

export function StatusFilterSelect({ value, onChange }: { value: StatusFilter; onChange: (value: StatusFilter) => void }) {
  const t = useT();
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{t("org.filter.status")}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as StatusFilter)}>
        <option value="active">{t("org.filter.active")}</option>
        <option value="completed">{t("org.filter.completed")}</option>
        <option value="archived">{t("org.filter.archived")}</option>
        <option value="all">{t("org.filter.all")}</option>
      </select>
    </div>
  );
}

export function SearchField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="search" value={value} maxLength={NAME_MAX} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function ArchivedPill() {
  const t = useT();
  return <span className="pill pill-muted">{t("org.archived")}</span>;
}

/** Edits every field of a task, including moving it between the inbox, projects, and workstreams. */
export function TaskEditor({ task, org, onDone }: { task: TaskDefinition; org: Organization; onDone: () => void }) {
  const t = useT();
  const { db } = useServices();
  const ids = { title: useId(), project: useId(), workstream: useId(), next: useId(), estimate: useId(), notes: useId() };
  const [title, setTitle] = useState(task.data.title);
  const [projectId, setProjectId] = useState(task.data.projectId ?? "");
  const [workstreamId, setWorkstreamId] = useState(task.data.workstreamId ?? "");
  const [nextAction, setNextAction] = useState(task.data.nextAction);
  const [estimate, setEstimate] = useState(task.data.estimateMinutes === null ? "" : String(task.data.estimateMinutes));
  const [notes, setNotes] = useState(task.data.notes);
  const [recurrence, setRecurrence] = useState<RecurrenceDraft>(() => draftOf(task.data.recurrence));
  const [goalIds, setGoalIds] = useState<string[]>(task.data.goalIds ?? []);
  const [definitionIds, setDefinitionIds] = useState<string[]>(task.data.outputDefinitionIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const goals = useGoals();
  const work = useWork();
  const sameList = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const recurrenceProblem = recurrenceError(recurrence);

  // Active choices, plus the current ones even if archived (so editing never silently moves a task).
  const projects = org.projects.filter((p) => p.data.archivedAt === null || p.id === task.data.projectId);
  const workstreams = org.workstreams.filter(
    (w) => w.data.projectId === projectId && (w.data.archivedAt === null || w.id === task.data.workstreamId),
  );
  const estimateValue = estimate.trim() === "" ? null : Number(estimate);
  const estimateInvalid =
    estimateValue !== null && (!Number.isInteger(estimateValue) || estimateValue < 1 || estimateValue > ESTIMATE_MAX_MINUTES);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await updateTask(db, task.id, {
        title,
        notes,
        nextAction,
        estimateMinutes: estimateValue,
        projectId: projectId || null,
        workstreamId: projectId && workstreamId ? workstreamId : null,
        // Unchanged recurrence is left out, so the record is not rewritten for it.
        ...recurrencePatch(task.data.recurrence, recurrence),
      });
      // Explicit task–goal links of any kind (T-120; never inherited from the project, T-121) and suggested definitions (T-138).
      if (!sameList(goalIds, task.data.goalIds ?? [])) await setTaskGoals(db, task.id, goalIds);
      if (!sameList(definitionIds, task.data.outputDefinitionIds ?? [])) await setTaskSuggestedDefinitions(db, task.id, definitionIds);
      onDone();
    } catch (e) {
      setError(organizationError(t, e));
    }
  }

  return (
    <form className="editor" onSubmit={onSubmit} aria-label={t("org.task.editLabel", { title: task.data.title })}>
      <div className="field">
        <label htmlFor={ids.title}>{t("org.task.title")}</label>
        <input id={ids.title} value={title} maxLength={NAME_MAX} required onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={ids.project}>{t("org.task.project")}</label>
        <select
          id={ids.project}
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setWorkstreamId(""); // a workstream belongs to one project
          }}
        >
          <option value="">{t("org.task.noProject")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.data.name}
            </option>
          ))}
        </select>
      </div>
      {projectId ? (
        <div className="field">
          <label htmlFor={ids.workstream}>{t("org.task.workstream")}</label>
          <select id={ids.workstream} value={workstreamId} onChange={(e) => setWorkstreamId(e.target.value)}>
            <option value="">{t("org.task.noWorkstream")}</option>
            {workstreams.map((w) => (
              <option key={w.id} value={w.id}>
                {w.data.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor={ids.next}>{t("org.task.nextAction")}</label>
        <input id={ids.next} value={nextAction} maxLength={NEXT_ACTION_MAX} onChange={(e) => setNextAction(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={ids.estimate}>{t("org.task.estimate")}</label>
        <input
          id={ids.estimate}
          type="number"
          inputMode="numeric"
          min={1}
          max={ESTIMATE_MAX_MINUTES}
          step={1}
          value={estimate}
          aria-invalid={estimateInvalid}
          onChange={(e) => setEstimate(e.target.value)}
        />
        {estimateInvalid ? <p className="hint hint-error">{t("org.task.estimateInvalid", { max: ESTIMATE_MAX_MINUTES })}</p> : null}
      </div>
      <div className="field">
        <label htmlFor={ids.notes}>{t("org.task.notes")}</label>
        <textarea id={ids.notes} value={notes} maxLength={TEXT_MAX} rows={3} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <RecurrenceFields draft={recurrence} onChange={setRecurrence} problem={recurrenceProblem} />
      {goals && goals.goals.length > 0 ? (
        <fieldset className="field" data-testid="task-goal-links">
          <legend>{t("work.taskGoals")}</legend>
          {goals.goals
            .filter((g) => g.data.archivedAt === null || goalIds.includes(g.id))
            .sort((a, b) => a.data.name.localeCompare(b.data.name))
            .map((g) => (
              <label key={g.id} className="check">
                <input type="checkbox" checked={goalIds.includes(g.id)} onChange={(e) => setGoalIds(e.target.checked ? [...goalIds, g.id] : goalIds.filter((id) => id !== g.id))} />{" "}
                {g.data.name} ({t(`goals.kind.${g.data.kind}`)})
              </label>
            ))}
          <p className="hint">{t("work.taskGoalsHint")}</p>
        </fieldset>
      ) : null}
      {work && work.definitions.length > 0 ? (
        <fieldset className="field" data-testid="task-suggested-definitions">
          <legend>{t("work.taskDefinitions")}</legend>
          {work.definitions
            .filter((d) => d.data.archivedAt === null || definitionIds.includes(d.id))
            .map((d) => (
              <label key={d.id} className="check">
                <input type="checkbox" checked={definitionIds.includes(d.id)} onChange={(e) => setDefinitionIds(e.target.checked ? [...definitionIds, d.id] : definitionIds.filter((id) => id !== d.id))} />{" "}
                {definitionLabel(d.data).name} ({definitionLabel(d.data).unit})
              </label>
            ))}
          <p className="hint">{t("work.taskDefinitionsHint")}</p>
        </fieldset>
      ) : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row">
        <button type="submit" disabled={!title.trim() || estimateInvalid || recurrenceProblem !== null}>
          {t("org.save")}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          {t("org.cancel")}
        </button>
      </div>
    </form>
  );
}

/* ---------- recurrence (Stage 3, T-029) ---------- */

interface RecurrenceDraft {
  enabled: boolean;
  weekdays: number[];
  startDate: string;
  endDate: string;
}

function draftOf(recurrence: Recurrence | undefined): RecurrenceDraft {
  return recurrence
    ? { enabled: true, weekdays: [...recurrence.weekdays], startDate: recurrence.startDate, endDate: recurrence.endDate ?? "" }
    : { enabled: false, weekdays: [], startDate: "", endDate: "" };
}

function recurrenceOf(draft: RecurrenceDraft): Recurrence | null {
  if (!draft.enabled) return null;
  return { kind: "weekdays", weekdays: [...draft.weekdays].sort((a, b) => a - b), startDate: draft.startDate, endDate: draft.endDate || null };
}

function recurrenceError(draft: RecurrenceDraft): MessageKey | null {
  if (!draft.enabled) return null;
  if (draft.weekdays.length === 0) return "recurrence.error.weekdays";
  if (!isLocalDate(draft.startDate)) return "recurrence.error.start";
  if (draft.endDate && draft.endDate < draft.startDate) return "recurrence.error.end";
  return null;
}

/** The `recurrence` part of a task edit: left out when unchanged, null to turn it off. */
function recurrencePatch(before: Recurrence | undefined, draft: RecurrenceDraft): { recurrence?: Recurrence | null } {
  const next = recurrenceOf(draft);
  if (JSON.stringify(next) === JSON.stringify(before ?? null)) return {};
  return { recurrence: next };
}

/**
 * Weekly recurrence on selected weekdays, a required start date (pre-filled with today's date in
 * the configured zone when turned on), and an optional inclusive end date. No other patterns in
 * Stage 3 (T-029). Turning it on needs a configured time zone (T-028).
 */
function RecurrenceFields({ draft, onChange, problem }: { draft: RecurrenceDraft; onChange: (draft: RecurrenceDraft) => void; problem: MessageKey | null }) {
  const t = useT();
  const prefs = usePreferences();
  const shared = useSharedPreferences();
  const id = useId();
  const zone = shared.timeZone;
  const weekdays = Array.from({ length: 7 }, (_, i) => (prefs.weekStart + i) % 7);
  return (
    <fieldset className="field recurrence">
      <legend>{t("recurrence.title")}</legend>
      <div className="checkbox-field">
        <input
          id={id}
          type="checkbox"
          checked={draft.enabled}
          disabled={!zone && !draft.enabled}
          onChange={(e) =>
            onChange(
              e.target.checked
                ? { ...draft, enabled: true, startDate: draft.startDate || (zone ? localDateOf(Date.now(), zone) : "") }
                : { ...draft, enabled: false },
            )
          }
        />
        <label htmlFor={id}>{t("recurrence.enable")}</label>
      </div>
      {!zone && !draft.enabled ? <p className="hint">{t("recurrence.needsZone")}</p> : null}
      {draft.enabled ? (
        <>
          <div className="weekday-picks" role="group" aria-label={t("recurrence.weekdays")}>
            {weekdays.map((day) => (
              <label key={day} className="weekday-pick">
                <input
                  type="checkbox"
                  checked={draft.weekdays.includes(day)}
                  onChange={(e) =>
                    onChange({ ...draft, weekdays: e.target.checked ? [...draft.weekdays, day] : draft.weekdays.filter((d) => d !== day) })
                  }
                />
                {t(`weekday.${day}` as MessageKey)}
              </label>
            ))}
          </div>
          <DateField label={t("recurrence.start")} value={draft.startDate} onChange={(startDate) => onChange({ ...draft, startDate })} required />
          <DateField
            label={t("recurrence.end")}
            value={draft.endDate}
            onChange={(endDate) => onChange({ ...draft, endDate })}
            hint={t("recurrence.endHint")}
          />
          {problem ? <p className="hint hint-error">{t(problem)}</p> : null}
        </>
      ) : null}
    </fieldset>
  );
}

function recurrenceSummary(t: Translate, recurrence: Recurrence, prefs: ReturnType<typeof usePreferences>): string {
  const ordered = [...recurrence.weekdays].sort((a, b) => ((a - prefs.weekStart + 7) % 7) - ((b - prefs.weekStart + 7) % 7));
  const days = ordered.map((d) => formatWeekdayShort(d, prefs.language)).join(prefs.language === "fa" ? "، " : ", ");
  const from = formatLocalDate(recurrence.startDate, prefs, "medium");
  return recurrence.endDate
    ? t("recurrence.summaryUntil", { days, from, until: formatLocalDate(recurrence.endDate, prefs, "medium") })
    : t("recurrence.summary", { days, from });
}

/** "Plan" on a task: a block for this task at a time the user enters (PRODUCT_SPEC "Scheduling"). */
function PlanTask({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const { ctx, zone } = usePlanning();
  const t = useT();
  if (!zone) return <p className="hint">{t("plan.zonePrompt")}</p>;
  if (!ctx) return null;
  return <BlockForm ctx={ctx} mode={{ kind: "task", taskId, date: localDateOf(Date.now(), ctx.zone) }} onDone={onDone} />;
}

/**
 * One task in a list: title, next action, estimate, recurrence, and edit/plan/archive actions. A
 * one-off task can be completed and reopened here (T-108, T-133); a completed one leaves the
 * active list and appears under "Completed" (T-134). Occurrences of recurring tasks are
 * completed on their date (Today, Calendar).
 */
export function TaskRow({ task, org, context, listStatus }: { task: TaskDefinition; org: Organization; context?: string; listStatus?: StatusFilter }) {
  const t = useT();
  const prefs = usePreferences();
  const { db } = useServices();
  const completedIds = useCompletedTaskIds();
  const [editing, setEditing] = useState(false);
  const [planning, setPlanning] = useState(false);
  const archived = task.data.archivedAt !== null;
  const completed = !task.data.recurrence && completedIds.has(task.id);
  if ((listStatus === "active" && completed) || (listStatus === "completed" && !completed)) return null;
  if (editing) {
    return (
      <li className="item">
        <TaskEditor task={task} org={org} onDone={() => setEditing(false)} />
      </li>
    );
  }
  if (planning) {
    return (
      <li className="item">
        <PlanTask taskId={task.id} onDone={() => setPlanning(false)} />
      </li>
    );
  }
  return (
    <li className="item" data-testid="task-row">
      <div className="item-main">
        <span className="item-title">{task.data.title}</span> {archived ? <ArchivedPill /> : null}
        {completed ? <span className="pill pill-ok">{t("work.completed")}</span> : null}
        {context ? <span className="hint"> · {context}</span> : null}
        {task.data.nextAction ? <p className="hint">{t("org.task.nextShort", { action: task.data.nextAction })}</p> : null}
        {task.data.estimateMinutes !== null ? <p className="hint">{t("org.task.estimateShort", { minutes: task.data.estimateMinutes })}</p> : null}
        {task.data.recurrence ? <p className="hint">{recurrenceSummary(t, task.data.recurrence, prefs)}</p> : null}
      </div>
      <div className="button-row">
        <button type="button" className="secondary" aria-label={t("org.task.editLabel", { title: task.data.title })} onClick={() => setEditing(true)}>
          {t("org.edit")}
        </button>
        {!archived && !completed ? (
          <button type="button" className="secondary" aria-label={t("plan.planLabel", { title: task.data.title })} onClick={() => setPlanning(true)}>
            {t("plan.plan")}
          </button>
        ) : null}
        {!task.data.recurrence && !archived ? (
          completed ? (
            <ReopenButton taskId={task.id} occurrenceDate={null} title={task.data.title} />
          ) : (
            <CompleteControl taskId={task.id} occurrenceDate={null} title={task.data.title} />
          )
        ) : null}
        <button
          type="button"
          className="secondary"
          aria-label={t(archived ? "org.restoreLabel" : "org.archiveLabel", { name: task.data.title })}
          onClick={() => setArchived(db, TASK_DEFINITIONS, task.id, !archived)}
        >
          {t(archived ? "org.restore" : "org.archive")}
        </button>
      </div>
    </li>
  );
}
