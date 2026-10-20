import { PGlite } from "@electric-sql/pglite";
import type { Db, Queryable } from "./types.ts";

interface PgliteLike {
  query<Row>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  exec(sql: string): Promise<unknown>;
}

function wrap(target: PgliteLike): Queryable {
  return {
    query: (sql, params) => target.query(sql, params),
    exec: async (sql) => {
      await target.exec(sql);
    },
  };
}

/**
 * Embedded PostgreSQL (WASM). `dataDir` undefined means in-memory (tests).
 * PGlite has a single connection; its transaction() holds an exclusive lock, so
 * concurrent transactions are serialized.
 */
export async function createPgliteDb(dataDir?: string): Promise<Db & { pglite: PGlite }> {
  const pglite = dataDir ? new PGlite(dataDir) : new PGlite();
  await pglite.waitReady;
  const base = wrap(pglite as unknown as PgliteLike);
  return {
    ...base,
    kind: "pglite",
    pglite,
    transaction: (fn) => pglite.transaction((tx) => fn(wrap(tx as unknown as PgliteLike))),
    close: () => pglite.close(),
  };
}
