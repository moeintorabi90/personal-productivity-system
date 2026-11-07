import type { DBCore, DBCoreTable } from "dexie";
import type { LocalDb } from "./db.ts";

interface Watched {
  start: number;
  /** Waiting is counted from here: the start, or when this copy's own work on its tables last ended. */
  waitFrom: number;
  stores: readonly string[];
  readwrite: boolean;
  /** Set once any request of the transaction returned: it has the data and is doing its own work. */
  progressed: boolean;
}

/**
 * Watches this copy's IndexedDB work for the case seen on Android Chrome (Stage 6 device check):
 * the app open twice on one device (a browser tab and the installed app), one copy hidden and
 * frozen by the browser, and saves in the visible copy waiting. The stuck save was not reproduced
 * later, so its cause is not proven.
 *
 * - When the browser freezes this page and no transaction is running, the connection is closed,
 *   so a frozen copy holds nothing (it reopens on the next use or on resume). A frozen page cannot
 *   answer another copy's upgrade request, so an open connection there would block it.
 * - A save is "waiting" when its write transaction has had no request answered for `thresholdMs`
 *   of visible time, counted only while no earlier transaction of this copy on the same tables is
 *   running (that one, not another copy, may be what it waits for). Reads never count, and
 *   neither does a write that already got an answer: that is this copy's own long work.
 *   IndexedDB does not say why a transaction waits, so the warning names a second open copy only
 *   as one possible cause.
 * - The warning belongs to the transactions that raised it: it clears when each of them has
 *   finished or got an answer, whatever else is still open. Nothing is aborted: the waiting
 *   change is saved once the data is free.
 */
export class StorageWatch {
  private readonly open = new Map<object, Watched>();
  /** Write transactions that raised the warning and are still waiting. */
  private readonly causes = new Set<object>();
  private readonly listeners = new Set<() => void>();
  private stalled = false;
  private visibleSince: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly cleanups: (() => void)[] = [];
  private readonly options: { thresholdMs?: number; now?: () => number; doc?: Document };

  constructor(db: LocalDb, options: { thresholdMs?: number; now?: () => number; doc?: Document } = {}) {
    this.options = options;
    this.visibleSince = this.now();
    db.use({
      stack: "dbcore",
      name: "storageWatch",
      create: (down: DBCore) => ({
        ...down,
        transaction: (stores, mode, txOptions) => {
          const tx = down.transaction(stores, mode, txOptions);
          this.track(tx, stores, mode === "readwrite");
          return tx;
        },
        table: (name) => this.watchTable(down.table(name)),
      }),
    });
    const doc = this.doc();
    if (!doc) return;
    const onFreeze = () => {
      // Closing while a transaction runs would fail that change; the browser keeps those either way.
      if (this.open.size === 0 && db.isOpen()) db.close({ disableAutoOpen: false });
    };
    const onResume = () => {
      if (!db.isOpen()) db.open().catch((error: unknown) => console.error("Could not reopen local data", error));
    };
    const onVisibility = () => {
      if (doc.visibilityState === "visible") this.visibleSince = this.now();
      this.check();
    };
    doc.addEventListener("freeze", onFreeze);
    doc.addEventListener("resume", onResume);
    doc.addEventListener("visibilitychange", onVisibility);
    this.cleanups.push(() => {
      doc.removeEventListener("freeze", onFreeze);
      doc.removeEventListener("resume", onResume);
      doc.removeEventListener("visibilitychange", onVisibility);
    });
  }

  /** True while a save has waited too long for the data (see the class comment). */
  readonly isStalled = (): boolean => this.stalled;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Re-evaluates the warning; runs every second while something is open. */
  check(): void {
    const doc = this.doc();
    // Only time the page spends visible counts: a hidden or frozen page is not waiting on others.
    if (!doc || doc.visibilityState === "visible") {
      const limit = this.options.thresholdMs ?? 5_000;
      const now = this.now();
      for (const [tx, info] of this.open) {
        if (!info.readwrite || info.progressed || this.causes.has(tx)) continue;
        if (this.busyBefore(info)) {
          info.waitFrom = now;
          continue;
        }
        if (now - Math.max(info.waitFrom, this.visibleSince) < limit) continue;
        this.causes.add(tx);
      }
    }
    this.publish();
    if (this.open.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  /** An earlier transaction of this copy on a shared table that is running may be what `info` waits for. */
  private busyBefore(info: Watched): boolean {
    for (const other of this.open.values()) {
      if (other === info || !other.progressed || other.start > info.start) continue;
      if (other.stores.some((store) => info.stores.includes(store))) return true;
    }
    return false;
  }

  private publish(): void {
    const next = this.causes.size > 0;
    if (next === this.stalled) return;
    this.stalled = next;
    for (const listener of this.listeners) listener();
  }

  private track(tx: unknown, stores: readonly string[], readwrite: boolean): void {
    const target = tx as Partial<EventTarget> | null;
    if (!target || typeof target.addEventListener !== "function") return;
    const start = this.now();
    this.open.set(target, { start, waitFrom: start, stores: [...stores], readwrite, progressed: false });
    const done = () => {
      const finished = this.open.get(target);
      this.open.delete(target);
      // Writes queued behind this one were waiting on this copy until now, not on another copy.
      if (finished?.progressed) {
        const now = this.now();
        for (const info of this.open.values())
          if (info.start >= finished.start && info.stores.some((store) => finished.stores.includes(store)))
            info.waitFrom = Math.max(info.waitFrom, now);
      }
      this.causes.delete(target);
      this.check();
    };
    target.addEventListener("complete", done);
    target.addEventListener("abort", done);
    if (this.timer === null) this.timer = setInterval(() => this.check(), 1_000);
  }

  /** Marks a transaction as running once any of its requests is answered. */
  private progressed(tx: unknown): void {
    const info = this.open.get(tx as object);
    if (!info || info.progressed) return;
    info.progressed = true;
    if (this.causes.delete(tx as object)) this.publish();
  }

  private watchTable(table: DBCoreTable): DBCoreTable {
    const answered = <R extends { trans: unknown }, T>(run: (req: R) => Promise<T>) => (req: R) =>
      run(req).then((result) => {
        this.progressed(req.trans);
        return result;
      });
    return {
      ...table,
      mutate: answered((req) => table.mutate(req)),
      get: answered((req) => table.get(req)),
      getMany: answered((req) => table.getMany(req)),
      query: answered((req) => table.query(req)),
      openCursor: answered((req) => table.openCursor(req)),
      count: answered((req) => table.count(req)),
    };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private doc(): Document | undefined {
    return this.options.doc ?? (typeof document === "undefined" ? undefined : document);
  }
}
