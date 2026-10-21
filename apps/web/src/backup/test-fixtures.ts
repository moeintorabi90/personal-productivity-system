/**
 * TEST-ONLY record types (docs/ROADMAP.md Stage 1B, docs/TESTING.md): one independent type and
 * one linked parent/child pair, used to exercise the merge engine before real product types
 * exist. Never imported by application code, so never shipped or accepted in real backups.
 */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { z } from "zod";
import { LocalDb } from "../local/db.ts";
import { createRegistry, preferencesType, type RecordTypeDef } from "./registry.ts";

export const fixtureNote: RecordTypeDef = {
  type: "fixtureNote",
  schema: z.object({ text: z.string().min(1).max(200) }).strict() as unknown as RecordTypeDef["schema"],
  links: [],
};

export const fixtureParent: RecordTypeDef = {
  type: "fixtureParent",
  schema: z.object({ name: z.string().min(1).max(200) }).strict() as unknown as RecordTypeDef["schema"],
  links: [],
};

export const fixtureChild: RecordTypeDef = {
  type: "fixtureChild",
  schema: z.object({ name: z.string().min(1).max(200), parentId: z.uuid() }).strict() as unknown as RecordTypeDef["schema"],
  links: [{ field: "parentId", target: "fixtureParent" }],
};

export const TEST_REGISTRY = createRegistry([preferencesType, fixtureNote, fixtureParent, fixtureChild]);

/** Same fixtures, with the independent type treated as append-only history (item 8/17). */
export const HISTORY_REGISTRY = createRegistry([
  preferencesType,
  { ...fixtureNote, appendOnly: true },
  fixtureParent,
  fixtureChild,
]);

export interface TestDevice {
  db: LocalDb;
  factory: IDBFactory;
  name: string;
  deviceId: string;
  /** Closes and reopens the same IndexedDB (simulates an app restart). */
  restart(): Promise<void>;
}

let counter = 0;

export async function createTestDevice(label: string): Promise<TestDevice> {
  const factory = new IDBFactory();
  const name = `device-${label}-${++counter}`;
  const deviceId = crypto.randomUUID();
  const device: TestDevice = {
    db: new LocalDb(name, { indexedDB: factory, IDBKeyRange }),
    factory,
    name,
    deviceId,
    async restart() {
      device.db.close();
      device.db = new LocalDb(name, { indexedDB: factory, IDBKeyRange });
      await device.db.open();
    },
  };
  await device.db.meta.put({ key: "device", value: { id: deviceId, name: label } });
  return device;
}
