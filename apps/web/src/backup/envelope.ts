import { canonicalBytes } from "./jcs.ts";
import { MAX_ENVELOPE_BYTES, MAX_VERSION_COUNTER, MAX_VERSION_VECTOR_ENTRIES } from "./limits.ts";
import { sha256Hex } from "./sha256.ts";
import type { VersionVector } from "./versions.ts";

/** Record envelope shared by local storage and backup files (docs/BACKUP_FORMAT.md, T-016). */
export interface Envelope {
  id: string;
  createdAt: string;
  updatedAt: string;
  version: VersionVector;
  contentHash: string;
  data: Record<string, unknown>;
}

export interface Tombstone {
  type: string;
  id: string;
  deletedAt: string;
  version: VersionVector;
}

/** SHA-256 over the JCS-canonical `data` (synchronous, safe inside IndexedDB transactions). */
export function contentHashOf(data: unknown): string {
  return sha256Hex(canonicalBytes(data));
}

export function makeEnvelope(
  id: string,
  data: Record<string, unknown>,
  version: VersionVector,
  createdAt: string,
  updatedAt = createdAt,
): Envelope {
  return { id, createdAt, updatedAt, version, contentHash: contentHashOf(data), data };
}

export const nowIso = () => new Date().toISOString();

/**
 * A per-record limit of the backup format: the version vector's devices, a device's edit counter
 * in it (`versionCounter`, at most `MAX_VERSION_COUNTER`), or the envelope's size.
 */
export type EnvelopeLimit = "devices" | "versionCounter" | "size";

/** Which limit of the backup format a version vector would break: devices, or a counter past its maximum. */
function vectorLimitProblem(version: Record<string, number>): "devices" | "versionCounter" | null {
  if (Object.keys(version).length > MAX_VERSION_VECTOR_ENTRIES) return "devices";
  return Object.values(version).some((n) => !(n <= MAX_VERSION_COUNTER)) ? "versionCounter" : null;
}

/**
 * Which per-record limit of the backup format an envelope, exactly as it would be stored and
 * exported (its ID, timestamps, version vector, content hash, and data; never a stored row's extra
 * fields), would break, or null: at most `MAX_VERSION_VECTOR_ENTRIES` (32) devices in its version
 * vector, each counter at most `MAX_VERSION_COUNTER`, and at most `MAX_ENVELOPE_BYTES` (256 KiB) in
 * canonical JSON. Imports refuse each. Every local increment of a counter (`bumpVersion`) is written
 * through this check or `tombstoneLimitProblem`, so a counter at its maximum is never passed.
 */
export function envelopeLimitProblem(e: Envelope): EnvelopeLimit | null {
  const vector = vectorLimitProblem(e.version);
  if (vector) return vector;
  const { id, createdAt, updatedAt, version, contentHash, data } = e;
  return canonicalBytes({ id, createdAt, updatedAt, version, contentHash, data }).length > MAX_ENVELOPE_BYTES ? "size" : null;
}

/** Whether an envelope is within every per-record limit of the backup format. */
export const envelopeFits = (e: Envelope) => envelopeLimitProblem(e) === null;

/** Which limit of the backup format a tombstone's version vector would break (32 devices, or a counter), or null. */
export const tombstoneLimitProblem = (t: Tombstone) => vectorLimitProblem(t.version);
