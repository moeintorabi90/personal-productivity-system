import { type Envelope, makeEnvelope, nowIso, type Tombstone } from "../backup/envelope.ts";
import type { Registry } from "../backup/registry.ts";
import { bumpVersion } from "../backup/versions.ts";
import { DEFAULT_DEVICE_SETTINGS, type DeviceIdentity, type DeviceSettings, type LocalDb, type MetaRow, type RecordRow } from "./db.ts";

/** Reads (or creates) this device's identity. Safe inside a transaction that includes `meta`. */
export async function deviceIdentity(db: LocalDb): Promise<DeviceIdentity> {
  const existing = (await db.meta.get("device"))?.value as DeviceIdentity | undefined;
  if (existing) return existing;
  const device = { id: crypto.randomUUID(), name: "This device" };
  await db.meta.put({ key: "device", value: device } satisfies MetaRow);
  return device;
}

export function toEnvelope(row: RecordRow): Envelope {
  const { type: _type, copyOf: _copyOf, ...envelope } = row;
  return envelope;
}

/**
 * Creates or updates a record of a registered type with a local edit: validates `data`, bumps
 * this device's version counter, and recomputes the content hash. An edit that does not change
 * the content is a no-op. A record that was deleted here is not silently recreated.
 */
export async function putRecord(
  db: LocalDb,
  registry: Registry,
  type: string,
  id: string,
  data: Record<string, unknown>,
): Promise<RecordRow> {
  const def = registry.get(type);
  if (!def) throw new Error(`Unknown record type ${type}`);
  const parsed = def.schema.parse(data) as Record<string, unknown>;
  return db.transaction("rw", [db.records, db.tombstones, db.meta], async () => {
    const device = await deviceIdentity(db);
    const current = await db.records.get([type, id]);
    if (await db.tombstones.get([type, id])) throw new Error("Record was deleted on this device");
    if (current) {
      if (def.appendOnly) throw new Error("Append-only records cannot be edited");
      const next = makeEnvelope(id, parsed, current.version, current.createdAt, nowIso());
      if (next.contentHash === current.contentHash) return current;
      const row: RecordRow = { type, ...next, version: bumpVersion(current.version, device.id) };
      await db.records.put(row);
      return row;
    }
    const row: RecordRow = { type, ...makeEnvelope(id, parsed, { [device.id]: 1 }, nowIso()) };
    await db.records.put(row);
    return row;
  });
}

/** Deletes a record locally, keeping a tombstone with a bumped version (never a silent forget). */
export async function deleteRecord(db: LocalDb, type: string, id: string): Promise<Tombstone | null> {
  return db.transaction("rw", [db.records, db.tombstones, db.meta], async () => {
    const device = await deviceIdentity(db);
    const current = await db.records.get([type, id]);
    if (!current) return null;
    const tombstone: Tombstone = { type, id, deletedAt: nowIso(), version: bumpVersion(current.version, device.id) };
    await db.records.delete([type, id]);
    await db.tombstones.put(tombstone);
    return tombstone;
  });
}

export async function getDeviceSettings(db: LocalDb): Promise<DeviceSettings> {
  const stored = (await db.meta.get("deviceSettings"))?.value as Partial<DeviceSettings> | undefined;
  return { ...DEFAULT_DEVICE_SETTINGS, ...stored };
}

/** Device-local settings (language, theme): never exported as mergeable data (D-017). */
export async function updateDeviceSettings(db: LocalDb, patch: Partial<DeviceSettings>): Promise<void> {
  await db.transaction("rw", db.meta, async () => {
    const current = await getDeviceSettings(db);
    await db.meta.put({ key: "deviceSettings", value: { ...current, ...patch } });
  });
}
