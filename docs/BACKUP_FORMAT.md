# Offline Backup: File Format, Merge, and Conflicts (Proposal)

Status: **proposed design for v1** (DECISIONS D-008 to D-012, T-016 to T-019). Nothing in this document is implemented yet. Backup protection (encryption and forgotten passwords) is an **open owner decision** (DECISIONS open question 7); options are listed at the end.

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
- Full backups only in v1 (all records of all types). Partial or incremental backups are out of scope.

## Top-level structure (format version 1)

```jsonc
{
  "format": "pps-backup",            // constant; identifies the file
  "formatVersion": 1,                // integer; bumped on any incompatible change
  "backupId": "uuid",                // unique per export; used for the import log
  "createdAt": "2026-10-20T18:30:00.000Z",
  "app": { "version": "0.2.0", "dataSchemaVersion": 1 },
  "sourceDevice": { "id": "uuid", "name": "Windows laptop" },
  "encryption": null,                // or an envelope description (see "Protection")
  "payload": {                       // encrypted as a whole when encryption is used
    "records": {
      "preferences": [ /* … */ ],
      "projects":    [ /* added by later stages */ ]
    },
    "tombstones": [
      { "type": "projects", "id": "uuid", "deletedAt": "…", "version": { "deviceA": 4 } }
    ]
  },
  "integrity": { "algorithm": "SHA-256", "payloadHash": "hex" }
}
```

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

- **IDs** are UUIDs created on the device that created the record. The same ID on two devices always means "the same item".
- **Version vector:** every device has a stable device ID (already implemented). Each local edit increments that device's counter in the record's `version`. Comparing two vectors tells whether one version already contains the other (see merge rules). It stays small because one person has only a few devices.
- **contentHash** is computed over a canonical (sorted-key) serialization of `data`, so identical content is recognised even if it was written independently.
- **Append-only history** (execution sessions, output corrections, finalized weekly reviews) uses the same envelope. Its `data` never changes after creation; corrections are new records that reference the original.
- **Tombstones:** deleting an item on the device keeps a tombstone (ID, deletion time, version vector) instead of forgetting the ID. Tombstones are exported so another device learns about the deletion, but importing never deletes anything by itself (see conflicts).

### Integrity

- `integrity.payloadHash` covers the canonical payload. It detects truncated or corrupted files (for example a partial download). It does **not** prove who made the file; only authenticated encryption (AES-GCM) does that.
- The whole file is validated against the format schema **before** any data is touched. Every reference inside the file must resolve to a record in the file or on the device (e.g. a task's project).

## Versioning and upgrades

- `formatVersion` describes the container and envelope; `dataSchemaVersion` describes the record types and their fields.
- The importer contains a chain of upgrade functions (`v1 → v2 → …`). An older file is upgraded in memory, then validated against the current schema. Upgrades never lose fields; removed concepts are mapped or kept in an `extra` object.
- A file with a **newer** version than the app understands is refused with a clear message ("This backup was made by a newer version; update the app first"). It is never partially imported.
- Every format change ships with a stored sample file of the previous version and a test that the new app imports it.

## Import flow

1. **Choose file** (file picker; works on Windows, Android, and iPhone).
2. **Read and check:** format, version, integrity hash, schema, references. If encrypted, ask for the password (see Protection). On any failure: stop, explain, change nothing.
3. **Preview** (nothing written yet). Each item in the file is classified:

| Category | Rule | Default action |
|---|---|---|
| **New** | ID not on this device (and no local tombstone) | Add |
| **Already here** | Same ID and same `contentHash` | Skip (no change) |
| **Older copy** | File version is contained in the device version (the device has the same item with later edits) | Skip (no change) |
| **Newer in backup** | Device version is contained in the file version (the item changed elsewhere after this device last had it; this device has not edited it since) | Listed for confirmation; not applied until the user confirms |
| **Conflict** | Neither version contains the other (edited on both sides), or same ID with different content and no usable version information | Kept as a pending conflict; the user decides |
| **Deleted here** | File has an item that this device deleted (local tombstone) | Kept as a pending conflict ("restore or keep deleted") |
| **Deleted in backup** | File has a tombstone for an item that exists here | Kept as a pending conflict ("delete here or keep") |

4. **Apply** (one local database transaction, all or nothing): add new items, apply confirmed updates, and store pending conflicts with **both** versions. The device's own versions of conflicting items stay exactly as they were.
5. **Record** an import log entry: `backupId`, file creation time, source device, counts per category, time of import. Re-importing the same `backupId` is allowed and shows "already imported on …"; because of the rules above, it changes nothing new.

Why this satisfies the requirements:

- **No replacement or deletion by import:** only "New" items are written automatically. Updates and deletions need an explicit user choice.
- **No duplicates on re-import:** identity is the UUID; identical or older copies are skipped.
- **No silent overwrite on differing content:** differing content is always either an explicitly confirmed update or a pending conflict.

## Showing and resolving conflicts (proposed UX)

- After import, a summary screen: "Added 12 · Already here 140 · Needs your decision 3 · Updates waiting for confirmation 5".
- A **Conflicts** list (also reachable later from Settings → Backup) shows each item side by side: "On this device" and "In backup (from *device name*, exported *date*)". Changed fields are highlighted; dates are shown in the user's calendar display.
- Choices per item:
  - **Keep this device's version** (backup version is discarded from the pending list);
  - **Use the backup's version**;
  - **Keep both** (the backup version is added as a new item with a new ID and a "(copy)" marker) — offered for user content such as notes, tasks, and projects, not for singletons such as preferences or for append-only history;
  - for deletions: **Restore** or **Keep deleted** / **Delete here** or **Keep**.
- Bulk actions ("keep this device's version for all") require a confirmation that states how many items are affected.
- **Nothing is lost while undecided:** pending conflicts keep both versions locally until resolved and survive app restarts. The version that is replaced by a choice is kept in a local "replaced versions" archive (included in later backups) so a wrong choice can be undone.
- Append-only history with the same ID but different content should never happen; it is shown as an integrity warning with both versions, and nothing is changed automatically.
- Preferences: language and theme differences are offered as "apply backup preferences?" instead of being merged field by field.

## Export flow

- Settings → Backup → "Export backup". Shows what will be included (counts) and the last export date.
- Delivery:
  - Android and iPhone: the system share sheet (Web Share API with files) to save to Files, Drive, etc.; a download as fallback.
  - Windows: a save dialog (File System Access API in Chromium browsers) or a normal download.
- After export, the app records the time and shows "Last backup: N days ago". A gentle reminder after a user-chosen interval is proposed (no nagging by default). Backups matter more on iPhone because Safari may evict data of web apps not added to the Home Screen.

## Protection of the backup file (open decision — options)

The file contains all personal data in readable form unless it is protected. There is no account or server in v1, so **nobody — not the developer and not the app — can recover a forgotten backup password.**

| Option | What it means | If the password is forgotten | Trade-offs |
|---|---|---|---|
| A. No app-level encryption | Plain JSON; protection relies on where the user stores the file (device lock, cloud account) | Not applicable | Simplest and most recoverable; anyone who gets the file can read it |
| B. Optional password per export | User may set a password when exporting. AES-256-GCM, key derived with PBKDF2-SHA-256 (Web Crypto, built into all target browsers; ≥ 600,000 iterations) and a random salt | That backup is **permanently unreadable** | Good protection when used; real risk of permanent loss for an infrequently used password |
| C. Mandatory password | Every export is encrypted (as B) | Every such backup is lost | Strongest default protection; highest loss risk for a non-specialist owner |
| D. Password plus recovery key | The file key is wrapped twice: by the password and by a randomly generated recovery key shown once (to print or save separately) | Recoverable with the recovery key; lost only if both are lost | Most robust; more steps and more to explain |
| E. Rely on device/cloud encryption | Like A, but the app recommends storing backups only in encrypted locations | Not applicable | No app complexity; protection outside the app's control |

**Recommendation (for the owner to decide):** start with **B, optional password, off by default but offered clearly at every export**, with these safeguards: enter the password twice; a plain warning that a forgotten password makes the backup unrecoverable; an immediate "verify" step that re-opens the new file with the password before the export is reported as successful; an optional non-secret hint stored in the file; and advice to keep the password in a password manager. Plan **D** as an upgrade if backups become the main long-term storage. The file format already reserves the `encryption` envelope (algorithm, KDF, iterations, salt, IV, optional hint, optional wrapped recovery key), so this choice does not block implementing unencrypted export first.

Separate from backups: data inside the app (IndexedDB) is protected only by the device's own lock and storage encryption. App-level encryption at rest is out of scope for v1.

## How this prepares for future sync (not built now)

The same primitives serve a later sync feature: stable UUIDs, per-device IDs, version vectors, content hashes, tombstones, and a conflict store with side-by-side resolution. A future sync service can exchange exactly these record envelopes; the existing Stage 1 sync code (server revisions) would be adapted to version vectors at that time (DECISIONS T-019).
