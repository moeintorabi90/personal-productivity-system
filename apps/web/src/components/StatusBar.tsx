import { useLiveQuery } from "dexie-react-hooks";
import { useLastBackupAt, useOnline, usePreferences, useServices, useSyncStatus, useT } from "../app-context.tsx";
import { formatDateTime, type Translate } from "../i18n/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export function lastBackupText(t: Translate, lastBackupAt: string | null, now = Date.now()): string {
  if (!lastBackupAt) return t("backup.never");
  const days = Math.floor((now - new Date(lastBackupAt).getTime()) / DAY_MS);
  return days <= 0 ? t("backup.lastToday") : t("backup.lastDays", { count: days });
}

/** Network state and the last-backup indicator, announced politely to screen readers. */
export function StatusBar() {
  const t = useT();
  const online = useOnline();
  const lastBackupAt = useLastBackupAt();
  const { syncEnabled } = useServices();

  return (
    <div className="status-bar" role="status" aria-live="polite">
      <span className={`pill ${online ? "pill-ok" : "pill-warn"}`} data-testid="network-status">
        <span className="dot" aria-hidden="true" />
        {online ? t("network.online") : t("network.offline")}
      </span>
      {lastBackupAt !== undefined ? (
        <span className={`pill ${lastBackupAt ? "pill-muted" : "pill-warn"}`} data-testid="last-backup">
          {lastBackupText(t, lastBackupAt)}
        </span>
      ) : null}
      {syncEnabled ? <FrozenSyncStatus /> : null}
    </div>
  );
}

/** Status of the frozen post-v1 sync engine; rendered only when the build flag enables it (D-016). */
function FrozenSyncStatus() {
  const t = useT();
  const prefs = usePreferences();
  const status = useSyncStatus();
  const { db } = useServices();
  const pending = useLiveQuery(() => db.outbox.where("status").anyOf("pending", "inflight").count(), [db]) ?? 0;
  const failed = useLiveQuery(() => db.outbox.where("status").equals("failed").count(), [db]) ?? 0;
  const conflicts = useLiveQuery(() => db.conflicts.count(), [db]) ?? 0;

  let syncText: string;
  let tone: "ok" | "warn" | "muted" = "ok";
  if (status.phase === "signedOut") {
    syncText = t("sync.signedOut");
    tone = "muted";
  } else if (status.phase === "sessionEnded") {
    syncText = t("sync.sessionEnded");
    tone = "warn";
  } else if (status.phase === "syncing") {
    syncText = t("sync.syncing");
  } else if (status.phase === "error" || status.phase === "unreachable") {
    syncText = t("sync.error");
    tone = "warn";
  } else if (pending > 0) {
    syncText = t("sync.pending", { count: pending });
    tone = "muted";
  } else {
    syncText = t("sync.synced");
  }

  return (
    <>
      <span className={`pill pill-${tone}`} data-testid="sync-status">
        {syncText}
      </span>
      {conflicts > 0 ? <span className="pill pill-warn">{t("sync.conflicts", { count: conflicts })}</span> : null}
      {failed > 0 ? <span className="pill pill-warn">{t("sync.failed", { count: failed })}</span> : null}
      {status.phase !== "signedOut" ? (
        <span className="status-time">
          {status.lastSyncAt ? t("sync.lastSync", { time: formatDateTime(status.lastSyncAt, prefs) }) : t("sync.never")}
        </span>
      ) : null}
    </>
  );
}

/** Explains what offline means for the user's data. */
export function ConnectivityNotice() {
  const t = useT();
  const online = useOnline();
  const { syncEnabled } = useServices();
  if (!online) return <p className="notice notice-info">{syncEnabled ? t("sync.offlineHint") : t("network.offlineHint")}</p>;
  return syncEnabled ? <FrozenSyncNotice /> : null;
}

function FrozenSyncNotice() {
  const t = useT();
  const status = useSyncStatus();
  if (status.phase === "unreachable") return <p className="notice notice-warn">{t("sync.unreachable")}</p>;
  if (status.phase === "sessionEnded") return <p className="notice notice-warn">{t("sync.sessionEnded")}</p>;
  return null;
}
