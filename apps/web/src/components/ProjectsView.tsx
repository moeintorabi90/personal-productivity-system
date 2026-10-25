import { type FormEvent, type ReactNode, useId, useState } from "react";
import { useServices, useT } from "../app-context.tsx";
import { NAME_MAX, type PaletteId, PROJECTS, TEXT_MAX, WORKSTREAMS } from "../backup/registry.ts";
import type { MessageKey } from "../i18n/index.ts";
import { defaultColorOf, PALETTE_IDS, projectColor } from "../planning/colors.ts";
import {
  createProject,
  createTask,
  createWorkstream,
  type Organization,
  type Project,
  projectOutline,
  searchOrganization,
  setArchived,
  type StatusFilter,
  updateProject,
  updateWorkstream,
  type Workstream,
} from "../local/organization.ts";
import { ArchivedPill, organizationError, SearchField, StatusFilterSelect, TaskRow, useOrganization } from "./organization-ui.tsx";

/** Projects list with search and filter, and the project detail (Stage 2). */
export function ProjectsView() {
  const org = useOrganization();
  const [openId, setOpenId] = useState<string | null>(null);
  if (!org) return null;
  const open = openId ? org.projects.find((p) => p.id === openId) : undefined;
  return open ? (
    <ProjectDetail project={open} org={org} onBack={() => setOpenId(null)} />
  ) : (
    <ProjectList org={org} onOpen={setOpenId} />
  );
}

function ProjectList({ org, onOpen }: { org: Organization; onOpen: (id: string) => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const result = searchOrganization(org, query, status);
  const projectName = (id: string | null) => org.projects.find((p) => p.id === id)?.data.name;
  const searching = query.trim() !== "";

  return (
    <>
      <section className="card" aria-labelledby="projects-title">
        <h1 id="projects-title">{t("projects.title")}</h1>
        <div className="filters">
          <SearchField label={t("projects.search")} value={query} onChange={setQuery} />
          <StatusFilterSelect value={status} onChange={setStatus} />
        </div>
        {searching ? <h2>{t("projects.results.projects")}</h2> : null}
        {result.projects.length === 0 ? (
          <p className="muted">{searching ? t("org.noMatches") : status === "active" ? t("projects.empty") : t("org.noMatches")}</p>
        ) : (
          <ul className="item-list" data-testid="project-list">
            {result.projects.map((p) => (
              <li key={p.id} className="item">
                <div className="item-main">
                  <span className="color-swatch" data-color={projectColor(p.id, p.data)} aria-hidden="true" /> <span className="item-title">{p.data.name}</span>{" "}
                  {p.data.archivedAt ? <ArchivedPill /> : null}
                  <p className="hint">
                    {t("projects.counts", {
                      workstreams: org.workstreams.filter((w) => w.data.projectId === p.id && !w.data.archivedAt).length,
                      tasks: org.tasks.filter((task) => task.data.projectId === p.id && !task.data.archivedAt).length,
                    })}
                  </p>
                </div>
                <button type="button" className="secondary" aria-label={t("projects.openLabel", { name: p.data.name })} onClick={() => onOpen(p.id)}>
                  {t("projects.open")}
                </button>
              </li>
            ))}
          </ul>
        )}
        {searching ? (
          <>
            <h2>{t("projects.results.workstreams")}</h2>
            {result.workstreams.length === 0 ? <p className="muted">{t("org.noMatches")}</p> : null}
            <ul className="item-list" data-testid="workstream-results">
              {result.workstreams.map((w) => (
                <li key={w.id} className="item">
                  <div className="item-main">
                    <span className="item-title">{w.data.name}</span> {w.data.archivedAt ? <ArchivedPill /> : null}
                    <span className="hint"> · {projectName(w.data.projectId)}</span>
                  </div>
                  <button type="button" className="secondary" aria-label={t("projects.openLabel", { name: projectName(w.data.projectId) ?? "" })} onClick={() => onOpen(w.data.projectId)}>
                    {t("projects.open")}
                  </button>
                </li>
              ))}
            </ul>
            <h2>{t("projects.results.tasks")}</h2>
            {result.tasks.length === 0 ? <p className="muted">{t("org.noMatches")}</p> : null}
            <ul className="item-list" data-testid="task-results">
              {result.tasks.map((task) => (
                <TaskRow key={task.id} task={task} org={org} context={projectName(task.data.projectId) ?? t("inbox.title")} />
              ))}
            </ul>
          </>
        ) : null}
      </section>
      <NewProject onCreated={onOpen} />
    </>
  );
}

/**
 * Project color (T-068, T-088): one of the 8 named palette entries, or "Default", which keeps the
 * color derived from the project ID (nothing is stored). `projectId` is null for a new project,
 * whose default is not known until it is created.
 */
function ColorSelect({ value, projectId, onChange }: { value: PaletteId | ""; projectId: string | null; onChange: (value: PaletteId | "") => void }) {
  const t = useT();
  const id = useId();
  const fallback = projectId ? defaultColorOf(projectId) : null;
  return (
    <div className="field">
      <label htmlFor={id}>{t("projects.color")}</label>
      <span className="color-pick">
        <span className="color-swatch" data-color={value || fallback || "neutral"} aria-hidden="true" />{" "}
        <select id={id} value={value} onChange={(e) => onChange(e.target.value as PaletteId | "")}>
          <option value="">{fallback ? t("projects.colorDefault", { name: t(`color.${fallback}` as MessageKey) }) : t("projects.colorDefault", { name: "…" })}</option>
          {PALETTE_IDS.map((c) => (
            <option key={c} value={c}>
              {t(`color.${c}` as MessageKey)}
            </option>
          ))}
        </select>
      </span>
      <p className="hint">{t("projects.colorHint")}</p>
    </div>
  );
}

/** The project's color as shown: a swatch and its name, marked when it is the derived default. */
export function ProjectColor({ project }: { project: Project }) {
  const t = useT();
  const color = projectColor(project.id, project.data);
  const name = t(`color.${color}` as MessageKey);
  return (
    <span className="hint" data-testid="project-color">
      <span className="color-swatch" data-color={color} aria-hidden="true" /> {t(project.data.color ? "projects.colorShown" : "projects.colorShownDefault", { name })}
    </span>
  );
}

function NewProject({ onCreated }: { onCreated: (id: string) => void }) {
  const t = useT();
  const { db } = useServices();
  const ids = { name: useId(), description: useId() };
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<PaletteId | "">("");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const id = await createProject(db, { name, description, ...(color ? { color } : {}) });
      setName("");
      setDescription("");
      setColor("");
      onCreated(id);
    } catch (e) {
      setError(organizationError(t, e));
    }
  }

  return (
    <section className="card" aria-labelledby={`${ids.name}-title`}>
      <h2 id={`${ids.name}-title`}>{t("projects.new")}</h2>
      <form onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor={ids.name}>{t("projects.name")}</label>
          <input id={ids.name} value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.description}>{t("projects.description")}</label>
          <textarea id={ids.description} value={description} maxLength={TEXT_MAX} rows={2} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <ColorSelect value={color} projectId={null} onChange={setColor} />
        {error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={!name.trim()}>
          {t("projects.create")}
        </button>
      </form>
    </section>
  );
}

/** Edits a name and description in place (projects and workstreams), and a project's color. */
function NameEditor({
  initial,
  label,
  onSave,
  onDone,
  colorOf,
}: {
  initial: { name: string; description: string; color?: PaletteId };
  label: string;
  onSave: (value: { name: string; description: string; color?: PaletteId | null }) => Promise<void>;
  onDone: () => void;
  /** Projects only: the project's ID, for its derived default color. */
  colorOf?: string;
}) {
  const t = useT();
  const ids = { name: useId(), description: useId() };
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [color, setColor] = useState<PaletteId | "">(initial.color ?? "");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="editor"
      aria-label={label}
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          // An unchanged color is left out, so the record is not rewritten for it.
          await onSave({ name, description, ...(colorOf && color !== (initial.color ?? "") ? { color: color || null } : {}) });
          onDone();
        } catch (e) {
          setError(organizationError(t, e));
        }
      }}
    >
      <div className="field">
        <label htmlFor={ids.name}>{t("projects.name")}</label>
        <input id={ids.name} value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={ids.description}>{t("projects.description")}</label>
        <textarea id={ids.description} value={description} maxLength={TEXT_MAX} rows={2} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {colorOf ? <ColorSelect value={color} projectId={colorOf} onChange={setColor} /> : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row">
        <button type="submit" disabled={!name.trim()}>
          {t("org.save")}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          {t("org.cancel")}
        </button>
      </div>
    </form>
  );
}

function ProjectDetail({ project, org, onBack }: { project: Project; org: Organization; onBack: () => void }) {
  const t = useT();
  const { db } = useServices();
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const outline = projectOutline(org, project.id, status, query)!;
  const archived = project.data.archivedAt !== null;
  const name = project.data.name;

  return (
    <>
      <section className="card" aria-labelledby="project-title">
        <button type="button" className="link-button" onClick={onBack}>
          {t("projects.back")}
        </button>
        <h1 id="project-title">
          {name} {archived ? <ArchivedPill /> : null}
        </h1>
        {editing ? (
          <NameEditor
            initial={project.data}
            label={t("projects.editLabel", { name })}
            onSave={(value) => updateProject(db, project.id, value)}
            onDone={() => setEditing(false)}
            colorOf={project.id}
          />
        ) : (
          <>
            {project.data.description ? <p className="preserve-lines">{project.data.description}</p> : null}
            <p>
              <ProjectColor project={project} />
            </p>
            <div className="button-row">
              <button type="button" className="secondary" aria-label={t("projects.editLabel", { name })} onClick={() => setEditing(true)}>
                {t("org.edit")}
              </button>
              <button
                type="button"
                className="secondary"
                aria-label={t(archived ? "org.restoreLabel" : "org.archiveLabel", { name })}
                onClick={() => setArchived(db, PROJECTS, project.id, !archived)}
              >
                {t(archived ? "org.restore" : "org.archive")}
              </button>
            </div>
            {archived ? <p className="hint">{t("projects.archivedHint")}</p> : null}
          </>
        )}
        <div className="filters">
          <SearchField label={t("projects.searchTasks")} value={query} onChange={setQuery} />
          <StatusFilterSelect value={status} onChange={setStatus} />
        </div>
      </section>

      <section className="card" aria-labelledby="direct-title" data-testid="direct-tasks">
        <h2 id="direct-title">{t("projects.direct")}</h2>
        {outline.directTasks.length === 0 ? <p className="muted">{t("projects.noTasks")}</p> : null}
        <ul className="item-list">
          {outline.directTasks.map((task) => (
            <TaskRow key={task.id} task={task} org={org} />
          ))}
        </ul>
        <NewTask projectId={project.id} org={org} />
      </section>

      {outline.workstreams.map(({ workstream, tasks }) => (
        <WorkstreamSection key={workstream.id} workstream={workstream}>
          {tasks.length === 0 ? <p className="muted">{t("projects.noTasks")}</p> : null}
          <ul className="item-list">
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} org={org} />
            ))}
          </ul>
          <NewTask projectId={project.id} workstreamId={workstream.id} org={org} />
        </WorkstreamSection>
      ))}

      <NewWorkstream projectId={project.id} />
    </>
  );
}

function WorkstreamSection({ workstream, children }: { workstream: Workstream; children: ReactNode }) {
  const t = useT();
  const { db } = useServices();
  const [editing, setEditing] = useState(false);
  const archived = workstream.data.archivedAt !== null;
  const name = workstream.data.name;
  const headingId = useId();
  return (
    <section className="card" aria-labelledby={headingId} data-testid="workstream">
      <h2 id={headingId}>
        {name} {archived ? <ArchivedPill /> : null}
      </h2>
      {editing ? (
        <NameEditor
          initial={workstream.data}
          label={t("workstreams.editLabel", { name })}
          onSave={(value) => updateWorkstream(db, workstream.id, value)}
          onDone={() => setEditing(false)}
        />
      ) : (
        <>
          {workstream.data.description ? <p className="preserve-lines">{workstream.data.description}</p> : null}
          <div className="button-row">
            <button type="button" className="secondary" aria-label={t("workstreams.editLabel", { name })} onClick={() => setEditing(true)}>
              {t("org.edit")}
            </button>
            <button
              type="button"
              className="secondary"
              aria-label={t(archived ? "org.restoreLabel" : "org.archiveLabel", { name })}
              onClick={() => setArchived(db, WORKSTREAMS, workstream.id, !archived)}
            >
              {t(archived ? "org.restore" : "org.archive")}
            </button>
          </div>
        </>
      )}
      {children}
    </section>
  );
}

function NewTask({ projectId, workstreamId, org }: { projectId: string; workstreamId?: string; org: Organization }) {
  const t = useT();
  const { db } = useServices();
  const id = useId();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const where = workstreamId ? org.workstreams.find((w) => w.id === workstreamId)?.data.name : org.projects.find((p) => p.id === projectId)?.data.name;
  return (
    <form
      className="inline-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await createTask(db, { title, projectId, workstreamId: workstreamId ?? null });
          setTitle("");
        } catch (e) {
          setError(organizationError(t, e));
        }
      }}
    >
      <label htmlFor={id}>{t("projects.newTaskIn", { name: where ?? "" })}</label>
      <input id={id} value={title} maxLength={NAME_MAX} onChange={(e) => setTitle(e.target.value)} />
      <button type="submit" disabled={!title.trim()}>
        {t("projects.addTask")}
      </button>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function NewWorkstream({ projectId }: { projectId: string }) {
  const t = useT();
  const { db } = useServices();
  const id = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t("workstreams.new")}</h2>
      <p className="hint">{t("workstreams.hint")}</p>
      <form
        className="inline-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          try {
            await createWorkstream(db, { projectId, name });
            setName("");
          } catch (e) {
            setError(organizationError(t, e));
          }
        }}
      >
        <label htmlFor={id}>{t("workstreams.name")}</label>
        <input id={id} value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={!name.trim()}>
          {t("workstreams.add")}
        </button>
      </form>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
