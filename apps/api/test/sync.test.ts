import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { generateToken, hashToken } from "../src/auth/crypto.ts";
import type { Db } from "../src/db/types.ts";
import { call, login, setupOwner, startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function createOp(text: string, recordId = randomUUID()) {
  return { opId: randomUUID(), kind: "sync_probe.create", recordId, payload: { text } };
}

async function push(baseUrl: string, token: string, operations: unknown[]) {
  return call(baseUrl, "POST", "/v1/sync/push", { token, body: { operations } });
}

async function pullAll(baseUrl: string, token: string, cursor?: string) {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return call(baseUrl, "GET", `/v1/sync/pull${qs}`, { token });
}

/** A second owner can only exist by direct insertion (setup allows one); used to prove isolation. */
async function insertForeignOwner(db: Db): Promise<{ userId: string; token: string }> {
  const userId = randomUUID();
  const deviceId = randomUUID();
  const token = generateToken();
  await db.query("INSERT INTO app_user (id, email, password_hash) VALUES ($1, 'other@example.test', 'scrypt$x')", [
    userId,
  ]);
  await db.query(
    `INSERT INTO user_preference (user_id, language, theme, calendar_display, week_start, revision)
     VALUES ($1, 'en', 'system', 'gregorian', 6, 1)`,
    [userId],
  );
  await db.query("INSERT INTO sync_device (user_id, id, name) VALUES ($1, $2, 'Other device')", [userId, deviceId]);
  await db.query(
    `INSERT INTO auth_session (id, user_id, device_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 day')`,
    [randomUUID(), userId, deviceId, hashToken(token)],
  );
  return { userId, token };
}

describe("POST /v1/sync/push", () => {
  it("is idempotent: retrying the same operation creates one record and returns the original result", async () => {
    server = await startTestServer();
    const owner = await setupOwner(server.baseUrl);
    const op = createOp("first note");

    const first = await push(server.baseUrl, owner.token, [op]);
    expect(first.status).toBe(200);
    expect(first.body.results[0]).toMatchObject({ status: "applied", revision: 1, replayed: false });

    const retry = await push(server.baseUrl, owner.token, [op]);
    expect(retry.body.results[0]).toMatchObject({ status: "applied", revision: 1, replayed: true });
    expect(retry.body.results[0].record).toEqual(first.body.results[0].record);

    const { rows } = await server.db.query("SELECT id FROM sync_probe");
    expect(rows).toHaveLength(1);
    const log = await server.db.query("SELECT seq FROM change_log WHERE record_type = 'sync_probe'");
    expect(log.rows).toHaveLength(1);
  });

  it("rejects reuse of an operation ID for different content", async () => {
    server = await startTestServer();
    const owner = await setupOwner(server.baseUrl);
    const op = createOp("original");
    await push(server.baseUrl, owner.token, [op]);
    const reused = await push(server.baseUrl, owner.token, [{ ...op, payload: { text: "different" } }]);
    expect(reused.body.results[0]).toMatchObject({ status: "rejected", error: { code: "IDEMPOTENCY_KEY_REUSED" } });
  });

  it("reports per-operation validation failures without blocking valid operations", async () => {
    server = await startTestServer();
    const owner = await setupOwner(server.baseUrl);
    const good = createOp("valid");
    const res = await push(server.baseUrl, owner.token, [
      { opId: randomUUID(), kind: "sync_probe.create", recordId: "not-a-uuid", payload: { text: "x" } },
      good,
      { kind: "nonsense" },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(["rejected", "applied", "rejected"]);
    expect(res.body.results[0].error.code).toBe("VALIDATION_FAILED");
    expect(res.body.results[2].opId).toBeNull();
  });

  it("applies update and delete with revisions and surfaces stale updates as conflicts", async () => {
    server = await startTestServer();
    const owner = await setupOwner(server.baseUrl);
    const recordId = randomUUID();
    await push(server.baseUrl, owner.token, [createOp("v1", recordId)]);

    const update = await push(server.baseUrl, owner.token, [
      { opId: randomUUID(), kind: "sync_probe.update", recordId, baseRevision: 1, payload: { text: "v2" } },
    ]);
    expect(update.body.results[0]).toMatchObject({ status: "applied", revision: 2 });

    const stale = await push(server.baseUrl, owner.token, [
      { opId: randomUUID(), kind: "sync_probe.update", recordId, baseRevision: 1, payload: { text: "lost?" } },
    ]);
    expect(stale.body.results[0]).toMatchObject({
      status: "conflict",
      current: { text: "v2", revision: 2 },
      submitted: { text: "lost?" },
    });

    const del = await push(server.baseUrl, owner.token, [
      { opId: randomUUID(), kind: "sync_probe.delete", recordId, baseRevision: 2 },
    ]);
    expect(del.body.results[0]).toMatchObject({ status: "applied", revision: 3 });
    expect(del.body.results[0].record.deletedAt).toEqual(expect.any(String));

    const afterDelete = await push(server.baseUrl, owner.token, [
      { opId: randomUUID(), kind: "sync_probe.update", recordId, baseRevision: 3, payload: { text: "zombie" } },
    ]);
    expect(afterDelete.body.results[0].status).toBe("conflict");
  });

  it("handles preference updates through sync with conflict detection", async () => {
    server = await startTestServer();
    const laptop = await setupOwner(server.baseUrl);
    const phone = await login(server.baseUrl);
    const a = await push(server.baseUrl, laptop.token, [
      { opId: randomUUID(), kind: "preferences.update", baseRevision: 1, payload: { language: "fa" } },
    ]);
    expect(a.body.results[0]).toMatchObject({ status: "applied", revision: 2, recordId: laptop.owner.id });
    const b = await push(server.baseUrl, phone.token, [
      { opId: randomUUID(), kind: "preferences.update", baseRevision: 1, payload: { language: "en" } },
    ]);
    expect(b.body.results[0]).toMatchObject({ status: "conflict", current: { language: "fa", revision: 2 } });
  });
});

describe("GET /v1/sync/pull", () => {
  it("returns ordered changes after the cursor, including tombstones, and pages with hasMore", async () => {
    server = await startTestServer();
    const owner = await setupOwner(server.baseUrl);
    const phone = await login(server.baseUrl);

    const initial = await pullAll(server.baseUrl, phone.token);
    expect(initial.body.changes).toHaveLength(1); // preferences revision 1 from setup
    expect(initial.body.changes[0]).toMatchObject({ recordType: "preferences", revision: 1 });

    const recordId = randomUUID();
    await push(server.baseUrl, owner.token, [createOp("hello", recordId)]);
    await push(server.baseUrl, owner.token, [
      { opId: randomUUID(), kind: "sync_probe.delete", recordId, baseRevision: 1 },
    ]);

    const next = await pullAll(server.baseUrl, phone.token, initial.body.nextCursor);
    expect(next.body.changes.map((c: { revision: number; deleted: boolean }) => [c.revision, c.deleted])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(next.body.changes[0].deviceId).toBe(owner.device.id);
    expect(next.body.hasMore).toBe(false);

    const empty = await pullAll(server.baseUrl, phone.token, next.body.nextCursor);
    expect(empty.body.changes).toEqual([]);
    expect(empty.body.nextCursor).toBe(next.body.nextCursor);

    const page = await call(server.baseUrl, "GET", "/v1/sync/pull?limit=1", { token: phone.token });
    expect(page.body.changes).toHaveLength(1);
    expect(page.body.hasMore).toBe(true);
  });

  it("rejects malformed cursors", async () => {
    server = await startTestServer();
    const owner = await setupOwner(server.baseUrl);
    const res = await pullAll(server.baseUrl, owner.token, "garbage!");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("owner isolation", () => {
  it("never exposes or modifies another owner's records", async () => {
    server = await startTestServer();
    const owner = await setupOwner(server.baseUrl);
    const foreign = await insertForeignOwner(server.db);

    const recordId = randomUUID();
    await push(server.baseUrl, owner.token, [createOp("owner secret", recordId)]);

    const update = await push(server.baseUrl, foreign.token, [
      { opId: randomUUID(), kind: "sync_probe.update", recordId, baseRevision: 1, payload: { text: "hijack" } },
    ]);
    expect(update.body.results[0]).toMatchObject({ status: "rejected", error: { code: "NOT_FOUND" } });
    const del = await push(server.baseUrl, foreign.token, [
      { opId: randomUUID(), kind: "sync_probe.delete", recordId, baseRevision: 1 },
    ]);
    expect(del.body.results[0]).toMatchObject({ status: "rejected", error: { code: "NOT_FOUND" } });

    // Same client-generated ID under another owner is a separate record, not a collision leak.
    const sameId = await push(server.baseUrl, foreign.token, [createOp("their own", recordId)]);
    expect(sameId.body.results[0].status).toBe("applied");

    const theirs = await pullAll(server.baseUrl, foreign.token);
    expect(JSON.stringify(theirs.body)).not.toContain("owner secret");
    const mine = await pullAll(server.baseUrl, owner.token);
    expect(JSON.stringify(mine.body)).not.toContain("their own");
    const { rows } = await server.db.query<{ text: string }>(
      "SELECT text FROM sync_probe WHERE user_id = $1",
      [owner.owner.id],
    );
    expect(rows.map((r) => r.text)).toEqual(["owner secret"]);
  });

  it("ignores client-supplied owner fields", async () => {
    server = await startTestServer();
    const owner = await setupOwner(server.baseUrl);
    const foreign = await insertForeignOwner(server.db);
    const op = { ...createOp("mine"), ownerId: foreign.userId, userId: foreign.userId };
    const res = await push(server.baseUrl, owner.token, [op]);
    expect(res.body.results[0].status).toBe("applied");
    const { rows } = await server.db.query<{ user_id: string }>("SELECT user_id FROM sync_probe");
    expect(rows.map((r) => r.user_id)).toEqual([owner.owner.id]);
  });
});
