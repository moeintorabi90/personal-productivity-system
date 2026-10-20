import { useLiveQuery } from "dexie-react-hooks";
import { type FormEvent, useId, useState } from "react";
import { useServices, useT } from "../app-context.tsx";
import { addProbe, deleteProbe } from "../local/repository.ts";
import { useOfflineReadiness } from "../pwa.ts";
import { ConflictsPanel } from "./ConflictsPanel.tsx";

export function HomeView() {
  const t = useT();
  const readiness = useOfflineReadiness();
  const readinessText =
    readiness === "ready"
      ? t("home.offlineReady")
      : readiness === "dev"
        ? t("home.offlineDev")
        : t("home.offlineNotReady");

  return (
    <>
      <section className="card" aria-labelledby="home-title">
        <h1 id="home-title">{t("home.title")}</h1>
        <p>{t("home.intro")}</p>
        <p className={`notice ${readiness === "ready" ? "notice-ok" : "notice-info"}`} data-testid="offline-readiness">
          {readinessText}
        </p>
      </section>
      <ConflictsPanel />
      <ProbePanel />
    </>
  );
}

function ProbePanel() {
  const t = useT();
  const { db, engine } = useServices();
  const inputId = useId();
  const [text, setText] = useState("");
  const probes = useLiveQuery(() => db.probes.orderBy("createdAt").toArray(), [db]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    await addProbe(db, text);
    setText("");
    engine.requestSync();
  }

  return (
    <section className="card" aria-labelledby="probe-title">
      <h2 id="probe-title">{t("probe.title")}</h2>
      <p className="muted">{t("probe.description")}</p>
      <form className="inline-form" onSubmit={onSubmit}>
        <label htmlFor={inputId}>{t("probe.inputLabel")}</label>
        <input id={inputId} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={!text.trim()}>
          {t("probe.add")}
        </button>
      </form>
      {probes && probes.length === 0 ? <p className="muted">{t("probe.empty")}</p> : null}
      <ul className="probe-list" data-testid="probe-list">
        {probes?.map((probe) => (
          <li key={probe.id}>
            <span className="probe-text">{probe.text}</span>
            {probe.serverRevision === 0 ? <span className="pill pill-muted">{t("probe.pending")}</span> : null}
            <button
              type="button"
              className="secondary"
              aria-label={t("probe.deleteLabel", { text: probe.text })}
              onClick={async () => {
                await deleteProbe(db, probe.id);
                engine.requestSync();
              }}
            >
              {t("probe.delete")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
