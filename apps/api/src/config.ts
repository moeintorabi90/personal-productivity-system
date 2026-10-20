import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * Default PGlite location: outside the repository, in the user's local app-data folder.
 * PGlite cannot store data on exFAT (this repo's drive E: fails with errno 28), and database
 * files should not live in the source tree anyway.
 */
function defaultPgliteDir(env: NodeJS.ProcessEnv): string {
  const base = env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "PersonalProductivitySystem", "pglite-dev");
}

/** Host names/addresses that are reachable only from this machine. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

/** Minimum SETUP_TOKEN length (24 random base64url characters ≈ 144 bits). */
export const SETUP_TOKEN_MIN_LENGTH = 24;

export interface Config {
  /** Interface the HTTP server binds to. Defaults to loopback (127.0.0.1). */
  host: string;
  /** True when `host` is not loopback, i.e. other devices on the network may connect. */
  exposed: boolean;
  port: number;
  production: boolean;
  databaseUrl: string | null;
  pgliteDataDir: string;
  setupToken: string | null;
  /** Lifetime of a device session; devices may stay offline for long periods. */
  sessionTtlDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const setupToken = env.SETUP_TOKEN?.trim() || null;
  const databaseUrl = env.DATABASE_URL?.trim() || null;

  // Safe by default: only this machine can reach the API unless HOST is set explicitly.
  const host = env.HOST?.trim() || "127.0.0.1";
  const exposed = !LOOPBACK_HOSTS.has(host.toLowerCase());

  if (setupToken && setupToken.length < SETUP_TOKEN_MIN_LENGTH) {
    throw new Error(`SETUP_TOKEN must be at least ${SETUP_TOKEN_MIN_LENGTH} characters (use a random value).`);
  }
  if (exposed && !setupToken) {
    throw new Error(
      `HOST=${host} makes the API reachable from other devices. Set SETUP_TOKEN so nobody else can claim the owner account, or remove HOST to listen on 127.0.0.1 only.`,
    );
  }
  if (production && !setupToken) {
    throw new Error("SETUP_TOKEN must be set when NODE_ENV=production so nobody else can claim the owner account.");
  }
  if (production && !databaseUrl) {
    throw new Error("DATABASE_URL must point at PostgreSQL when NODE_ENV=production.");
  }

  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);

  return {
    host,
    exposed,
    port,
    production,
    databaseUrl,
    pgliteDataDir: env.PGLITE_DATA_DIR?.trim()
      ? path.resolve(API_ROOT, env.PGLITE_DATA_DIR.trim())
      : defaultPgliteDir(env),
    setupToken,
    sessionTtlDays: 365,
  };
}
