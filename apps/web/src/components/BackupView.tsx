import type { PreferenceFields } from "@pps/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { type ChangeEvent, useId, useState } from "react";
import { useLastBackupAt, usePreferences, useServices, useT } from "../app-context.tsx";
import {
  type ConflictView,
  type LinkedItem,
  loadConflictViews,
  type Resolution,
  ResolutionError,
  resolveConflict,
  resolveConflicts,
  restoreReplacedVersion,
} from "../backup/conflicts.ts";
import { canShareFiles, downloadBackup, readFileBytes, shareBackup } from "../backup/deliver.ts";
import { BackupError } from "../backup/errors.ts";
import { createBackup, type ExportResult, markBackupExported } from "../backup/export.ts";
import { applyImport, type ImportPreview, type ImportResult, previewImport } from "../backup/merge.ts";
import { type CheckedBackup, checkBackupFile, type OpenedBackup, openCheckedBackup } from "../backup/read.ts";
import { PRODUCT_REGISTRY } from "../backup/registry.ts";
import { formatDateTime, formatLocalDate, type MessageKey, type Translate } from "../i18n/index.ts";
import type { DeviceIdentity, VersionEntry } from "../local/db.ts";
import { getMeta } from "../local/db.ts";
import { renameDevice } from "../local/repository.ts";
import { definitionLabel } from "../local/work.ts";
import { useGoals, useWork } from "./data-hooks.ts";
import { useOrganization } from "./organization-ui.tsx";
import { lastBackupText } from "./StatusBar.tsx";

const registry = PRODUCT_REGISTRY;

function errorMessage(t: Translate, error: unknown): string {
  if (error instanceof BackupError) return t(`backup.error.${error.code}` as MessageKey);
  if (error instanceof ResolutionError && error.code === "HAS_LINKED_ITEMS") {
    return t("backup.resolve.error", {
      reason: error.linkedItems.length > 0 ? t("backup.resolve.hasLinkedCount", { count: error.linkedItems.length }) : t("backup.resolve.hasLinked"),
    });
  }
  if (error instanceof ResolutionError && error.code === "LINKED_ITEMS_MISMATCH") {
    return t("backup.resolve.error", { reason: t("backup.resolve.linkedMismatch", { count: error.linkedItems.length }) });
  }
  if (error instanceof ResolutionError && error.code === "IMMUTABLE_FIELD") {
    return t("backup.resolve.error", { reason: t("backup.resolve.immutableField") });
  }
  if (error instanceof ResolutionError && error.code === "INCONSISTENT_HISTORY") {
    return t("backup.resolve.error", { reason: t("backup.resolve.inconsistentHistory") });
  }
  if (error instanceof ResolutionError && error.code === "BROKEN_LINK") {
    return t("backup.resolve.error", { reason: t("backup.resolve.brokenLink") });
  }
  if (error instanceof ResolutionError && error.code === "INVALID_RELATIONSHIP") {
    return t("backup.resolve.error", { reason: t("backup.resolve.invalidRelationship") });
  }
  if (error instanceof ResolutionError && error.code === "STALE") return t("backup.resolve.stale");
  return t("backup.error.generic");
}

/** An error to show: its message and, for LINKED_ITEMS_MISMATCH, the outputs on this device that block the choice. */
interface ShownError {
  text: string;
  outputs: string[];
}

function shownError(t: Translate, error: unknown, suffix = ""): ShownError {
  const blocking =
    (error instanceof ResolutionError || error instanceof BackupError) && error.code === "LINKED_ITEMS_MISMATCH"
      ? error.linkedItems.map((item) => item.id)
      : [];
  return { text: `${errorMessage(t, error)}${suffix}`, outputs: blocking };
}

function ErrorNotice({ error, testId }: { error: ShownError; testId?: string }) {
  return (
    <div className="notice notice-error" role="alert" data-testid={testId}>
      <p>{error.text}</p>
      {error.outputs.length > 0 ? <BlockingOutputs ids={error.outputs} /> : null}
    </div>
  );
}

/** Names each blocking output so the owner can find it on the Work screen: amount, definition, session start, trash. */
function BlockingOutputs({ ids }: { ids: string[] }) {
  const t = useT();
  const prefs = usePreferences();
  const work = useWork();
  if (!work) return null; // still loading: never claim an output is missing
  return (
    <ul data-testid="blocking-outputs">
      {ids.map((id) => {
        const output = work.outputs.find((o) => o.id === id);
        if (!output) return <li key={id}>{t("org.unknownItem")}</li>;
        const definition = work.definitions.find((d) => d.id === output.data.definitionId);
        const label = definition ? definitionLabel(definition.data, output.data.revision) : { name: t("org.unknownItem"), unit: "" };
        const session = work.sessions.find((s) => s.id === output.data.sessionId);
        const inTrash = output.data.deletedAt !== null || (session !== undefined && session.data.deletedAt !== null);
        return (
          <li key={id}>
            {t("backup.blockingOutput", {
              output: t("work.output.value", { value: output.data.value, unit: label.unit, name: label.name }),
              session: session ? formatDateTime(session.data.startedAt, prefs) : t("org.unknownItem"),
            })}
            {inTrash ? ` ${t("backup.blockingOutput.trash")}` : null}
          </li>
        );
      })}
    </ul>
  );
}

export function BackupView() {
  const t = useT();
  return (
    <>
      <section className="card" aria-labelledby="backup-title">
        <h1 id="backup-title">{t("backup.title")}</h1>
        <p>{t("backup.intro")}</p>
        <LastBackupLine />
        <DeviceNameField />
      </section>
      <ExportPanel />
      <ImportPanel />
      <PendingConflicts />
      <ReplacedVersions />
    </>
  );
}

function LastBackupLine() {
  const t = useT();
  const lastBackupAt = useLastBackupAt();
  if (lastBackupAt === undefined) return null;
  return (
    <p className={`notice ${lastBackupAt ? "notice-info" : "notice-warn"}`} data-testid="backup-last">
      {lastBackupText(t, lastBackupAt)}
    </p>
  );
}

function DeviceNameField() {
  const t = useT();
  const { db } = useServices();
  const id = useId();
  const device = useLiveQuery(() => getMeta<DeviceIdentity>(db, "device"), [db]);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="field">
      <label htmlFor={id}>{t("backup.deviceName")}</label>
      <input
        id={id}
        maxLength={80}
        value={draft ?? device?.name ?? ""}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={async () => {
          const name = draft?.trim();
          if (name) await renameDevice(db, name);
          setDraft(null);
        }}
      />
    </div>
  );
}

/* ------------------------------ export ------------------------------ */

function ExportPanel() {
  const t = useT();
  const { db } = useServices();
  const ids = { protect: useId(), password: useId(), confirm: useId(), warning: useId() };
  const [protect, setProtect] = useState(false); // D-014: off by default on every export
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const shareable = canShareFiles();

  const mismatch = protect && confirm.length > 0 && password !== confirm;
  const ready = !protect || (password.length > 0 && password === confirm);

  async function run(deliver: "download" | "share") {
    setBusy(true);
    setMessage({ tone: "info", text: t("backup.export.working") });
    let file: ExportResult;
    try {
      file = await createBackup(db, registry, protect ? { password } : {});
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(t, error) });
      setBusy(false);
      return;
    }
    try {
      if (deliver === "share") {
        if (!(await shareBackup(file.fileName, file.text))) {
          setMessage({ tone: "info", text: t("backup.export.cancelled") });
          return;
        }
      } else {
        downloadBackup(file.fileName, file.text);
      }
      await markBackupExported(db);
      setMessage({ tone: "ok", text: t("backup.export.done", { file: file.fileName }) });
      // Each export decides on its own (D-014): the next one starts unprotected again.
      setProtect(false);
      setPassword("");
      setConfirm("");
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(t, error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="export-title">
      <h2 id="export-title">{t("backup.export.title")}</h2>
      <div className="checkbox-field">
        <input
          id={ids.protect}
          type="checkbox"
          checked={protect}
          onChange={(e) => setProtect(e.target.checked)}
          aria-describedby={`${ids.protect}-hint`}
        />
        <label htmlFor={ids.protect}>{t("backup.export.protect")}</label>
      </div>
      <p id={`${ids.protect}-hint`} className="hint">
        {t("backup.export.protectHint")}
      </p>
      {protect ? (
        <div className="stack">
          <p id={ids.warning} className="notice notice-warn" role="alert" data-testid="password-warning">
            {t("backup.export.warning")} {t("backup.export.manager")}
          </p>
          <div className="field">
            <label htmlFor={ids.password}>{t("backup.export.password")}</label>
            <input
              id={ids.password}
              type="password"
              autoComplete="new-password"
              dir="auto"
              value={password}
              aria-describedby={ids.warning}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.confirm}>{t("backup.export.confirm")}</label>
            <input
              id={ids.confirm}
              type="password"
              autoComplete="new-password"
              dir="auto"
              value={confirm}
              aria-invalid={mismatch}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {mismatch ? <p className="hint hint-error">{t("backup.export.mismatch")}</p> : null}
          </div>
        </div>
      ) : null}
      <div className="button-row">
        <button type="button" disabled={busy || !ready} onClick={() => run("download")}>
          {t("backup.export.download")}
        </button>
        {shareable ? (
          <button type="button" className="secondary" disabled={busy || !ready} onClick={() => run("share")}>
            {t("backup.export.share")}
          </button>
        ) : null}
      </div>
      {message ? (
        <p className={`notice notice-${message.tone}`} role={message.tone === "error" ? "alert" : "status"} data-testid="export-message">
          {message.text}
        </p>
      ) : null}
    </section>
  );
}

/* ------------------------------ import ------------------------------ */

type ImportState =
  | { step: "idle" }
  | { step: "checking" }
  | { step: "password"; checked: CheckedBackup }
  | { step: "preview"; opened: OpenedBackup; preview: ImportPreview }
  | { step: "done"; result: ImportResult };

function ImportPanel() {
  const t = useT();
  const prefs = usePreferences();
  const { db } = useServices();
  const ids = { file: useId(), password: useId(), updates: useId(), display: useId() };
  const [state, setState] = useState<ImportState>({ step: "idle" });
  const [error, setError] = useState<ShownError | null>(null);
  const [password, setPassword] = useState("");
  const [applyUpdates, setApplyUpdates] = useState(false);
  const [applyDisplay, setApplyDisplay] = useState(false);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => {
    setError(shownError(t, e, ` ${t("backup.error.unchanged")}`));
  };

  async function showPreview(checked: CheckedBackup, pw?: string) {
    const opened = await openCheckedBackup(checked, registry, pw);
    const preview = await previewImport(db, opened, registry);
    setApplyUpdates(false);
    setApplyDisplay(false);
    setState({ step: "preview", opened, preview });
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow choosing the same file again
    if (!file) return;
    setError(null);
    setPassword("");
    setState({ step: "checking" });
    try {
      const checked = await checkBackupFile(readFileBytes(file));
      if (checked.encrypted) setState({ step: "password", checked });
      else await showPreview(checked);
    } catch (e) {
      fail(e);
      setState({ step: "idle" });
    }
  }

  async function onOpenEncrypted(checked: CheckedBackup) {
    setBusy(true);
    setError(null);
    try {
      await showPreview(checked, password);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function onApply(opened: OpenedBackup) {
    setBusy(true);
    try {
      const result = await applyImport(db, opened, registry, { applyUpdates, applyDisplaySettings: applyDisplay });
      setState({ step: "done", result });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="import-title">
      <h2 id="import-title">{t("backup.import.title")}</h2>
      <div className="field">
        <label htmlFor={ids.file}>{t("backup.import.choose")}</label>
        <input id={ids.file} type="file" accept=".json,application/json" onChange={onFile} disabled={busy} />
      </div>
      {state.step === "checking" ? <p className="muted">{t("backup.import.checking")}</p> : null}
      {error ? <ErrorNotice error={error} testId="import-error" /> : null}

      {state.step === "password" ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void onOpenEncrypted(state.checked);
          }}
        >
          <p>{t("backup.import.passwordNeeded")}</p>
          <div className="field">
            <label htmlFor={ids.password}>{t("backup.import.password")}</label>
            <input
              id={ids.password}
              type="password"
              autoComplete="current-password"
              dir="auto"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button type="submit" disabled={busy || !password}>
            {t("backup.import.open")}
          </button>
        </form>
      ) : null}

      {state.step === "preview" ? (
        <div className="stack" data-testid="import-preview">
          <h3>{t("backup.import.previewTitle")}</h3>
          <p className="muted">
            {t("backup.import.from", {
              device: state.preview.header.sourceDevice.name || "—",
              date: formatDateTime(state.preview.header.createdAt, prefs),
            })}
          </p>
          {state.preview.previouslyImportedAt ? (
            <p className="notice notice-info">
              {t("backup.import.previous", { date: formatDateTime(state.preview.previouslyImportedAt, prefs) })}
            </p>
          ) : null}
          <PreviewCounts preview={state.preview} />
          {state.preview.counts.newerInBackup > 0 ? (
            <div className="checkbox-field">
              <input id={ids.updates} type="checkbox" checked={applyUpdates} onChange={(e) => setApplyUpdates(e.target.checked)} />
              <label htmlFor={ids.updates}>{t("backup.import.applyUpdates", { count: state.preview.counts.newerInBackup })}</label>
            </div>
          ) : null}
          {state.preview.updatesBlockedBy.length > 0 ? (
            <div className="notice notice-warn" data-testid="import-updates-blocked">
              <p>{t("backup.import.updatesBlocked")}</p>
              <BlockingOutputs ids={state.preview.updatesBlockedBy} />
            </div>
          ) : null}
          {state.preview.displaySettingsDiffer ? (
            <div className="checkbox-field">
              <input id={ids.display} type="checkbox" checked={applyDisplay} onChange={(e) => setApplyDisplay(e.target.checked)} />
              <label htmlFor={ids.display}>
                {t("backup.import.applyDisplay", { device: state.preview.header.sourceDevice.name || "—" })}
              </label>
            </div>
          ) : null}
          <div className="button-row">
            <button type="button" disabled={busy} onClick={() => onApply(state.opened)}>
              {t("backup.import.confirm")}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setState({ step: "idle" })}>
              {t("backup.import.cancel")}
            </button>
          </div>
        </div>
      ) : null}

      {state.step === "done" ? (
        <p className="notice notice-ok" role="status" data-testid="import-done">
          {t("backup.import.done", {
            added: state.result.counts.new,
            updated: state.result.appliedUpdates,
            decisions: decisionsCount(state.result.counts) + state.result.counts.carriedConflicts,
          })}
        </p>
      ) : null}
    </section>
  );
}

function decisionsCount(counts: ImportPreview["counts"]): number {
  return counts.conflict + counts.deletedHere + counts.deletedInBackup + counts.history;
}

function PreviewCounts({ preview }: { preview: ImportPreview }) {
  const t = useT();
  const c = preview.counts;
  const lines: [MessageKey, number][] = [
    ["backup.import.count.new", c.new],
    ["backup.import.count.alreadyHere", c.alreadyHere],
    ["backup.import.count.olderCopy", c.olderCopy],
    ["backup.import.count.newerInBackup", c.newerInBackup],
    ["backup.import.count.decisions", decisionsCount(c)],
    ["backup.import.count.alreadyPending", c.alreadyPending],
    ["backup.import.count.carried", c.carriedConflicts],
  ];
  return (
    <ul className="count-list">
      {lines
        .filter(([, n]) => n > 0)
        .map(([key, n]) => (
          <li key={key}>{t(key, { count: n })}</li>
        ))}
    </ul>
  );
}

/* --------------------------- conflicts & undo --------------------------- */

const RESOLUTION_LABELS: Record<Resolution, MessageKey> = {
  keepDevice: "backup.resolve.keepDevice",
  useBackup: "backup.resolve.useBackup",
  keepBoth: "backup.resolve.keepBoth",
  restore: "backup.resolve.restore",
  keepDeleted: "backup.resolve.keepDeleted",
  deleteHere: "backup.resolve.deleteHere",
  keepHere: "backup.resolve.keepHere",
};

const TYPE_LABELS: Record<string, MessageKey> = {
  preferences: "backup.type.preferences",
  projects: "backup.type.projects",
  workstreams: "backup.type.workstreams",
  taskDefinitions: "backup.type.taskDefinitions",
  calendarBlocks: "backup.type.calendarBlocks",
  goals: "backup.type.goals",
  milestones: "backup.type.milestones",
  sessions: "backup.type.sessions",
  outputDefinitions: "backup.type.outputDefinitions",
  outputRecords: "backup.type.outputRecords",
  corrections: "backup.type.corrections",
  taskCompletions: "backup.type.taskCompletions",
};

function typeLabel(t: Translate, type: string): string {
  return TYPE_LABELS[type] ? t(TYPE_LABELS[type]) : type;
}

const FIELD_LABELS: Record<string, MessageKey> = {
  timeZone: "settings.timeZone",
  weekStart: "settings.weekStart",
  calendarDisplay: "settings.calendar",
  name: "projects.name",
  description: "projects.description",
  title: "org.task.title",
  notes: "org.task.notes",
  projectId: "org.task.project",
  workstreamId: "org.task.workstream",
  nextAction: "org.task.nextAction",
  estimateMinutes: "org.task.estimate",
  archivedAt: "org.field.archivedAt",
  recurrence: "recurrence.title",
  dailyCapacityMinutes: "settings.capacity",
  taskId: "plan.form.task",
  startsAt: "plan.field.startsAt",
  endsAt: "plan.field.endsAt",
  localDate: "plan.field.localDate",
  occurrenceDate: "plan.field.occurrenceDate",
  status: "plan.field.status",
  snapshot: "plan.field.snapshot",
  startDate: "goals.startDate",
  deadline: "goals.deadline",
  kind: "goals.field.kind",
  target: "goals.field.target",
  unit: "goals.target.unit",
  goalId: "backup.type.goals",
  completedAt: "milestones.completed",
  color: "projects.color",
};

function formatValue(t: Translate, type: string, field: string, value: unknown, names: Map<string, string>, prefs: PreferenceFields): string {
  if (type === "preferences") {
    if (field === "timeZone") return value ? String(value) : t("settings.timeZoneNotSet");
    if (field === "weekStart") return t(`weekday.${value}` as MessageKey);
    if (field === "calendarDisplay") return t(`settings.calendar.${value}` as MessageKey);
    if (field === "dailyCapacityMinutes") return t("plan.minutes", { m: Number(value) });
  }
  if (type === "calendarBlocks") {
    if (field === "taskId") return names.get(String(value)) ?? t("org.unknownItem");
    if (field === "startsAt" || field === "endsAt") return formatDateTime(String(value), prefs);
    if (field === "localDate") return formatLocalDate(String(value), prefs, "medium");
    if (field === "occurrenceDate") return value ? formatLocalDate(String(value), prefs, "medium") : "—";
    if (field === "status") return t(value === "cancelled" ? "plan.cancelled" : "plan.planned");
    if (field === "snapshot") {
      const s = value as { taskTitle: string; projectName: string | null; workstreamName: string | null };
      return [s.taskTitle, s.projectName, s.workstreamName].filter(Boolean).join(" · ");
    }
  }
  if (type === "projects" && field === "color") return t(`color.${value}` as MessageKey);
  if (type === "goals" || type === "milestones") {
    if (field === "startDate" || field === "deadline") return value ? formatLocalDate(String(value), prefs, "medium") : "—";
    if (field === "kind") return t(`goals.kind.${value}` as MessageKey);
    if (field === "status") return t(`goals.status.${value}` as MessageKey);
    if (field === "goalId") return names.get(String(value)) ?? t("org.unknownItem");
    if (field === "completedAt") return value ? formatDateTime(String(value), prefs) : t("milestones.notCompleted");
  }
  if (field === "recurrence") {
    const r = value as { weekdays: number[]; startDate: string; endDate: string | null };
    const days = r.weekdays.map((d) => t(`weekday.${d}` as MessageKey)).join(", ");
    return `${days} · ${formatLocalDate(r.startDate, prefs, "medium")}${r.endDate ? ` – ${formatLocalDate(r.endDate, prefs, "medium")}` : ""}`;
  }
  if (field === "projectId" || field === "workstreamId") {
    // Links show the item's name on this device; an item not here shows as unknown (never a guess).
    if (value === null) return field === "projectId" ? t("org.task.noProject") : t("org.task.noWorkstream");
    return names.get(String(value)) ?? t("org.unknownItem");
  }
  if (field === "archivedAt") return value ? formatDateTime(String(value), prefs) : t("org.notArchived");
  if (value === null) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function EntryView({ type, entry, other, missingLabel }: { type: string; entry: VersionEntry | null; other: VersionEntry | null; missingLabel: string }) {
  const t = useT();
  const prefs = usePreferences();
  const org = useOrganization();
  const goals = useGoals();
  if (!entry) return <span className="muted">{missingLabel}</span>;
  if (entry.deleted) return <span className="muted">{t("backup.conflicts.deleted")}</span>;
  const names = new Map<string, string>([
    ...(org?.projects.map((p) => [p.id, p.data.name] as const) ?? []),
    ...(org?.workstreams.map((w) => [w.id, w.data.name] as const) ?? []),
    ...(org?.tasks.map((task) => [task.id, task.data.title] as const) ?? []),
    ...(goals?.goals.map((g) => [g.id, g.data.name] as const) ?? []),
  ]);
  const otherData = other && !other.deleted ? other.envelope.data : {};
  return (
    <dl className="field-list">
      {Object.entries(entry.envelope.data).map(([field, value]) => {
        const changed = JSON.stringify(value) !== JSON.stringify(otherData[field]);
        return (
          <div key={field} className={changed ? "changed" : undefined}>
            <dt>{FIELD_LABELS[field] ? t(FIELD_LABELS[field]) : field}</dt>
            <dd>{formatValue(t, type, field, value, names, prefs)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function PendingConflicts() {
  const t = useT();
  const prefs = usePreferences();
  const { db } = useServices();
  // Live: re-renders when the conflict list OR the device's current versions change, so the
  // comparison always shows what is on this device now.
  const views = useLiveQuery(() => loadConflictViews(db, registry), [db]);
  // An error from one decision is shown with that decision (conflictId), a bulk one above the list.
  const [error, setError] = useState<(ShownError & { conflictId: string | null }) | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  if (!views) return null;
  const conflicts = views;

  // Captured with the versions on screen: the bulk action skips items that changed since.
  const bulk = views
    .filter((v) => v.options.includes("keepDevice"))
    .map((v) => ({ conflictId: v.conflict.conflictId, expected: v.token }));

  async function resolve(view: ConflictView, resolution: Resolution) {
    setError(null);
    try {
      await resolveConflict(db, registry, view.conflict.conflictId, resolution, view.token);
    } catch (e) {
      setError({ conflictId: view.conflict.conflictId, ...shownError(t, e) });
    }
  }

  function goTo(conflictId: string) {
    const target = document.getElementById(`conflict-${conflictId}`);
    target?.scrollIntoView?.({ block: "start" });
    target?.focus();
  }

  return (
    <section className="card" aria-labelledby="conflicts-title" data-testid="pending-conflicts">
      <h2 id="conflicts-title">{t("backup.conflicts.title")}</h2>
      {conflicts.length === 0 ? (
        <p className="muted">{t("backup.conflicts.empty")}</p>
      ) : (
        <>
          <p>{t("backup.conflicts.intro")}</p>
          {bulk.length > 1 ? (
            confirmBulk ? (
              <div className="notice notice-warn" role="alertdialog" aria-label={t("backup.bulk.keepDevice", { count: bulk.length })}>
                <p>{t("backup.bulk.confirm", { count: bulk.length })}</p>
                <div className="button-row">
                  <button
                    type="button"
                    onClick={async () => {
                      setConfirmBulk(false);
                      setError(null);
                      const result = await resolveConflicts(db, registry, bulk, "keepDevice");
                      if (result.skipped.length > 0) {
                        setError({ conflictId: null, text: t("backup.bulk.skipped", { count: result.skipped.length }), outputs: [] });
                      }
                    }}
                  >
                    {t("backup.bulk.yes", { count: bulk.length })}
                  </button>
                  <button type="button" className="secondary" onClick={() => setConfirmBulk(false)}>
                    {t("backup.bulk.no")}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="secondary" onClick={() => setConfirmBulk(true)}>
                {t("backup.bulk.keepDevice", { count: bulk.length })}
              </button>
            )
          ) : null}
          {error && error.conflictId === null ? <ErrorNotice error={error} /> : null}
          {conflicts.map((view) => {
            const { conflict, current } = view;
            return (
              <article key={conflict.conflictId} id={`conflict-${conflict.conflictId}`} tabIndex={-1} className="conflict" data-testid="backup-conflict">
                <h3>{typeLabel(t, conflict.type)}</h3>
                {conflict.kind === "history" ? <p className="notice notice-warn">{t("backup.conflicts.history")}</p> : null}
                <div className="conflict-columns">
                  <div data-testid="conflict-current">
                    <h4>{t("backup.conflicts.device")}</h4>
                    <EntryView type={conflict.type} entry={current} other={conflict.incoming} missingLabel={t("backup.conflicts.missing")} />
                  </div>
                  <div data-testid="conflict-incoming">
                    <h4>
                      {t("backup.conflicts.backup", {
                        device: conflict.source.deviceName || "—",
                        date: formatDateTime(conflict.source.exportedAt, prefs),
                      })}
                    </h4>
                    <EntryView type={conflict.type} entry={conflict.incoming} other={current} missingLabel="" />
                  </div>
                </div>
                {view.snapshotDiffers ? (
                  <div className="notice notice-info" data-testid="conflict-snapshot">
                    <p>
                      {/* Conflicts from the first Stage 1B build did not record the device: say so, never guess. */}
                      {conflict.detectedOn
                        ? t("backup.conflicts.snapshot", {
                            device: conflict.detectedOn.deviceName || "—",
                            date: formatDateTime(conflict.detectedAt, prefs),
                          })
                        : t("backup.conflicts.snapshotUnknownDevice", { date: formatDateTime(conflict.detectedAt, prefs) })}
                    </p>
                    <EntryView type={conflict.type} entry={conflict.local} other={current} missingLabel="" />
                  </div>
                ) : null}
                {view.blockedBy.length > 0 ? <BlockedDeletion items={view.blockedBy} goTo={goTo} /> : null}
                {error && error.conflictId === conflict.conflictId ? <ErrorNotice error={error} /> : null}
                <div className="button-row">
                  {view.options.map((resolution, i) => (
                    <button
                      key={resolution}
                      type="button"
                      className={i === 0 ? undefined : "secondary"}
                      onClick={() => resolve(view, resolution)}
                    >
                      {t(RESOLUTION_LABELS[resolution])}
                    </button>
                  ))}
                </div>
              </article>
            );
          })}
        </>
      )}
    </section>
  );
}

/**
 * "Delete it here too" is refused while live records link to this one (restrict, never cascade):
 * names them, and for each one also deleted in the backup offers its own decision (D-015).
 */
function BlockedDeletion({ items, goTo }: { items: LinkedItem[]; goTo: (conflictId: string) => void }) {
  const t = useT();
  return (
    <div className="notice notice-info" data-testid="conflict-blocked">
      <p>{t("backup.blocked.intro", { count: items.length })}</p>
      <ul>
        {items.map((item) => (
          <li key={`${item.type}/${item.id}`}>
            {typeLabel(t, item.type)}
            {" — "}
            {item.conflictId ? (
              <>
                {t("backup.blocked.pending")}{" "}
                <button type="button" className="link-button" onClick={() => goTo(item.conflictId!)}>
                  {t("backup.blocked.goTo")}
                </button>
              </>
            ) : (
              t("backup.blocked.kept")
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReplacedVersions() {
  const t = useT();
  const prefs = usePreferences();
  const { db } = useServices();
  const replaced = useLiveQuery(() => db.replacedVersions.orderBy("replacedAt").reverse().limit(20).toArray(), [db]);
  const [error, setError] = useState<ShownError | null>(null);
  if (!replaced || replaced.length === 0) return null;
  return (
    <section className="card" aria-labelledby="replaced-title" data-testid="replaced-versions">
      <h2 id="replaced-title">{t("backup.replaced.title")}</h2>
      <p className="muted">{t("backup.replaced.intro")}</p>
      {error ? <ErrorNotice error={error} /> : null}
      {replaced.map((row) => (
        <article key={row.replacedId} className="conflict">
          <h3>{typeLabel(t, row.type)}</h3>
          <p className="hint">{t("backup.replaced.at", { date: formatDateTime(row.replacedAt, prefs) })}</p>
          <EntryView type={row.type} entry={row.entry} other={null} missingLabel="" />
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              setError(null);
              try {
                await restoreReplacedVersion(db, registry, row.replacedId);
              } catch (e) {
                setError(shownError(t, e));
              }
            }}
          >
            {t("backup.replaced.restore")}
          </button>
        </article>
      ))}
    </section>
  );
}
