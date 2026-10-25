/** Format version 1 limits for untrusted backup files (docs/BACKUP_FORMAT.md, "Input limits"). */
export const BACKUP_FORMAT = "pps-backup";
export const FORMAT_VERSION = 1;
/**
 * Record types and fields (docs/BACKUP_FORMAT.md, "Versioning and upgrades"). 1: shared
 * preferences (Stage 1B). 2: adds projects, workstreams, and task definitions (Stage 2). 3: adds
 * calendar blocks and the optional fields task `recurrence` and preference `dailyCapacityMinutes`
 * (Stage 3, T-025). 4: adds goals and milestones (Stage 4, T-081). Readers accept every version
 * from 1 to this one; each record type declares the version that introduced it, and types whose
 * fields changed keep the schema of older versions.
 */
export const DATA_SCHEMA_VERSION = 4;

export const MIB = 1024 * 1024;
export const MAX_FILE_BYTES = 32 * MIB;
export const MAX_PLAINTEXT_BYTES = 32 * MIB;
export const MAX_ENTRIES = 200_000;
export const MAX_ENVELOPE_BYTES = 256 * 1024;
export const MAX_VERSION_VECTOR_ENTRIES = 32;
export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_VALUES = 4_000_000;
export const MAX_DEVICE_NAME_CHARS = 80;

export const KDF_ITERATIONS_WRITE = 600_000;
export const KDF_ITERATIONS_MIN = 600_000;
export const KDF_ITERATIONS_MAX = 1_000_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const TAG_BITS = 128;
export const DATA_KEY_BYTES = 32;
export const WRAPPED_KEY_BYTES = DATA_KEY_BYTES + TAG_BITS / 8; // 48

/** Reserved ID of the shared-preferences singleton (D-017). */
export const SHARED_PREFERENCES_ID = "00000000-0000-4000-8000-000000000001";
