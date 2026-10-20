import { useLiveQuery } from "dexie-react-hooks";
import { useOnline, usePreferences, useServices, useSyncStatus, useT } from "../app-context.tsx";
import { formatDateTime } from "../i18n/index.ts";

/** Network and sync state, announced politely to screen readers. */
export function StatusBar() {
  const t = useT();
  const prefs = usePreferences();
  const online = useOnline();
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
    <div className="status-bar" role="status" aria-live="polite">
      <span className={`pill ${online ? "pill-ok" : "pill-warn"}`} data-testid="network-status">
        <span className="dot" aria-hidden="true" />
        {online ? t("network.online") : t("network.offline")}
      </span>
      <span className={`pill pill-${tone}`} data-testid="sync-status">
        {syncText}
      </span>
      {status.phase !== "signedOut" && pending > 0 && status.phase !== "idle" && status.phase !== "syncing" ? (
        <span className="pill pill-muted">{t("sync.pending", { count: pending })}</span>
      ) : null}
      {conflicts > 0 ? <span className="pill pill-warn">{t("sync.conflicts", { count: conflicts })}</span> : null}
      {failed > 0 ? <span className="pill pill-warn">{t("sync.failed", { count: failed })}</span> : null}
      {status.phase !== "signedOut" ? (
        <span className="status-time">
          {status.lastSyncAt
            ? t("sync.lastSync", { time: formatDateTime(status.lastSyncAt, prefs) })
            : t("sync.never")}
        </span>
      ) : null}
    </div>
  );
}

/** Explains what offline/unreachable means for the user's data. */
export function ConnectivityNotice() {
  const t = useT();
  const online = useOnline();
  const status = useSyncStatus();
  if (!online) return <p className="notice notice-info">{t("sync.offlineHint")}</p>;
  if (status.phase === "unreachable") return <p className="notice notice-warn">{t("sync.unreachable")}</p>;
  if (status.phase === "sessionEnded") return <p className="notice notice-warn">{t("sync.sessionEnded")}</p>;
  return null;
}
