import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { SessionResponse } from "@pps/shared";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { createPgliteDb } from "../src/db/pglite.ts";
import { createPostgresDb } from "../src/db/postgres.ts";
import type { Db } from "../src/db/types.ts";

/**
 * In-memory PGlite by default. When TEST_DATABASE_URL is set, uses that real PostgreSQL
 * server with a fresh schema per call, dropped on close.
 */
export async function createTestDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createPgliteDb();

  const schema = `pps_test_${randomUUID().replace(/-/g, "")}`;
  const admin = createPostgresDb({ connectionString: url, max: 1 });
  await admin.exec(`CREATE SCHEMA ${schema}`);
  await admin.close();
  const db = createPostgresDb({ connectionString: url, schema });
  return {
    ...db,
    close: async () => {
      await db.exec(`DROP SCHEMA ${schema} CASCADE`);
      await db.close();
    },
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    exposed: false,
    port: 0,
    production: false,
    databaseUrl: null,
    pgliteDataDir: "",
    setupToken: null,
    sessionTtlDays: 365,
    ...overrides,
  };
}

export interface TestServer {
  db: Db;
  baseUrl: string;
  close(): Promise<void>;
}

export async function startTestServer(options: { config?: Partial<Config>; db?: Db } = {}): Promise<TestServer> {
  const db = options.db ?? (await createTestDb());
  await migrate(db);
  const server = createApp(db, testConfig(options.config)).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!options.db) await db.close();
    },
  };
}

export interface CallResult<T = any> {
  status: number;
  body: T;
}

export async function call<T = any>(
  baseUrl: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string } = {},
): Promise<CallResult<T>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers["content-type"] = "application/json";
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export const TEST_PASSWORD = "correct horse battery staple";

export function newDevice(name = "Test device") {
  return { id: randomUUID(), name };
}

export async function setupOwner(
  baseUrl: string,
  extra: { headers?: Record<string, string>; preferences?: Record<string, unknown> } = {},
): Promise<SessionResponse> {
  const res = await call<SessionResponse>(baseUrl, "POST", "/v1/setup", {
    headers: extra.headers,
    body: {
      email: "owner@example.test",
      password: TEST_PASSWORD,
      device: newDevice("Windows laptop"),
      ...(extra.preferences ? { preferences: extra.preferences } : {}),
    },
  });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function login(baseUrl: string, deviceName = "Android phone"): Promise<SessionResponse> {
  const res = await call<SessionResponse>(baseUrl, "POST", "/v1/auth/session", {
    body: { email: "owner@example.test", password: TEST_PASSWORD, device: newDevice(deviceName) },
  });
  if (res.status !== 201) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
