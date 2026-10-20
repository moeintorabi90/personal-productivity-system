import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDb, setMeta } from "./db.ts";
import { addProbe, deleteProbe, editProbe, getDevice, loadPreferences, updatePreferences } from "./repository.ts";

let db: LocalDb;
beforeEach(() => {
  db = new LocalDb("repo-test", { indexedDB: new IDBFactory(), IDBKeyRange });
});
afterEach(() => db.close());

describe("local repository", () => {
  it("creates a stable device identity once", async () => {
    const first = await getDevice(db);
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getDevice(db)).toEqual(first);
  });

  it("saves preferences locally without queueing while signed out", async () => {
    await updatePreferences(db, { language: "fa" });
    expect((await loadPreferences(db)).data.language).toBe("fa");
    expect(await db.outbox.count()).toBe(0);
  });

  it("queues and merges preference changes once signed in", async () => {
    await setMeta(db, "session", { token: "t", expiresAt: "", ownerId: "o", email: "e" });
    await db.preferences.put({ key: "self", data: (await loadPreferences(db)).data, serverRevision: 3, updatedAt: "" });
    await updatePreferences(db, { theme: "dark" });
    await updatePreferences(db, { weekStart: 1 });
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "preferences.update", baseRevision: 3, payload: { theme: "dark", weekStart: 1 } });
  });

  it("folds edits into an unsent create and drops create+delete entirely", async () => {
    const id = await addProbe(db, "  draft  ");
    await editProbe(db, id, "final");
    let ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "sync_probe.create", payload: { text: "final" } });
    expect((await db.probes.get(id))?.text).toBe("final");

    await deleteProbe(db, id);
    ops = await db.outbox.toArray();
    expect(ops).toHaveLength(0);
    expect(await db.probes.count()).toBe(0);
  });

  it("turns a pending update into a delete with the original base revision", async () => {
    await db.probes.put({ id: "p1", text: "synced", serverRevision: 4, createdAt: "a", updatedAt: "a" });
    await editProbe(db, "p1", "changed");
    await deleteProbe(db, "p1");
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "sync_probe.delete", baseRevision: 4 });
  });

  it("does not merge into an operation that is already in flight", async () => {
    await db.probes.put({ id: "p2", text: "synced", serverRevision: 1, createdAt: "a", updatedAt: "a" });
    await editProbe(db, "p2", "first");
    await db.outbox.toCollection().modify({ status: "inflight" });
    await editProbe(db, "p2", "second");
    const ops = await db.outbox.orderBy("seq").toArray();
    expect(ops.map((op) => [op.status, (op.payload as { text: string }).text])).toEqual([
      ["inflight", "first"],
      ["pending", "second"],
    ]);
  });
});
