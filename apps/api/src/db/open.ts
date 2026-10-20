import { mkdir } from "node:fs/promises";
import type { Config } from "../config.ts";
import { createPgliteDb } from "./pglite.ts";
import { createPostgresDb } from "./postgres.ts";
import type { Db } from "./types.ts";

export async function openDatabase(config: Config): Promise<Db> {
  if (config.databaseUrl) return createPostgresDb({ connectionString: config.databaseUrl });
  await mkdir(config.pgliteDataDir, { recursive: true });
  return createPgliteDb(config.pgliteDataDir);
}
