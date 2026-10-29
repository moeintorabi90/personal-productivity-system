/**
 * Project color in backups (docs/TESTING.md "Stage 3 follow-up: project colors" 8; BACKUP_FORMAT
 * "Project color"; DECISIONS T-070, T-088): data schema version 5. The color round-trips and merges
 * as an ordinary project field; existing projects are not rewritten; every version in a file is
 * validated against the fields of its own version.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_SCHEMA_VERSION } from "./limits.ts";
import { createProject, createTask, loadOrganization, updateProject } from "../local/organization.ts";
import { createBlock } from "../local/planning.ts";
import { updateSharedPreferences } from "../local/settings.ts";
import { loadConflictViews } from "./conflicts.ts";
import { contentHashOf, makeEnvelope, nowIso } from "./envelope.ts";
import { openBackupFile } from "./read.ts";
import { CALENDAR_BLOCKS, PRODUCT_REGISTRY, PROJECTS } from "./registry.ts";
import { createTestDevice, type TestDevice } from "./test-fixtures.ts";
import { blobOf, decide, exportFrom, importInto, mutate, snapshot } from "./test-helpers.ts";

const registry = PRODUCT_REGISTRY;
const product = { registry };
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

/** A project with a chosen color, one without, and a block of a task in the colored project. */
async function coloredDevice(label = "A") {
  const d = await device(label);
  const colored = await createProject(d.db, { name: "Thesis", color: "teal" });
  const plain = await createProject(d.db, { name: "Home" });
  const task = await createTask(d.db, { title: "Write", projectId: colored });
  const block = await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "09:00", durationMinutes: 60 });
  return { d, colored, plain, task, block };
}

describe("8. round-trip and merge of the project color", () => {
  it("an empty device receives the color unchanged (written as dataSchemaVersion 6 since Stage 5); an unchosen color stays absent", async () => {
    const a = await coloredDevice();
    const text = await exportText(a.d);
    const doc = JSON.parse(text);
    expect(doc.app.dataSchemaVersion).toBe(6);
    const projects = doc.payload.records[PROJECTS] as { id: string; data: Record<string, unknown> }[];
    expect(projects.find((p) => p.id === a.colored)!.data.color).toBe("teal");
    expect(projects.find((p) => p.id === a.plain)!.data).not.toHaveProperty("color");
    const b = await device("B", null);
    await importInto(b, text, { ...product, applyUpdates: true });
    expect(await recordsOf(b)).toEqual(await recordsOf(a.d));
  });

  it("a color changed only elsewhere is 'newer in backup' and applied after confirmation; importing it changes no block", async () => {
    const a = await coloredDevice();
    const b = await device("B", null);
    await importInto(b, await exportText(a.d), { ...product, applyUpdates: true });
    const blocksBefore = await b.db.records.where("type").equals(CALENDAR_BLOCKS).toArray();
    await updateProject(a.d.db, a.colored, { color: "purple" });
    const text = await exportText(a.d);
    expect((await importInto(b, text, product)).preview.counts.newerInBackup).toBe(1);
    expect((await b.db.records.get([PROJECTS, a.colored]))!.data.color).toBe("teal");
    await importInto(b, text, { ...product, applyUpdates: true });
    expect((await b.db.records.get([PROJECTS, a.colored]))!.data.color).toBe("purple");
    expect(await b.db.records.where("type").equals(CALENDAR_BLOCKS).toArray()).toEqual(blocksBefore);
  });

  it("a color edited on both devices is a project conflict with keep/use only", async () => {
    const a = await coloredDevice();
    const b = await device("B", null);
    await importInto(b, await exportText(a.d), { ...product, applyUpdates: true });
    await updateProject(a.d.db, a.colored, { color: "red" });
    await updateProject(b.db, a.colored, { color: null }); // B returns to the default
    await importInto(b, await exportText(a.d), product);
    const [view] = await loadConflictViews(b.db, registry);
    expect(view!.conflict).toMatchObject({ type: PROJECTS, id: a.colored, kind: "edit" });
    expect(view!.options).toEqual(["keepDevice", "useBackup"]);
    await decide(b.db, view!.conflict.conflictId, "useBackup", registry);
    expect((await b.db.records.get([PROJECTS, a.colored]))!.data.color).toBe("red");
  });
});

describe("8. upgrade and older files", () => {
  const sample = (name: string) => readFileSync(new URL(`./samples/${name}`, import.meta.url), "utf8");
  const v5Sample = new URL("./samples/pps-backup-format-v1-data-v5.json", import.meta.url);

  it("existing projects keep their content hashes; re-importing a version-4 backup is 'already here'", async () => {
    const v4 = sample("pps-backup-format-v1-data-v4.json");
    const d = await device("Upgraded", null);
    await importInto(d, v4, { ...product, applyUpdates: true });
    const before = await recordsOf(d);
    for (const r of before) {
      expect("color" in r.data).toBe(false);
      expect(contentHashOf(r.data)).toBe(r.contentHash);
    }
    await d.restart();
    expect(await recordsOf(d)).toEqual(before);
    const exported = await exportText(d);
    const target = await device("Holds the version-4 backup", null);
    await importInto(target, v4, { ...product, applyUpdates: true });
    const { preview } = await importInto(target, exported, product);
    expect(preview.counts.conflict).toBe(0);
    expect(preview.counts.new).toBe(0);
    expect(preview.counts.alreadyHere).toBe(before.length);
  });

  it("the committed version-1 to version-4 samples import unchanged", async () => {
    const b = await device("B", null);
    for (const name of ["pps-backup-format-v1.json", "pps-backup-format-v1-data-v2.json", "pps-backup-format-v1-data-v3.json", "pps-backup-format-v1-data-v4.json"]) {
      expect(await codeOf(importInto(b, sample(name), { ...product, applyUpdates: true })), name).toBe("OK");
    }
  });

  it("a version-4 file with a color, a null color, or an unknown palette ID is refused with no change; version 6 is refused as newer", async () => {
    const a = await coloredDevice();
    const text = await exportText(a.d);
    const b = await device("B", null);
    const before = await snapshot(b.db);
    const withColor = (value: unknown) =>
      mutate(text, (doc) => {
        const env = doc.payload.records[PROJECTS].find((e: { id: string }) => e.id === a.colored);
        env.data.color = value;
        env.contentHash = contentHashOf(env.data);
      });
    const asV4 = mutate(text, (doc) => (doc.app.dataSchemaVersion = 4));
    expect(await codeOf(importInto(b, asV4, product))).toBe("INVALID_PAYLOAD");
    expect(await codeOf(importInto(b, withColor(null), product))).toBe("INVALID_PAYLOAD");
    expect(await codeOf(importInto(b, withColor("magenta"), product))).toBe("INVALID_PAYLOAD");
    expect(await codeOf(importInto(b, withColor("Teal"), product))).toBe("INVALID_PAYLOAD");
    expect(await snapshot(b.db)).toEqual(before);
    const newer = mutate(text, (doc) => (doc.app.dataSchemaVersion = 7));
    await expect(openBackupFile(blobOf(newer), registry)).rejects.toMatchObject({ code: "NEWER_VERSION" });
    // Without the color, the same content is a valid version-4 file.
    const plainV4 = mutate(text, (doc) => {
      doc.app.dataSchemaVersion = 4;
      for (const env of doc.payload.records[PROJECTS]) {
        delete env.data.color;
        env.contentHash = contentHashOf(env.data);
      }
    });
    expect(await codeOf(importInto(b, plainV4, product))).toBe("OK");
  });

  it("the same checks apply to carried conflict and archived versions", async () => {
    const a = await coloredDevice();
    const text = await exportText(a.d);
    const b = await device("B", null);
    const before = await snapshot(b.db);
    const original = (await a.d.db.records.get([PROJECTS, a.colored]))!.data;
    const bad = { deleted: false, envelope: makeEnvelope(a.colored, { ...original, color: "magenta" }, { [crypto.randomUUID()]: 9 }, nowIso()) };
    const inArchive = mutate(text, (doc) => {
      doc.payload.replacedVersions.push({ replacedId: crypto.randomUUID(), type: PROJECTS, id: a.colored, entry: bad, replacedAt: nowIso(), reason: "x" });
    });
    const inConflict = mutate(text, (doc) => {
      doc.payload.pendingConflicts.push({
        conflictId: crypto.randomUUID(),
        kind: "edit",
        type: PROJECTS,
        id: a.colored,
        local: null,
        incoming: bad,
        source: { backupId: crypto.randomUUID(), deviceId: crypto.randomUUID(), deviceName: "X", exportedAt: nowIso() },
        detectedAt: nowIso(),
      });
    });
    expect(await codeOf(importInto(b, inArchive, product))).toBe("INVALID_PAYLOAD");
    expect(await codeOf(importInto(b, inConflict, product))).toBe("INVALID_PAYLOAD");
    expect(await snapshot(b.db)).toEqual(before);
  });

  it("writes the dataSchemaVersion-5 sample when PPS_WRITE_SAMPLE=1 (maintainers only)", async () => {
    // The app writes its current version; this sample stays the committed version-5 file.
    if (process.env.PPS_WRITE_SAMPLE !== "1" || (DATA_SCHEMA_VERSION as number) !== 5) return;
    const d = await device("Sample device");
    const colored = await createProject(d.db, { name: "Sample project with a color", color: "green" });
    await createProject(d.db, { name: "Sample project with the default color" });
    const task = await createTask(d.db, { title: "Sample task", projectId: colored });
    await createBlock(d.db, { taskId: task, date: "2026-11-02", startTime: "09:00", durationMinutes: 30 });
    const file = await exportFrom(d, { now: new Date("2026-10-25T09:00:00.000Z"), backupId: "55555555-5555-4555-8555-555555555555" }, registry);
    writeFileSync(v5Sample, `${file.text}\n`);
  });

  it("the committed dataSchemaVersion-5 sample imports (fabricated data only)", async () => {
    const text = readFileSync(v5Sample, "utf8");
    expect(JSON.parse(text).app.dataSchemaVersion).toBe(5);
    const b = await device("B", null);
    await importInto(b, text, { ...product, applyUpdates: true });
    const { projects } = await loadOrganization(b.db);
    expect(projects.map((p) => p.data.color ?? null).sort()).toEqual(["green", null]);
  });
});
