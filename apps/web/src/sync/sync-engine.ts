import type {
  Change,
  OperationResult,
  PreferencesRecord,
  SyncOperation,
  SyncProbeRecord,
} from "@pps/shared";
import { getMeta, type LocalDb, type OutboxRow, PREFERENCES_KEY, setMeta } from "../local/db.ts";
import { getSession, probeRowFrom } from "../local/repository.ts";
import { type ApiClient, ApiRequestError, NetworkError } from "./api-client.ts";

export type SyncPhase = "idle" | "syncing" | "error" | "unreachable" | "signedOut" | "sessionEnded";

export interface SyncStatus {
  phase: SyncPhase;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface SyncSummary {
  pushed: number;
  applied: number;
  conflicts: number;
  rejected: number;
  pulled: number;
}

const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 300_000];

/**
 * Moves queued local operations to the server and server changes into the local store.
 * Safe to retry at any point: every operation has a stable opId and the server deduplicates.
 */
export class SyncEngine {
  readonly #db: LocalDb;
  readonly #api: ApiClient;
  #status: SyncStatus = { phase: "signedOut", lastSyncAt: null, lastError: null };
  readonly #listeners = new Set<() => void>();
  #running: Promise<SyncSummary> | null = null;
  #again = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #failures = 0;
  #started = false;
  #starting: Promise<void> | null = null;
  readonly #onOnline = () => this.requestSync();

  constructor(db: LocalDb, api: ApiClient) {
    this.#db = db;
    this.#api = api;
  }

  /* ---------- status (compatible with React useSyncExternalStore) ---------- */

  getStatus = (): SyncStatus => this.#status;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #setStatus(patch: Partial<SyncStatus>): void {
    this.#status = { ...this.#status, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /* ---------- lifecycle ---------- */

  start(): Promise<void> {
    if (this.#started) return this.#starting ?? Promise.resolve();
    this.#started = true;
    this.#starting = this.#start();
    return this.#starting;
  }

  async #start(): Promise<void> {
    // Operations left "inflight" by a closed tab or crash are resent; the server deduplicates them.
    await this.#db.outbox.where("status").equals("inflight").modify({ status: "pending" });
    const lastSyncAt = (await getMeta<string>(this.#db, "lastSyncAt")) ?? null;
    const session = await getSession(this.#db);
    this.#api.token = session?.token ?? null;
    this.#setStatus({ lastSyncAt, phase: session ? "idle" : "signedOut" });
    globalThis.addEventListener?.("online", this.#onOnline);
    this.requestSync();
  }

  /** Stops scheduling and waits for any running cycle, so the local database can be closed safely. */
  async stop(): Promise<void> {
    this.#started = false;
    globalThis.removeEventListener?.("online", this.#onOnline);
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#again = false;
    await this.#starting?.catch(() => undefined);
    await this.#running?.catch(() => undefined);
  }

  /** Debounced trigger used after local writes and when connectivity returns. */
  requestSync(delayMs = 300): void {
    if (!this.#started) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.syncNow().catch(() => undefined);
    }, delayMs);
  }

  #scheduleRetry(): void {
    if (!this.#started) return;
    const delay = BACKOFF_MS[Math.min(this.#failures - 1, BACKOFF_MS.length - 1)]!;
    this.requestSync(delay);
  }

  async refreshSession(): Promise<void> {
    const session = await getSession(this.#db);
    this.#api.token = session?.token ?? null;
    this.#failures = 0;
    this.#setStatus({ phase: session ? "idle" : "signedOut", lastError: null });
  }

  /* ---------- sync cycle ---------- */

  /** Runs one push+pull cycle. Concurrent calls share the running cycle and queue one more. */
  syncNow(): Promise<SyncSummary> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#cycle().finally(() => {
      this.#running = null;
      if (this.#again) {
        this.#again = false;
        this.requestSync(0);
      }
    });
    return this.#running;
  }

  async #cycle(): Promise<SyncSummary> {
    const summary: SyncSummary = { pushed: 0, applied: 0, conflicts: 0, rejected: 0, pulled: 0 };
    const session = await getSession(this.#db);
    if (!session) {
      this.#api.token = null;
      this.#setStatus({ phase: "signedOut" });
      return summary;
    }
    this.#api.token = session.token;
    this.#setStatus({ phase: "syncing" });

    try {
      // Push until nothing is pending (each round sends at most one operation per record).
      for (let round = 0; round < 50; round++) {
        const sent = await this.#pushOnce(summary);
        if (sent === 0) break;
      }
      summary.pulled = await this.#pullAll();
      const at = new Date().toISOString();
      await setMeta(this.#db, "lastSyncAt", at);
      this.#failures = 0;
      this.#setStatus({ phase: "idle", lastSyncAt: at, lastError: null });
      return summary;
    } catch (error) {
      await this.#db.outbox.where("status").equals("inflight").modify({ status: "pending" });
      if (error instanceof ApiRequestError && error.status === 401) {
        this.#api.token = null;
        this.#setStatus({ phase: "sessionEnded", lastError: error.code });
        throw error;
      }
      this.#failures += 1;
      const phase: SyncPhase = error instanceof NetworkError ? "unreachable" : "error";
      this.#setStatus({ phase, lastError: error instanceof Error ? error.message : String(error) });
      this.#scheduleRetry();
      throw error;
    }
  }

  async #pushOnce(summary: SyncSummary): Promise<number> {
    const batch = await this.#db.transaction("rw", this.#db.outbox, async () => {
      const inflightKeys = new Set(
        (await this.#db.outbox.where("status").equals("inflight").toArray()).map((row) => row.recordKey),
      );
      const pending = await this.#db.outbox.where("status").equals("pending").sortBy("seq");
      const chosen: OutboxRow[] = [];
      const seen = new Set<string>(inflightKeys);
      for (const row of pending) {
        if (seen.has(row.recordKey)) continue;
        seen.add(row.recordKey);
        chosen.push(row);
        if (chosen.length >= 100) break;
      }
      for (const row of chosen) await this.#db.outbox.update(row.seq!, { status: "inflight" });
      return chosen;
    });
    if (batch.length === 0) return 0;

    await this.#db.outbox
      .where("seq")
      .anyOf(batch.map((row) => row.seq!))
      .modify((row) => {
        row.attempts += 1;
      });

    const response = await this.#api.push(batch.map(toWireOperation));
    summary.pushed += batch.length;

    const tables = [this.#db.outbox, this.#db.preferences, this.#db.probes, this.#db.conflicts, this.#db.meta];
    await this.#db.transaction("rw", tables, async () => {
      for (const result of response.results) {
        const row = batch[result.index];
        if (!row) continue;
        await this.#applyResult(row, result, summary);
      }
    });
    return batch.length;
  }

  async #applyResult(row: OutboxRow, result: OperationResult, summary: SyncSummary): Promise<void> {
    const db = this.#db;
    const laterOps = () =>
      db.outbox
        .where("recordKey")
        .equals(row.recordKey)
        .filter((other) => other.seq !== row.seq && other.status === "pending")
        .toArray();

    if (result.status === "applied") {
      summary.applied += 1;
      await db.outbox.delete(row.seq!);
      // Operations queued while this one was in flight were based on our own change: rebase them.
      const later = await laterOps();
      for (const other of later) {
        if (other.baseRevision === row.baseRevision) await db.outbox.update(other.seq!, { baseRevision: result.revision });
      }
      const settled = later.length === 0;
      if (result.recordType === "preferences") {
        const current = await db.preferences.get("self");
        if (current) {
          const record = result.record as PreferencesRecord;
          const { revision: _r, updatedAt: _u, ...fields } = record;
          await db.preferences.put({ ...current, serverRevision: result.revision, ...(settled ? { data: fields } : {}) });
        }
      } else {
        const record = result.record as SyncProbeRecord;
        const local = await db.probes.get(result.recordId);
        if (record.deletedAt) {
          if (local && settled) await db.probes.delete(result.recordId);
        } else if (local) {
          await db.probes.put(settled ? probeRowFrom(record) : { ...local, serverRevision: result.revision });
        }
      }
      return;
    }

    if (result.status === "conflict") {
      summary.conflicts += 1;
      await db.outbox.delete(row.seq!);
      // Fold any later local edits of the same record into the conflict so nothing is lost.
      let submitted = result.submitted;
      for (const other of await laterOps()) {
        submitted =
          other.kind === "sync_probe.delete"
            ? { delete: true }
            : { ...(submitted as object), ...(other.payload as object) };
        await db.outbox.delete(other.seq!);
      }
      await db.conflicts.put({
        opId: row.opId,
        recordType: result.recordType,
        recordKey: row.recordKey,
        current: result.current,
        submitted,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    // Rejected: retrying will not help. Keep it visible instead of silently dropping it.
    summary.rejected += 1;
    await db.outbox.update(row.seq!, {
      status: "failed",
      lastError: `${result.error.code}: ${result.error.message}`,
    });
    // Remote changes to this record may have been skipped while this operation was pending;
    // pull from the beginning once (revision checks make re-applying safe).
    await setMeta(db, "cursor", null);
  }

  async #pullAll(): Promise<number> {
    let total = 0;
    for (let page = 0; page < 1000; page++) {
      const cursor = (await getMeta<string | null>(this.#db, "cursor")) ?? null;
      const response = await this.#api.pull(cursor);
      const tables = [this.#db.meta, this.#db.preferences, this.#db.probes, this.#db.outbox, this.#db.conflicts];
      await this.#db.transaction("rw", tables, async () => {
        for (const change of response.changes) await this.#applyChange(change);
        await setMeta(this.#db, "cursor", response.nextCursor);
      });
      total += response.changes.length;
      if (!response.hasMore) break;
    }
    return total;
  }

  async #applyChange(change: Change): Promise<void> {
    const db = this.#db;
    const recordKey = change.recordType === "preferences" ? PREFERENCES_KEY : change.recordId;
    // A local change or unresolved conflict for this record wins locally until the push
    // reports a conflict and the owner chooses; never silently overwrite it.
    const hasLocalWork =
      (await db.outbox.where("recordKey").equals(recordKey).filter((r) => r.status !== "failed").count()) > 0 ||
      (await db.conflicts.where("recordKey").equals(recordKey).count()) > 0;

    if (change.recordType === "preferences") {
      const current = await db.preferences.get("self");
      if (current && change.revision <= current.serverRevision) return;
      if (hasLocalWork) return;
      const { revision, updatedAt, ...fields } = change.data as PreferencesRecord;
      await db.preferences.put({ key: "self", data: fields, serverRevision: revision, updatedAt });
      return;
    }

    const local = await db.probes.get(change.recordId);
    if (local && change.revision <= local.serverRevision) return;
    if (hasLocalWork) return;
    const record = change.data as SyncProbeRecord;
    if (change.deleted || record.deletedAt) await db.probes.delete(change.recordId);
    else await db.probes.put(probeRowFrom(record));
  }
}

function toWireOperation(row: OutboxRow): SyncOperation {
  switch (row.kind) {
    case "preferences.update":
      return { opId: row.opId, kind: row.kind, baseRevision: row.baseRevision, payload: row.payload as never };
    case "sync_probe.create":
      return { opId: row.opId, kind: row.kind, recordId: row.recordId!, payload: row.payload as never };
    case "sync_probe.update":
      return {
        opId: row.opId,
        kind: row.kind,
        recordId: row.recordId!,
        baseRevision: row.baseRevision,
        payload: row.payload as never,
      };
    case "sync_probe.delete":
      return { opId: row.opId, kind: row.kind, recordId: row.recordId!, baseRevision: row.baseRevision };
  }
}
