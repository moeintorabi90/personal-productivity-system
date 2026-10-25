# Offline Backup: File Format, Merge, and Conflicts

Status: **decided design for v1** (owner decisions D-008 to D-017; technical decisions T-016 to T-019 in `DECISIONS.md`), **implemented in Stage 1B** (`apps/web/src/backup/`). Implementation choices that refine details are listed in "Implementation notes (Stage 1B)" near the end. Items marked "proposal only" or "possible later" are **not** part of v1 and would need owner approval.

## Goals

1. Export one file that contains all of the user's data on a device, without internet.
2. Restore it on Windows and Android; keep the format usable by a future iPhone version.
3. Importing **merges** into existing data. It never replaces or deletes local data by itself.
4. Importing the same file again creates **no duplicates** and changes nothing.
5. If the same item (same ID) differs between the file and the device, **neither version is silently overwritten or deleted**; the user decides.
6. The file is **versioned**, so later app versions can still read old backups.
7. The design reuses the identity and versioning rules that a future sync feature would need, without building sync now.

## File container

- **One JSON file**, UTF-8, named `pps-backup-YYYY-MM-DD-HHmm.json` (local time of export).
  - `.json` rather than a custom extension: iOS and Android file pickers recognise `application/json`, while unknown extensions are often greyed out or mis-typed. The `format` field below, not the extension, identifies the file.
  - Plain JSON is inspectable and recoverable by hand if the app is ever unavailable. Compression may be added in a later format version.
- Full backups only in v1 (all product records). Partial or incremental backups are out of scope.

## What a backup contains

**Included (product data):** shared preferences now (time zone, week start, calendar display; device-only settings such as language and theme are carried only as information, see "Preferences"); each product record type added by later stages (projects, workstreams, tasks, calendar blocks, sessions, outputs, goals, habits, reviews, …) together with its tombstones; pending conflicts and the replaced-versions archive (so undecided choices and undo survive a device move).

**Excluded:**

- `sync_probe` (local table `probes`, shown as "Sync check notes"): a Stage 1 diagnostic record that proves the frozen sync engine (DECISIONS T-011). It is not product data, is never exported, and a file containing it is invalid.
- Sync machinery of the frozen post-v1 code: session token, outbox, pull cursor, sync status.
- Device-local settings (language and theme now; others later, such as the Stage 8 app-use streak days) as mergeable data. Only the exporting device's values travel, as informational `sourceDeviceSettings`. Each record type and setting declares whether it is exported.

Format version 1 lists its allowed record types explicitly. An importer refuses a file with an unknown record type rather than ignoring it silently.

## Canonical serialization

Wherever this document says "canonical", it means the **JSON Canonicalization Scheme (JCS, RFC 8785)**: object keys sorted, no insignificant whitespace, standard number and string encoding, then UTF-8 bytes. Hashes are lower-case hex SHA-256 of those bytes. Text values are stored as entered (no Unicode normalization of user content).

### Password text normalization (limited guarantee)

Passwords are converted to Unicode **NFC** before key derivation. NFC only makes **canonically equivalent** sequences identical: the same character encoded precomposed or as a base letter plus combining marks (e.g. `آ` as U+0622 or as U+0627 U+0653) gives the same bytes. It does **not** make different characters equal. Persian and Arabic keyboard layouts can produce different characters for what looks like the same letter: Arabic Yeh `ي` (U+064A) vs Persian Yeh `ی` (U+06CC), Arabic Kaf `ك` (U+0643) vs Keheh `ک` (U+06A9), Persian vs Arabic-Indic vs ASCII digits, and zero-width non-joiner (U+200C) vs space or nothing. NFC leaves these different, and the app does **not** fold them together, so a password must be typed with the same characters it was created with. The forgotten-password warning, the double entry, and the immediate verify step (see Protection) are the safeguards.

Possible later aid, proposal only: show a notice when a new password contains characters that commonly differ between keyboard layouts (Arabic Yeh/Kaf, non-ASCII digits, ZWNJ). Folding these characters into one form would change the key derivation contract and is not proposed for format version 1.

## Top-level structure (format version 1)

A backup file is one JSON object with a **header** (all top-level fields except `payload` and `integrity`), a **payload**, and an **integrity** block.

### Unencrypted file (`encryption` is `null`)

```jsonc
{
  "format": "pps-backup",            // constant; identifies the file
  "formatVersion": 1,                // integer; bumped on any incompatible change
  "backupId": "uuid",                // unique per export; used for the import log
  "createdAt": "2026-10-20T18:30:00.000Z",
  "app": { "version": "0.2.0", "dataSchemaVersion": 1 },
  "sourceDevice": { "id": "uuid", "name": "Windows laptop" },
  "encryption": null,
  "payload": {
    "records": {
      "preferences": [ /* record envelopes */ ],
      "projects":    [ /* added by later stages */ ]
    },
    "tombstones": [
      { "type": "projects", "id": "uuid", "deletedAt": "…", "version": { "<deviceId>": 4 } }
    ],
    "pendingConflicts": [ /* both versions of each undecided item */ ],
    "replacedVersions": [ /* versions replaced by earlier choices, for undo */ ],
    "sourceDeviceSettings": { "language": "fa", "theme": "dark" }  // informational, never merged
  },
  "integrity": {
    "algorithm": "SHA-256",
    "canonicalization": "JCS-RFC8785",
    "hash": "hex"
  }
}
```

### Encrypted file (when the user turns on the optional password, D-014)

The same header, with `encryption` describing how to decrypt, and `payload` replaced by ciphertext. In format version 1 an encrypted file has **exactly one key slot, of type `password`**, and no hint field. The `recoveryKey` slot type is reserved for a possible future format version (not v1).

```jsonc
{
  "format": "pps-backup",
  "formatVersion": 1,
  "backupId": "uuid",
  "createdAt": "…",
  "app": { "version": "0.2.0", "dataSchemaVersion": 1 },
  "sourceDevice": { "id": "uuid", "name": "" },     // name may be left empty to reveal less
  "encryption": {
    "scheme": "pps-enc-1",
    "content": {
      "cipher": "AES-256-GCM",
      "iv": "base64 (12 random bytes)",
      "tagBits": 128,
      "aad": "header-jcs"           // additional authenticated data, see below
    },
    "keySlots": [
      {
        "type": "password",
        "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "base64 (16 random bytes)" },
        "wrap": { "cipher": "AES-256-GCM", "iv": "base64 (12 random bytes)" },
        "wrappedKey": "base64 (encrypted 32-byte data key + tag)"
      }
      // v1: exactly this one password slot; a "recoveryKey" slot is reserved for the future
    ]
  },
  "payload": { "ciphertext": "base64" },
  "integrity": {
    "algorithm": "SHA-256",
    "canonicalization": "JCS-RFC8785",
    "hash": "hex"
  }
}
```

How encryption works:

1. Generate a random 256-bit **data key**. Encrypt the canonical bytes of the plaintext payload object (`records`, `tombstones`, `pendingConflicts`, `replacedVersions`, `sourceDeviceSettings`) with AES-256-GCM using the data key, a fresh random 12-byte IV, and the **canonical header** as additional authenticated data (AAD). The header includes the `encryption` object itself, so changing the salt, iteration count, IVs, version, or any header field makes decryption fail instead of silently producing a weaker file.
2. For the password slot, derive a key-encryption key (PBKDF2-SHA-256 from the UTF-8 bytes of the NFC-normalized password and the slot's salt and iterations) and wrap the data key with AES-256-GCM. Writers use 600,000 iterations; readers enforce the bounds in "Input limits" before running PBKDF2.
3. Decryption uses the password slot: unwrap the data key, then decrypt and authenticate the payload. A GCM failure means the wrong password or a modified file; nothing is imported.

The key-slot structure leaves room for a possible future recovery-key slot (option D below) without redesigning the format; v1 does not write or accept it. Everything in the header (creation time, app version, source device ID and name) is **readable without the password**; the export screen can leave the device name empty in encrypted files to reveal less.

### Integrity hash — exactly what it covers

- `integrity.hash` = SHA-256 over the canonical serialization of the **whole document with the `integrity` member removed**: header and `payload`. In an encrypted file, `payload` is `{ "ciphertext": … }`, so the hash covers the ciphertext, not the plaintext.
- Purpose: detect accidental damage (truncated download, edited file) **before** asking for a password, so the app can say "this file is damaged" instead of the misleading "wrong password". It is not a signature: anyone who edits a file can recompute it.
- Authenticity: only an encrypted file is protected against deliberate tampering (by the GCM tag over header and payload). An unencrypted file has no protection against deliberate changes; import validation still applies.
- Per-record `contentHash` values (below) are computed over the canonical `data` of each record and are used only to compare versions of the same ID, not for file integrity.

### Record envelope (every record type)

```jsonc
{
  "id": "uuid",                  // client-generated, never reused
  "createdAt": "ISO-8601 UTC",
  "updatedAt": "ISO-8601 UTC",
  "version": { "<deviceId>": 3, "<otherDeviceId>": 1 },  // version vector, see below
  "contentHash": "hex",          // SHA-256 of the canonical content fields
  "data": { /* type-specific fields, validated by that type's schema */ }
}
```

- **IDs** are random UUIDs created on the device that created the record. The same ID on two devices always means "the same item". Exception: singleton records (currently only shared preferences) use a reserved constant ID defined by the format (see "Preferences").
- **Version vector:** every device has a stable device ID (already implemented). Each local edit increments that device's counter in the record's `version`. Comparing two vectors tells whether one version already contains the other (see merge rules). It stays small because one person has only a few devices.
- **contentHash** is SHA-256 over the canonical serialization of `data`. It is used **only to compare two versions of the same ID** (device vs file): equal hashes mean "already here" even if the two devices reached the same content independently. It is **never used across different IDs**: two records with different UUIDs are different items even if their content is identical (for example, the same task typed on two devices before any backup), and import keeps both. Identity is the UUID, nothing else.
- Possible later aid, proposal only: an import preview note such as "N new items look identical to items already here", letting the user review them. It would never merge or delete anything automatically, and would need owner approval.
- **Links:** a record type declares its references to other records (e.g. a task's `projectId`). Record types are **independent** if they have no links in either direction (nothing they reference and nothing that references them), and **linked** otherwise. This matters for conflict resolution below.
- **Append-only history** (execution sessions, output corrections, finalized weekly reviews) uses the same envelope. Its `data` never changes after creation; corrections are new records that reference the original.
- **Tombstones:** deleting an item on the device keeps a tombstone (ID, deletion time, version vector) instead of forgetting the ID. Tombstones are exported so another device learns about the deletion, but importing never deletes anything by itself (see conflicts).

### Preferences: singleton with a fixed logical ID (decided, D-017)

Today the app stores one preferences row in IndexedDB under the key `"self"` with five fields (language, theme, calendar display, week start, time zone) and a server revision used only by the frozen sync code. The owner decided (D-017) to split them into two groups:

| Group | Fields | In backup | Why |
|---|---|---|---|
| **Shared preferences** (transferable) | `timeZone`, `weekStart`, `calendarDisplay`; later stages add calculation-relevant settings here (Stage 3: optional `dailyCapacityMinutes`, see "Data schema version 3") | Yes, as one record of type `preferences` | Time zone and week start change how days, weeks, recurrence, and reviews are computed; all devices should agree. Calendar display is grouped here so dates look the same everywhere. |
| **Device settings** (device-local) | `language`, `theme`; later device-only items (e.g. reminders on this device) | Not merged. The exporting device's values are written as informational `sourceDeviceSettings` inside the payload. | A phone and a laptop may reasonably differ (e.g. dark theme on the phone only). |

Rules:

- **Fixed logical ID:** the shared preferences record always has the same reserved ID on every device, `00000000-0000-4000-8000-000000000001` (a constant defined by format version 1, not random). So the same ID on two devices means the same singleton, and the normal merge rules apply: version vectors, "already here / older / newer in backup / conflict". It can never be added as a second record, and "keep both" is never offered.
- **Untouched defaults:** a device that never changed its shared preferences has an empty version vector, which every other version contains. Importing into such a device therefore shows "newer in backup", not a conflict, and is applied after the usual confirmation.
- **Device settings on import:** language and theme are **never changed automatically** by an import. If the file's `sourceDeviceSettings` differ from this device's, the preview may offer one optional action, "Use the display settings of *device name* on this device?". Declining changes nothing; there is no conflict entry.
- **Migration in Stage 1B:** the existing `"self"` row is split: shared fields move into the `preferences` envelope (reserved ID, empty version vector unless the user changed them, which counts as this device's first edit), and language/theme move to device-local settings. The frozen sync code's `serverRevision` is not part of the backup.
- Moving a field between the two groups later is a product change that needs a new owner decision and, if exported data changes, a new `dataSchemaVersion`.

### Input limits and validation order (untrusted files)

A backup file may come from anywhere, so it is untrusted input. Limits for format version 1:

| Item | Limit |
|---|---|
| File size (`File.size`) | ≤ **32 MiB**, checked before reading any bytes |
| Decrypted payload (encrypted files) | ≤ **32 MiB** of plaintext bytes; the ciphertext length is also checked against this before decrypting |
| Records + tombstones + pending conflicts + replaced versions, all types together | ≤ **200,000** entries |
| One record envelope (canonical size) | ≤ **256 KiB** |
| Text fields | per record-type schema (e.g. names ≤ 200 characters, notes ≤ 20,000 characters) |
| Version vector | ≤ **32** device entries per record |
| Text encoding | valid UTF-8 (decoded with a fatal decoder; any invalid byte sequence rejects the file) |
| JSON nesting depth | ≤ **32** levels (each `{` or `[` opens one level; the top-level object is level 1), enforced by the pre-parse scan |
| JSON values | ≤ **4,000,000** values in total (objects, arrays, strings, numbers, literals), enforced by the pre-parse scan |
| `sourceDevice.name` | ≤ 80 characters |
| `keySlots` | exactly 1 entry, of `type` `password` (a `recoveryKey` slot, or any second slot, is refused in format version 1) |
| `kdf` | `name` exactly `PBKDF2`, `hash` exactly `SHA-256`, `iterations` an integer from **600,000 to 1,000,000** (writers use 600,000), `salt` exactly 16 bytes |
| Ciphers | `AES-256-GCM` only; every IV exactly 12 bytes; `tagBits` exactly 128; `wrappedKey` exactly 48 bytes (32-byte key + 16-byte tag) |
| Unknown fields in header or `encryption` | rejected |

Because the ciphertext is base64 text inside a file of at most 32 MiB, an encrypted backup in practice holds at most about 24 MiB of plaintext.

**PBKDF2 bounds.** The minimum equals the writer's value, 600,000 iterations (the OWASP recommendation for PBKDF2-HMAC-SHA-256 at the time of writing). No encrypted backup has been released, so there are no older files with fewer iterations to stay compatible with, and accepting fewer would only let a weakened file be imported without notice. The cap of 1,000,000 stops a crafted file from freezing a phone with an enormous PBKDF2 cost. A later app version may raise the writer's count; it must then accept the new range, and older apps would refuse such files with a clear "update the app" message. Lowering the minimum would need a documented compatibility reason.

### Pre-parse scan (before `JSON.parse`)

`JSON.parse` builds the whole object tree at once and has no depth or size options, so it runs only after a **structural pre-scan** of the decoded text has passed. The scan is one linear pass with constant memory: it builds no objects and does not recurse. It tracks whether it is inside a string (handling `\` escapes), counts nesting with a single integer, and counts values. It rejects the file as soon as:

- nesting exceeds 32 levels;
- a closing `}` or `]` does not match the open bracket (the scan keeps a fixed 32-entry stack of open-bracket types, enough because deeper nesting is already rejected);
- a string is unterminated, contains a raw control character, or has an invalid escape;
- the value count exceeds 4,000,000;
- there is anything after the top-level value except whitespace, or the input ends inside a value.

The scan is not a full JSON validator. `JSON.parse` still decides exact grammar (number formats, comma and colon placement), but by then size, depth, and value count are bounded, so parsing cannot recurse deeply or build an unexpectedly large structure. The decrypted plaintext of an encrypted file goes through the same scan before it is parsed.

An implementation may instead use a streaming JSON parser with built-in depth and value limits, if it enforces the same limits before building the corresponding structures and passes the same acceptance tests.

**Validation order** — each step runs only if the previous one passed, so no expensive work happens on an unchecked file:

1. Check `File.size` against the limit, before reading.
2. Read the bytes and decode them as UTF-8 with a fatal decoder; invalid UTF-8 rejects the file.
3. Run the **pre-parse scan** (depth, bracket matching, strings, value count, trailing content). No object is built in steps 1–3.
4. `JSON.parse`; any exception counts as an invalid file.
5. Validate the **header** strictly: `format`, `formatVersion` (refuse newer), field types, and, if encrypted, every `encryption` parameter against the table above (including iteration bounds and byte lengths). This happens **before any password prompt and before any PBKDF2 run**.
6. Verify the integrity hash (linear in file size, bounded by step 1).
7. If encrypted: ask for the password; run PBKDF2 once per user attempt (no automatic retries); unwrap the data key; check the ciphertext/plaintext length limit; decrypt and authenticate; then decode the plaintext as UTF-8, run the pre-parse scan on it, and only then `JSON.parse` it.
8. Validate the payload: entry counts, envelope sizes, record-type schemas, allowed record types, version vectors.
9. Check references (inside the preview/import transaction): every record version in the file — including carried conflict and archived versions — must link only to known IDs and satisfy its type's relationship rules, and records the import makes active must link to records that are live after the import (e.g. a task's project; see "Implementation notes (Stage 1B)", "Links in every version" and "Relationship rules in every version").
10. Build the preview. Nothing has been written to the database before the user confirms.

Export enforces the same limits: if a device's data would exceed them, export stops with an explanation instead of writing a file that this app version could not import. (Not expected for one person's data in v1; a later format version could add compression or splitting.)

## Versioning and upgrades

- `formatVersion` describes the container and envelope; `dataSchemaVersion` describes the record types and their fields.
- **Data schema versions so far** (all with `formatVersion` 1): **1** — shared preferences (Stage 1B); **2** — adds `projects`, `workstreams`, and `taskDefinitions` (Stage 2; fields in DATA_MODEL "Stage 2 record types"). **3** — adds `calendarBlocks` and the optional fields task `recurrence` and preference `dailyCapacityMinutes` (Stage 3; "Data schema version 3" below). The Stage 3 app writes version 3 and reads 1, 2, and 3. The upgrade 1 → 2 changes nothing (types were only added), but a file is checked against the types of **its** version: a version-1 file containing a Stage 2 type is refused as unknown data. A Stage 1B app refuses a version-2 file, and a Stage 2 app a version-3 file, with "made by a newer version" before reading its contents. Samples: `apps/web/src/backup/samples/pps-backup-format-v1.json` (data version 1), `pps-backup-format-v1-data-v2.json` (data version 2), and `pps-backup-format-v1-data-v3.json` (data version 3), all fabricated. **4** — adds `goals` and `milestones` (Stage 4; "Data schema version 4" below); the Stage 4 app writes version 4 and reads 1–4, and a Stage 3 app refuses a version-4 file as newer; sample `pps-backup-format-v1-data-v4.json`. **Next versions (approved order T-076, not implemented):** **5** — the optional project `color` (Stage 3 follow-up, "Project color" below), built after Stage 4; **6** — Stage 5's execution-session, correction, output-metric, and output record types and the optional task output-metric field (DECISIONS T-024), in one step as Stage 3's additions were in version 3 (fields to be specified with the Stage 5 contract). If Stage 5 were released in more than one data-version step, its additions would take consecutive versions starting at 6.
- The importer contains a chain of upgrade functions (`v1 → v2 → …`). An older file is upgraded in memory, then validated against the current schema. Upgrades never lose fields; removed concepts are mapped or kept in an `extra` object.
- A file with a **newer** version than the app understands is refused with a clear message ("This backup was made by a newer version; update the app first"). It is never partially imported.
- Every format change ships with a stored sample file of the previous version and a test that the new app imports it.

### Data schema version 3 (Stage 3 — implemented and merged into `main`)

Decisions: D-019 to D-023, T-025 to T-036 (DECISIONS); fields: DATA_MODEL "Stage 3 record types and fields". `formatVersion` stays 1.

**What version 3 adds** (additive only):

| Change | Version 3 | Meaning when absent |
|---|---|---|
| `taskDefinitions` data | optional `recurrence` | not recurring |
| `preferences` data | optional `dailyCapacityMinutes` | capacity not set |
| new record type | `calendarBlocks` (since version 3) | — |

**Why optional, never `null`, for the new fields (T-025):** a record's `contentHash` covers its `data`. If the upgrade added `recurrence: null` to every stored task, every unchanged task would get a new content hash under the same version vector; the next backup exchange with a device that has not upgraded yet (or with an older backup file) would see "same version, different content" and raise a false conflict for every task. Keeping the field absent when unused leaves existing data byte-for-byte identical. Writers must never write the new fields as `null`, and must remove the field (not write `null`) when the user turns recurrence or capacity off.

**Upgrade path (no data loss):**

1. **Stored data:** no rewrite. Stage 2 task definitions and preferences are already valid version-3 data (fields absent). Their data, content hashes, and version vectors stay unchanged; no IndexedDB data migration runs. (An optional new index for blocks is a schema step that rewrites no record.)
2. **Files:** readers accept data versions 1, 2, and 3. The in-memory upgrade chain is 1 → 2 → 3, each step the identity: version 1 adds nothing to remove, version 2 tasks simply have no `recurrence`.
3. **Validation per version** (extends Stage 2's per-version type check to fields): a file is validated against the types **and fields** of its declared version. A version-1 or version-2 file containing `recurrence`, `dailyCapacityMinutes`, or `calendarBlocks` is refused (`INVALID_PAYLOAD` for fields, `UNKNOWN_RECORD_TYPE` for the type), with nothing changed. This requires version-aware schemas for `taskDefinitions` and `preferences` (the version-2 schemas stay strict).
4. **Writers** always write version 3 once Stage 3 ships. A Stage 2 app (data version 2) refuses a version-3 file before reading its payload ("made by a newer version"); every device must be updated before moving version-3 backups to it. A Stage 3 app imports Stage 1B and Stage 2 files unchanged.
5. **Samples:** the committed version-1 and version-2 samples keep importing; a fabricated version-3 sample (tasks with and without recurrence, preferences with and without capacity, planned and cancelled blocks, a block with and without `occurrenceDate`) is added and imported by the tests.

**Validation of version-3 content on import** (in addition to the existing order and limits):

- Blocks: shape and limits from DATA_MODEL; `endsAt` after `startsAt` and at most 24 hours later; minute precision; `localDate` equal to the local date of `startsAt` in the block's `timeZone`; valid IANA `timeZone`; snapshot consistency. A violation refuses the file (`INVALID_PAYLOAD`), in any version in the file (records, carried conflicts, archived versions).
- Links: `taskId` must be known (file or device), as for other links ("Links in every version"); a block that becomes active (new, confirmed update, "use the backup's version", "restore", undo) needs a **live** task.
- Recurrence: weekdays 1–7 distinct values 0–6 in ascending order; `endDate` null or ≥ `startDate`; valid calendar dates.
- `occurrenceDate` is not checked against the task's recurrence (plans are history).

**Merge and conflicts:**

- Blocks follow the general rules: new blocks are added; identical and older copies are skipped; a block changed only elsewhere is "newer in backup" and applied only after confirmation; a block moved, resized, cancelled, or restored on both devices is a conflict with "keep this device's" or "use the backup's" version (linked type: no "keep both"); a block deleted in a backup (only possible through earlier conflict choices) is a deletion conflict.
- A task deleted in the backup while live blocks here link to it: "Delete here" is refused (restrict); the user can keep it.
- Recurrence and capacity are ordinary field edits: a recurrence edited on both devices is a task conflict; a capacity edited on both devices is a preferences conflict (singleton, no "keep both").
- Unscheduled items are derived, so they are never exported, imported, or in conflict; after an import they are recomputed from the merged tasks and blocks: an occurrence is scheduled while at least one of its blocks is planned (D-023), so a conflict choice that cancels one of several blocks of an occurrence leaves it scheduled.
- The configured time zone is a shared preference: importing a different zone changes only how blocks are displayed, never their stored instants or `occurrenceDate` (D-022).
- Import never creates, moves, or cancels a block except as the rules above allow, and capacity warnings never cause any change (D-021).

### Data schema version 4 (Stage 4 — goals and milestones)

Decisions: T-081 to T-087 (derived) with T-037 to T-065 and T-077 to T-080 (owner); fields: DATA_MODEL "Stage 4 record types". `formatVersion` stays 1.

- **What version 4 adds** (additive only): record types `goals` (since version 4) and `milestones` (since version 4). No field of an existing type changes.
- **Upgrade path (no data loss):** no stored record is rewritten; existing records keep their data, content hash, and version vector, so the upgrade causes no false conflicts. The in-memory upgrade chain 1 → 2 → 3 → 4 is the identity. Readers accept versions 1–4; writers write version 4. A Stage 3 app refuses a version-4 file as "made by a newer version"; every device must be updated before moving version-4 backups to it.
- **Validation per version:** a file of version 3 or older containing `goals` or `milestones` is refused (`UNKNOWN_RECORD_TYPE`). Goal and milestone shapes and limits are checked for every version in the file (records, carried conflicts, archive): a goal deadline before its start date, a `unit` on a non-output goal or a missing one on an output goal, an unknown `kind` or `status`, or a non-whole or out-of-range target refuses the file (`INVALID_PAYLOAD`). Links: `projectId` and `goalId` must be known; a version that becomes active needs a live target. A milestone's `goalId` must agree across all versions of one ID (immutable field). The milestone deadline range (T-057) is **not** an import rule (T-084): a merged milestone outside its goal's dates is imported and shown with a warning (T-078).
- **Merge and conflicts:** both types are linked, so a goal or milestone edited on two devices (including status, archive, and completion) is a conflict with "keep this device's" or "use the backup's" version. A milestone deleted here is not brought back by an older backup that still contains it (older copy); a milestone deleted in a backup but live here becomes a deletion decision for the owner, as for every type (never deleted silently). "Delete here" for a goal is refused while live milestones link to it.
- **Samples:** the committed version-1, -2, and -3 samples keep importing; a fabricated version-4 sample (`pps-backup-format-v1-data-v4.json`: goals of each kind, active, paused, completed, and archived; milestones with and without deadline, complete and incomplete) is added.

### Project color (Stage 3 follow-up — approved 2026-10-25, not implemented)

Decisions: T-068 to T-070 (owner) and the derived technical choices in DECISIONS ("Calendar interaction, project color, and streak decisions"); field: DATA_MODEL "Stage 3 follow-up: project color". `formatVersion` stays 1.

- **What changes:** one optional field on `projects` data, `color` (a palette identifier). It is absent when the owner has not chosen a color (never `null`); the default color is derived on display and never written.
- **Version:** **`dataSchemaVersion` 5.** The owner approved building this follow-up after Stage 4 (T-076), and Stage 4's goal and milestone records take version 4, so the color is the next version after Stage 4's. (If Stage 4 were released in more than one data-version step, the color would take the next version after the last of them.)
- **Upgrade path (no data loss):** no stored record is rewritten; existing projects keep their data, content hash, and version vector, so devices that update at different times see no false conflicts (T-025 reasoning). Older files upgrade by the identity. The committed samples for versions 1–4 keep importing; a fabricated version-5 sample (projects with and without `color`) is added.
- **Validation per version:** a file is checked against the fields of its own version: a file of version 4 or older containing `projects.color` is refused (`INVALID_PAYLOAD`), as is `null` or an identifier that is not in that version's palette, in every version in the file (records, carried conflicts, archive). Adding palette entries later is another data-version step.
- **Older apps:** the Stage 4 app (data version 4), and any earlier one, refuses a version-5 file as "made by a newer version"; every device must be updated before moving such backups to it.
- **Merge and conflicts:** the color is an ordinary project field. A color changed only elsewhere is "newer in backup" and applied after confirmation; a color (or any other project field) edited on both devices is a project conflict with "keep this device's" or "use the backup's" version (linked type, no "keep both"). Blocks and snapshots carry no color, so no block changes when a color is imported or chosen.

**Streaks in backups:** goal streaks (Stage 6) are derived from records that are already exported, so they add no backup data and are the same after a round-trip. The app-use streak (Stage 8) is device-local metadata like language and theme (D-017): it is not exported as mergeable data and is never changed by an import.

## Import flow

1. **Choose file** (file picker; works on Windows, Android, and iPhone).
2. **Read and check** in the order given in "Input limits and validation order": size, UTF-8 decoding, pre-parse scan, JSON parsing, header and encryption parameters, integrity hash; if encrypted, then password and decryption; then payload schema, allowed record types, references. On any failure: stop, explain, change nothing.
3. **Preview** (nothing written yet). Each item in the file is classified:

| Category | Rule | Default action |
|---|---|---|
| **New** | ID not on this device (and no local tombstone) | Add |
| **Already here** | Same ID and same `contentHash` | Skip (no change) |
| **Older copy** | File version is contained in the device version (the device has the same item with later edits) | Skip (no change) |
| **Newer in backup** | Device version is contained in the file version (the item changed elsewhere after this device last had it; this device has not edited it since) | Listed for confirmation; not applied until the user confirms |
| **Conflict** | Neither version contains the other (edited on both sides), or same ID with different content and no usable version information | Kept as a pending conflict; the user decides |
| **Deleted here** | File has an item that this device deleted (local tombstone), and the deletion has not already seen that version (otherwise: older copy) | Kept as a pending conflict ("restore or keep deleted") |
| **Deleted in backup** | File has a tombstone for an item that exists here, and this device's version is not newer than that deletion (otherwise: older copy) | Kept as a pending conflict ("delete here or keep") |

4. **Apply** (one local database transaction, all or nothing): add new items, apply confirmed updates, and store pending conflicts with **both** versions. The device's own versions of conflicting items stay exactly as they were.
5. **Record** an import log entry: `backupId`, file creation time, source device, counts per category, time of import. Re-importing the same `backupId` is allowed and shows "already imported on …"; because of the rules above, it changes nothing new.

Why this satisfies the requirements:

- **No replacement or deletion by import:** only "New" items are written automatically. Updates and deletions need an explicit user choice.
- **No duplicates on re-import:** identity is the UUID; identical or older copies of the same ID are skipped. (Separately created items with different UUIDs are not duplicates in this sense and are both kept; see `contentHash`.)
- **No silent overwrite on differing content:** differing content is always either an explicitly confirmed update or a pending conflict.

## Showing and resolving conflicts (decided for v1, D-015)

Everything in this section is the final v1 behavior, except items explicitly marked "proposal only".

- After import, a summary screen: "Added 12 · Already here 140 · Needs your decision 3 · Updates waiting for confirmation 5".
- A **Conflicts** list (also reachable later from Settings → Backup) shows each item side by side: "On this device" and "In backup (from *device name*, exported *date*)". Changed fields are highlighted; dates are shown in the user's calendar display.
- Choices per item:
  - **Keep this device's version** (the backup version moves to the replaced-versions archive);
  - **Use the backup's version** (this device's version moves to the replaced-versions archive);
  - **Keep both** — **only for independent record types** (no links in either direction, see "Links"): the backup version is added as a new item with a new ID and a "(copy)" marker. Not offered for linked records (projects, workstreams, tasks, calendar blocks, sessions, goals, …), singletons such as preferences, or append-only history;
  - for deletions: **Restore** or **Keep deleted** / **Delete here** or **Keep**.
- **Linked records (projects, tasks, …):** the user chooses one of the two versions. Both versions are preserved, unchanged and visible, until the user decides; the choice keeps the record's ID, so everything that links to it (tasks under a project, sessions under a task, snapshots in history) stays attached to the same item. The unchosen version goes to the replaced-versions archive. Copying a linked item is not offered in v1 because it would make it unclear which copy the existing links, history, and goal attributions belong to.
- **Possible later option (proposal only, not in v1 scope):** "copy without links" for linked items — create a copy with a new ID that keeps only its outgoing links to records that exist on both sides (e.g. a task copy still belongs to the same project) and receives no incoming links (no tasks, sessions, or history move to the copy), clearly marked as a detached copy. It would need per-type rules and tests, and owner approval.
- Bulk actions ("keep this device's version for all") require a confirmation that states how many items are affected.
- **Nothing is lost while undecided:** pending conflicts keep both versions locally until resolved and survive app restarts. The version that is replaced by a choice is kept in a local "replaced versions" archive (included in later backups) so a wrong choice can be undone.
- Append-only history with the same ID but different content should never happen; it is shown as an integrity warning with both versions, and nothing is changed automatically.
- Preferences: shared preferences (time zone, week start, calendar display) follow the normal rules for one singleton record (choose a version; no "keep both"). Device settings (language, theme) are never conflicts; the preview only offers "use the display settings of *device name*?" (see "Preferences").

## Export flow

- Settings → Backup → "Export backup". Shows what will be included (counts) and the last export date.
- Delivery:
  - Android and iPhone: the system share sheet (Web Share API with files) to save to Files, Drive, etc.; a download as fallback.
  - Windows: a save dialog (File System Access API in Chromium browsers) or a normal download.
- After export, the app records the time and shows "Last backup: N days ago". A gentle reminder after a user-chosen interval is a proposal only (not decided; no nagging by default). Backups matter on every platform because local data can be lost (ARCHITECTURE, "Platform installation, updates, and storage"), and especially on iPhone.

## Protection of the backup file (decided, D-014)

The file contains all personal data in readable form unless it is protected. There is no account or server in v1, so **nobody — not the developer and not the app — can recover a forgotten backup password.**

**v1 behavior (D-014):**

- On every export, the export screen shows a clearly visible **"Protect this file with a password"** option. It is **off by default**.
- If the user turns it on:
  - the password is entered **twice** and must match;
  - the user sees a clear warning before export that **forgetting this password makes this file impossible to restore**, and nobody can recover it;
  - the app recommends keeping the password in a **password manager**.
- Encryption: AES-256-GCM, key derived with PBKDF2-SHA-256 (600,000 iterations), as specified in "Encrypted file" above.
- Implementation safeguard (engineering, not a product option): before reporting success, the app re-opens the newly written file with the entered password, to catch a broken file at export time instead of at restore time.
- A password **hint** is not part of v1 (a hint would be readable by anyone holding the file).
- **Recovery key** (option D below): a possible future improvement, **not part of v1**.
- Each export decides on its own: protecting one file does not change other files or later exports.

**Options that were considered** (kept for reference; v1 uses B):

| Option | What it means | If the password is forgotten | Trade-offs |
|---|---|---|---|
| A. No app-level encryption | Plain JSON; protection relies on where the user stores the file (device lock, cloud account) | Not applicable | Simplest and most recoverable; anyone who gets the file can read it |
| B. Optional password per export | User may set a password when exporting. AES-256-GCM, key derived with PBKDF2-SHA-256 (Web Crypto, built into all target browsers; 600,000 iterations, readers accept 600,000–1,000,000) and a random salt | That backup is **permanently unreadable** | Good protection when used; real risk of permanent loss for an infrequently used password |
| C. Mandatory password | Every export is encrypted (as B) | Every such backup is lost | Strongest default protection; highest loss risk for a non-specialist owner |
| D. Password plus recovery key | The file key is wrapped twice: by the password and by a randomly generated recovery key shown once (to print or save separately) | Recoverable with the recovery key; lost only if both are lost | Most robust; more steps and more to explain |
| E. Rely on device/cloud encryption | Like A, but the app recommends storing backups only in encrypted locations | Not applicable | No app complexity; protection outside the app's control |

Option D could be added later in a new format version (a `recoveryKey` key slot), with owner approval.

Separate from backups: data inside the app (IndexedDB) is protected only by the device's own lock and storage encryption. App-level encryption at rest is out of scope for v1.

## Implementation notes (Stage 1B)

These are how the implementation applies the rules above where the text left a detail open. None changes an owner decision.

- **Deletions are versions.** A tombstone carries a version vector like any edit. So a backup item whose version is already contained in a local tombstone is an **older copy** (it was deleted here after that state) and is skipped instead of raising "Deleted here" again; likewise a backup tombstone whose version is contained in the local record's version is an older copy. Only deletions that this device has not seen, or that crossed an edit made here, become "Deleted here" / "Deleted in backup" conflicts.
- **Every resolution records the decision.** Whatever the user chooses, the resulting record or tombstone gets a version that contains every version involved (merged and bumped for this device). Importing the same backup again therefore classifies the item as an older copy and does not ask again.
- **Conflicts compare against this device's version NOW** (Codex review). A pending conflict stores the backup's version (`incoming`) and a **snapshot** (`local`) of the version on the device where it was found, with `detectedOn` (device ID and name; written for every conflict found from commit `20a44e5` on). The Conflicts screen shows "On this device now" from the database, not the snapshot; the choices offered follow the current state (a record, a deletion, or nothing). If the snapshot differs from both the current version and the backup's (an edit made after detection, or a conflict carried from another device), it is shown separately, labelled with its device and date, and archived when the user decides.
- **`detectedOn` is optional in format version 1** (compatibility, Codex review). The first Stage 1B build (`53d38c2`) stored pending conflicts and wrote files without it, and `formatVersion` stayed 1 with no IndexedDB migration. So readers accept a pending-conflict entry with or without `detectedOn` (if present it must be valid: an object with a UUID `deviceId` and a `deviceName` of at most 80 characters; `null` is refused). Missing means **unknown**: it is never filled in, guessed, or replaced with this device or the file's source device. Such entries are imported, stored, exported, and re-imported unchanged (both versions kept, still without `detectedOn`), and resolved like any other; the Conflicts screen says that the device where the conflict was found is not known. Writers always include it for newly found conflicts. Note: the `53d38c2` build itself refuses files that contain a pending conflict with `detectedOn` (its schema was strict); such a device must update the app to import them.
- **A choice is applied only to the versions that were shown.** The UI sends a token of the current version it displayed; if this device's version changed in between, the choice is refused (nothing changes) and the comparison refreshes for a new decision. The bulk action skips items that changed and leaves them pending.
- **Nothing that is not kept is lost.** On every resolution, each version not kept — the backup's, the replaced current one, and a differing snapshot — goes to the replaced-versions archive. "Keep this device's version" when this device has nothing records that absence as a deletion marker (the backup's version and the snapshot are archived).
- **Links in every version** (Codex review). At import, every record version in the file — active records, both versions of carried conflicts, and archived versions — may only link to IDs known in the file (record, tombstone, conflict or archive version) or on this device (record or tombstone); otherwise the file is refused. Conflict and archive versions are history, so a link to a since-deleted item is allowed there. A version becomes **active** (imported as new, confirmed update, "use the backup's version", "restore", "keep both", or undo) only if each link resolves to a **live** record at that moment, checked inside the same transaction; otherwise the whole operation is refused and nothing changes. The import also re-checks this inside its transaction, so a target deleted between preview and import makes the import fail as a whole.
- **Relationship rules in every version** (Stage 2, DECISIONS T-022). After the link check, the import checks (1) that every version of one ID — in the file and on this device (record, pending conflicts, archive) — agrees on immutable fields (a workstream's `projectId`), and (2) that every record version in the file satisfies its type's rule (a task's workstream belongs to the task's project; an inbox task has no workstream), looking the workstream up in any known version. Otherwise the file is refused (`INVALID_RELATIONSHIP`) and nothing changes. The rule is checked again inside the transaction for versions that become active (import, "use the backup's version", "restore", undo).
- **"Keep both" copy marker** (`copyOf`) is stored only on the device; the format-version-1 envelope has no field for it, so it is not exported.
- **Backup tombstones for IDs this device never had** are stored as tombstones ("newTombstone"). This deletes nothing; it only prevents an older backup from adding the item back as "new" later.
- **Unconfirmed "newer in backup" items** are not stored; the user can import the same file again later and confirm them.
- **Carried pending conflicts and replaced versions** from another device are added once (by ID) and skipped when this device already has that version or a later one.
- **Deleting a record that other records link to is refused** (restrict, never cascade), for "Delete it here too" and for undo. In Stage 1B this was exercised with the linked test fixtures; since Stage 2 also with projects that still have tasks.
- **Preview writes nothing.** A singleton that was never stored is compared as its untouched default; the default is written only inside the import transaction.
- **Migration** copies the legacy `"self"` row; the row itself is left unchanged for the frozen sync code (D-016), and v1 never reads it again.
- **Export delivery:** a normal download on every platform, plus a "Share or save…" button where the browser supports sharing files (typically Android and iPhone). The File System Access save dialog is not used; the spec allows "a save dialog … or a normal download".
- **Device name** is editable on the Backup screen and written into the header (≤ 80 characters).
- **Limits that cannot be reached through a valid file:** a decrypted payload over 32 MiB cannot occur, because base64 ciphertext inside a file of at most 32 MiB holds at most about 24 MiB. The check stays in place as defense in depth.
- **Sample files:** `apps/web/src/backup/samples/pps-backup-format-v1.json` (data version 1), `pps-backup-format-v1-data-v2.json` (data version 2, Stage 2), and `pps-backup-format-v1-data-v3.json` (data version 3, Stage 3: tasks with and without recurrence, capacity set, planned and cancelled blocks, a block with and without `occurrenceDate`) contain fabricated data only and are imported by the tests; regenerate a sample only for its own version (`PPS_WRITE_SAMPLE=1`), never to replace an older one.
- **Per-version fields** (Stage 3, T-025). Each record type may keep the schema of older data versions (`olderSchemas` in `backup/registry.ts`); a file is validated with the schemas of its own `dataSchemaVersion`, so a version-2 task with `recurrence` or version-2 preferences with `dailyCapacityMinutes` are refused (`INVALID_PAYLOAD`) and a version-2 file with `calendarBlocks` is refused as unknown data (`UNKNOWN_RECORD_TYPE`). `null` for the optional fields is refused in every version.
- **Block rules live in the block schema** (Stage 3): end after start, at most 24 hours, instants written exactly as `YYYY-MM-DDTHH:MM:00.000Z` (whole minutes), valid IANA zone, `localDate` equal to the local date of `startsAt` in the block's zone, consistent snapshot. Because they are part of the type's schema, they apply to typed-in data and to every version in a file (records, carried conflicts, archive).

## How this prepares for future sync (not built now)

The same primitives serve a later sync feature: stable UUIDs, per-device IDs, version vectors, content hashes, tombstones, and a conflict store with side-by-side resolution. A future sync service can exchange exactly these record envelopes; the existing Stage 1 sync code (server revisions), kept frozen and inactive in v1 (D-016), would be reviewed and adapted to version vectors at that time, and may need further changes.
