import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./types.ts";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Arbitrary constant key so two processes never apply migrations at the same time.
const MIGRATION_LOCK_KEY = 727_274_001;

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const match = FILE_PATTERN.exec(file);
    if (!match) throw new Error(`Migration file name must look like 0001_name.sql: ${file}`);
    // Normalize line endings so a Windows checkout and a Linux server compute the same checksum.
    const sql = (await readFile(path.join(dir, file), "utf8")).replace(/\r\n/g, "\n");
    migrations.push({
      version: match[1]!,
      name: file,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  const versions = new Set(migrations.map((m) => m.version));
  if (versions.size !== migrations.length) throw new Error("Duplicate migration version numbers");
  return migrations;
}

export interface MigrationReport {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Applies pending migrations in order, each in its own transaction. Refuses to run if an
 * already-applied migration file was edited (checksum mismatch): add a new migration instead.
 */
export async function migrate(db: Db, migrations?: Migration[]): Promise<MigrationReport> {
  const all = migrations ?? (await loadMigrations());
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const report: MigrationReport = { applied: [], alreadyApplied: [] };
  for (const migration of all) {
    await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      const existing = await tx.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [migration.version],
      );
      const row = existing.rows[0];
      if (row) {
        if (row.checksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.name} was modified after it was applied (checksum mismatch). Create a new migration instead.`,
          );
        }
        report.alreadyApplied.push(migration.name);
        return;
      }
      await tx.exec(migration.sql);
      await tx.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
        migration.version,
        migration.name,
        migration.checksum,
      ]);
      report.applied.push(migration.name);
    });
  }
  return report;
}
