import { type FormEvent, useId, useState } from "react";
import { useServices, useT } from "../app-context.tsx";
import { NAME_MAX } from "../backup/registry.ts";
import { captureToInbox, inboxTasks, type StatusFilter } from "../local/organization.ts";
import { organizationError, SearchField, StatusFilterSelect, TaskRow, useOrganization } from "./organization-ui.tsx";

/** Quick capture: unsorted tasks and ideas, sorted into projects later (Stage 2). */
export function InboxView() {
  const t = useT();
  const { db } = useServices();
  const org = useOrganization();
  const captureId = useId();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  async function onCapture(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setError(null);
    try {
      await captureToInbox(db, text);
      setAdded(text.trim());
      setText("");
    } catch (e) {
      setError(organizationError(t, e));
    }
  }

  const items = org ? inboxTasks(org, query, status) : [];
  return (
    <section className="card" aria-labelledby="inbox-title">
      <h1 id="inbox-title">{t("inbox.title")}</h1>
      <p className="muted">{t("inbox.intro")}</p>
      <form className="inline-form" onSubmit={onCapture}>
        <label htmlFor={captureId}>{t("inbox.capture")}</label>
        <input id={captureId} value={text} maxLength={NAME_MAX} onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={!text.trim()}>
          {t("inbox.add")}
        </button>
      </form>
      <p className="hint" role="status">
        {added ? t("inbox.added", { title: added }) : ""}
      </p>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="filters">
        <SearchField label={t("inbox.search")} value={query} onChange={setQuery} />
        <StatusFilterSelect value={status} onChange={setStatus} />
      </div>
      {org && items.length === 0 ? <p className="muted">{query.trim() ? t("org.noMatches") : t("inbox.empty")}</p> : null}
      <ul className="item-list" data-testid="inbox-list">
        {org ? items.map((task) => <TaskRow key={task.id} task={task} org={org} listStatus={status} />) : null}
      </ul>
      {items.length > 0 ? <p className="hint">{t("inbox.organizeHint")}</p> : null}
    </section>
  );
}
