/** Shared pieces of the Stage 2 screens (Inbox, Projects): task editing, task rows, filters. */
import { useLiveQuery } from "dexie-react-hooks";
import { type FormEvent, useId, useState } from "react";
import { useServices, useT } from "../app-context.tsx";
import { ESTIMATE_MAX_MINUTES, NAME_MAX, NEXT_ACTION_MAX, TASK_DEFINITIONS, TEXT_MAX } from "../backup/registry.ts";
import type { MessageKey, Translate } from "../i18n/index.ts";
import { loadOrganization, type Organization, setArchived, type StatusFilter, type TaskDefinition, updateTask } from "../local/organization.ts";
import { RecordRuleError } from "../local/records.ts";

/** All projects, workstreams, and task definitions on this device, kept live. */
export function useOrganization(): Organization | undefined {
  const { db } = useServices();
  return useLiveQuery(() => loadOrganization(db), [db]);
}

export function organizationError(t: Translate, error: unknown): string {
  if (error instanceof RecordRuleError) return t(`org.error.${error.code}` as MessageKey);
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
  const [error, setError] = useState<string | null>(null);

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
      });
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
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row">
        <button type="submit" disabled={!title.trim() || estimateInvalid}>
          {t("org.save")}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          {t("org.cancel")}
        </button>
      </div>
    </form>
  );
}

/** One task in a list: title, next action, estimate, and edit/archive actions. */
export function TaskRow({ task, org, context }: { task: TaskDefinition; org: Organization; context?: string }) {
  const t = useT();
  const { db } = useServices();
  const [editing, setEditing] = useState(false);
  const archived = task.data.archivedAt !== null;
  if (editing) {
    return (
      <li className="item">
        <TaskEditor task={task} org={org} onDone={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li className="item" data-testid="task-row">
      <div className="item-main">
        <span className="item-title">{task.data.title}</span> {archived ? <ArchivedPill /> : null}
        {context ? <span className="hint"> · {context}</span> : null}
        {task.data.nextAction ? <p className="hint">{t("org.task.nextShort", { action: task.data.nextAction })}</p> : null}
        {task.data.estimateMinutes !== null ? <p className="hint">{t("org.task.estimateShort", { minutes: task.data.estimateMinutes })}</p> : null}
      </div>
      <div className="button-row">
        <button type="button" className="secondary" aria-label={t("org.task.editLabel", { title: task.data.title })} onClick={() => setEditing(true)}>
          {t("org.edit")}
        </button>
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
