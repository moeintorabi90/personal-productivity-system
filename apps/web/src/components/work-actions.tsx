/**
 * Small Stage 5 actions used on planning screens (Today, Calendar, task lists): complete or
 * reopen a task or occurrence (T-108, T-118, T-123, T-130, T-133, T-155), and start a session from
 * a planned block (T-094, T-141). Every write is an explicit user action.
 */
import { useEffect, useId, useState } from "react";
import { useServices, useT } from "../app-context.tsx";
import { type ExpectedOutput, type GoalData, OUTPUT_VALUE_MAX, type TaskDefinitionData } from "../backup/registry.ts";
import type { MessageKey, Translate } from "../i18n/index.ts";
import { GoalError } from "../local/goals.ts";
import { RecordRuleError } from "../local/records.ts";
import { allowedTaskCountGoals, completeTask, definitionLabel, openSessions, reopenTask, startSession, type WorkData, WorkError } from "../local/work.ts";
import { useGoals, useOrganization, useWork } from "./data-hooks.ts";

export function workError(t: Translate, error: unknown): string {
  if (error instanceof WorkError) return t(`work.error.${error.code}` as MessageKey);
  if (error instanceof GoalError) return t(`goal.error.${error.code}` as MessageKey, { names: error.milestoneNames.join(t("goals.nameSeparator")) });
  if (error instanceof RecordRuleError) return t(`org.error.${error.code}` as MessageKey);
  return t("org.error.generic");
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p className="notice notice-error" role="alert">
      {error}
    </p>
  ) : null;
}

/** A goal choice with an explicit "none" (T-129, T-130). Archived goals are labelled. */
export function GoalSelect({
  label,
  goals,
  value,
  onChange,
  hint,
}: {
  label: string;
  goals: { id: string; data: GoalData }[];
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  const t = useT();
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("work.goal.none")}</option>
        {goals.map((g) => (
          <option key={g.id} value={g.id}>
            {g.data.archivedAt ? t("work.goal.archived", { name: g.data.name }) : g.data.name}
          </option>
        ))}
      </select>
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

/**
 * "Complete" for a one-off task (`occurrenceDate` null) or one occurrence. When task-count goals
 * exist, the user chooses one — the task's linked ones, or any when none is linked — or "none"
 * (T-123, T-130); a single linked goal is pre-selected. A manual choice adds no task–goal link.
 */
export function CompleteControl({ taskId, occurrenceDate, title }: { taskId: string; occurrenceDate: string | null; title: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // The goal data is read only once the user opens the control (task lists show many of these).
  if (open) return <CompleteForm taskId={taskId} occurrenceDate={occurrenceDate} title={title} onClose={() => setOpen(false)} />;
  return (
    <button type="button" className="secondary" aria-label={t("work.complete.label", { title })} onClick={() => setOpen(true)}>
      {t("work.complete")}
    </button>
  );
}

function CompleteForm({ taskId, occurrenceDate, title, onClose }: { taskId: string; occurrenceDate: string | null; title: string; onClose: () => void }) {
  const t = useT();
  const { db } = useServices();
  const goals = useGoals();
  const org = useOrganization();
  const [goalId, setGoalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tasks = new Map((org?.tasks ?? []).map((task) => [task.id, task.data]));
  const allowed = new Set(goals ? allowedTaskCountGoals(taskId, tasks, goals.goals) : []);
  const choices = (goals?.goals ?? []).filter((g) => allowed.has(g.id)).sort((a, b) => a.data.name.localeCompare(b.data.name));
  const linked = (tasks.get(taskId)?.goalIds ?? []).filter((id) => allowed.has(id));
  const chosen = goalId ?? (linked.length === 1 ? linked[0]! : "");
  const loaded = !!goals && !!org;

  async function complete(goal: string | null) {
    setError(null);
    setBusy(true);
    try {
      await completeTask(db, taskId, { occurrenceDate, goalId: goal });
      onClose();
    } catch (e) {
      setError(workError(t, e));
      setBusy(false);
    }
  }

  // Without any task-count goal there is nothing to choose: complete at once (T-130 "none").
  useEffect(() => {
    if (loaded && choices.length === 0 && !busy && error === null) void complete(null);
  }, [loaded, choices.length]);

  if (!loaded || choices.length === 0) return error ? <ErrorLine error={error} /> : null;
  return (
    <div className="editor" role="group" aria-label={t("work.complete.label", { title })}>
      <GoalSelect
        label={t("work.complete.goal")}
        goals={choices}
        value={chosen}
        onChange={setGoalId}
        hint={linked.length > 0 ? t("work.complete.linkedHint") : t("work.complete.manualHint")}
      />
      <ErrorLine error={error} />
      <div className="button-row">
        <button type="button" onClick={() => complete(chosen || null)}>
          {t("work.complete.confirm")}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          {t("org.cancel")}
        </button>
      </div>
    </div>
  );
}

/** Reopens a completed one-off task or occurrence; its task-count progress is reversed (T-133). */
export function ReopenButton({ taskId, occurrenceDate, title }: { taskId: string; occurrenceDate: string | null; title: string }) {
  const t = useT();
  const { db } = useServices();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="secondary"
        aria-label={t("work.reopen.label", { title })}
        onClick={async () => {
          setError(null);
          try {
            await reopenTask(db, taskId, occurrenceDate);
          } catch (e) {
            setError(workError(t, e));
          }
        }}
      >
        {t("work.reopen")}
      </button>
      <ErrorLine error={error} />
    </>
  );
}

/** Starts a session from a planned block of its task (T-094): linked, with the block's expected amounts copied (T-141). */
export function StartFromBlockButton({ blockId, title }: { blockId: string; title: string }) {
  const t = useT();
  const { db } = useServices();
  const work = useWork();
  const [error, setError] = useState<string | null>(null);
  const busy = !work || openSessions(work.sessions).length > 0;
  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        aria-label={t("work.startFromBlock.label", { title })}
        title={busy && work ? t("work.error.SESSION_OPEN") : undefined}
        onClick={async () => {
          setError(null);
          try {
            await startSession(db, { blockId });
          } catch (e) {
            setError(workError(t, e));
          }
        }}
      >
        {t("work.startFromBlock")}
      </button>
      <ErrorLine error={error} />
    </>
  );
}

/* ---------------- expected output amounts (T-125, T-128, T-141, T-150, T-163) ---------------- */

const wholeNumber = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

export interface ExpectedDraft {
  key: string;
  definitionId: string;
  amount: string;
}

export const expectedDraftsOf = (list: readonly ExpectedOutput[]): ExpectedDraft[] => list.map((e) => ({ key: crypto.randomUUID(), definitionId: e.definitionId, amount: String(e.amount) }));

/** Expected amounts as entered: 0 is a stored amount; an empty row is no entry (T-125, T-163). */
export function expectedOf(drafts: ExpectedDraft[]): ExpectedOutput[] | null {
  const out: ExpectedOutput[] = [];
  const seen = new Set<string>();
  for (const d of drafts) {
    if (!d.definitionId && d.amount.trim() === "") continue;
    const amount = wholeNumber(d.amount);
    if (!d.definitionId || amount === null || amount > OUTPUT_VALUE_MAX || seen.has(d.definitionId)) return null;
    seen.add(d.definitionId);
    out.push({ definitionId: d.definitionId, amount });
  }
  return out;
}

export function ExpectedEditor({ defs, taskId, drafts, onChange, tasks }: { defs: WorkData["definitions"]; taskId: string | null; tasks: Map<string, TaskDefinitionData>; drafts: ExpectedDraft[]; onChange: (d: ExpectedDraft[]) => void }) {
  const t = useT();
  const suggested = new Set(taskId ? (tasks.get(taskId)?.outputDefinitionIds ?? []) : []);
  const options = defs
    .filter((d) => d.data.archivedAt === null)
    .map((d) => ({ id: d.id, label: `${definitionLabel(d.data).name} (${definitionLabel(d.data).unit})`, suggested: suggested.has(d.id) }))
    .sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.label.localeCompare(b.label));
  const set = (key: string, patch: Partial<ExpectedDraft>) => onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  return (
    <fieldset className="field">
      <legend>{t("work.expected")}</legend>
      <p className="hint">{t("work.expectedHint")}</p>
      {drafts.map((d, i) => (
        <ExpectedRow key={d.key} index={i} draft={d} options={options} onChange={(p) => set(d.key, p)} onRemove={() => onChange(drafts.filter((x) => x.key !== d.key))} />
      ))}
      <button type="button" className="secondary" disabled={options.length === 0} onClick={() => onChange([...drafts, { key: crypto.randomUUID(), definitionId: "", amount: "" }])}>
        {t("work.expected.add")}
      </button>
    </fieldset>
  );
}

function ExpectedRow({ index, draft, options, onChange, onRemove }: { index: number; draft: ExpectedDraft; options: { id: string; label: string; suggested: boolean }[]; onChange: (p: Partial<ExpectedDraft>) => void; onRemove: () => void }) {
  const t = useT();
  const ids = { def: useId(), amount: useId() };
  return (
    <div className="inline-form" role="group" aria-label={t("work.expected.row", { n: index + 1 })}>
      <label htmlFor={ids.def}>{t("work.output.definition")}</label>
      <select id={ids.def} value={draft.definitionId} onChange={(e) => onChange({ definitionId: e.target.value })}>
        <option value="">{t("work.output.choose")}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.suggested ? t("work.output.suggested", { label: o.label }) : o.label}
          </option>
        ))}
      </select>
      <label htmlFor={ids.amount}>{t("work.expected.amount")}</label>
      <input id={ids.amount} inputMode="numeric" size={8} value={draft.amount} onChange={(e) => onChange({ amount: e.target.value })} />
      <button type="button" className="secondary" onClick={onRemove}>
        {t("work.output.remove")}
      </button>
    </div>
  );
}
