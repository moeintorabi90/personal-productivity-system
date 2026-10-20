# Testing Strategy

Testing requirements are part of delivery. A reported result must name the exact command and observed outcome; skipped work includes the concrete reason.

## Test layers

- **Pure unit tests:** date/time conversion, recurrence, week boundaries, goal progress/pacing, metric aggregation, estimation suggestions, state transitions, and validation.
- **Client component tests:** React Testing Library for forms, accessible controls, RTL/LTR behavior, offline/sync indicators, and conflict resolution UI.
- **Local repository/domain tests (v1):** IndexedDB repository through fake-indexeddb: relationship rules, history immutability, version vectors, tombstones, local schema upgrades.
- **Backup tests (v1):** export/import round-trip, merge classification, idempotent re-import, conflicts, upgrades, corrupted/foreign/newer files, encryption if chosen (see below).
- **API integration and server database tests (frozen Stage 1 code, after v1):** real Express handlers with PostgreSQL; kept running in `npm test` so the frozen code does not rot, but not a v1 release gate.
- **End-to-end tests:** Playwright workflows for first run, project/task creation, planning, offline logging, export and import with conflict handling, review finalization.
- **Manual platform checks:** Windows 11 desktop, Android install/offline use and file export/import, and iPhone install/offline/file feasibility on supported browsers. Record device/OS/browser versions and limitations.
- **Accessibility/localization checks:** English LTR, Persian RTL, keyboard and screen-reader labeling, theme contrast, and long text/date layouts.

## Minimum acceptance coverage (v1)

- First run without account; preference persistence; everything works with the network disabled.
- Project/workstream/task relationship rules enforced locally, for typed-in and imported data.
- Backup: see "Backup acceptance tests" below.
- Concurrent edits (same item changed on two devices, then merged via backup) surfaced as conflicts without lost data.
- Timezone, DST, week start, recurrence, Gregorian/Jalali display separation.
- Goal progress and active-day pacing against documented examples.
- Running/finished session invariants, chronology, unplanned execution, correction audit.
- Planned/actual separation, historical snapshots captured locally when a session or block is recorded (task/project/workstream names at that time; unchanged by later edits and by imports), actual output recording.
- Dashboard definitions and calculation consistency.
- Weekly finalized snapshot stability and estimation suggestion behavior.
- Local data upgrade from the previous app version without loss.
- Essential responsive workflows and theme/language persistence.

## Backup acceptance tests (v1, Stage 1B onward)

Automated (Vitest, two simulated devices with separate fake IndexedDB stores, plus Playwright for the real file flow):

1. **Round-trip:** export from device A, import into empty device B → all records, tombstones, and history identical (by ID and content hash).
2. **Merge, no loss:** B has its own items; importing A's backup adds A's items and leaves every B item unchanged; nothing is deleted.
3. **Idempotent:** importing the same file twice → second import reports everything "already here", database unchanged, no duplicate IDs.
4. **Older copy:** export, edit locally, re-import the old file → local edits kept, no conflict.
5. **Newer in backup:** item unchanged on B since it came from A, edited on A → listed as an update needing confirmation; not applied without confirmation.
6. **True conflict:** same item edited on A and B → pending conflict with both versions; survives app restart; each resolution choice gives the expected result; undo restores the replaced version. For an **independent** fixture type, "keep both" adds a copy with a new ID. For a **linked** fixture type (parent with children), "keep both" is not offered; choosing either version keeps the ID and all children stay attached.
7. **Deletions:** deleted on A and still present on B (and the reverse) → pending conflict, never an automatic delete or resurrection.
8. **History:** append-only records merge by ID; corrections are appended; same ID with different content raises an integrity warning and changes nothing.
9. **Bad input:** truncated file, wrong `format`, hash mismatch, schema violation, unknown record type, unresolved reference → refused with a clear message, database unchanged.
9a. **Input limits** (values from `BACKUP_FORMAT.md`, "Input limits"): a file of 32 MiB + 1 byte is refused without its contents being read; files at exactly the limits are accepted; more than 200,000 entries, an envelope over 256 KiB, a version vector with 33 entries, or an oversized decrypted payload → refused; unknown header or `encryption` fields → refused.
9b. **KDF bounds before work:** `iterations` of 599,999 or 1,000,001 (600,000 and 1,000,000 accepted), a non-integer, a salt that is not 16 bytes, an IV that is not 12 bytes, a `wrappedKey` that is not 48 bytes, more than two key slots, or an unknown cipher/hash → refused **before** the password prompt; a test spy on the PBKDF2 call confirms it was never invoked.
9c. **Pre-parse scan before `JSON.parse`:** a spy on `JSON.parse` confirms it is **never called** for: nesting of 33 levels (32 accepted); a pathological file of millions of `[` (up to the size limit), which is rejected without a stack overflow; mismatched brackets (`[}`); an unterminated string; a raw control character or invalid escape in a string; brackets inside strings, which must not count toward depth (accepted); trailing content after the top-level value; more than 4,000,000 values (exactly 4,000,000 accepted); invalid UTF-8 bytes. The same cases inside the decrypted plaintext of an encrypted file are rejected before its `JSON.parse`. A syntactically invalid file that passes the scan (e.g. a bad number literal) is refused by `JSON.parse` with the database unchanged.
10. **Scope:** an export never contains `sync_probe` or sync-machinery data, even when the device has diagnostic notes; a file that contains them is refused.
11. **Versioning:** a committed sample file for every released `formatVersion` imports into the current app; a file with a newer version is refused without changes.
12. **Integrity hash:** computed over the JCS-canonical document without `integrity`; matches an independent reference implementation on the committed sample files; a damaged encrypted file is reported as damaged before any password prompt.
13. **Encryption (if chosen):** correct password round-trips; wrong password fails without changes; modified ciphertext, IV, salt, iteration count (within bounds), or any header field fails authentication; a password containing a canonically equivalent sequence in another form (e.g. `آ` precomposed vs decomposed) still works; a password typed with Arabic Yeh `ي` instead of Persian Yeh `ی` is treated as a **different** password (documents the limited NFC guarantee); the forgotten-password warning is shown before export.
14. **Preview accuracy:** preview counts equal what is applied.
15. **Identity is the UUID:** two records with different UUIDs and identical content (created separately on two devices) are both kept after import; `contentHash` equality only skips versions with the same ID.
16. **Preferences:** the shared preferences record has the reserved ID on every device; importing into a device with untouched defaults shows "newer in backup" (not a conflict); edits on both devices give a conflict with no "keep both" option; language and theme are never merged or turned into conflicts, and are changed only if the user accepts "use the display settings of …"; the Stage 1B migration of the existing `"self"` row keeps all values.

Until later stages add real product types, items 1–9, 14, and 15 use test-only fixture record types (one independent, one linked parent/child pair) plus preferences.

Manual on real devices (record versions): export on Windows → import on Android, and the reverse; file picker/share sheet behavior; iPhone feasibility of export/import with `.json`.

## Release gate

A stage is not complete while a critical acceptance item has an unexplained failure. Do not claim an endpoint works based only on a pure helper test. Keep a small test report in the stage notes with passed, failed, skipped, and not-yet-tested items.

## Stage 1 test report (2026-10-20)

Environment: Windows 11 Enterprise, Node.js 24.20.0, npm 11.19.0, TypeScript 7.0.2, Vitest 5.0.5, Playwright 1.64, Microsoft Edge 155.0.4283.62 (headless), PGlite 0.5.

| Command | Result |
|---|---|
| `npm run typecheck` | Passed (shared, API, web; exit 0) |
| `npm test` | **53 passed, 0 failed** in 10 files |
| `npm run build` | Passed (`apps/web/dist`, `sw.js` with 11 precached files) |
| `npm run test:e2e` | **3 passed, 0 failed** (Edge) |
| `npm run db:migrate` twice on an empty on-disk PGlite database (C:) | First run applied `0001_foundation.sql`; second run applied none |
| API started with `node --import ./tools/node-aliases.mjs apps/api/src/server.ts` | `/v1/health` and `/v1/setup/status` answered |
| Manual check in a browser against the dev servers | Owner setup, Persian RTL, calendar "both" (Jalali + Gregorian), preference and note sync confirmed against the server; test data deleted afterwards |

Automated coverage by file:

- `packages/shared/src/schemas.test.ts` (7): IANA time-zone validation, preference defaults/patch rules, setup input normalization, sync operation shapes.
- `apps/api/test/migrations.test.ts` (4): migrate from empty creates all tables; re-run is a no-op; edited migration is refused; single-owner and preference CHECK constraints.
- `apps/api/test/auth.test.ts` (10): setup exactly once; setup token; field errors without echoing the password; malformed JSON; sign-in on a second device; wrong password and unknown email give the same error; sign-out; 401 on every owner route; device revocation; failed-login rate limit; only token hashes and scrypt hashes stored; 404 shape.
- `apps/api/test/preferences.test.ts` (3): defaults and patch with revision; invalid values and unknown fields (e.g. `ownerId`) rejected; concurrent edit returns `409 CONFLICT` with current and submitted values and no lost update.
- `apps/api/test/sync.test.ts` (9): idempotent retry returns the stored result and creates one row; opId reuse with different content rejected; per-operation validation; update/delete revisions, stale update conflict, update after tombstone conflict; preference conflict through push; ordered pull with tombstones, paging, stable cursor; malformed cursor; owner isolation (foreign update/delete → `NOT_FOUND`, same client UUID under another owner is separate, pulls never cross owners); client-supplied owner fields ignored.
- `apps/api/test/pg-wire.test.ts` (1): the production `pg` driver over the PostgreSQL wire protocol (PGlite socket server): migrate from empty, setup, idempotent push, pull, transaction rollback.
- `apps/api/test/config.test.ts` (8): default data folder outside the repo; production refuses to start without `SETUP_TOKEN`/`DATABASE_URL`; invalid port; loopback host by default (also in production); explicit loopback names are not exposed; non-loopback `HOST` refused without a setup token; exposure allowed only with a ≥ 24-character token; weak token rejected.
- `apps/api/test/network.test.ts` (4): server binds to `127.0.0.1` by default; a non-loopback `Host` header (DNS rebinding) gets `403 HOST_NOT_ALLOWED` and cannot run setup, while `localhost`, `127.0.0.1`, `[::1]` work; exposed mode accepts other host names but setup still requires the token; Host-header parsing.
- `apps/web/src/local/repository.test.ts` (6): device identity; no queueing while signed out; coalescing of edits; create+delete never sent; update→delete keeps base revision; no merging into an in-flight operation.
- `apps/web/src/sync/two-clients.test.ts` (5): two simulated devices (real sync engine + IndexedDB via fake-indexeddb) against the real API and database: offline write stays local; lost push response then retry → exactly one server record; edits and tombstones flow both ways; coalesced offline edits; preference conflict resolved both ways; edit-vs-delete conflict keeps the edit as a new note; revoked session stops sync and keeps local data.
- `apps/web/src/App.test.tsx` (5, jsdom): English LTR default with accessible navigation; Persian switches `dir="rtl"`/`lang="fa"` and persists; theme applied to the document; time zone never imposed and invalid names rejected; offline indicator and local writes while offline.
- `apps/web/e2e/offline.spec.ts` (3, Edge): installed shell reloads and works offline (with a local write); a note survives closing the browser and reopening it **offline** with a persistent profile; Persian RTL layout (navigation starts at the right edge) and dark theme persist after reload.

Security fix after Codex review (branch `fix/api-loopback-bind`, DECISIONS T-015), re-verified: `npm run typecheck` passed; `npm test` **62 passed, 0 failed** in 11 files; `npm run test:e2e` 3 passed. Manual runtime check: with `HOST` unset, only `127.0.0.1:<port>` was listening and the PC's LAN address could not connect (`Test-NetConnection` false); `HOST=0.0.0.0` without `SETUP_TOKEN` exited with an explanatory error; the Vite dev proxy reached the API (`/v1/setup/status` → 200).

A defect found by these tests and fixed: the service worker missed cached JS/CSS offline because the server's `Vary: Origin` header made `caches.match` fail for `crossorigin` requests (now `ignoreVary: true`).

Scope note (D-012, added after this report): the server, authentication, and sync tests above cover the frozen post-v1 code; they keep running but are no longer v1 gates.

Not yet tested (Stage 1):

- **(Post-v1, no longer a v1 gate)** The full suite against a native PostgreSQL server (`TEST_DATABASE_URL`): no server is available on this PC and Docker is excluded. Only the wire-protocol path against PGlite has run.
- **Android and iPhone** installation and offline use on real devices; PWA install prompt on Windows (headless E2E does not exercise installation UI).
- Screen-reader pass and contrast measurement (semantic labels and focus styles exist; not audited with assistive technology).
- Concurrent pushes from two devices at the same instant on real PostgreSQL (owner row lock is implemented; PGlite serializes transactions, so the race is not exercised).
