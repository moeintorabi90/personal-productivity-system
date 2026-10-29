/**
 * Stage 4 data in backups (docs/TESTING.md "Stage 4 acceptance tests" 8–10; BACKUP_FORMAT "Data
 * schema version 4"): goals and milestones round-trip and merge; Stage 3 data is upgraded without
 * any change; every version in a file is validated against its own version.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_SCHEMA_VERSION } from "./limits.ts";
import {
  createGoal,
  createMilestone,
  deleteMilestone,
  loadGoals,
  milestonesOutside,
  setGoalArchived,
  setGoalStatus,
  setMilestoneCompleted,
  updateGoal,
} from "../local/goals.ts";
import { createProject } from "../local/organization.ts";
import { deleteRecord, putRecord } from "../local/records.ts";
import { updateSharedPreferences } from "../local/settings.ts";
import { loadConflictViews, resolveConflict } from "./conflicts.ts";
import { contentHashOf, makeEnvelope, nowIso } from "./envelope.ts";
import { openBackupFile } from "./read.ts";
import { GOALS, MILESTONES, PRODUCT_REGISTRY } from "./registry.ts";
import { createTestDevice, type TestDevice } from "./test-fixtures.ts";
import { blobOf, decide, exportFrom, importInto, mutate, snapshot } from "./test-helpers.ts";

const registry = PRODUCT_REGISTRY;
const product = { registry };

/** A pre-Stage-5 output goal with its own unit label (T-050), as Stage 4 wrote it; Stage 5 creates goals with a definition instead (T-161). */
async function legacyOutputGoal(
  db: TestDevice["db"],
  input: { name: string; projectId: string | null; startDate: string; deadline: string | null; target: number; unit: string },
): Promise<string> {
  const id = crypto.randomUUID();
  await putRecord(db, registry, GOALS, id, { ...input, description: "", kind: "output", status: "active", archivedAt: null });
  return id;
}
const devices: TestDevice[] = [];
async function device(label: string, zone: string | null = "Asia/Tehran") {
  const d = await createTestDevice(label);
  devices.push(d);
  if (zone) await updateSharedPreferences(d.db, { timeZone: zone });
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
const recordsOf = async (d: TestDevice) =>
  (await d.db.records.toArray())
    .map((r) => ({ type: r.type, id: r.id, contentHash: r.contentHash, version: r.version, data: r.data }))
    .sort((a, b) => `${a.type}/${a.id}`.localeCompare(`${b.type}/${b.id}`));

/** A device with a project-linked output goal (two milestones, one complete), a paused time goal, and an archived task-count goal. */
async function goalDevice(label = "A") {
  const d = await device(label);
  const project = await createProject(d.db, { name: "Thesis" });
  const book = await legacyOutputGoal(d.db, { name: "Write", projectId: project, startDate: "2026-11-01", deadline: "2026-12-31", target: 300, unit: "pages" });
  const draft = await createMilestone(d.db, { goalId: book, name: "Draft", deadline: "2026-11-30" });
  const review = await createMilestone(d.db, { goalId: book, name: "Review" });
  await setMilestoneCompleted(d.db, draft, true);
  const study = await createGoal(d.db, { name: "Study", startDate: "2026-10-01", kind: "time", target: 2430 });
  await setGoalStatus(d.db, study, "paused");
  const tasks = await createGoal(d.db, { name: "Tasks", startDate: "2026-10-01", kind: "taskCount", target: 20 });
  await setGoalArchived(d.db, tasks, true);
  return { d, project, book, draft, review, study, tasks };
}

describe("8. round-trip and merge of goals and milestones", () => {
  it("an empty device receives everything with identical IDs, hashes, and versions (written as dataSchemaVersion 6 since Stage 5)", async () => {
    const a = await goalDevice();
    const text = await exportText(a.d);
    const doc = JSON.parse(text);
    expect(doc.app.dataSchemaVersion).toBe(6);
    expect(doc.payload.records[GOALS]).toHaveLength(3);
    expect(doc.payload.records[MILESTONES]).toHaveLength(2);
    const b = await device("B", null);
    const { preview } = await importInto(b, text, { ...product, applyUpdates: true });
    expect(preview.counts.new).toBe(6); // project, 3 goals, 2 milestones
    expect(await recordsOf(b)).toEqual(await recordsOf(a.d));
    const { goals } = await loadGoals(b.db);
    expect(goals.find((g) => g.id === a.tasks)!.data).toMatchObject({ status: "active" });
    expect(goals.find((g) => g.id === a.tasks)!.data.archivedAt).not.toBeNull();
  });

  it("re-import is idempotent; a goal edited on both devices is a conflict with keep/use only", async () => {
    const a = await goalDevice();
    const b = await device("B", null);
    const first = await exportText(a.d);
    await importInto(b, first, { ...product, applyUpdates: true });
    const before = await snapshot(b.db);
    expect((await importInto(b, first, product)).preview.counts.new).toBe(0);
    expect(await snapshot(b.db)).toEqual(before);

    await setGoalStatus(a.d.db, a.book, "completed");
    await updateGoal(b.db, a.book, { target: 320 });
    await importInto(b, await exportText(a.d), product);
    const [view] = await loadConflictViews(b.db, registry);
    expect(view!.conflict).toMatchObject({ type: GOALS, id: a.book, kind: "edit" });
    expect(view!.options).toEqual(["keepDevice", "useBackup"]);
    await decide(b.db, view!.conflict.conflictId, "useBackup", registry);
    expect((await b.db.records.get([GOALS, a.book]))!.data).toMatchObject({ status: "completed", target: 300 });
  });

  it("a milestone completed on both devices differently is a keep/use conflict", async () => {
    const a = await goalDevice();
    const b = await device("B", null);
    await importInto(b, await exportText(a.d), { ...product, applyUpdates: true });
    await setMilestoneCompleted(a.d.db, a.review, true);
    await setMilestoneCompleted(b.db, a.draft, false);
    await setMilestoneCompleted(b.db, a.review, true); // different completedAt instant on B
    await importInto(b, await exportText(a.d), product);
    const views = await loadConflictViews(b.db, registry);
    expect(views.map((v) => v.conflict.type)).toEqual([MILESTONES]);
    expect(views[0]!.options).toEqual(["keepDevice", "useBackup"]);
  });

  it("a deleted milestone is not restored by an older backup; a deletion in a backup is a decision", async () => {
    const a = await goalDevice();
    const b = await device("B", null);
    const old = await exportText(a.d);
    await importInto(b, old, { ...product, applyUpdates: true });
    await deleteMilestone(b.db, a.review);
    const { preview } = await importInto(b, old, { ...product, applyUpdates: true });
    expect(preview.counts.new).toBe(0);
    expect(await b.db.records.get([MILESTONES, a.review])).toBeUndefined();

    await deleteMilestone(a.d.db, a.draft);
    await importInto(b, await exportText(a.d), product);
    const views = await loadConflictViews(b.db, registry);
    expect(views.map((v) => [v.conflict.type, v.conflict.kind])).toEqual([[MILESTONES, "deletedInBackup"]]);
    expect(await b.db.records.get([MILESTONES, a.draft])).toBeTruthy(); // never deleted silently
  });

  it("'delete here' for a goal is refused while live milestones link to it", async () => {
    const a = await goalDevice();
    const b = await device("B", null);
    await importInto(b, await exportText(a.d), { ...product, applyUpdates: true });
    await deleteRecord(a.d.db, MILESTONES, a.draft); // deletions arrive only through backup data
    await deleteRecord(a.d.db, MILESTONES, a.review);
    await deleteRecord(a.d.db, GOALS, a.book);
    await importInto(b, await exportText(a.d), product);
    const goalView = (await loadConflictViews(b.db, registry)).find((v) => v.conflict.type === GOALS)!;
    const before = await snapshot(b.db);
    await expect(resolveConflict(b.db, registry, goalView.conflict.conflictId, "deleteHere", goalView.token)).rejects.toMatchObject({ code: "HAS_LINKED_ITEMS" });
    expect(await snapshot(b.db)).toEqual(before);
  });

  it("a merged milestone outside its goal's dates is imported and can be flagged (T-078, T-084)", async () => {
    const a = await goalDevice();
    const b = await device("B", null);
    await importInto(b, await exportText(a.d), { ...product, applyUpdates: true });
    await updateGoal(a.d.db, a.book, { deadline: "2026-12-31" }); // unchanged on A
    await createMilestone(b.db, { goalId: a.book, name: "Late", deadline: "2026-12-30" }); // valid on B
    await updateGoal(a.d.db, a.book, { deadline: "2026-12-15" }); // valid on A
    await importInto(b, await exportText(a.d), { ...product, applyUpdates: true });
    const { goals, milestones } = await loadGoals(b.db);
    const goal = goals.find((g) => g.id === a.book)!;
    expect(goal.data.deadline).toBe("2026-12-15");
    expect(milestonesOutside(milestones, a.book, goal.data).map((m) => m.data.name)).toEqual(["Late"]);
  });
});

describe("9. upgrade from Stage 3 without loss", () => {
  const v3Sample = new URL("./samples/pps-backup-format-v1-data-v3.json", import.meta.url);

  it("Stage 3 records are byte-identical under the current app; re-importing a Stage 3 backup is 'already here'", async () => {
    const sample = readFileSync(v3Sample, "utf8");
    const d = await device("Upgraded", null);
    await importInto(d, sample, { ...product, applyUpdates: true });
    const before = await recordsOf(d);
    for (const r of before) expect(contentHashOf(r.data)).toBe(r.contentHash);
    await d.restart();
    expect(await recordsOf(d)).toEqual(before);
    const exported = await exportText(d);
    expect(JSON.parse(exported).app.dataSchemaVersion).toBe(6);
    const target = await device("Holds Stage 3 backup", null);
    await importInto(target, sample, { ...product, applyUpdates: true });
    const { preview } = await importInto(target, exported, product);
    expect(preview.counts.conflict).toBe(0);
    expect(preview.counts.new).toBe(0);
    expect(preview.counts.alreadyHere).toBe(before.length);
  });

  it("the committed version-1, -2, and -3 samples import", async () => {
    const b = await device("B", null);
    for (const name of ["pps-backup-format-v1.json", "pps-backup-format-v1-data-v2.json", "pps-backup-format-v1-data-v3.json"]) {
      expect(await codeOf(importInto(b, readFileSync(new URL(`./samples/${name}`, import.meta.url), "utf8"), { ...product, applyUpdates: true }))).toBe("OK");
    }
  });
});

describe("10. versioning and validation", () => {
  const v4Sample = new URL("./samples/pps-backup-format-v1-data-v4.json", import.meta.url);

  async function fileWithGoals() {
    const a = await goalDevice();
    const text = await exportText(a.d);
    const b = await device("B", null);
    return { a, text, b, before: await snapshot(b.db) };
  }
  const withRecord = (text: string, type: string, id: string, change: (data: Record<string, any>) => void) =>
    mutate(text, (doc) => {
      const env = doc.payload.records[type].find((e: { id: string }) => e.id === id);
      change(env.data);
      env.contentHash = contentHashOf(env.data);
    });

  it("a version-3 file with goals or milestones is refused as unknown data; version 6 is refused as newer", async () => {
    const s = await fileWithGoals();
    const asV3 = mutate(s.text, (doc) => {
      doc.app.dataSchemaVersion = 3;
      delete doc.payload.records[MILESTONES];
    });
    const milestonesOnly = mutate(s.text, (doc) => {
      doc.app.dataSchemaVersion = 3;
      delete doc.payload.records[GOALS];
    });
    const plainV3 = mutate(s.text, (doc) => {
      doc.app.dataSchemaVersion = 3;
      delete doc.payload.records[GOALS];
      delete doc.payload.records[MILESTONES];
    });
    expect(await codeOf(importInto(s.b, asV3, product))).toBe("UNKNOWN_RECORD_TYPE");
    expect(await codeOf(importInto(s.b, milestonesOnly, product))).toBe("UNKNOWN_RECORD_TYPE");
    expect(await snapshot(s.b.db)).toEqual(s.before);
    expect(await codeOf(importInto(s.b, plainV3, product))).toBe("OK");
    const newer = mutate(s.text, (doc) => (doc.app.dataSchemaVersion = 7));
    await expect(openBackupFile(blobOf(newer), registry)).rejects.toMatchObject({ code: "NEWER_VERSION" });
  });

  it("invalid goals and milestones and unknown links are refused with no change", async () => {
    const s = await fileWithGoals();
    const cases: [string, string][] = [
      [withRecord(s.text, GOALS, s.a.book, (d) => (d.deadline = "2026-10-01")), "INVALID_PAYLOAD"],
      [withRecord(s.text, GOALS, s.a.book, (d) => delete d.unit), "INVALID_PAYLOAD"],
      [withRecord(s.text, GOALS, s.a.study, (d) => (d.unit = "hours")), "INVALID_PAYLOAD"],
      [withRecord(s.text, GOALS, s.a.book, (d) => (d.kind = "habit")), "INVALID_PAYLOAD"],
      [withRecord(s.text, GOALS, s.a.book, (d) => (d.status = "archived")), "INVALID_PAYLOAD"],
      [withRecord(s.text, GOALS, s.a.book, (d) => (d.target = 2.5)), "INVALID_PAYLOAD"],
      [withRecord(s.text, GOALS, s.a.study, (d) => (d.target = 1_000_001)), "INVALID_PAYLOAD"],
      [withRecord(s.text, GOALS, s.a.book, (d) => (d.progress = 10)), "INVALID_PAYLOAD"],
      [withRecord(s.text, GOALS, s.a.book, (d) => (d.startDate = "2026-02-30")), "INVALID_PAYLOAD"],
      [withRecord(s.text, MILESTONES, s.a.draft, (d) => (d.name = " ")), "INVALID_PAYLOAD"],
      [withRecord(s.text, MILESTONES, s.a.draft, (d) => (d.completedAt = "yesterday")), "INVALID_PAYLOAD"],
      [withRecord(s.text, GOALS, s.a.book, (d) => (d.projectId = crypto.randomUUID())), "UNRESOLVED_REFERENCE"],
      [withRecord(s.text, MILESTONES, s.a.draft, (d) => (d.goalId = crypto.randomUUID())), "UNRESOLVED_REFERENCE"],
    ];
    for (const [file, expected] of cases) expect(await codeOf(importInto(s.b, file, product)), expected).toBe(expected);
    expect(await snapshot(s.b.db)).toEqual(s.before);
  });

  it("the same checks apply to carried conflict and archived versions; a milestone's goal cannot differ between versions", async () => {
    const s = await fileWithGoals();
    const original = (await s.a.d.db.records.get([GOALS, s.a.book]))!.data;
    const bad = { ...original, deadline: "2026-10-01" };
    const entry = { deleted: false, envelope: makeEnvelope(s.a.book, bad, { [crypto.randomUUID()]: 9 }, nowIso()) };
    const inArchive = mutate(s.text, (doc) => {
      doc.payload.replacedVersions.push({ replacedId: crypto.randomUUID(), type: GOALS, id: s.a.book, entry, replacedAt: nowIso(), reason: "x" });
    });
    const inConflict = mutate(s.text, (doc) => {
      doc.payload.pendingConflicts.push({
        conflictId: crypto.randomUUID(),
        kind: "edit",
        type: GOALS,
        id: s.a.book,
        local: null,
        incoming: entry,
        source: { backupId: crypto.randomUUID(), deviceId: crypto.randomUUID(), deviceName: "X", exportedAt: nowIso() },
        detectedAt: nowIso(),
      });
    });
    const milestone = (await s.a.d.db.records.get([MILESTONES, s.a.draft]))!.data;
    const moved = { deleted: false, envelope: makeEnvelope(s.a.draft, { ...milestone, goalId: s.a.study }, { [crypto.randomUUID()]: 1 }, nowIso()) };
    const movedInArchive = mutate(s.text, (doc) => {
      doc.payload.replacedVersions.push({ replacedId: crypto.randomUUID(), type: MILESTONES, id: s.a.draft, entry: moved, replacedAt: nowIso(), reason: "x" });
    });
    const kindChanged = { deleted: false, envelope: makeEnvelope(s.a.study, { ...(await s.a.d.db.records.get([GOALS, s.a.study]))!.data, kind: "taskCount" }, { [crypto.randomUUID()]: 1 }, nowIso()) };
    const kindInArchive = mutate(s.text, (doc) => {
      doc.payload.replacedVersions.push({ replacedId: crypto.randomUUID(), type: GOALS, id: s.a.study, entry: kindChanged, replacedAt: nowIso(), reason: "x" });
    });
    expect(await codeOf(importInto(s.b, inArchive, product))).toBe("INVALID_PAYLOAD");
    expect(await codeOf(importInto(s.b, inConflict, product))).toBe("INVALID_PAYLOAD");
    expect(await codeOf(importInto(s.b, movedInArchive, product))).toBe("INVALID_RELATIONSHIP");
    expect(await codeOf(importInto(s.b, kindInArchive, product))).toBe("INVALID_RELATIONSHIP");
    expect(await snapshot(s.b.db)).toEqual(s.before);
  });

  it("writes the dataSchemaVersion-4 sample when PPS_WRITE_SAMPLE=1 (maintainers only)", async () => {
    // The app writes its current version; this sample stays the committed version-4 file.
    if (process.env.PPS_WRITE_SAMPLE !== "1" || (DATA_SCHEMA_VERSION as number) !== 4) return;
    const d = await device("Sample device");
    const project = await createProject(d.db, { name: "Sample project" });
    const output = await legacyOutputGoal(d.db, { name: "Sample output goal", projectId: project, startDate: "2026-11-01", deadline: "2026-12-31", target: 120, unit: "pages" });
    const done = await createMilestone(d.db, { goalId: output, name: "Sample completed milestone", deadline: "2026-11-30" });
    await setMilestoneCompleted(d.db, done, true);
    await createMilestone(d.db, { goalId: output, name: "Sample open milestone", description: "No deadline" });
    const time = await createGoal(d.db, { name: "Sample time goal", startDate: "2026-11-01", kind: "time", target: 90 });
    await setGoalStatus(d.db, time, "paused");
    const count = await createGoal(d.db, { name: "Sample task-count goal", startDate: "2026-10-01", deadline: "2026-10-31", kind: "taskCount", target: 10 });
    await setGoalStatus(d.db, count, "completed");
    const archived = await createGoal(d.db, { name: "Sample archived goal", startDate: "2026-09-01", kind: "taskCount", target: 5 });
    await setGoalArchived(d.db, archived, true);
    const file = await exportFrom(d, { now: new Date("2026-10-25T08:00:00.000Z"), backupId: "44444444-4444-4444-8444-444444444444" }, registry);
    writeFileSync(v4Sample, `${file.text}\n`);
  });

  it("the committed dataSchemaVersion-4 sample imports (fabricated data only)", async () => {
    const text = readFileSync(v4Sample, "utf8");
    expect(JSON.parse(text).app.dataSchemaVersion).toBe(4);
    const b = await device("B", null);
    await importInto(b, text, { ...product, applyUpdates: true });
    const { goals, milestones } = await loadGoals(b.db);
    expect(goals.map((g) => g.data.kind).sort()).toEqual(["output", "taskCount", "taskCount", "time"]);
    expect(goals.map((g) => g.data.status).sort()).toEqual(["active", "active", "completed", "paused"]);
    expect(goals.filter((g) => g.data.archivedAt !== null)).toHaveLength(1);
    expect(milestones.map((m) => m.data.completedAt !== null).sort()).toEqual([false, true]);
  });
});
