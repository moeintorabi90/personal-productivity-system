import { afterEach, describe, expect, it } from "vitest";
import { call, login, newDevice, setupOwner, startTestServer, TEST_PASSWORD, type TestServer } from "./helpers.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("owner setup", () => {
  it("creates the owner exactly once and returns a working session", async () => {
    server = await startTestServer();
    const status = await call(server.baseUrl, "GET", "/v1/setup/status");
    expect(status.body).toEqual({ setupCompleted: false });

    const session = await setupOwner(server.baseUrl, { preferences: { language: "fa", timeZone: "Asia/Tehran" } });
    expect(session.owner.email).toBe("owner@example.test");
    expect(session.preferences).toMatchObject({ language: "fa", timeZone: "Asia/Tehran", weekStart: 6, revision: 1 });

    const me = await call(server.baseUrl, "GET", "/v1/me", { token: session.token });
    expect(me.status).toBe(200);
    expect(me.body.owner.id).toBe(session.owner.id);

    const again = await call(server.baseUrl, "POST", "/v1/setup", {
      body: { email: "intruder@example.test", password: TEST_PASSWORD, device: newDevice() },
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("SETUP_ALREADY_COMPLETED");
    expect((await call(server.baseUrl, "GET", "/v1/setup/status")).body).toEqual({ setupCompleted: true });
  });

  it("requires the setup token when one is configured", async () => {
    server = await startTestServer({ config: { setupToken: "s3cret-setup-token" } });
    const body = { email: "owner@example.test", password: TEST_PASSWORD, device: newDevice() };
    const missing = await call(server.baseUrl, "POST", "/v1/setup", { body });
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe("SETUP_TOKEN_INVALID");
    const wrong = await call(server.baseUrl, "POST", "/v1/setup", { body, headers: { "x-setup-token": "nope" } });
    expect(wrong.status).toBe(403);
    const ok = await call(server.baseUrl, "POST", "/v1/setup", {
      body,
      headers: { "x-setup-token": "s3cret-setup-token" },
    });
    expect(ok.status).toBe(201);
  });

  it("validates input with field errors and never echoes the password", async () => {
    server = await startTestServer();
    const res = await call(server.baseUrl, "POST", "/v1/setup", {
      body: { email: "not-an-email", password: "short", device: { id: "x", name: "" } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(Object.keys(res.body.error.fieldErrors)).toEqual(
      expect.arrayContaining(["email", "password", "device.id", "device.name"]),
    );
    expect(JSON.stringify(res.body)).not.toContain("short");
  });

  it("rejects malformed JSON with a stable error", async () => {
    server = await startTestServer();
    const res = await call(server.baseUrl, "POST", "/v1/setup", { rawBody: "{nope" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("sessions and devices", () => {
  it("signs in a second device, rejects wrong passwords, and signs out", async () => {
    server = await startTestServer();
    await setupOwner(server.baseUrl);

    const bad = await call(server.baseUrl, "POST", "/v1/auth/session", {
      body: { email: "owner@example.test", password: "wrong password!!", device: newDevice() },
    });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("INVALID_CREDENTIALS");
    const unknown = await call(server.baseUrl, "POST", "/v1/auth/session", {
      body: { email: "nobody@example.test", password: TEST_PASSWORD, device: newDevice() },
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe("INVALID_CREDENTIALS");

    const phone = await login(server.baseUrl, "Android phone");
    expect((await call(server.baseUrl, "GET", "/v1/me", { token: phone.token })).body.device.name).toBe(
      "Android phone",
    );

    const out = await call(server.baseUrl, "DELETE", "/v1/auth/session", { token: phone.token });
    expect(out.status).toBe(204);
    const after = await call(server.baseUrl, "GET", "/v1/me", { token: phone.token });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("returns a stable 404 for unknown routes", async () => {
    server = await startTestServer();
    const res = await call(server.baseUrl, "GET", "/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("requires authentication on owner routes", async () => {
    server = await startTestServer();
    for (const [method, path] of [
      ["GET", "/v1/me"],
      ["GET", "/v1/preferences"],
      ["GET", "/v1/sync/pull"],
      ["POST", "/v1/sync/push"],
      ["GET", "/v1/devices"],
    ] as const) {
      const res = await call(server.baseUrl, method, path, { token: "invalid-token-value-123456" });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("revoking a device ends its sessions", async () => {
    server = await startTestServer();
    const laptop = await setupOwner(server.baseUrl);
    const phone = await login(server.baseUrl, "Android phone");

    const list = await call(server.baseUrl, "GET", "/v1/devices", { token: laptop.token });
    expect(list.body.devices).toHaveLength(2);

    const revoke = await call(server.baseUrl, "POST", `/v1/devices/${phone.device.id}/revoke`, { token: laptop.token });
    expect(revoke.status).toBe(204);
    expect((await call(server.baseUrl, "GET", "/v1/me", { token: phone.token })).status).toBe(401);
    expect((await call(server.baseUrl, "GET", "/v1/me", { token: laptop.token })).status).toBe(200);
  });

  it("rate-limits repeated failed sign-ins", async () => {
    server = await startTestServer();
    await setupOwner(server.baseUrl);
    const body = { email: "owner@example.test", password: "wrong password!!", device: newDevice() };
    for (let i = 0; i < 10; i++) {
      expect((await call(server.baseUrl, "POST", "/v1/auth/session", { body })).status).toBe(401);
    }
    const blocked = await call(server.baseUrl, "POST", "/v1/auth/session", { body });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  }, 60_000);

  it("stores only a hash of session tokens", async () => {
    server = await startTestServer();
    const session = await setupOwner(server.baseUrl);
    const { rows } = await server.db.query<{ token_hash: string }>("SELECT token_hash FROM auth_session");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toContain(session.token);
    const users = await server.db.query<{ password_hash: string }>("SELECT password_hash FROM app_user");
    expect(users.rows[0]!.password_hash.startsWith("scrypt$")).toBe(true);
  });
});
