/**
 * Stage 2 — organization and quick capture (docs/ROADMAP.md, PRODUCT_SPEC "Capture and
 * organization"). Projects, optional workstreams, and task definitions are ordinary product
 * records (envelopes with version vectors), so they are exported, merged, and resolved by the
 * backup code like any other type. Relationship rules are enforced by `putRecord` for typed-in
 * data and by the import for backup data (registry `rule` / `immutableFields`).
 *
 * Nothing here deletes: archiving is a data change (`archivedAt`) that can be undone.
 */
import { nowIso } from "../backup/envelope.ts";
import {
  type PaletteId,
  PRODUCT_REGISTRY,
  PROJECTS,
  type ProjectData,
  type Recurrence,
  TASK_DEFINITIONS,
  type TaskDefinitionData,
  type Registry,
  WORKSTREAMS,
  type WorkstreamData,
} from "../backup/registry.ts";
import type { LocalDb, RecordRow } from "./db.ts";
import { requireZone } from "./planning-error.ts";
import { putRecord } from "./records.ts";

export interface Item<T> {
  id: string;
  data: T;
  createdAt: string;
  updatedAt: string;
}

export type Project = Item<ProjectData>;
export type Workstream = Item<WorkstreamData>;
export type TaskDefinition = Item<TaskDefinitionData>;

export interface Organization {
  projects: Project[];
  workstreams: Workstream[];
  tasks: TaskDefinition[];
}

function itemOf<T>(row: RecordRow): Item<T> {
  return { id: row.id, data: row.data as T, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/** Everything Stage 2 shows, read in one transaction (live records only; deletions are not shown). */
export async function loadOrganization(db: LocalDb): Promise<Organization> {
  return db.transaction("r", db.records, async () => {
    const [projects, workstreams, tasks] = await Promise.all(
      [PROJECTS, WORKSTREAMS, TASK_DEFINITIONS].map((type) => db.records.where("type").equals(type).toArray()),
    );
    return {
      projects: projects!.map((row) => itemOf<ProjectData>(row)),
      workstreams: workstreams!.map((row) => itemOf<WorkstreamData>(row)),
      tasks: tasks!.map((row) => itemOf<TaskDefinitionData>(row)),
    };
  });
}

async function current<T>(db: LocalDb, type: string, id: string): Promise<T> {
  const row = await db.records.get([type, id]);
  if (!row) throw new Error(`${type}/${id} does not exist`);
  return row.data as T;
}

/* ---------- commands ---------- */

/** `color` is a palette identifier; leaving it out keeps the derived default (nothing is written). */
export async function createProject(
  db: LocalDb,
  input: { name: string; description?: string; color?: PaletteId },
  registry: Registry = PRODUCT_REGISTRY,
): Promise<string> {
  const id = crypto.randomUUID();
  const data: ProjectData = {
    name: input.name.trim(),
    description: (input.description ?? "").trim(),
    archivedAt: null,
    ...(input.color ? { color: input.color } : {}),
  };
  await putRecord(db, registry, PROJECTS, id, data);
  return id;
}

/**
 * Edits a project. `color: null` returns to the derived default by removing the field (never
 * stored as null, T-025); leaving `color` out keeps it. Only the project record is written: blocks
 * and snapshots carry no color (T-069).
 */
export async function updateProject(
  db: LocalDb,
  id: string,
  patch: Partial<Pick<ProjectData, "name" | "description">> & { color?: PaletteId | null },
  registry: Registry = PRODUCT_REGISTRY,
): Promise<void> {
  await db.transaction("rw", [db.records, db.tombstones, db.meta], async () => {
    const data = await current<ProjectData>(db, PROJECTS, id);
    const { color, ...rest } = patch;
    const next: Record<string, unknown> = { ...data, ...trimmed(rest) };
    if (color === null) delete next.color;
    else if (color !== undefined) next.color = color;
    await putRecord(db, registry, PROJECTS, id, next);
  });
}

export async function createWorkstream(
  db: LocalDb,
  input: { projectId: string; name: string; description?: string },
  registry: Registry = PRODUCT_REGISTRY,
): Promise<string> {
  const id = crypto.randomUUID();
  const data: WorkstreamData = {
    projectId: input.projectId,
    name: input.name.trim(),
    description: (input.description ?? "").trim(),
    archivedAt: null,
  };
  await putRecord(db, registry, WORKSTREAMS, id, data);
  return id;
}

/** A workstream's project never changes (registry `immutableFields`). */
export async function updateWorkstream(
  db: LocalDb,
  id: string,
  patch: Partial<Pick<WorkstreamData, "name" | "description">>,
  registry: Registry = PRODUCT_REGISTRY,
): Promise<void> {
  await db.transaction("rw", [db.records, db.tombstones, db.meta], async () => {
    const data = await current<WorkstreamData>(db, WORKSTREAMS, id);
    await putRecord(db, registry, WORKSTREAMS, id, { ...data, ...trimmed(patch) });
  });
}

export interface TaskInput {
  title: string;
  notes?: string;
  projectId?: string | null;
  workstreamId?: string | null;
  nextAction?: string;
  estimateMinutes?: number | null;
}

/** Quick capture: a task definition without a project lands in the inbox. */
export async function captureToInbox(db: LocalDb, title: string, registry: Registry = PRODUCT_REGISTRY): Promise<string> {
  return createTask(db, { title }, registry);
}

export async function createTask(db: LocalDb, input: TaskInput, registry: Registry = PRODUCT_REGISTRY): Promise<string> {
  const id = crypto.randomUUID();
  const data: TaskDefinitionData = {
    title: input.title.trim(),
    notes: (input.notes ?? "").trim(),
    projectId: input.projectId ?? null,
    workstreamId: input.workstreamId ?? null,
    nextAction: (input.nextAction ?? "").trim(),
    estimateMinutes: input.estimateMinutes ?? null,
    archivedAt: null,
  };
  await putRecord(db, registry, TASK_DEFINITIONS, id, data);
  return id;
}

/**
 * Edits a task, including moving it: to another project (its workstream must then belong to that
 * project, or be cleared), into a workstream, or back to the inbox (no project, no workstream).
 * `recurrence: null` turns recurrence off by removing the field (never stored as null, T-025);
 * leaving `recurrence` out keeps it unchanged. Existing blocks are never changed.
 */
export async function updateTask(
  db: LocalDb,
  id: string,
  patch: Partial<Omit<TaskDefinitionData, "archivedAt" | "recurrence">> & { recurrence?: Recurrence | null },
  registry: Registry = PRODUCT_REGISTRY,
): Promise<void> {
  await db.transaction("rw", [db.records, db.tombstones, db.meta], async () => {
    const data = await current<TaskDefinitionData>(db, TASK_DEFINITIONS, id);
    const { recurrence, ...rest } = patch;
    if (recurrence) await requireZone(db); // planning data needs a configured zone (T-028)
    const next: Record<string, unknown> = { ...data, ...trimmed(rest) };
    if (recurrence === null) delete next.recurrence;
    else if (recurrence !== undefined) next.recurrence = { ...recurrence, weekdays: [...new Set(recurrence.weekdays)].sort((a, b) => a - b) };
    await putRecord(db, registry, TASK_DEFINITIONS, id, next);
  });
}

/** Archives or restores a project, workstream, or task. Nothing linked to it is changed or deleted. */
export async function setArchived(
  db: LocalDb,
  type: typeof PROJECTS | typeof WORKSTREAMS | typeof TASK_DEFINITIONS,
  id: string,
  archived: boolean,
  registry: Registry = PRODUCT_REGISTRY,
): Promise<void> {
  await db.transaction("rw", [db.records, db.tombstones, db.meta], async () => {
    const data = await current<{ archivedAt: string | null }>(db, type, id);
    if (archived === (data.archivedAt !== null)) return;
    await putRecord(db, registry, type, id, { ...data, archivedAt: archived ? nowIso() : null });
  });
}

function trimmed<T extends object>(patch: T): T {
  const out = { ...patch } as Record<string, unknown>;
  for (const [key, value] of Object.entries(out)) if (typeof value === "string") out[key] = value.trim();
  return out as T;
}

/* ---------- queries (pure; unit-tested) ---------- */

export type StatusFilter = "active" | "archived" | "all";

const matchesStatus = (archivedAt: string | null, status: StatusFilter) =>
  status === "all" || (status === "active" ? archivedAt === null : archivedAt !== null);

/** Case-insensitive search that also folds Arabic/Persian letter variants and ignores ZWNJ. */
export function normalizeForSearch(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/ي/g, "ی") // Arabic Yeh → Persian Yeh
    .replace(/ك/g, "ک") // Arabic Kaf → Keheh
    .replace(/‌/g, "")
    .normalize("NFC");
}

function matches(query: string, ...texts: string[]): boolean {
  const q = normalizeForSearch(query.trim());
  if (!q) return true;
  return texts.some((text) => normalizeForSearch(text).includes(q));
}

const byName = <T>(name: (item: T) => string) => (a: T, b: T) => name(a).localeCompare(name(b));

/** Inbox: task definitions without a project. */
export function inboxTasks(org: Organization, query = "", status: StatusFilter = "active"): TaskDefinition[] {
  return org.tasks
    .filter((t) => t.data.projectId === null && matchesStatus(t.data.archivedAt, status))
    .filter((t) => matches(query, t.data.title, t.data.notes, t.data.nextAction))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface SearchResult {
  projects: Project[];
  workstreams: Workstream[];
  tasks: TaskDefinition[];
}

/** Searches names, descriptions, notes, and next actions of every organization record. */
export function searchOrganization(org: Organization, query: string, status: StatusFilter): SearchResult {
  return {
    projects: org.projects
      .filter((p) => matchesStatus(p.data.archivedAt, status) && matches(query, p.data.name, p.data.description))
      .sort(byName((p) => p.data.name)),
    workstreams: org.workstreams
      .filter((w) => matchesStatus(w.data.archivedAt, status) && matches(query, w.data.name, w.data.description))
      .sort(byName((w) => w.data.name)),
    tasks: org.tasks
      .filter((t) => matchesStatus(t.data.archivedAt, status) && matches(query, t.data.title, t.data.notes, t.data.nextAction))
      .sort(byName((t) => t.data.title)),
  };
}

export interface ProjectOutline {
  project: Project;
  /** Tasks assigned directly to the project (no workstream). */
  directTasks: TaskDefinition[];
  workstreams: { workstream: Workstream; tasks: TaskDefinition[] }[];
}

/**
 * Project detail: its workstreams and its tasks grouped by workstream, plus tasks assigned
 * directly to the project. `status` filters workstreams and tasks; a task in an archived
 * workstream is still listed under that workstream when the workstream is shown.
 */
export function projectOutline(org: Organization, projectId: string, status: StatusFilter = "active", query = ""): ProjectOutline | null {
  const project = org.projects.find((p) => p.id === projectId);
  if (!project) return null;
  const tasks = org.tasks
    .filter((t) => t.data.projectId === projectId && matchesStatus(t.data.archivedAt, status))
    .filter((t) => matches(query, t.data.title, t.data.notes, t.data.nextAction))
    .sort(byName((t) => t.data.title));
  const workstreams = org.workstreams
    .filter((w) => w.data.projectId === projectId)
    .sort(byName((w) => w.data.name))
    .map((workstream) => ({ workstream, tasks: tasks.filter((t) => t.data.workstreamId === workstream.id) }))
    .filter(({ workstream, tasks: own }) => matchesStatus(workstream.data.archivedAt, status) || own.length > 0);
  return { project, directTasks: tasks.filter((t) => t.data.workstreamId === null), workstreams };
}
