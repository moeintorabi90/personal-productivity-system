/**
 * Stage 2 domain rules on the device (docs/TESTING.md "Project/workstream/task relationship rules
 * enforced locally"): quick capture, create/edit/archive, relationships, search and filters.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTestDevice, type TestDevice } from "../backup/test-fixtures.ts";
import { PRODUCT_REGISTRY, PROJECTS, TASK_DEFINITIONS, WORKSTREAMS } from "../backup/registry.ts";
import {
  captureToInbox,
  createProject,
  createTask,
  createWorkstream,
  inboxTasks,
  loadOrganization,
  normalizeForSearch,
  projectOutline,
  searchOrganization,
  setArchived,
  updateProject,
  updateTask,
  updateWorkstream,
} from "./organization.ts";
import { deleteRecord, putRecord, RecordRuleError } from "./records.ts";

const devices: TestDevice[] = [];
async function device(label = "D") {
  const d = await createTestDevice(label);
  devices.push(d);
  return d.db;
}
afterEach(() => {
  for (const d of devices.splice(0)) d.db.close();
});

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "OK";
  } catch (e) {
    return e instanceof RecordRuleError ? e.code : (e as Error).name;
  }
};

describe("quick capture and the inbox", () => {
  it("captures a trimmed task without a project, newest first, and leaves the inbox when organized", async () => {
    const db = await device();
    const first = await captureToInbox(db, "  Buy paper  ");
    await new Promise((r) => setTimeout(r, 5));
    const second = await captureToInbox(db, "Idea: weekly summary");
    let org = await loadOrganization(db);
    expect(inboxTasks(org).map((t) => t.id)).toEqual([second, first]);
    expect(org.tasks.find((t) => t.id === first)!.data).toEqual({
      title: "Buy paper",
      notes: "",
      projectId: null,
      workstreamId: null,
      nextAction: "",
      estimateMinutes: null,
      archivedAt: null,
    });

    const project = await createProject(db, { name: "Home" });
    await updateTask(db, first, { projectId: project });
    org = await loadOrganization(db);
    expect(inboxTasks(org).map((t) => t.id)).toEqual([second]);
    expect(projectOutline(org, project)!.directTasks.map((t) => t.id)).toEqual([first]);
  });

  it("rejects blank or too long titles (same schema as imported data)", async () => {
    const db = await device();
    expect(await codeOf(captureToInbox(db, "   "))).toBe("ZodError");
    expect(await codeOf(captureToInbox(db, "x".repeat(201)))).toBe("ZodError");
    expect(await codeOf(captureToInbox(db, "x".repeat(200)))).toBe("OK");
  });
});

describe("relationship rules for typed-in data", () => {
  it("a workstream needs an existing project and never moves to another project", async () => {
    const db = await device();
    expect(await codeOf(createWorkstream(db, { projectId: crypto.randomUUID(), name: "W" }))).toBe("BROKEN_LINK");
    const p1 = await createProject(db, { name: "P1" });
    const p2 = await createProject(db, { name: "P2" });
    const ws = await createWorkstream(db, { projectId: p1, name: "W" });
    await updateWorkstream(db, ws, { name: "W renamed" });
    const row = (await db.records.get([WORKSTREAMS, ws]))!;
    expect(row.data).toMatchObject({ projectId: p1, name: "W renamed" });
    // Even a direct write cannot move it.
    expect(await codeOf(putRecord(db, PRODUCT_REGISTRY, WORKSTREAMS, ws, { ...row.data, projectId: p2 }))).toBe("IMMUTABLE_FIELD");
  });

  it("a task's workstream must belong to the task's project; an inbox task has no workstream", async () => {
    const db = await device();
    const p1 = await createProject(db, { name: "P1" });
    const p2 = await createProject(db, { name: "P2" });
    const w1 = await createWorkstream(db, { projectId: p1, name: "W1" });
    const w2 = await createWorkstream(db, { projectId: p2, name: "W2" });

    expect(await codeOf(createTask(db, { title: "T", projectId: p1, workstreamId: w2 }))).toBe("INVALID_RELATIONSHIP");
    expect(await codeOf(createTask(db, { title: "T", projectId: null, workstreamId: w1 }))).toBe("INVALID_RELATIONSHIP");
    expect(await codeOf(createTask(db, { title: "T", projectId: crypto.randomUUID() }))).toBe("BROKEN_LINK");

    const task = await createTask(db, { title: "T", projectId: p1, workstreamId: w1 });
    // Moving to another project while keeping the old workstream is refused; nothing changes.
    expect(await codeOf(updateTask(db, task, { projectId: p2 }))).toBe("INVALID_RELATIONSHIP");
    expect((await db.records.get([TASK_DEFINITIONS, task]))!.data).toMatchObject({ projectId: p1, workstreamId: w1 });
    await updateTask(db, task, { projectId: p2, workstreamId: w2 });
    await updateTask(db, task, { projectId: null, workstreamId: null }); // back to the inbox
    expect(inboxTasks(await loadOrganization(db)).map((t) => t.id)).toEqual([task]);
  });

  it("a link to a deleted (tombstoned) project is refused", async () => {
    const db = await device();
    const p = await createProject(db, { name: "Gone" });
    await deleteRecord(db, PROJECTS, p);
    expect(await codeOf(createTask(db, { title: "T", projectId: p }))).toBe("BROKEN_LINK");
  });

  it("each edit bumps this device's version; an edit with no change is a no-op", async () => {
    const db = await device();
    const p = await createProject(db, { name: "P" });
    const v1 = (await db.records.get([PROJECTS, p]))!.version;
    await updateProject(db, p, { name: "P" });
    expect((await db.records.get([PROJECTS, p]))!.version).toEqual(v1);
    await updateProject(db, p, { name: "P2", description: "  about  " });
    const row = (await db.records.get([PROJECTS, p]))!;
    expect(row.data).toMatchObject({ name: "P2", description: "about" });
    expect(Object.values(row.version)).toEqual([2]);
  });
});

describe("archive (never a deletion)", () => {
  it("archiving a project keeps its workstreams and tasks unchanged, and can be undone", async () => {
    const db = await device();
    const p = await createProject(db, { name: "P" });
    const w = await createWorkstream(db, { projectId: p, name: "W" });
    const t = await createTask(db, { title: "T", projectId: p, workstreamId: w });
    const before = { w: (await db.records.get([WORKSTREAMS, w]))!, t: (await db.records.get([TASK_DEFINITIONS, t]))! };

    await setArchived(db, PROJECTS, p, true);
    let org = await loadOrganization(db);
    expect(org.projects[0]!.data.archivedAt).not.toBeNull();
    expect(searchOrganization(org, "", "active").projects).toEqual([]);
    expect(searchOrganization(org, "", "archived").projects.map((x) => x.id)).toEqual([p]);
    expect(await db.records.get([WORKSTREAMS, w])).toEqual(before.w);
    expect(await db.records.get([TASK_DEFINITIONS, t])).toEqual(before.t);
    expect(await db.tombstones.count()).toBe(0);

    await setArchived(db, PROJECTS, p, true); // already archived: no change
    await setArchived(db, PROJECTS, p, false);
    org = await loadOrganization(db);
    expect(org.projects[0]!.data.archivedAt).toBeNull();
  });
});

describe("queries: search, filters, project outline", () => {
  async function sample() {
    const db = await device();
    const p = await createProject(db, { name: "Thesis", description: "PhD" });
    const other = await createProject(db, { name: "Garden" });
    const w = await createWorkstream(db, { projectId: p, name: "Writing" });
    const wOld = await createWorkstream(db, { projectId: p, name: "Old notes" });
    const direct = await createTask(db, { title: "Meet supervisor", projectId: p });
    const inW = await createTask(db, { title: "Draft chapter", projectId: p, workstreamId: w, nextAction: "Outline section 2" });
    const archived = await createTask(db, { title: "Old draft", projectId: p, workstreamId: wOld });
    await setArchived(db, TASK_DEFINITIONS, archived, true);
    await setArchived(db, WORKSTREAMS, wOld, true);
    const inbox = await captureToInbox(db, "کتاب علمي");
    return { db, p, other, w, wOld, direct, inW, archived, inbox };
  }

  it("project outline groups tasks by workstream and lists direct tasks; filters by status", async () => {
    const s = await sample();
    const org = await loadOrganization(s.db);
    const active = projectOutline(org, s.p, "active")!;
    expect(active.directTasks.map((t) => t.id)).toEqual([s.direct]);
    expect(active.workstreams.map((g) => [g.workstream.id, g.tasks.map((t) => t.id)])).toEqual([[s.w, [s.inW]]]);
    const archived = projectOutline(org, s.p, "archived")!;
    expect(archived.directTasks).toEqual([]);
    expect(archived.workstreams.map((g) => [g.workstream.id, g.tasks.map((t) => t.id)])).toEqual([[s.wOld, [s.archived]]]);
    const all = projectOutline(org, s.p, "all")!;
    expect(all.workstreams.map((g) => g.workstream.data.name)).toEqual(["Old notes", "Writing"]);
    expect(projectOutline(org, s.p, "active", "outline")!.workstreams[0]!.tasks.map((t) => t.id)).toEqual([s.inW]);
    expect(projectOutline(org, crypto.randomUUID())).toBeNull();
  });

  it("search covers projects, workstreams, and tasks (name, description, notes, next action)", async () => {
    const s = await sample();
    const org = await loadOrganization(s.db);
    const r = searchOrganization(org, "THESIS", "active");
    expect(r.projects.map((p) => p.id)).toEqual([s.p]);
    expect(searchOrganization(org, "phd", "all").projects.map((p) => p.id)).toEqual([s.p]);
    expect(searchOrganization(org, "writ", "active").workstreams.map((w) => w.id)).toEqual([s.w]);
    expect(searchOrganization(org, "section 2", "active").tasks.map((t) => t.id)).toEqual([s.inW]);
    expect(searchOrganization(org, "draft", "active").tasks.map((t) => t.id)).toEqual([s.inW]);
    expect(searchOrganization(org, "draft", "all").tasks.map((t) => t.id).sort()).toEqual([s.archived, s.inW].sort());
    expect(searchOrganization(org, "", "active").projects.map((p) => p.data.name)).toEqual(["Garden", "Thesis"]);
  });

  it("Persian search ignores Arabic/Persian letter variants and ZWNJ", async () => {
    const s = await sample();
    const org = await loadOrganization(s.db);
    expect(normalizeForSearch("علمي")).toBe(normalizeForSearch("علمی"));
    expect(inboxTasks(org, "علمی").map((t) => t.id)).toEqual([s.inbox]);
    expect(inboxTasks(org, "کتاب‌").map((t) => t.id)).toEqual([s.inbox]);
    expect(inboxTasks(org, "nothing")).toEqual([]);
  });
});
