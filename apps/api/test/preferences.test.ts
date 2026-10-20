import { afterEach, describe, expect, it } from "vitest";
import { call, login, setupOwner, startTestServer, type TestServer } from "./helpers.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("GET/PATCH /v1/preferences", () => {
  it("returns defaults and applies a validated change with a new revision", async () => {
    server = await startTestServer();
    const owner = await setupOwner(server.baseUrl);
    const initial = await call(server.baseUrl, "GET", "/v1/preferences", { token: owner.token });
    expect(initial.body).toMatchObject({
      language: "en",
      theme: "system",
      calendarDisplay: "gregorian",
      weekStart: 6,
      timeZone: null,
      revision: 1,
    });

    const patched = await call(server.baseUrl, "PATCH", "/v1/preferences", {
      token: owner.token,
      body: { baseRevision: 1, changes: { language: "fa", theme: "dark", timeZone: "Asia/Tehran" } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ language: "fa", theme: "dark", timeZone: "Asia/Tehran", revision: 2 });
  });

  it("rejects invalid values and unknown fields such as ownerId", async () => {
    server = await startTestServer();
    const owner = await setupOwner(server.baseUrl);
    for (const changes of [{ timeZone: "+03:30" }, { weekStart: 7 }, { language: "de" }, { ownerId: owner.owner.id }]) {
      const res = await call(server.baseUrl, "PATCH", "/v1/preferences", {
        token: owner.token,
        body: { baseRevision: 1, changes },
      });
      expect(res.status, JSON.stringify(changes)).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("reports a conflict instead of overwriting a concurrent edit", async () => {
    server = await startTestServer();
    const laptop = await setupOwner(server.baseUrl);
    const phone = await login(server.baseUrl);

    const first = await call(server.baseUrl, "PATCH", "/v1/preferences", {
      token: laptop.token,
      body: { baseRevision: 1, changes: { theme: "dark" } },
    });
    expect(first.status).toBe(200);

    const stale = await call(server.baseUrl, "PATCH", "/v1/preferences", {
      token: phone.token,
      body: { baseRevision: 1, changes: { theme: "light" } },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("CONFLICT");
    expect(stale.body.error.details.current).toMatchObject({ theme: "dark", revision: 2 });
    expect(stale.body.error.details.submitted).toEqual({ theme: "light" });

    const now = await call(server.baseUrl, "GET", "/v1/preferences", { token: phone.token });
    expect(now.body).toMatchObject({ theme: "dark", revision: 2 });
  });
});
