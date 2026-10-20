import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, hostnameOf } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createPgliteDb } from "../src/db/pglite.ts";
import type { Db } from "../src/db/types.ts";
import { listen } from "../src/http/listen.ts";
import { newDevice, TEST_PASSWORD } from "./helpers.ts";

let server: Server | undefined;
let db: Db | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await db?.close();
  server = undefined;
  db = undefined;
});

async function start(env: NodeJS.ProcessEnv) {
  db = await createPgliteDb();
  await migrate(db);
  const config = loadConfig({ PORT: "0", ...env });
  server = await listen(createApp(db, config), config);
  return server.address() as AddressInfo;
}

/** Raw request so the Host header can be set (fetch does not allow overriding it). */
function send(port: number, path: string, host: string, body?: unknown): Promise<{ status: number; body: any }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: payload ? "POST" : "GET",
        headers: { host, ...(payload ? { "content-type": "application/json" } : {}) },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("network exposure", () => {
  it("binds to 127.0.0.1 by default", async () => {
    const address = await start({});
    expect(address.address).toBe("127.0.0.1");
  });

  it("rejects requests whose Host header is not a loopback name (DNS rebinding)", async () => {
    const { port } = await start({});
    const rebound = await send(port, "/v1/setup", `attacker.example:${port}`, {
      email: "owner@example.test",
      password: TEST_PASSWORD,
      device: newDevice(),
    });
    expect(rebound.status).toBe(403);
    expect(rebound.body.error.code).toBe("HOST_NOT_ALLOWED");
    const { rows } = await db!.query("SELECT 1 FROM app_installation");
    expect(rows).toHaveLength(0);

    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, "LOCALHOST"]) {
      const ok = await send(port, "/v1/setup/status", host);
      expect(ok.status, host).toBe(200);
    }
  });

  it("when exposed, accepts other host names but still requires the setup token for setup", async () => {
    const token = "t".repeat(32);
    const { port } = await start({ HOST: "0.0.0.0", SETUP_TOKEN: token });
    const status = await send(port, "/v1/setup/status", `my-pc.local:${port}`);
    expect(status.status).toBe(200);
    const setup = await send(port, "/v1/setup", `my-pc.local:${port}`, {
      email: "owner@example.test",
      password: TEST_PASSWORD,
      device: newDevice(),
    });
    expect(setup.status).toBe(403);
    expect(setup.body.error.code).toBe("SETUP_TOKEN_INVALID");
  });
});

describe("hostnameOf", () => {
  it("extracts the host name without port, including IPv6 literals", () => {
    expect(hostnameOf("localhost:8787")).toBe("localhost");
    expect(hostnameOf("127.0.0.1")).toBe("127.0.0.1");
    expect(hostnameOf("[::1]:8787")).toBe("::1");
    expect(hostnameOf("Example.COM")).toBe("example.com");
    expect(hostnameOf(undefined)).toBeNull();
    expect(hostnameOf("[::1")).toBeNull();
  });
});
