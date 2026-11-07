import type { DBCore } from "dexie";
import type { LocalDb } from "./db.ts";

/**
 * Watches this copy's IndexedDB work for the case seen on Android Chrome (Stage 6 device check):
 * the app open twice on one device (a browser tab and the installed app), one copy hidden and
 * frozen by the browser while it still holds the data, and every save in the visible copy waiting.
 *
 * - When the browser freezes this page and no transaction is running, the connection is closed,
 *   so a frozen copy holds nothing (it reopens on the next use or on resume). A frozen page cannot
 *   answer another copy's upgrade request, so an open connection there would block it.
 * - A transaction that has been waiting for `thresholdMs` while the page is visible marks storage
 *   as "stalled", and the app tells the user to close the other copies. The mark clears when every
 *   such transaction has finished. Nothing is aborted: the waiting change is saved once the data
 *   is free.
 */
export class StorageWatch {
  private readonly open = new Map<IDBTransaction, number>();
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
          this.track(tx as unknown as IDBTransaction);
          return tx;
        },
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

  /** True while a change has waited too long for the data (see the class comment). */
  readonly isStalled = (): boolean => this.stalled;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Re-evaluates the stalled mark; runs every second while something is open. */
  check(): void {
    const doc = this.doc();
    const visible = !doc || doc.visibilityState === "visible";
    const limit = this.options.thresholdMs ?? 5_000;
    const now = this.now();
    let waiting = false;
    for (const start of this.open.values()) {
      // Only time the page spends visible counts: a hidden or frozen page is not waiting on others.
      if (visible && now - Math.max(start, this.visibleSince) >= limit) waiting = true;
    }
    // Once shown, the notice stays until the waiting transactions are done, even if hidden meanwhile.
    const next = waiting || (this.stalled && this.open.size > 0);
    if (next !== this.stalled) {
      this.stalled = next;
      for (const listener of this.listeners) listener();
    }
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

  private track(tx: IDBTransaction): void {
    if (typeof tx?.addEventListener !== "function") return;
    this.open.set(tx, this.now());
    const done = () => {
      this.open.delete(tx);
      this.check();
    };
    tx.addEventListener("complete", done);
    tx.addEventListener("abort", done);
    if (this.timer === null) this.timer = setInterval(() => this.check(), 1_000);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private doc(): Document | undefined {
    return this.options.doc ?? (typeof document === "undefined" ? undefined : document);
  }
}
