import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.ts";
import { createPostgresDb } from "../src/db/postgres.ts";
import { call, login, setupOwner, startTestServer, type TestServer } from "./helpers.ts";

/**
 * Exercises the production `pg` driver path (wire protocol, type parsing, BEGIN/COMMIT,
 * multi-statement migrations) against PGlite served over a TCP socket. This is not a substitute
 * for running the full suite against a native PostgreSQL server (set TEST_DATABASE_URL).
 */
describe("node-postgres driver over the PostgreSQL wire protocol", () => {
  let socket: PGLiteSocketServer | undefined;
  let pglite: PGlite | undefined;
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    await socket?.stop();
    await pglite?.close();
    server = undefined;
    socket = undefined;
    pglite = undefined;
  });

  it("migrates from empty, sets up an owner, and syncs idempotently through pg", async () => {
    pglite = new PGlite();
    await pglite.waitReady;
    const port = 20000 + Math.floor(Math.random() * 20000);
    socket = new PGLiteSocketServer({ db: pglite, port, host: "127.0.0.1", maxConnections: 1 });
    await socket.start();

    // PGlite has one session: a single pooled connection keeps transactions from interleaving.
    const db = createPostgresDb({ connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`, max: 1 });
    expect(db.kind).toBe("postgres");
    const report = await migrate(db);
    expect(report.applied).toEqual(["0001_foundation.sql"]);

    server = await startTestServer({ db });
    const laptop = await setupOwner(server.baseUrl);
    const phone = await login(server.baseUrl);

    const op = { opId: randomUUID(), kind: "sync_probe.create", recordId: randomUUID(), payload: { text: "via pg" } };
    for (let i = 0; i < 2; i++) {
      const res = await call(server.baseUrl, "POST", "/v1/sync/push", { token: laptop.token, body: { operations: [op] } });
      expect(res.body.results[0]).toMatchObject({ status: "applied", revision: 1, replayed: i === 1 });
    }

    const pulled = await call(server.baseUrl, "GET", "/v1/sync/pull", { token: phone.token });
    expect(pulled.body.changes.map((c: { recordType: string }) => c.recordType)).toEqual(["preferences", "sync_probe"]);
    expect(pulled.body.changes[1].data).toMatchObject({ text: "via pg" });
    expect(typeof pulled.body.changes[1].changedAt).toBe("string");

    // A failing transaction must roll back through the pg path.
    await expect(
      db.transaction(async (tx) => {
        await tx.query("UPDATE sync_probe SET text = 'should roll back'");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const { rows } = await db.query<{ text: string }>("SELECT text FROM sync_probe");
    expect(rows).toEqual([{ text: "via pg" }]);

    await server.close();
    server = undefined;
    await db.close();
  });
});
