/**
 * Android device check (Stage 6): a second, frozen copy of the app can hold the data so that saves
 * in the visible copy wait. StorageWatch marks a write that got no answer for 5 s of visible time,
 * never a read or this copy's own long work, clears the mark when the writes that raised it are
 * done, and closes an idle connection when the page is frozen.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDb } from "./db.ts";
import { StorageWatch } from "./storage-watch.ts";

let counter = 0;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  let t = 1_000_000;
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  const db = new LocalDb(`storage-watch-${++counter}`);
  const watch = new StorageWatch(db, { now: () => t, doc: doc as unknown as Document });
  const changes: boolean[] = [];
  watch.subscribe(() => changes.push(watch.isStalled()));
  cleanups.push(() => {
    watch.stop();
    db.close();
  });
  return { db, watch, doc, changes, advance: (ms: number) => (t += ms) };
}

/** Another connection (the "other copy") keeps a write transaction on `meta` busy until released. */
async function holdMeta(name: string): Promise<() => Promise<void>> {
  const other = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  let held = true;
  const tx = other.transaction(["meta"], "readwrite");
  const store = tx.objectStore("meta");
  const spin = () => {
    if (held) store.get("spin").onsuccess = spin;
  };
  spin();
  const finished = new Promise<void>((resolve) => (tx.oncomplete = () => resolve()));
  return async () => {
    held = false;
    await finished;
    other.close();
  };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Keeps one Dexie transaction of this copy running (answered requests) until released. */
function keepBusy(db: LocalDb, mode: "r" | "rw", table: "meta" | "records") {
  let held = true;
  const done = db.transaction(mode, db.table(table), async () => {
    await db.table(table).get("first");
    while (held) await db.table(table).get("spin");
  });
  return async () => {
    held = false;
    await done;
  };
}

describe("StorageWatch", () => {
  it("marks a save that waits 5 s while visible, and clears the mark once the save is done", async () => {
    const { db, watch, changes, advance } = setup();
    await db.meta.put({ key: "warm", value: 1 }); // opens the database
    const release = await holdMeta(db.name);

    const save = db.meta.put({ key: "change", value: 1 });
    await tick();
    advance(4_999);
    watch.check();
    expect(watch.isStalled()).toBe(false);
    advance(1);
    watch.check();
    expect(watch.isStalled()).toBe(true);

    await release();
    await save;
    await tick();
    expect(watch.isStalled()).toBe(false);
    expect(await db.meta.get("change")).toEqual({ key: "change", value: 1 }); // nothing was aborted
    expect(changes).toEqual([true, false]);
  });

  it("does not count time while the page is hidden; counting restarts when it is shown again", async () => {
    const { db, watch, doc, advance } = setup();
    await db.meta.put({ key: "warm", value: 1 });
    const release = await holdMeta(db.name);
    const save = db.meta.put({ key: "change", value: 2 });
    await tick();

    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    advance(60_000);
    watch.check();
    expect(watch.isStalled()).toBe(false);

    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    advance(4_000);
    watch.check();
    expect(watch.isStalled()).toBe(false);
    advance(1_000);
    watch.check();
    expect(watch.isStalled()).toBe(true);

    await release();
    await save;
    await tick();
    expect(watch.isStalled()).toBe(false);
  });

  it("quick saves never show the mark", async () => {
    const { db, changes, advance } = setup();
    for (let i = 0; i < 5; i++) {
      await db.meta.put({ key: `quick-${i}`, value: i });
      advance(10_000);
    }
    await tick();
    expect(changes).toEqual([]);
  });

  it("a read that waits, even for a long time, never shows the mark", async () => {
    const { db, watch, changes, advance } = setup();
    await db.meta.put({ key: "warm", value: 1 });
    const release = await holdMeta(db.name);
    const read = db.meta.get("warm"); // waits behind the other connection's write
    await tick();
    advance(60_000);
    watch.check();
    expect(watch.isStalled()).toBe(false);
    await release();
    expect(await read).toEqual({ key: "warm", value: 1 });
    await tick();
    expect(changes).toEqual([]);
  });

  it("this copy's own long work does not show the mark: a long read, a long write that got answers, and a write queued behind them", async () => {
    const { db, watch, changes, advance } = setup();
    await db.meta.put({ key: "warm", value: 1 });
    const releaseRead = keepBusy(db, "r", "records");
    const releaseWrite = keepBusy(db, "rw", "meta");
    await tick();
    const queued = db.meta.put({ key: "queued", value: 1 }); // waits for this copy's running write
    await tick();
    advance(60_000);
    watch.check();
    expect(watch.isStalled()).toBe(false);
    await releaseWrite();
    await queued;
    await releaseRead();
    await tick();
    expect(changes).toEqual([]);
  });

  it("the mark belongs to the writes that raised it: it clears when they are done although other work is still running", async () => {
    const { db, watch, advance } = setup();
    await db.meta.put({ key: "warm", value: 1 });
    const release = await holdMeta(db.name);
    const save = db.meta.put({ key: "change", value: 4 });
    await tick();
    const releaseRead = keepBusy(db, "r", "records"); // unrelated, keeps running throughout
    await tick();
    advance(5_000);
    watch.check();
    expect(watch.isStalled()).toBe(true);

    await release();
    await save;
    await tick();
    expect(watch.isStalled()).toBe(false);
    advance(60_000);
    watch.check();
    expect(watch.isStalled()).toBe(false); // the long read never raises it
    await releaseRead();
  });

  it("closes an idle connection when the page is frozen and reopens it on use or resume", async () => {
    const { db, doc } = setup();
    await db.meta.put({ key: "warm", value: 1 });
    expect(db.isOpen()).toBe(true);

    doc.dispatchEvent(new Event("freeze"));
    expect(db.isOpen()).toBe(false);
    expect(await db.meta.get("warm")).toEqual({ key: "warm", value: 1 }); // reopens on the next use
    expect(db.isOpen()).toBe(true);
    await tick(); // the read's transaction completes just after its result arrives

    doc.dispatchEvent(new Event("freeze"));
    expect(db.isOpen()).toBe(false);
    doc.dispatchEvent(new Event("resume"));
    await tick();
    expect(db.isOpen()).toBe(true);
  });

  it("keeps the connection open when the page is frozen during a save, and the save completes", async () => {
    const { db, doc } = setup();
    await db.meta.put({ key: "warm", value: 1 });
    const release = await holdMeta(db.name);
    const save = db.meta.put({ key: "during-freeze", value: 3 });
    await tick();

    doc.dispatchEvent(new Event("freeze"));
    expect(db.isOpen()).toBe(true);
    await release();
    await save;
    expect(await db.meta.get("during-freeze")).toEqual({ key: "during-freeze", value: 3 });
  });
});
