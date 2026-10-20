import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, createPgliteDb, type Db, migrate } from "@pps/api";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDb } from "../local/db.ts";
import {
  addProbe,
  deleteProbe,
  editProbe,
  loadPreferences,
  resolveKeepMine,
  resolveKeepServer,
  updatePreferences,
} from "../local/repository.ts";
import { createOwnerAccount, signIn } from "./account.ts";
import { ApiClient, type FetchLike, NetworkError } from "./api-client.ts";
import { SyncEngine } from "./sync-engine.ts";

/**
 * End-to-end sync between two simulated devices: the real client sync engine and local
 * IndexedDB code (fake-indexeddb) against the real Express API and a PostgreSQL (PGlite) database.
 */

const PASSWORD = "correct horse battery staple";
let db: Db;
let http: Server;
let baseUrl: string;

beforeEach(async () => {
  db = await createPgliteDb();
  await migrate(db);
  const app = createApp(db, {
    port: 0,
    production: false,
    databaseUrl: null,
    pgliteDataDir: "",
    setupToken: null,
    sessionTtlDays: 365,
  });
  http = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await db.close();
});

interface Client {
  local: LocalDb;
  api: ApiClient;
  engine: SyncEngine;
  network: { online: boolean; dropNextPushResponse: boolean };
}

function makeClient(name: string): Client {
  const network = { online: true, dropNextPushResponse: false };
  const fetchImpl: FetchLike = async (input, init) => {
    if (!network.online) throw new TypeError("Failed to fetch");
    const response = await fetch(input, init);
    if (network.dropNextPushResponse && input.includes("/v1/sync/push")) {
      network.dropNextPushResponse = false;
      // The server processed the request, but the response never reached the device.
      throw new TypeError("connection reset");
    }
    return response;
  };
  const local = new LocalDb(name, { indexedDB: new IDBFactory(), IDBKeyRange });
  const api = new ApiClient(baseUrl, fetchImpl);
  const engine = new SyncEngine(local, api);
  return { local, api, engine, network };
}

async function probeTexts(client: Client): Promise<string[]> {
  return (await client.local.probes.orderBy("createdAt").toArray()).map((p) => p.text);
}

async function serverProbeCount(): Promise<number> {
  const { rows } = await db.query<{ n: string | number }>("SELECT count(*) AS n FROM sync_probe");
  return Number(rows[0]!.n);
}

describe("two devices syncing through the API", () => {
  it("offline writes stay local, then sync idempotently after a lost response", async () => {
    const laptop = makeClient("laptop");
    const phone = makeClient("phone");

    await updatePreferences(laptop.local, { language: "fa", timeZone: "Asia/Tehran" });
    await createOwnerAccount(laptop.local, laptop.api, laptop.engine, {
      email: "owner@example.test",
      password: PASSWORD,
      deviceName: "Laptop",
    });
    await signIn(phone.local, phone.api, phone.engine, {
      email: "owner@example.test",
      password: PASSWORD,
      deviceName: "Phone",
    });
    // Local preferences chosen before setup became the account's preferences on both devices.
    expect((await loadPreferences(phone.local)).data).toMatchObject({ language: "fa", timeZone: "Asia/Tehran" });

    // Offline: the write succeeds locally and is queued.
    laptop.network.online = false;
    await addProbe(laptop.local, "written offline");
    expect(await probeTexts(laptop)).toEqual(["written offline"]);
    await expect(laptop.engine.syncNow()).rejects.toBeInstanceOf(NetworkError);
    expect(laptop.engine.getStatus().phase).toBe("unreachable");
    expect(await laptop.local.outbox.count()).toBe(1);
    expect(await serverProbeCount()).toBe(0);

    // Back online, but the push response is lost after the server applied it.
    laptop.network.online = true;
    laptop.network.dropNextPushResponse = true;
    await expect(laptop.engine.syncNow()).rejects.toBeInstanceOf(NetworkError);
    expect(await serverProbeCount()).toBe(1);
    expect(await laptop.local.outbox.where("status").equals("pending").count()).toBe(1);

    // Retry resends the same operation ID: the server replays the result, no duplicate.
    const retry = await laptop.engine.syncNow();
    expect(retry).toMatchObject({ pushed: 1, applied: 1, conflicts: 0 });
    expect(await serverProbeCount()).toBe(1);
    expect(await laptop.local.outbox.count()).toBe(0);
    expect((await laptop.local.probes.toArray())[0]!.serverRevision).toBe(1);

    await phone.engine.syncNow();
    expect(await probeTexts(phone)).toEqual(["written offline"]);

    // Edits and deletions (tombstones) flow back the other way.
    const id = (await phone.local.probes.toArray())[0]!.id;
    await editProbe(phone.local, id, "edited on phone");
    await phone.engine.syncNow();
    await laptop.engine.syncNow();
    expect(await probeTexts(laptop)).toEqual(["edited on phone"]);

    await deleteProbe(laptop.local, id);
    await laptop.engine.syncNow();
    await phone.engine.syncNow();
    expect(await probeTexts(phone)).toEqual([]);
    const { rows } = await db.query<{ deleted_at: unknown }>("SELECT deleted_at FROM sync_probe");
    expect(rows[0]!.deleted_at).not.toBeNull();
  });

  it("coalesces offline edits and never sends a note that was created and deleted offline", async () => {
    const laptop = makeClient("laptop-coalesce");
    await createOwnerAccount(laptop.local, laptop.api, laptop.engine, {
      email: "owner@example.test",
      password: PASSWORD,
      deviceName: "Laptop",
    });
    laptop.network.online = false;
    const keep = await addProbe(laptop.local, "draft");
    await editProbe(laptop.local, keep, "final");
    const gone = await addProbe(laptop.local, "temporary");
    await deleteProbe(laptop.local, gone);
    await updatePreferences(laptop.local, { theme: "dark" });
    await updatePreferences(laptop.local, { weekStart: 1 });
    expect(await laptop.local.outbox.count()).toBe(2);

    laptop.network.online = true;
    const summary = await laptop.engine.syncNow();
    expect(summary).toMatchObject({ pushed: 2, applied: 2 });
    const { rows } = await db.query<{ text: string }>("SELECT text FROM sync_probe");
    expect(rows).toEqual([{ text: "final" }]);
    const prefs = await db.query<{ theme: string; week_start: number; revision: number }>(
      "SELECT theme, week_start, revision FROM user_preference",
    );
    expect(prefs.rows[0]).toMatchObject({ theme: "dark", week_start: 1, revision: 2 });
  });

  it("surfaces concurrent preference edits as a conflict without losing either value", async () => {
    const laptop = makeClient("laptop-conflict");
    const phone = makeClient("phone-conflict");
    await createOwnerAccount(laptop.local, laptop.api, laptop.engine, {
      email: "owner@example.test",
      password: PASSWORD,
      deviceName: "Laptop",
    });
    await signIn(phone.local, phone.api, phone.engine, {
      email: "owner@example.test",
      password: PASSWORD,
      deviceName: "Phone",
    });

    await updatePreferences(laptop.local, { theme: "dark" });
    await updatePreferences(phone.local, { theme: "light" });
    await laptop.engine.syncNow();
    const result = await phone.engine.syncNow();
    expect(result.conflicts).toBe(1);

    // The phone still shows its own value until the owner decides.
    expect((await loadPreferences(phone.local)).data.theme).toBe("light");
    const conflict = (await phone.local.conflicts.toArray())[0]!;
    expect(conflict.current).toMatchObject({ theme: "dark", revision: 2 });
    expect(conflict.submitted).toEqual({ theme: "light" });

    await resolveKeepMine(phone.local, conflict);
    await phone.engine.syncNow();
    await laptop.engine.syncNow();
    expect((await loadPreferences(laptop.local)).data.theme).toBe("light");
    expect(await phone.local.conflicts.count()).toBe(0);

    // The other choice: accept the server version.
    await updatePreferences(laptop.local, { calendarDisplay: "jalali" });
    await updatePreferences(phone.local, { calendarDisplay: "both" });
    await laptop.engine.syncNow();
    await phone.engine.syncNow();
    const second = (await phone.local.conflicts.toArray())[0]!;
    await resolveKeepServer(phone.local, second);
    expect((await loadPreferences(phone.local)).data.calendarDisplay).toBe("jalali");
    await phone.engine.syncNow();
    expect(await phone.local.outbox.count()).toBe(0);
  });

  it("keeps an edit made on one device when the other deleted the note", async () => {
    const laptop = makeClient("laptop-del");
    const phone = makeClient("phone-del");
    await createOwnerAccount(laptop.local, laptop.api, laptop.engine, {
      email: "owner@example.test",
      password: PASSWORD,
      deviceName: "Laptop",
    });
    await signIn(phone.local, phone.api, phone.engine, {
      email: "owner@example.test",
      password: PASSWORD,
      deviceName: "Phone",
    });
    const id = await addProbe(laptop.local, "shared");
    await laptop.engine.syncNow();
    await phone.engine.syncNow();

    await deleteProbe(laptop.local, id);
    await editProbe(phone.local, id, "phone edit");
    await laptop.engine.syncNow();
    const result = await phone.engine.syncNow();
    expect(result.conflicts).toBe(1);
    const conflict = (await phone.local.conflicts.toArray())[0]!;
    await resolveKeepMine(phone.local, conflict);
    await phone.engine.syncNow();
    await laptop.engine.syncNow();
    expect(await probeTexts(laptop)).toEqual(["phone edit"]);
  });

  it("stops syncing and reports when the session is revoked", async () => {
    const laptop = makeClient("laptop-revoke");
    await createOwnerAccount(laptop.local, laptop.api, laptop.engine, {
      email: "owner@example.test",
      password: PASSWORD,
      deviceName: "Laptop",
    });
    await db.query("UPDATE auth_session SET revoked_at = now()");
    await addProbe(laptop.local, "kept locally");
    await expect(laptop.engine.syncNow()).rejects.toMatchObject({ status: 401 });
    expect(laptop.engine.getStatus().phase).toBe("sessionEnded");
    expect(await probeTexts(laptop)).toEqual(["kept locally"]);
    expect(await laptop.local.outbox.where("status").equals("pending").count()).toBe(1);
  });
});
