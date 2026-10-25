import { LANGUAGES, THEMES } from "@pps/shared";
import { z } from "zod";
import type { DeviceSettings, VersionEntry } from "../local/db.ts";
import { base64DecodedLength } from "./base64.ts";
import { contentHashOf, type Envelope, type Tombstone } from "./envelope.ts";
import { BackupError } from "./errors.ts";
import { canonicalBytes } from "./jcs.ts";
import {
  BACKUP_FORMAT,
  DATA_SCHEMA_VERSION,
  FORMAT_VERSION,
  IV_BYTES,
  KDF_ITERATIONS_MAX,
  KDF_ITERATIONS_MIN,
  MAX_DEVICE_NAME_CHARS,
  MAX_ENTRIES,
  MAX_ENVELOPE_BYTES,
  MAX_VERSION_VECTOR_ENTRIES,
  SALT_BYTES,
  WRAPPED_KEY_BYTES,
} from "./limits.ts";
import { EXCLUDED_RECORD_TYPES, type Registry, registryForDataSchemaVersion } from "./registry.ts";

/* ---------------- header ---------------- */

const base64String = z.string().max(64 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const isoInstant = z.iso.datetime();

export const encryptionSchema = z
  .object({
    scheme: z.literal("pps-enc-1"),
    content: z
      .object({
        cipher: z.literal("AES-256-GCM"),
        iv: base64String,
        tagBits: z.literal(128),
        aad: z.literal("header-jcs"),
      })
      .strict(),
    keySlots: z
      .array(
        z
          .object({
            type: z.literal("password"),
            kdf: z
              .object({
                name: z.literal("PBKDF2"),
                hash: z.literal("SHA-256"),
                iterations: z.number().int().min(KDF_ITERATIONS_MIN).max(KDF_ITERATIONS_MAX),
                salt: base64String,
              })
              .strict(),
            wrap: z.object({ cipher: z.literal("AES-256-GCM"), iv: base64String }).strict(),
            wrappedKey: base64String,
          })
          .strict(),
      )
      .length(1),
  })
  .strict();

export type EncryptionInfo = z.infer<typeof encryptionSchema>;

export const headerSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    formatVersion: z.literal(FORMAT_VERSION),
    backupId: z.uuid(),
    createdAt: isoInstant,
    app: z.object({ version: z.string().min(1).max(32), dataSchemaVersion: z.number().int().min(1) }).strict(),
    sourceDevice: z.object({ id: z.uuid(), name: z.string().max(MAX_DEVICE_NAME_CHARS) }).strict(),
    encryption: encryptionSchema.nullable(),
  })
  .strict();

export type BackupHeader = z.infer<typeof headerSchema>;

export const integritySchema = z
  .object({
    algorithm: z.literal("SHA-256"),
    canonicalization: z.literal("JCS-RFC8785"),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const HEADER_KEYS = ["format", "formatVersion", "backupId", "createdAt", "app", "sourceDevice", "encryption"] as const;

export function headerOf(doc: Record<string, unknown>): Record<string, unknown> {
  const header: Record<string, unknown> = {};
  for (const key of HEADER_KEYS) header[key] = doc[key];
  return header;
}

/** Exact byte lengths of the encryption parameters (checked before any key derivation). */
export function checkEncryptionLengths(encryption: EncryptionInfo): void {
  const slot = encryption.keySlots[0]!;
  const checks: [string, string, number][] = [
    ["content.iv", encryption.content.iv, IV_BYTES],
    ["kdf.salt", slot.kdf.salt, SALT_BYTES],
    ["wrap.iv", slot.wrap.iv, IV_BYTES],
    ["wrappedKey", slot.wrappedKey, WRAPPED_KEY_BYTES],
  ];
  for (const [name, value, expected] of checks) {
    if (value.length % 4 !== 0 || base64DecodedLength(value) !== expected) {
      throw new BackupError("INVALID_HEADER", `${name} must be ${expected} bytes`);
    }
  }
}

/* ---------------- payload ---------------- */

export interface BackupPayload {
  records: Record<string, Envelope[]>;
  tombstones: Tombstone[];
  pendingConflicts: CarriedConflict[];
  replacedVersions: CarriedReplaced[];
  sourceDeviceSettings: DeviceSettings;
}

export interface CarriedConflict {
  conflictId: string;
  kind: "edit" | "deletedHere" | "deletedInBackup" | "history";
  type: string;
  id: string;
  local: VersionEntry | null;
  incoming: VersionEntry;
  source: { backupId: string; deviceId: string; deviceName: string; exportedAt: string };
  detectedAt: string;
  /** Absent in entries written before it was added (unknown device; never filled in). */
  detectedOn?: { deviceId: string; deviceName: string };
}

export interface CarriedReplaced {
  replacedId: string;
  type: string;
  id: string;
  entry: VersionEntry;
  replacedAt: string;
  reason: string;
}

const versionVectorSchema = z
  .record(z.uuid(), z.number().int().min(1).max(Number.MAX_SAFE_INTEGER))
  .refine((v) => Object.keys(v).length <= MAX_VERSION_VECTOR_ENTRIES, {
    message: `at most ${MAX_VERSION_VECTOR_ENTRIES} devices`,
  });

const envelopeShape = z
  .object({
    id: z.uuid(),
    createdAt: isoInstant,
    updatedAt: isoInstant,
    version: versionVectorSchema,
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

const tombstoneShape = z
  .object({ type: z.string().min(1).max(64), id: z.uuid(), deletedAt: isoInstant, version: versionVectorSchema })
  .strict();

const entryShape = z.discriminatedUnion("deleted", [
  z.object({ deleted: z.literal(false), envelope: envelopeShape }).strict(),
  z.object({ deleted: z.literal(true), tombstone: tombstoneShape }).strict(),
]);

const sourceShape = z
  .object({ backupId: z.uuid(), deviceId: z.uuid(), deviceName: z.string().max(MAX_DEVICE_NAME_CHARS), exportedAt: isoInstant })
  .strict();

const conflictShape = z
  .object({
    conflictId: z.uuid(),
    kind: z.enum(["edit", "deletedHere", "deletedInBackup", "history"]),
    type: z.string().min(1).max(64),
    id: z.uuid(),
    local: entryShape.nullable(),
    incoming: entryShape,
    source: sourceShape,
    detectedAt: isoInstant,
    // Optional within format version 1: files from the first Stage 1B build have no such field.
    detectedOn: z.object({ deviceId: z.uuid(), deviceName: z.string().max(MAX_DEVICE_NAME_CHARS) }).strict().optional(),
  })
  .strict();

const replacedShape = z
  .object({
    replacedId: z.uuid(),
    type: z.string().min(1).max(64),
    id: z.uuid(),
    entry: entryShape,
    replacedAt: isoInstant,
    reason: z.string().max(64),
  })
  .strict();

const payloadShape = z
  .object({
    records: z.record(z.string(), z.array(z.unknown())),
    tombstones: z.array(z.unknown()),
    pendingConflicts: z.array(z.unknown()),
    replacedVersions: z.array(z.unknown()),
    sourceDeviceSettings: z.object({ language: z.enum(LANGUAGES), theme: z.enum(THEMES) }).strict(),
  })
  .strict();

function checkType(type: string, registry: Registry): void {
  if (EXCLUDED_RECORD_TYPES.has(type)) throw new BackupError("EXCLUDED_DATA", type);
  if (!registry.get(type)) throw new BackupError("UNKNOWN_RECORD_TYPE", type);
}

/** Validates one envelope of `type`: shape, type schema, singleton ID, size, and content hash. */
function validateEnvelope(raw: unknown, type: string, registry: Registry, where: string): Envelope {
  checkType(type, registry);
  const def = registry.get(type)!;
  const shaped = envelopeShape.safeParse(raw);
  if (!shaped.success) throw new BackupError("INVALID_PAYLOAD", `${where}: ${shaped.error.issues[0]?.message}`);
  const envelope = shaped.data as Envelope;
  if (canonicalBytes(envelope).length > MAX_ENVELOPE_BYTES) throw new BackupError("LIMIT_EXCEEDED", `${where}: record too large`);
  const data = def.schema.safeParse(envelope.data);
  if (!data.success) throw new BackupError("INVALID_PAYLOAD", `${where}: ${data.error.issues[0]?.message}`);
  if (def.singletonId && envelope.id !== def.singletonId) {
    throw new BackupError("INVALID_PAYLOAD", `${where}: singleton must use its reserved ID`);
  }
  if (contentHashOf(envelope.data) !== envelope.contentHash) {
    throw new BackupError("INVALID_PAYLOAD", `${where}: content hash does not match`);
  }
  return envelope;
}

function validateTombstone(raw: unknown, registry: Registry, where: string): Tombstone {
  const shaped = tombstoneShape.safeParse(raw);
  if (!shaped.success) {
    const type = (raw as { type?: unknown } | null)?.type;
    if (typeof type === "string") checkType(type, registry);
    throw new BackupError("INVALID_PAYLOAD", `${where}: ${shaped.error.issues[0]?.message}`);
  }
  checkType(shaped.data.type, registry);
  if (registry.get(shaped.data.type)!.singletonId) {
    throw new BackupError("INVALID_PAYLOAD", `${where}: singletons cannot be deleted`);
  }
  return shaped.data;
}

function validateEntry(raw: z.infer<typeof entryShape>, type: string, id: string, registry: Registry, where: string): VersionEntry {
  if (raw.deleted) {
    const tombstone = validateTombstone(raw.tombstone, registry, where);
    if (tombstone.type !== type || tombstone.id !== id) throw new BackupError("INVALID_PAYLOAD", `${where}: mismatched ID`);
    return { deleted: true, tombstone };
  }
  const envelope = validateEnvelope(raw.envelope, type, registry, where);
  if (envelope.id !== id) throw new BackupError("INVALID_PAYLOAD", `${where}: mismatched ID`);
  return { deleted: false, envelope };
}

/**
 * Validates the (decrypted) payload: entry count first, then shapes, record types, schemas,
 * sizes, content hashes, and uniqueness. Throws BackupError; never touches the database.
 *
 * Upgrades (docs/BACKUP_FORMAT.md, "Versioning and upgrades"): 1 → 2 adds record types, 2 → 3
 * adds a type and optional fields (absent, never null), and 3 → 4 adds types (goals, milestones),
 * so every upgrade is the identity. The
 * payload is checked against the types AND fields of ITS version: a version-1 file containing a
 * version-2 type is refused as an unknown record type, and a version-2 task with `recurrence` is
 * refused as invalid data.
 */
export function validatePayload(raw: unknown, fullRegistry: Registry, dataSchemaVersion = DATA_SCHEMA_VERSION): BackupPayload {
  const registry = registryForDataSchemaVersion(fullRegistry, dataSchemaVersion);
  const shaped = payloadShape.safeParse(raw);
  if (!shaped.success) {
    const records = (raw as { records?: unknown } | null)?.records;
    if (records && typeof records === "object") {
      for (const type of Object.keys(records)) if (EXCLUDED_RECORD_TYPES.has(type)) throw new BackupError("EXCLUDED_DATA", type);
    }
    throw new BackupError("INVALID_PAYLOAD", shaped.error.issues[0]?.message);
  }
  const p = shaped.data;
  const total =
    Object.values(p.records).reduce((sum, list) => sum + list.length, 0) +
    p.tombstones.length +
    p.pendingConflicts.length +
    p.replacedVersions.length;
  if (total > MAX_ENTRIES) throw new BackupError("LIMIT_EXCEEDED", `more than ${MAX_ENTRIES} entries`);

  const seen = new Set<string>();
  const records: Record<string, Envelope[]> = {};
  for (const [type, list] of Object.entries(p.records)) {
    checkType(type, registry);
    records[type] = list.map((raw, i) => {
      const envelope = validateEnvelope(raw, type, registry, `records.${type}[${i}]`);
      const key = `${type}/${envelope.id}`;
      if (seen.has(key)) throw new BackupError("INVALID_PAYLOAD", `duplicate ${key}`);
      seen.add(key);
      return envelope;
    });
  }
  const tombstones = p.tombstones.map((raw, i) => {
    const tombstone = validateTombstone(raw, registry, `tombstones[${i}]`);
    const key = `${tombstone.type}/${tombstone.id}`;
    if (seen.has(key)) throw new BackupError("INVALID_PAYLOAD", `duplicate ${key}`);
    seen.add(key);
    return tombstone;
  });

  const conflictIds = new Set<string>();
  const pendingConflicts = p.pendingConflicts.map((raw, i): CarriedConflict => {
    const where = `pendingConflicts[${i}]`;
    const c = conflictShape.safeParse(raw);
    if (!c.success) {
      const type = (raw as { type?: unknown } | null)?.type;
      if (typeof type === "string") checkType(type, registry);
      throw new BackupError("INVALID_PAYLOAD", `${where}: ${c.error.issues[0]?.message}`);
    }
    checkType(c.data.type, registry);
    if (conflictIds.has(c.data.conflictId)) throw new BackupError("INVALID_PAYLOAD", `${where}: duplicate conflictId`);
    conflictIds.add(c.data.conflictId);
    return {
      ...c.data,
      local: c.data.local ? validateEntry(c.data.local, c.data.type, c.data.id, registry, `${where}.local`) : null,
      incoming: validateEntry(c.data.incoming, c.data.type, c.data.id, registry, `${where}.incoming`),
    };
  });

  const replacedIds = new Set<string>();
  const replacedVersions = p.replacedVersions.map((raw, i): CarriedReplaced => {
    const where = `replacedVersions[${i}]`;
    const r = replacedShape.safeParse(raw);
    if (!r.success) {
      const type = (raw as { type?: unknown } | null)?.type;
      if (typeof type === "string") checkType(type, registry);
      throw new BackupError("INVALID_PAYLOAD", `${where}: ${r.error.issues[0]?.message}`);
    }
    checkType(r.data.type, registry);
    if (replacedIds.has(r.data.replacedId)) throw new BackupError("INVALID_PAYLOAD", `${where}: duplicate replacedId`);
    replacedIds.add(r.data.replacedId);
    return { ...r.data, entry: validateEntry(r.data.entry, r.data.type, r.data.id, registry, `${where}.entry`) };
  });

  return { records, tombstones, pendingConflicts, replacedVersions, sourceDeviceSettings: p.sourceDeviceSettings };
}
