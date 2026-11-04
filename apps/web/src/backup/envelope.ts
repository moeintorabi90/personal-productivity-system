import { canonicalBytes } from "./jcs.ts";
import { MAX_ENVELOPE_BYTES } from "./limits.ts";
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
 * Whether an envelope, exactly as it would be stored and exported (its ID, timestamps, version
 * vector, content hash, and data; never a stored row's extra fields), is within the per-record
 * limit that exports and imports enforce (`MAX_ENVELOPE_BYTES`, 256 KiB).
 */
export function envelopeFits(e: Envelope): boolean {
  const { id, createdAt, updatedAt, version, contentHash, data } = e;
  return canonicalBytes({ id, createdAt, updatedAt, version, contentHash, data }).length <= MAX_ENVELOPE_BYTES;
}
