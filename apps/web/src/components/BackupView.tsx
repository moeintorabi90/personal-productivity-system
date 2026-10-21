import { useLiveQuery } from "dexie-react-hooks";
import { type ChangeEvent, useId, useState } from "react";
import { useLastBackupAt, usePreferences, useServices, useT } from "../app-context.tsx";
import {
  type ConflictView,
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
import { formatDateTime, type MessageKey, type Translate } from "../i18n/index.ts";
import type { DeviceIdentity, VersionEntry } from "../local/db.ts";
import { getMeta } from "../local/db.ts";
import { renameDevice } from "../local/repository.ts";
import { lastBackupText } from "./StatusBar.tsx";

const registry = PRODUCT_REGISTRY;

function errorMessage(t: Translate, error: unknown): string {
  if (error instanceof BackupError) return t(`backup.error.${error.code}` as MessageKey);
  if (error instanceof ResolutionError && error.code === "HAS_LINKED_ITEMS") {
    return t("backup.resolve.error", { reason: t("backup.resolve.hasLinked") });
  }
  if (error instanceof ResolutionError && error.code === "BROKEN_LINK") {
    return t("backup.resolve.error", { reason: t("backup.resolve.brokenLink") });
  }
  if (error instanceof ResolutionError && error.code === "STALE") return t("backup.resolve.stale");
  return t("backup.error.generic");
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
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [applyUpdates, setApplyUpdates] = useState(false);
  const [applyDisplay, setApplyDisplay] = useState(false);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => {
    setError(`${errorMessage(t, e)} ${t("backup.error.unchanged")}`);
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
      {error ? (
        <p className="notice notice-error" role="alert" data-testid="import-error">
          {error}
        </p>
      ) : null}

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

function typeLabel(t: Translate, type: string): string {
  return type === "preferences" ? t("backup.type.preferences") : type;
}

const PREFERENCE_LABELS: Record<string, MessageKey> = {
  timeZone: "settings.timeZone",
  weekStart: "settings.weekStart",
  calendarDisplay: "settings.calendar",
};

function formatValue(t: Translate, type: string, field: string, value: unknown): string {
  if (type === "preferences") {
    if (field === "timeZone") return value ? String(value) : t("settings.timeZoneNotSet");
    if (field === "weekStart") return t(`weekday.${value}` as MessageKey);
    if (field === "calendarDisplay") return t(`settings.calendar.${value}` as MessageKey);
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function EntryView({ type, entry, other, missingLabel }: { type: string; entry: VersionEntry | null; other: VersionEntry | null; missingLabel: string }) {
  const t = useT();
  if (!entry) return <span className="muted">{missingLabel}</span>;
  if (entry.deleted) return <span className="muted">{t("backup.conflicts.deleted")}</span>;
  const otherData = other && !other.deleted ? other.envelope.data : {};
  return (
    <dl className="field-list">
      {Object.entries(entry.envelope.data).map(([field, value]) => {
        const changed = JSON.stringify(value) !== JSON.stringify(otherData[field]);
        return (
          <div key={field} className={changed ? "changed" : undefined}>
            <dt>{type === "preferences" && PREFERENCE_LABELS[field] ? t(PREFERENCE_LABELS[field]) : field}</dt>
            <dd>{formatValue(t, type, field, value)}</dd>
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
  const [error, setError] = useState<string | null>(null);
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
      setError(errorMessage(t, e));
    }
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
                      await resolveConflicts(db, registry, bulk, "keepDevice");
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
          {error ? (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          ) : null}
          {conflicts.map((view) => {
            const { conflict, current } = view;
            return (
              <article key={conflict.conflictId} className="conflict" data-testid="backup-conflict">
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
                      {t("backup.conflicts.snapshot", {
                        device: conflict.detectedOn?.deviceName || "—",
                        date: formatDateTime(conflict.detectedAt, prefs),
                      })}
                    </p>
                    <EntryView type={conflict.type} entry={conflict.local} other={current} missingLabel="" />
                  </div>
                ) : null}
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

function ReplacedVersions() {
  const t = useT();
  const prefs = usePreferences();
  const { db } = useServices();
  const replaced = useLiveQuery(() => db.replacedVersions.orderBy("replacedAt").reverse().limit(20).toArray(), [db]);
  const [error, setError] = useState<string | null>(null);
  if (!replaced || replaced.length === 0) return null;
  return (
    <section className="card" aria-labelledby="replaced-title" data-testid="replaced-versions">
      <h2 id="replaced-title">{t("backup.replaced.title")}</h2>
      <p className="muted">{t("backup.replaced.intro")}</p>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
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
                setError(errorMessage(t, e));
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
