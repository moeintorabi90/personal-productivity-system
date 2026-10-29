/**
 * Stage 2 record types in backups (docs/ROADMAP.md Stage 2 acceptance, docs/TESTING.md "Backup
 * acceptance tests"): projects, workstreams, and task definitions round-trip, merge, conflict,
 * and are validated on import with the same relationship rules as typed-in data.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_SCHEMA_VERSION } from "./limits.ts";
import {
  captureToInbox,
  createProject,
  createTask,
  createWorkstream,
  loadOrganization,
  projectOutline,
  setArchived,
  updateProject,
  updateTask,
} from "../local/organization.ts";
import { deleteRecord } from "../local/records.ts";
import { loadConflictViews, ResolutionError, resolveConflict } from "./conflicts.ts";
import { contentHashOf, makeEnvelope, nowIso } from "./envelope.ts";
import { openBackupFile } from "./read.ts";
import { PRODUCT_REGISTRY, PROJECTS, TASK_DEFINITIONS, WORKSTREAMS } from "./registry.ts";
import { createTestDevice, type TestDevice } from "./test-fixtures.ts";
import { blobOf, decide, exportFrom, importInto, mutate, snapshot } from "./test-helpers.ts";

const registry = PRODUCT_REGISTRY;
const product = { registry };
const devices: TestDevice[] = [];
async function device(label: string) {
  const d = await createTestDevice(label);
  devices.push(d);
  return d;
}
afterEach(() => {
  for (const d of devices.splice(0)) d.db.close();
});

const exportText = async (d: TestDevice) => (await exportFrom(d, {}, registry)).text;
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

/** A device with one project, a workstream, a direct task, a workstream task, an inbox item, an archived task. */
async function organizedDevice(label = "A") {
  const d = await device(label);
  const project = await createProject(d.db, { name: "Thesis", description: "PhD work" });
  const workstream = await createWorkstream(d.db, { projectId: project, name: "Writing" });
  const direct = await createTask(d.db, { title: "Meet supervisor", projectId: project, estimateMinutes: 30 });
  const inWorkstream = await createTask(d.db, { title: "Draft chapter 2", projectId: project, workstreamId: workstream, nextAction: "Outline" });
  const inbox = await captureToInbox(d.db, "Idea: reading list");
  const archived = await createTask(d.db, { title: "Old plan", projectId: project });
  await setArchived(d.db, TASK_DEFINITIONS, archived, true);
  return { d, project, workstream, direct, inWorkstream, inbox, archived };
}

const recordsOf = async (d: TestDevice) =>
  (await d.db.records.toArray())
    .filter((r) => r.type !== "preferences")
    .map((r) => ({ type: r.type, id: r.id, contentHash: r.contentHash, version: r.version, data: r.data }))
    .sort((a, b) => `${a.type}/${a.id}`.localeCompare(`${b.type}/${b.id}`));

describe("1–3. round-trip, merge without loss, idempotent re-import", () => {
  it("an empty device receives every project, workstream, and task unchanged (written as dataSchemaVersion 6 since Stage 5)", async () => {
    const a = await organizedDevice();
    const text = await exportText(a.d);
    const doc = JSON.parse(text);
    expect(doc.app.dataSchemaVersion).toBe(6);
    expect(Object.keys(doc.payload.records).sort()).toEqual(["preferences", PROJECTS, TASK_DEFINITIONS, WORKSTREAMS].sort());

    const b = await device("B");
    const { preview } = await importInto(b, text, product);
    expect(preview.counts.new).toBe(6); // 1 project, 1 workstream, 4 tasks (untouched preferences: already here)
    expect(await recordsOf(b)).toEqual(await recordsOf(a.d));
    const outline = projectOutline(await loadOrganization(b.db), a.project, "all")!;
    expect(outline.directTasks.map((t) => t.id).sort()).toEqual([a.direct, a.archived].sort());
    expect(outline.workstreams[0]!.tasks.map((t) => t.id)).toEqual([a.inWorkstream]);
  });

  it("merges into a device with its own data, keeps everything, and a second import changes nothing", async () => {
    const a = await organizedDevice();
    const b = await device("B");
    const own = await createProject(b.db, { name: "Thesis", description: "PhD work" }); // same content, other ID
    const ownTask = await captureToInbox(b.db, "Idea: reading list");
    const text = await exportText(a.d);
    await importInto(b, text, product);
    const org = await loadOrganization(b.db);
    expect(org.projects.map((p) => p.id).sort()).toEqual([a.project, own].sort()); // identity is the UUID
    expect(org.tasks.map((t) => t.id)).toEqual(expect.arrayContaining([ownTask, a.inbox]));

    const before = await snapshot(b.db);
    const { preview } = await importInto(b, text, product);
    expect(preview.counts.new).toBe(0);
    expect(preview.counts.alreadyHere).toBe(7);
    expect(await snapshot(b.db)).toEqual({ ...before });
  });
});

describe("4–5. older copies and newer versions", () => {
  it("a task moved to another project elsewhere is an update that needs confirmation", async () => {
    const a = await organizedDevice();
    const b = await device("B");
    await importInto(b, await exportText(a.d), product);
    const other = await createProject(a.d.db, { name: "Admin" });
    await updateTask(a.d.db, a.inWorkstream, { projectId: other, workstreamId: null });
    const text = await exportText(a.d);

    const first = await importInto(b, text, product);
    expect(first.preview.counts.newerInBackup).toBe(1);
    expect((await b.db.records.get([TASK_DEFINITIONS, a.inWorkstream]))!.data).toMatchObject({ projectId: a.project, workstreamId: a.workstream });

    await importInto(b, text, { ...product, applyUpdates: true });
    expect((await b.db.records.get([TASK_DEFINITIONS, a.inWorkstream]))!.data).toMatchObject({ projectId: other, workstreamId: null });
    expect(await b.db.replacedVersions.count()).toBe(1); // the previous version is kept for undo
  });

  it("an old file does not undo newer local edits", async () => {
    const a = await organizedDevice();
    const old = await exportText(a.d);
    await updateProject(a.d.db, a.project, { name: "Thesis (final)" });
    const { preview } = await importInto(a.d, old, product);
    expect(preview.counts.olderCopy).toBe(1);
    expect((await a.d.db.records.get([PROJECTS, a.project]))!.data.name).toBe("Thesis (final)");
  });
});

describe("6. conflicts on linked records keep the ID and the links", () => {
  async function editedOnBoth() {
    const a = await organizedDevice();
    const b = await device("B");
    await importInto(b, await exportText(a.d), product);
    await updateProject(a.d.db, a.project, { name: "Thesis A" });
    await updateProject(b.db, a.project, { name: "Thesis B" });
    await importInto(b, await exportText(a.d), product);
    return { a, b };
  }

  it("offers keep/use but never 'keep both'; survives a restart; tasks stay attached either way", async () => {
    const { a, b } = await editedOnBoth();
    await b.restart();
    const [view] = await loadConflictViews(b.db, registry);
    expect(view!.conflict).toMatchObject({ type: PROJECTS, id: a.project });
    expect(view!.options).toEqual(["keepDevice", "useBackup"]);

    await decide(b.db, view!.conflict.conflictId, "useBackup", registry);
    const org = await loadOrganization(b.db);
    expect(org.projects.find((p) => p.id === a.project)!.data.name).toBe("Thesis A");
    const outline = projectOutline(org, a.project)!;
    expect(outline.directTasks.map((t) => t.id)).toEqual([a.direct]);
    expect(outline.workstreams[0]!.tasks.map((t) => t.id)).toEqual([a.inWorkstream]);
    expect((await b.db.replacedVersions.toArray()).map((r) => (r.entry.deleted ? null : r.entry.envelope.data.name))).toEqual(["Thesis B"]);
  });

  it("a task edited on both sides also offers only keep/use", async () => {
    const a = await organizedDevice();
    const b = await device("B");
    await importInto(b, await exportText(a.d), product);
    await updateTask(a.d.db, a.inbox, { title: "Reading list (A)" });
    await updateTask(b.db, a.inbox, { title: "Reading list (B)" });
    await importInto(b, await exportText(a.d), product);
    const [view] = await loadConflictViews(b.db, registry);
    expect(view!.options).toEqual(["keepDevice", "useBackup"]);
    await decide(b.db, view!.conflict.conflictId, "keepDevice", registry);
    expect((await b.db.records.get([TASK_DEFINITIONS, a.inbox]))!.data.title).toBe("Reading list (B)");
  });
});

describe("7. deletions are never applied automatically", () => {
  it("a deleted task becomes a decision; 'delete here' works for a task but is refused for a project with tasks", async () => {
    const a = await organizedDevice();
    const b = await device("B");
    await importInto(b, await exportText(a.d), product);
    await deleteRecord(a.d.db, TASK_DEFINITIONS, a.inbox);
    // Deleting a project that still has tasks happens only through backup data (no delete in the UI).
    await deleteRecord(a.d.db, PROJECTS, a.project);
    await importInto(b, await exportText(a.d), product);

    const views = await loadConflictViews(b.db, registry);
    expect(views.map((v) => [v.conflict.type, v.conflict.kind]).sort()).toEqual([
      [PROJECTS, "deletedInBackup"],
      [TASK_DEFINITIONS, "deletedInBackup"],
    ]);
    expect(await b.db.records.get([TASK_DEFINITIONS, a.inbox])).toBeDefined(); // not deleted yet

    const taskView = views.find((v) => v.conflict.type === TASK_DEFINITIONS)!;
    await decide(b.db, taskView.conflict.conflictId, "deleteHere", registry);
    expect(await b.db.records.get([TASK_DEFINITIONS, a.inbox])).toBeUndefined();

    const projectView = views.find((v) => v.conflict.type === PROJECTS)!;
    const before = await snapshot(b.db);
    await expect(resolveConflict(b.db, registry, projectView.conflict.conflictId, "deleteHere", projectView.token)).rejects.toMatchObject({
      code: "HAS_LINKED_ITEMS",
    });
    expect(await snapshot(b.db)).toEqual(before);
    await decide(b.db, projectView.conflict.conflictId, "keepHere", registry);
    expect(await b.db.records.get([PROJECTS, a.project])).toBeDefined();
  });
});

describe("9. imported data follows the same relationship rules (refused, nothing changes)", () => {
  async function fileAndTarget() {
    const a = await organizedDevice();
    const other = await createProject(a.d.db, { name: "Other" });
    const otherWs = await createWorkstream(a.d.db, { projectId: other, name: "Other WS" });
    const text = await exportText(a.d);
    const b = await device("B");
    return { a, other, otherWs, text, b, before: await snapshot(b.db) };
  }
  /** Rewrites one task's data in the file, keeping its content hash valid. */
  const withTask = (text: string, id: string, change: (data: Record<string, unknown>) => void) =>
    mutate(text, (doc) => {
      const env = doc.payload.records[TASK_DEFINITIONS].find((e: { id: string }) => e.id === id);
      change(env.data);
      env.contentHash = contentHashOf(env.data);
    });

  it("a task whose workstream belongs to another project", async () => {
    const s = await fileAndTarget();
    const bad = withTask(s.text, s.a.inWorkstream, (d) => (d.workstreamId = s.otherWs));
    expect(await codeOf(importInto(s.b, bad, product))).toBe("INVALID_RELATIONSHIP");
    expect(await snapshot(s.b.db)).toEqual(s.before);
  });

  it("an inbox task with a workstream", async () => {
    const s = await fileAndTarget();
    const bad = withTask(s.text, s.a.inbox, (d) => (d.workstreamId = s.a.workstream));
    expect(await codeOf(importInto(s.b, bad, product))).toBe("INVALID_RELATIONSHIP");
    expect(await snapshot(s.b.db)).toEqual(s.before);
  });

  it("the same rule applies to carried conflict and archived versions", async () => {
    const s = await fileAndTarget();
    const badEntry = () => {
      const data = { title: "x", notes: "", projectId: s.a.project, workstreamId: s.otherWs, nextAction: "", estimateMinutes: null, archivedAt: null };
      return { deleted: false, envelope: makeEnvelope(s.a.direct, data, { [crypto.randomUUID()]: 9 }, nowIso()) };
    };
    const inArchive = mutate(s.text, (doc) => {
      doc.payload.replacedVersions.push({ replacedId: crypto.randomUUID(), type: TASK_DEFINITIONS, id: s.a.direct, entry: badEntry(), replacedAt: nowIso(), reason: "x" });
    });
    expect(await codeOf(importInto(s.b, inArchive, product))).toBe("INVALID_RELATIONSHIP");
    expect(await snapshot(s.b.db)).toEqual(s.before);
  });

  it("a workstream whose project differs between versions (here: the device and the file)", async () => {
    const s = await fileAndTarget();
    await importInto(s.b, s.text, product);
    const before = await snapshot(s.b.db);
    const moved = mutate(s.text, (doc) => {
      const env = doc.payload.records[WORKSTREAMS].find((e: { id: string }) => e.id === s.a.workstream);
      env.data.projectId = s.other;
      env.contentHash = contentHashOf(env.data);
      env.version = { ...env.version, [crypto.randomUUID()]: 1 };
      // Keep the file itself consistent: its task in that workstream moves too.
      const task = doc.payload.records[TASK_DEFINITIONS].find((e: { id: string }) => e.id === s.a.inWorkstream);
      task.data.projectId = s.other;
      task.contentHash = contentHashOf(task.data);
    });
    expect(await codeOf(importInto(s.b, moved, product))).toBe("INVALID_RELATIONSHIP");
    expect(await snapshot(s.b.db)).toEqual(before);
  });

  it("a missing project, a blank name, and an unknown field", async () => {
    const s = await fileAndTarget();
    const cases: [string, string][] = [
      [withTask(s.text, s.a.direct, (d) => (d.projectId = crypto.randomUUID())), "UNRESOLVED_REFERENCE"],
      [withTask(s.text, s.a.direct, (d) => (d.title = "   ")), "INVALID_PAYLOAD"],
      [withTask(s.text, s.a.direct, (d) => (d.recurrence = "daily")), "INVALID_PAYLOAD"],
      [withTask(s.text, s.a.direct, (d) => (d.estimateMinutes = 0)), "INVALID_PAYLOAD"],
    ];
    for (const [file, expected] of cases) expect(await codeOf(importInto(s.b, file, product)), expected).toBe(expected);
    expect(await snapshot(s.b.db)).toEqual(s.before);
  });

  it("a resolution that would activate a version breaking the rule is refused (defense in depth)", async () => {
    const s = await fileAndTarget();
    await importInto(s.b, s.text, product);
    const data = { title: "x", notes: "", projectId: s.a.project, workstreamId: s.otherWs, nextAction: "", estimateMinutes: null, archivedAt: null };
    const conflictId = crypto.randomUUID();
    // Stored directly (bypassing import validation) to exercise the resolution-time check.
    await s.b.db.pendingConflicts.put({
      conflictId,
      kind: "edit",
      type: TASK_DEFINITIONS,
      id: s.a.direct,
      local: null,
      incoming: { deleted: false, envelope: makeEnvelope(s.a.direct, data, { [crypto.randomUUID()]: 5 }, nowIso()) },
      source: { backupId: crypto.randomUUID(), deviceId: crypto.randomUUID(), deviceName: "X", exportedAt: nowIso() },
      detectedAt: nowIso(),
    });
    const before = await snapshot(s.b.db);
    const view = (await loadConflictViews(s.b.db, registry)).find((v) => v.conflict.conflictId === conflictId)!;
    const error = await resolveConflict(s.b.db, registry, conflictId, "useBackup", view.token).catch((e) => e);
    expect(error).toBeInstanceOf(ResolutionError);
    expect(error.code).toBe("INVALID_RELATIONSHIP");
    expect(await snapshot(s.b.db)).toEqual(before);
  });
});

describe("11. versioning: dataSchemaVersion 1 files still import; types are checked per version", () => {
  const v1Sample = new URL("./samples/pps-backup-format-v1.json", import.meta.url);
  const v2Sample = new URL("./samples/pps-backup-format-v1-data-v2.json", import.meta.url);

  it("the committed dataSchemaVersion-1 sample (Stage 1B) imports into the Stage 2 app", async () => {
    const text = readFileSync(v1Sample, "utf8");
    expect(JSON.parse(text).app.dataSchemaVersion).toBe(1);
    const b = await device("B");
    const { preview } = await importInto(b, text, { ...product, applyUpdates: true });
    expect(preview.counts.newerInBackup).toBe(1);
  });

  it("a dataSchemaVersion-1 file containing Stage 2 types is refused as unknown data", async () => {
    const a = await organizedDevice();
    const asV1 = mutate(await exportText(a.d), (doc) => (doc.app.dataSchemaVersion = 1));
    const b = await device("B");
    expect(await codeOf(importInto(b, asV1, product))).toBe("UNKNOWN_RECORD_TYPE");
    const tombstoneOnly = mutate(readFileSync(v1Sample, "utf8"), (doc) => {
      doc.payload.tombstones.push({ type: PROJECTS, id: crypto.randomUUID(), deletedAt: nowIso(), version: { [crypto.randomUUID()]: 1 } });
    });
    expect(await codeOf(importInto(b, tombstoneOnly, product))).toBe("UNKNOWN_RECORD_TYPE");
  });

  it("a newer dataSchemaVersion is refused before anything else", async () => {
    const a = await organizedDevice();
    const newer = mutate(await exportText(a.d), (doc) => (doc.app.dataSchemaVersion = 7));
    await expect(openBackupFile(blobOf(newer), registry)).rejects.toMatchObject({ code: "NEWER_VERSION" });
  });

  it("writes the dataSchemaVersion-2 sample when PPS_WRITE_SAMPLE=1 (maintainers only)", async () => {
    // The app writes its current version; this sample stays the committed version-2 file.
    if (process.env.PPS_WRITE_SAMPLE !== "1" || (DATA_SCHEMA_VERSION as number) !== 2) return;
    const d = await device("Sample device");
    const project = await createProject(d.db, { name: "Sample project", description: "Fabricated sample data" });
    const workstream = await createWorkstream(d.db, { projectId: project, name: "Sample workstream" });
    await createTask(d.db, { title: "Sample task in a workstream", projectId: project, workstreamId: workstream, nextAction: "Start", estimateMinutes: 25 });
    await createTask(d.db, { title: "Sample task directly in the project", projectId: project });
    await captureToInbox(d.db, "Sample inbox item");
    const file = await exportFrom(d, { now: new Date("2026-10-22T08:00:00.000Z"), backupId: "22222222-2222-4222-8222-222222222222" }, registry);
    writeFileSync(v2Sample, `${file.text}\n`);
  });

  it("the committed dataSchemaVersion-2 sample imports (fabricated data only)", async () => {
    const text = readFileSync(v2Sample, "utf8");
    expect(JSON.parse(text).app.dataSchemaVersion).toBe(2);
    const b = await device("B");
    await importInto(b, text, product);
    const org = await loadOrganization(b.db);
    expect(org.projects.map((p) => p.data.name)).toEqual(["Sample project"]);
    const outline = projectOutline(org, org.projects[0]!.id)!;
    expect(outline.directTasks.map((t) => t.data.title)).toEqual(["Sample task directly in the project"]);
    expect(outline.workstreams[0]!.tasks.map((t) => t.data.title)).toEqual(["Sample task in a workstream"]);
    expect(org.tasks.filter((t) => t.data.projectId === null).map((t) => t.data.title)).toEqual(["Sample inbox item"]);
  });
});
