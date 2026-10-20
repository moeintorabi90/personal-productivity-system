export interface QueryResult<Row> {
  rows: Row[];
}

/** Minimal surface shared by PGlite and node-postgres, so the same SQL runs on both. */
export interface Queryable {
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
  /** Runs one or more statements without parameters (used by migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: "pglite" | "postgres";
}

/** PGlite and pg return different JS types for timestamptz/int8; normalize at the boundary. */
export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new TypeError(`Expected a timestamp, got ${typeof value}`);
}

export function toIsoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

export function toInt(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : (value as number);
  if (!Number.isSafeInteger(n)) throw new TypeError(`Expected an integer, got ${String(value)}`);
  return n;
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}
