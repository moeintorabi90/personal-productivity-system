import { base64DecodedLength } from "./base64.ts";
import { decryptPayload } from "./crypto.ts";
import { BackupError } from "./errors.ts";
import {
  type BackupHeader,
  type BackupPayload,
  checkEncryptionLengths,
  HEADER_KEYS,
  headerOf,
  headerSchema,
  integritySchema,
  validatePayload,
} from "./format.ts";
import { canonicalBytes } from "./jcs.ts";
import { BACKUP_FORMAT, DATA_SCHEMA_VERSION, FORMAT_VERSION, MAX_FILE_BYTES, MAX_PLAINTEXT_BYTES } from "./limits.ts";
import type { Registry } from "./registry.ts";
import { scanJson } from "./scan.ts";
import { sha256HexAsync } from "./sha256.ts";

/** Anything with a size and readable bytes (File, Blob). */
export interface BlobLike {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface CheckedBackup {
  header: BackupHeader;
  encrypted: boolean;
  /** Plaintext payload (unvalidated) or `{ ciphertext }` for encrypted files. */
  rawPayload: unknown;
}

export interface OpenedBackup {
  header: BackupHeader;
  payload: BackupPayload;
}

const decoder = () => new TextDecoder("utf-8", { fatal: true });

/** Steps 2–4 of the validation order: fatal UTF-8 decode, pre-parse scan, then JSON.parse. */
function decodeAndParse(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = decoder().decode(bytes);
  } catch {
    throw new BackupError("INVALID_UTF8");
  }
  const scan = scanJson(text);
  if (!scan.ok) throw new BackupError("INVALID_STRUCTURE", scan.reason);
  try {
    return JSON.parse(text);
  } catch {
    throw new BackupError("INVALID_JSON");
  }
}

/**
 * Steps 1–6 of the validation order (docs/BACKUP_FORMAT.md): size, UTF-8, pre-parse scan,
 * JSON.parse, strict header (including all encryption parameters), integrity hash. Runs before
 * any password prompt and never performs key derivation.
 */
export async function checkBackupFile(file: BlobLike): Promise<CheckedBackup> {
  if (file.size > MAX_FILE_BYTES) throw new BackupError("FILE_TOO_LARGE");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) throw new BackupError("FILE_TOO_LARGE");

  const doc = decodeAndParse(bytes);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new BackupError("NOT_A_BACKUP");
  const record = doc as Record<string, unknown>;
  if (record.format !== BACKUP_FORMAT) throw new BackupError("NOT_A_BACKUP");
  if (typeof record.formatVersion === "number" && record.formatVersion > FORMAT_VERSION) {
    throw new BackupError("NEWER_VERSION");
  }
  const app = record.app as { dataSchemaVersion?: unknown } | undefined;
  if (typeof app?.dataSchemaVersion === "number" && app.dataSchemaVersion > DATA_SCHEMA_VERSION) {
    throw new BackupError("NEWER_VERSION");
  }

  const allowedKeys = new Set<string>([...HEADER_KEYS, "payload", "integrity"]);
  for (const key of Object.keys(record)) if (!allowedKeys.has(key)) throw new BackupError("INVALID_HEADER", `unknown field ${key}`);

  const header = headerSchema.safeParse(headerOf(record));
  if (!header.success) {
    const issue = header.error.issues[0];
    throw new BackupError("INVALID_HEADER", `${issue?.path.join(".")}: ${issue?.message}`);
  }
  // Every version from 1 to the current one is read (older ones are upgraded in validatePayload).
  if (header.data.app.dataSchemaVersion > DATA_SCHEMA_VERSION) throw new BackupError("NEWER_VERSION");
  const encryption = header.data.encryption;
  if (encryption) {
    checkEncryptionLengths(encryption);
    const payload = record.payload as { ciphertext?: unknown } | undefined;
    if (!payload || typeof payload !== "object" || Object.keys(payload).join() !== "ciphertext" || typeof payload.ciphertext !== "string") {
      throw new BackupError("INVALID_HEADER", "encrypted payload must be { ciphertext }");
    }
    if (payload.ciphertext.length % 4 !== 0 || base64DecodedLength(payload.ciphertext) > MAX_PLAINTEXT_BYTES + 16) {
      throw new BackupError("LIMIT_EXCEEDED", "ciphertext too large");
    }
  }

  const integrity = integritySchema.safeParse(record.integrity);
  if (!integrity.success) throw new BackupError("DAMAGED", "missing or invalid integrity block");
  const { integrity: _omit, ...withoutIntegrity } = record;
  const actual = await sha256HexAsync(canonicalBytes(withoutIntegrity));
  if (actual !== integrity.data.hash) throw new BackupError("DAMAGED");

  return { header: header.data, encrypted: !!encryption, rawPayload: record.payload };
}

/**
 * Step 7: decrypt (encrypted files only) and decode/scan/parse the plaintext; step 8: validate
 * the payload against the record-type registry.
 */
export async function openCheckedBackup(checked: CheckedBackup, registry: Registry, password?: string): Promise<OpenedBackup> {
  let rawPayload = checked.rawPayload;
  if (checked.encrypted) {
    if (!password) throw new BackupError("PASSWORD_REQUIRED");
    const encryption = checked.header.encryption!;
    const aad = canonicalBytes(checked.header) as Uint8Array<ArrayBuffer>;
    const plaintext = await decryptPayload(encryption, (rawPayload as { ciphertext: string }).ciphertext, aad, password);
    if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new BackupError("LIMIT_EXCEEDED", "decrypted payload too large");
    rawPayload = decodeAndParse(plaintext);
  }
  return { header: checked.header, payload: validatePayload(rawPayload, registry, checked.header.app.dataSchemaVersion) };
}

/** Convenience: all checks and decryption in order. */
export async function openBackupFile(file: BlobLike, registry: Registry, password?: string): Promise<OpenedBackup> {
  return openCheckedBackup(await checkBackupFile(file), registry, password);
}
