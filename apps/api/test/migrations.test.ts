import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrate } from "../src/db/migrate.ts";
import type { Db } from "../src/db/types.ts";
import { createTestDb } from "./helpers.ts";

let db: Db | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

const EXPECTED_TABLES = [
  "app_installation",
  "app_user",
  "auth_session",
  "change_log",
  "schema_migrations",
  "sync_device",
  "sync_operation",
  "sync_probe",
  "user_preference",
];

describe("migrations", () => {
  it("migrate from an empty database creates every table", async () => {
    db = await createTestDb();
    const report = await migrate(db);
    expect(report.applied).toEqual(["0001_foundation.sql"]);

    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES);
  });

  it("is idempotent when run again", async () => {
    db = await createTestDb();
    await migrate(db);
    const second = await migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(["0001_foundation.sql"]);
  });

  it("refuses to run when an applied migration was edited", async () => {
    db = await createTestDb();
    const migrations = await loadMigrations();
    await migrate(db, migrations);
    const tampered = migrations.map((m) => ({ ...m, checksum: `${m.checksum}x` }));
    await expect(migrate(db, tampered)).rejects.toThrow(/checksum mismatch/);
  });

  it("enforces the single-owner installation row and preference checks", async () => {
    db = await createTestDb();
    await migrate(db);
    const owner = "11111111-1111-4111-8111-111111111111";
    await db.query("INSERT INTO app_user (id, email, password_hash) VALUES ($1, 'a@example.test', 'x')", [owner]);
    await db.query("INSERT INTO app_installation (owner_id) VALUES ($1)", [owner]);
    const other = "22222222-2222-4222-8222-222222222222";
    await db.query("INSERT INTO app_user (id, email, password_hash) VALUES ($1, 'b@example.test', 'x')", [other]);
    await expect(db.query("INSERT INTO app_installation (owner_id) VALUES ($1)", [other])).rejects.toMatchObject({
      code: "23505",
    });
    await expect(
      db.query(
        `INSERT INTO user_preference (user_id, language, theme, calendar_display, week_start, revision)
         VALUES ($1, 'de', 'system', 'gregorian', 6, 1)`,
        [owner],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
