import type { PreferencesRecord, SyncProbeRecord } from "@pps/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { useServices, useT } from "../app-context.tsx";
import type { ConflictRow } from "../local/db.ts";
import { resolveKeepMine, resolveKeepServer } from "../local/repository.ts";

const PREFERENCE_FIELDS = ["language", "theme", "calendarDisplay", "weekStart", "timeZone"] as const;

/** Shows both versions of a conflicting record; nothing is discarded until the owner chooses. */
export function ConflictsPanel() {
  const t = useT();
  const { db, engine } = useServices();
  const conflicts = useLiveQuery(() => db.conflicts.toArray(), [db]);
  if (!conflicts?.length) return null;

  async function resolve(conflict: ConflictRow, keep: "mine" | "server") {
    if (keep === "mine") await resolveKeepMine(db, conflict);
    else await resolveKeepServer(db, conflict);
    engine.requestSync();
  }

  return (
    <section className="card card-warn" aria-labelledby="conflicts-title">
      <h2 id="conflicts-title">{t("conflict.title")}</h2>
      <p>{t("conflict.description")}</p>
      {conflicts.map((conflict) => (
        <article key={conflict.opId} className="conflict">
          <h3>{conflict.recordType === "preferences" ? t("conflict.preferences") : t("conflict.note")}</h3>
          <dl className="conflict-grid">
            <dt>{t("conflict.server")}</dt>
            <dd>{describe(conflict, "server", t("conflict.deleted"))}</dd>
            <dt>{t("conflict.mine")}</dt>
            <dd>{describe(conflict, "mine", t("conflict.deleted"))}</dd>
          </dl>
          <div className="button-row">
            <button type="button" onClick={() => resolve(conflict, "server")}>
              {t("conflict.keepServer")}
            </button>
            <button type="button" className="secondary" onClick={() => resolve(conflict, "mine")}>
              {t("conflict.keepMine")}
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

function describe(conflict: ConflictRow, side: "server" | "mine", deletedLabel: string): string {
  if (conflict.recordType === "preferences") {
    const submitted = conflict.submitted as Record<string, unknown>;
    const current = conflict.current as PreferencesRecord;
    const source: Record<string, unknown> = side === "server" ? current : submitted;
    return PREFERENCE_FIELDS.filter((field) => field in submitted)
      .map((field) => `${field}: ${String(source[field] ?? "—")}`)
      .join(", ");
  }
  if (side === "server") {
    const current = conflict.current as SyncProbeRecord;
    return current.deletedAt ? deletedLabel : current.text;
  }
  const submitted = conflict.submitted as { text?: string; delete?: boolean };
  return submitted.delete ? deletedLabel : (submitted.text ?? "");
}
