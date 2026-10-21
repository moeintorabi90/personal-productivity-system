import { readFileSync, writeFileSync } from "node:fs";
import { Dexie } from "dexie";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDb } from "../local/db.ts";
import { getDeviceSettings, updateDeviceSettings } from "../local/records.ts";
import { getSharedPreferences, updateSharedPreferences } from "../local/settings.ts";
import { availableResolutions } from "./conflicts.ts";
import { createBackup } from "./export.ts";
import { SHARED_PREFERENCES_ID } from "./limits.ts";
import { openBackupFile } from "./read.ts";
import { PRODUCT_REGISTRY } from "./registry.ts";
import { createTestDevice, type TestDevice } from "./test-fixtures.ts";
import { blobOf, importInto, mutate } from "./test-helpers.ts";

const devices: TestDevice[] = [];
async function device(label: string) {
  const d = await createTestDevice(label);
  devices.push(d);
  return d;
}
afterEach(() => {
  for (const d of devices.splice(0)) d.db.close();
});

const product = { registry: PRODUCT_REGISTRY };
const exportProduct = async (d: TestDevice) => (await createBackup(d.db, PRODUCT_REGISTRY)).text;

describe("16. preferences (D-017)", () => {
  it("shared preferences use the reserved ID on every device", async () => {
    const a = await device("A");
    await updateSharedPreferences(a.db, { timeZone: "Asia/Tehran" });
    const doc = JSON.parse(await exportProduct(a));
    expect(doc.payload.records.preferences).toHaveLength(1);
    expect(doc.payload.records.preferences[0].id).toBe(SHARED_PREFERENCES_ID);
    expect(doc.payload.records.preferences[0].data).toEqual({ timeZone: "Asia/Tehran", weekStart: 6, calendarDisplay: "gregorian" });
    expect(Object.keys(doc.payload.records.preferences[0].data)).not.toContain("language");
  });

  it("importing into untouched defaults is 'newer in backup', applied only after confirmation", async () => {
    const a = await device("A");
    const b = await device("B");
    await updateSharedPreferences(a.db, { weekStart: 1, timeZone: "Europe/London" });
    const file = await exportProduct(a);
    const declined = await importInto(b, file, { ...product, applyUpdates: false });
    expect(declined.preview.counts.newerInBackup).toBe(1);
    expect(declined.preview.counts.conflict).toBe(0);
    expect((await getSharedPreferences(b.db)).weekStart).toBe(6);
    await importInto(b, file, { ...product, applyUpdates: true });
    expect(await getSharedPreferences(b.db)).toMatchObject({ weekStart: 1, timeZone: "Europe/London" });
  });

  it("edits on both devices give a conflict without 'keep both'", async () => {
    const a = await device("A");
    const b = await device("B");
    await updateSharedPreferences(a.db, { weekStart: 1 });
    await updateSharedPreferences(b.db, { weekStart: 0 });
    const { result } = await importInto(b, await exportProduct(a), product);
    expect(result.counts.conflict).toBe(1);
    const [conflict] = await b.db.pendingConflicts.toArray();
    expect(availableResolutions(conflict!, PRODUCT_REGISTRY)).toEqual(["keepDevice", "useBackup"]);
    expect((await getSharedPreferences(b.db)).weekStart).toBe(0);
  });

  it("language and theme never change on import unless the user accepts the source device's display settings", async () => {
    const a = await device("A");
    const b = await device("B");
    await updateDeviceSettings(a.db, { language: "fa", theme: "dark" });
    const file = await exportProduct(a);
    expect(JSON.parse(file).payload.sourceDeviceSettings).toEqual({ language: "fa", theme: "dark" });

    const first = await importInto(b, file, { ...product, applyUpdates: true });
    expect(first.preview.displaySettingsDiffer).toBe(true);
    expect(await getDeviceSettings(b.db)).toEqual({ language: "en", theme: "system" });
    expect(await b.db.pendingConflicts.count()).toBe(0);

    await importInto(b, file, { ...product, applyDisplaySettings: true });
    expect(await getDeviceSettings(b.db)).toEqual({ language: "fa", theme: "dark" });
  });
});

describe("Stage 1B migration of the legacy preferences row", () => {
  async function legacyDb(data: Record<string, unknown> | null) {
    const factory = new IDBFactory();
    const name = `legacy-${crypto.randomUUID()}`;
    const old = new Dexie(name, { indexedDB: factory, IDBKeyRange });
    old.version(1).stores({
      meta: "key",
      preferences: "key",
      probes: "id, createdAt",
      outbox: "++seq, opId, recordKey, status",
      conflicts: "opId, recordKey",
    });
    const deviceId = crypto.randomUUID();
    await old.table("meta").put({ key: "device", value: { id: deviceId, name: "Old laptop" } });
    if (data) await old.table("preferences").put({ key: "self", data, serverRevision: 3, updatedAt: "2026-10-01T10:00:00.000Z" });
    old.close();
    const db = new LocalDb(name, { indexedDB: factory, IDBKeyRange });
    await db.open();
    return { db, deviceId };
  }

  it("splits the 'self' row into shared preferences and device settings, keeping every value", async () => {
    const { db, deviceId } = await legacyDb({
      language: "fa",
      theme: "dark",
      calendarDisplay: "jalali",
      weekStart: 0,
      timeZone: "Asia/Tehran",
    });
    const record = await db.records.get(["preferences", SHARED_PREFERENCES_ID]);
    expect(record?.data).toEqual({ timeZone: "Asia/Tehran", weekStart: 0, calendarDisplay: "jalali" });
    expect(record?.version).toEqual({ [deviceId]: 1 }); // changed from defaults = this device's first edit
    expect(await getDeviceSettings(db)).toEqual({ language: "fa", theme: "dark" });
    // The legacy row stays untouched for the frozen sync code.
    expect((await db.preferences.get("self"))?.serverRevision).toBe(3);
    db.close();
  });

  it("untouched defaults migrate with an empty version vector", async () => {
    const { db } = await legacyDb({ language: "en", theme: "system", calendarDisplay: "gregorian", weekStart: 6, timeZone: null });
    expect((await db.records.get(["preferences", SHARED_PREFERENCES_ID]))?.version).toEqual({});
    db.close();
  });

  it("a database without a legacy row gets defaults", async () => {
    const { db } = await legacyDb(null);
    expect(await getSharedPreferences(db)).toEqual({ timeZone: null, weekStart: 6, calendarDisplay: "gregorian" });
    expect(await getDeviceSettings(db)).toEqual({ language: "en", theme: "system" });
    db.close();
  });
});

describe("11. versioning: committed format-version-1 sample (fabricated data only)", () => {
  const samplePath = new URL("./samples/pps-backup-format-v1.json", import.meta.url);

  it("writes the sample when PPS_WRITE_SAMPLE=1 (maintainers only)", async () => {
    if (process.env.PPS_WRITE_SAMPLE !== "1") return;
    const d = await device("Sample device");
    await updateSharedPreferences(d.db, { timeZone: "Europe/London", weekStart: 1, calendarDisplay: "both" });
    const file = await createBackup(d.db, PRODUCT_REGISTRY, {
      now: new Date("2026-10-21T08:00:00.000Z"),
      backupId: "11111111-1111-4111-8111-111111111111",
    });
    writeFileSync(samplePath, `${file.text}\n`);
  });

  it("imports into the current app", async () => {
    const text = readFileSync(samplePath, "utf8");
    const opened = await openBackupFile(blobOf(text), PRODUCT_REGISTRY);
    expect(opened.header).toMatchObject({ formatVersion: 1, backupId: "11111111-1111-4111-8111-111111111111" });
    const b = await device("B");
    await importInto(b, text, { ...product, applyUpdates: true });
    expect(await getSharedPreferences(b.db)).toEqual({ timeZone: "Europe/London", weekStart: 1, calendarDisplay: "both" });
  });

  it("refuses a file with a newer format version, without changes", async () => {
    const text = readFileSync(samplePath, "utf8");
    const newer = mutate(text, (d) => (d.formatVersion = 2));
    await expect(openBackupFile(blobOf(newer), PRODUCT_REGISTRY)).rejects.toMatchObject({ code: "NEWER_VERSION" });
  });
});
