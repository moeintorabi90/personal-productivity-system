import pg from "pg";
import type { Db, Queryable } from "./types.ts";

function wrap(target: pg.Pool | pg.PoolClient): Queryable {
  return {
    query: async (sql, params) => {
      const result = await target.query(sql, params as unknown[] | undefined);
      return { rows: result.rows };
    },
    exec: async (sql) => {
      // Without parameters, node-postgres uses the simple protocol, which allows multiple statements.
      await target.query(sql);
    },
  };
}

export interface PostgresOptions {
  connectionString: string;
  /** Optional schema placed first on search_path (used by tests for isolation). */
  schema?: string;
  max?: number;
}

export function createPostgresDb(options: PostgresOptions): Db & { pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 5,
    ...(options.schema ? { options: `-c search_path=${options.schema},public` } : {}),
  });
  return {
    ...wrap(pool),
    kind: "postgres",
    pool,
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrap(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
