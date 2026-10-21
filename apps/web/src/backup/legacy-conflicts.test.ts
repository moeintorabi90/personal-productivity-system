/**
 * Compatibility (Codex review): `detectedOn` was added to pending conflicts after the first
 * Stage 1B build (53d38c2), within format version 1 and IndexedDB schema version 2. Conflicts
 * stored, and files written, by that build have no `detectedOn`. They must still import, export,
 * and resolve without losing a version, and the unknown device must never be filled in or guessed.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { LocalDb } from "../local/db.ts";
import { putRecord } from "../local/records.ts";
import { loadConflictViews } from "./conflicts.ts";
import { createTestDevice, TEST_REGISTRY, type TestDevice } from "./test-fixtures.ts";
import { decide, exportFrom, importInto, mutate } from "./test-helpers.ts";

const devices: TestDevice[] = [];
async function device(label: string) {
  const d = await createTestDevice(label);
  devices.push(d);
  return d;
}
afterEach(() => {
  for (const d of devices.splice(0)) d.db.close();
});

const note = (text: string) => ({ text });
const textOf = (entry: { deleted: boolean; envelope?: { data: Record<string, unknown> } } | null) =>
  entry && !entry.deleted ? String(entry.envelope!.data.text) : null;
const archivedTexts = async (d: TestDevice) =>
  (await d.db.replacedVersions.toArray()).map((r) => (r.entry.deleted ? "(deleted)" : String(r.entry.envelope.data.text))).sort();

/** Rewrites stored conflicts exactly as the first Stage 1B build stored them (no `detectedOn`). */
async function toLegacyRows(db: LocalDb) {
  for (const row of await db.pendingConflicts.toArray()) {
    const { detectedOn: _notStoredThen, ...legacy } = row;
    await db.pendingConflicts.put(legacy);
  }
}

/** A format-version-1 file as the first Stage 1B build wrote it (no `detectedOn`). */
const withoutDetectedOn = (text: string) =>
  mutate(text, (doc) => {
    for (const c of doc.payload.pendingConflicts) delete c.detectedOn;
  });

/** A, B, C share "base"; A edits A1, B edits B1 and finds the conflict (B1 vs A1). */
async function conflictOnB() {
  const a = await device("A");
  const b = await device("B");
  const c = await device("C");
  const item = crypto.randomUUID();
  await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("base"));
  const base = (await exportFrom(a)).text;
  await importInto(b, base);
  await importInto(c, base);
  await putRecord(a.db, TEST_REGISTRY, "fixtureNote", item, note("A1"));
  await putRecord(b.db, TEST_REGISTRY, "fixtureNote", item, note("B1"));
  await importInto(b, (await exportFrom(a)).text);
  return { a, b, c, item };
}

describe("version-1 conflict entries without detectedOn", () => {
  it("import: accepted with both versions; the device stays unknown and is not attributed to anyone", async () => {
    const { b, c, item } = await conflictOnB();
    await putRecord(c.db, TEST_REGISTRY, "fixtureNote", item, note("C1"));
    const legacyFile = withoutDetectedOn((await exportFrom(b)).text);
    expect(legacyFile).not.toContain("detectedOn");

    const { opened } = await importInto(c, legacyFile);
    expect(opened.payload.pendingConflicts[0]).not.toHaveProperty("detectedOn");

    const views = await loadConflictViews(c.db, TEST_REGISTRY);
    expect(views).toHaveLength(2);
    const carried = views.find((v) => textOf(v.conflict.local) === "B1")!;
    const own = views.find((v) => textOf(v.conflict.local) === "C1")!;
    // Carried legacy conflict: both versions kept; no device recorded (not C, not the file's B).
    expect(textOf(carried.conflict.incoming)).toBe("A1");
    expect(carried.conflict).not.toHaveProperty("detectedOn");
    expect(carried.snapshotDiffers).toBe(true);
    expect(textOf(carried.current)).toBe("C1");
    // The conflict C found itself still records C.
    expect(own.conflict.detectedOn).toEqual({ deviceId: c.deviceId, deviceName: "C" });

    await decide(c.db, carried.conflict.conflictId, "keepDevice");
    expect((await c.db.records.get(["fixtureNote", item]))?.data).toEqual(note("C1"));
    expect(await archivedTexts(c)).toEqual(["A1", "B1"]);
  });

  it("a stored legacy row exports and re-imports (twice) without losing either version", async () => {
    const { b, item } = await conflictOnB();
    await toLegacyRows(b.db);
    const [legacy] = await b.db.pendingConflicts.toArray();
    expect(legacy).not.toHaveProperty("detectedOn");

    // Export verifies the file by re-opening it; this used to fail on the missing field.
    const exported = await exportFrom(b);
    const fileConflict = JSON.parse(exported.text).payload.pendingConflicts[0];
    expect(fileConflict).not.toHaveProperty("detectedOn"); // not invented on export
    expect(fileConflict.conflictId).toBe(legacy!.conflictId);

    const d = await device("D");
    await importInto(d, exported.text);
    const e = await device("E");
    await importInto(e, (await exportFrom(d)).text);
    for (const target of [d, e]) {
      const [row] = await target.db.pendingConflicts.toArray();
      expect(row).toMatchObject({ conflictId: legacy!.conflictId, type: "fixtureNote", id: item });
      expect(row!.local).toEqual(legacy!.local);
      expect(row!.incoming).toEqual(legacy!.incoming);
      expect(textOf(row!.local)).toBe("B1");
      expect(textOf(row!.incoming)).toBe("A1");
      expect(row).not.toHaveProperty("detectedOn");
    }
    // The legacy row on B itself still resolves normally.
    await decide(b.db, legacy!.conflictId, "useBackup");
    expect((await b.db.records.get(["fixtureNote", item]))?.data).toEqual(note("A1"));
    expect(await archivedTexts(b)).toEqual(["B1"]);
  });

  it("new conflicts still record detectedOn, keep it through export and import, and the file field is still validated", async () => {
    const { b, c } = await conflictOnB();
    const [row] = await b.db.pendingConflicts.toArray();
    expect(row!.detectedOn).toEqual({ deviceId: b.deviceId, deviceName: "B" });
    const text = (await exportFrom(b)).text;
    expect(JSON.parse(text).payload.pendingConflicts[0].detectedOn).toEqual({ deviceId: b.deviceId, deviceName: "B" });
    await importInto(c, text);
    const [carried] = await c.db.pendingConflicts.toArray();
    expect(carried!.detectedOn).toEqual({ deviceId: b.deviceId, deviceName: "B" });

    // Optional means absent — not null and not malformed.
    for (const bad of [null, {}, { deviceId: "not-a-uuid", deviceName: "B" }]) {
      const file = mutate(text, (doc) => {
        doc.payload.pendingConflicts[0].detectedOn = bad;
      });
      await expect(importInto(await device("F"), file)).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    }
  });
});
