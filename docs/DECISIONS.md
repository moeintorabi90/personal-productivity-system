# Decisions and Open Questions

## Agreed product decisions

| ID | Decision | Status |
|---|---|---|
| D-001 | English is the default interface; Persian is selectable with full RTL support. | Agreed |
| D-002 | Windows 11 and Android are the primary devices; iPhone installation is desired if feasible. | Agreed |
| D-003 | Ordinary app workflows must work offline; internet is used to synchronize devices. | **Revised by D-008 for v1:** no internet use for data in v1; sync is post-v1 |
| D-004 | Start with a private sync service. | **Deferred to after v1 by D-010** |
| D-005 | Initial product is for one person's own devices, without collaboration features. | Agreed |
| D-006 | Include quick capture, realistic prioritization/capacity, plan-vs-actual, weekly review, backup/export. | Agreed |
| D-007 | AI features are optional future additions; core product must not depend on AI connectivity. | Recommended and accepted as product direction |
| D-008 | **Version 1 works entirely without internet.** Each device keeps its own data locally. Clarification: this covers daily use after installation and all user data; installing the app the first time and receiving app updates may need internet depending on the delivery method (open question 8). | Agreed (owner, 2026-10-20) |
| D-009 | Version 1 includes **manual offline backup**: export one file and restore it on Windows and Android; the format stays usable by a future iPhone version. See `BACKUP_FORMAT.md`. | Agreed (owner, 2026-10-20) |
| D-010 | Importing a backup **merges** with existing data; it never replaces or deletes it by itself. Re-importing the same file creates no duplicates. Same ID with different content is never silently overwritten or deleted. | Agreed (owner, 2026-10-20); resolution UX proposed in `BACKUP_FORMAT.md` (T-017), awaiting owner review |
| D-011 | The backup file is **versioned** so later app versions can upgrade and read it. | Agreed (owner, 2026-10-20) |
| D-012 | **Not in v1:** automatic sync, any data server, user accounts, and email recovery. The structure must keep adding sync later simple, without building its infrastructure now. Transfer between devices in v1 is manual (backup file). | Agreed (owner, 2026-10-20). Supersedes D-004 and the server parts of D-003 for v1. |

## Proposed technical decisions

| ID | Proposal | Reason | Status |
|---|---|---|---|
| T-001 | Evaluate an installable PWA as the first client approach. | One codebase may serve desktop and phones; validate offline/install behavior on iOS before commitment. | Proposed; requires platform proof |
| T-002 | Keep an IndexedDB local store and sync through an authenticated TypeScript API to PostgreSQL. | Supports offline work with clear server validation and recoverable cross-device sync. | IndexedDB store: adopted for v1. API/PostgreSQL sync: post-v1 (D-012) |
| T-003 | Detect concurrent edits using revisions and ask the user to resolve conflicts. | Prevents silent loss of changes while staying simpler than general CRDT replication. | Applies to v1 backup import as version vectors (T-016, T-017) |
| T-004 | Use managed private hosting for the sync API/database initially, with export/restore and reliable backups. | Less maintenance for a non-specialist owner. | Post-v1 (D-012) |
| T-005 | Do not install Docker Desktop by default on this PC; first evaluate native PostgreSQL on E: or a managed development database. | The device is at Docker's published 8 GB RAM minimum and had about 0.8 GB free during inspection. | Adopted; Docker not installed |

## Stage 1 technical decisions (2026-10-20)

| ID | Decision | Reason | Status |
|---|---|---|---|
| T-006 | Server data access uses plain SQL through a small `Db` interface, with the `pg` driver for real PostgreSQL. Migrations are numbered `.sql` files applied by a small runner that records them in `schema_migrations`. Prisma is not used in Stage 1. | See the comparison below. | Adopted |
| T-007 | Local development and automated tests use PGlite (`@electric-sql/pglite`): PostgreSQL compiled to WASM, running in-process with a data directory on an NTFS drive (default `%LOCALAPPDATA%`; it fails on exFAT). The same migrations and queries must run on a real PostgreSQL server; the API test suite runs against real PostgreSQL when `TEST_DATABASE_URL` is set, and also through the `pg` wire-protocol driver against PGlite via `@electric-sql/pglite-socket`. | No system install, no background service, no Docker; small footprint on a 7.8 GB RAM machine. | Adopted for dev/test. **Real PostgreSQL server compatibility is an open acceptance item** until the suite has run against one (managed dev DB or native install). |
| T-008 | Hand-written service worker with a build-time precache manifest instead of `vite-plugin-pwa`. | Stage 1 needs only a versioned app-shell cache; avoids the large `workbox-build` dependency chain. | Adopted |
| T-009 | Small typed in-house i18n dictionary instead of i18next. | The type system enforces that Persian has every English key; no runtime dependency. Revisit if pluralization grows. | Adopted |
| T-010 | Development authentication: one owner created once by `POST /v1/setup` (gated by the `SETUP_TOKEN` server secret when set; required in production), scrypt password hash (Node `crypto`), opaque random bearer token stored only as a SHA-256 hash and bound to an enrolled, revocable device. | Dependency-free; fits the one-owner/multi-device model. | Adopted for development only. Recovery flow (open decision 3) and hosting (open decision 1) must be settled before real data is used. |
| T-011 | Stage 1 sync proof uses two record types: owner preferences (mutable singleton with revisions and conflicts) and a diagnostic `sync_probe` note (create/update/delete with tombstones). The probe proves the sync engine before Stage 2 records exist; it is not a product feature and may be removed later. | Proves idempotency, conflicts, cursors, and tombstones without starting Stage 2 scope. | Adopted |
| T-012 | Pushes from one owner are serialized with a row lock on the owner record, so the per-owner change-log sequence is committed in order and pull cursors cannot skip changes. | A global `bigserial` can commit out of order across concurrent transactions. | Adopted |
| T-013 | Playwright end-to-end tests use the installed Microsoft Edge (`channel: "msedge"`). | Avoids downloading Playwright browsers on a constrained machine. | Adopted |
| T-015 | The API listens on `127.0.0.1` by default (`HOST` unset), in every environment. A non-loopback `HOST` is an explicit opt-in and requires `SETUP_TOKEN`; any `SETUP_TOKEN` must be at least 24 characters. In loopback mode, requests with a non-loopback `Host` header are rejected (`HOST_NOT_ALLOWED`) to block DNS rebinding. Hosted deployments set `HOST` (or sit behind a reverse proxy on loopback) and always have `SETUP_TOKEN`. | Codex review found that `listen` without a host bound to all interfaces while development setup could be open (`SETUP_TOKEN` unset), letting any device on the network claim the owner account. | Adopted (2026-10-20) |
| T-014 | The repository keeps a monorepo folder layout (`apps/web`, `apps/api`, `packages/shared`) but uses **one root `package.json`** instead of npm workspaces. Internal packages are resolved by path aliases: TypeScript `paths`, Vite/Vitest `resolve.alias`, and a small Node resolve hook (`tools/node-aliases.mjs`) for the API runtime. | The project folder is on drive E:, which is **exFAT**; exFAT supports neither symlinks nor junctions, and `npm install` with workspaces failed with `EISDIR … symlink`. Moving the repository to an NTFS drive was not chosen because the owner specified this location. | Adopted. If the repository moves to NTFS, npm workspaces can be restored without code changes. |

## v1 offline-and-backup technical decisions (2026-10-20, proposed)

These follow from D-008 to D-012. They are proposals until implemented and reviewed; details are in `BACKUP_FORMAT.md`.

| ID | Proposal | Reason | Status |
|---|---|---|---|
| T-016 | Every user record carries a client UUID, `createdAt`/`updatedAt` (UTC), a **version vector** keyed by device ID, and a **content hash**. Deletions keep **tombstones**. Append-only history records never change after creation. | Lets import tell "same", "older", "newer", and "edited on both sides" apart without a server, so re-import is idempotent and nothing is overwritten silently. The same primitives serve future sync. | Proposed |
| T-017 | Import is preview → confirm → one atomic local transaction. Only new items are added automatically; newer-in-backup items need confirmation; true conflicts and deletions are stored as pending conflicts with both versions and resolved side by side: keep this device's / use the backup's version for every record; "keep both" (copy with a new ID) only for independent record types without links. Linked records keep their ID and the user picks one version, so links and history stay attached. Replaced versions are archived locally for undo. | Safe and understandable; meets "merge, never replace or delete silently"; avoids ambiguous links and history from copies. | Proposed; final UX approval is an open owner decision |
| T-018 | Backup container: one UTF-8 JSON file (`.json`) with a header (`format`, integer `formatVersion`, `dataSchemaVersion`, `backupId`, source device, `encryption` = `null` or an envelope with key slots), a payload (plaintext object, or `{ ciphertext }` encrypted with AES-256-GCM using the canonical header as AAD), and a SHA-256 integrity hash over the JCS-canonical document without the `integrity` member. Only product record types are included (`sync_probe` excluded). Readers upgrade older versions step by step and refuse newer ones. Whether encryption is used at all is open question 7. | Portable across Windows, Android, and iPhone file pickers; inspectable; upgradeable; damage detectable before a password prompt. | Proposed |
| T-019 | The Stage 1 sync API, authentication, PostgreSQL schema, and client sync engine **stay in the repository, frozen and tested, but are not part of v1**: no further work on them, and the v1 UI must not show account/sync screens or the diagnostic "Sync check notes" (`sync_probe`), all hidden behind one build-time feature flag, off by default. `sync_probe` is never part of a backup. When sync is planned after v1, it is adapted to T-016 (version vectors instead of server revisions). | Preserves tested work at low cost and keeps the path to sync simple, without building more server infrastructure now. Alternative: move it to an archive branch to shrink the v1 codebase. | Proposed; owner may choose the archive alternative |

### Prisma 7 versus plain SQL + `pg` (checked 2026-10-20)

| Criterion | Prisma 7.10.1 (latest stable; `latest` tag is 8.0.0-rc.23) | Plain SQL + `pg` 8.23 |
|---|---|---|
| Install footprint | `prisma` CLI ~42 MB unpacked plus `@prisma/engines`, `@prisma/dev`, `@prisma/studio-core`, `mysql2`; `@prisma/client` ~74 MB unpacked | `pg` and its small dependencies (well under 1 MB) |
| PGlite for lightweight dev/test | Runtime only through the community `pglite-prisma-adapter` (built against driver utils 7.2.0, version skew); Prisma Migrate needs a database server connection (`prisma dev` adds its own local server) | Same SQL runs directly on PGlite in-process |
| Real PostgreSQL | First-class via `@prisma/adapter-pg` | First-class |
| Migrations | Generated, reviewable SQL; strong drift detection | Hand-written SQL; simple runner; no drift detection |
| Type safety | Generated types | Manual row types plus Zod validation at boundaries |
| Fit for sync rules (row locks, append-only log, revision checks) | Often needs raw SQL anyway | Direct |

Conclusion: for Stage 1 on this machine, plain SQL + `pg` is smaller, runs unchanged on PGlite and PostgreSQL, and keeps the sync transaction logic explicit. Revisit Prisma (or a lighter query builder) if Stage 2+ query volume makes hand-written SQL error-prone.

## Consequential open decisions

Questions 1–3 concern the post-v1 sync service (D-012) and no longer block v1. Questions 7, 8, and 9, and the final approval of the conflict-resolution UX (T-017), are open owner decisions for v1. Recommendations below are proposals, not decisions.

1. **(Post-v1) Sync hosting and jurisdiction:** managed service provider, expected monthly budget, and preferred data region. Recommendation: managed service with a private owner account, transparent backup/restore, and no public sharing.
2. **(Post-v1) Sync encryption model:** standard HTTPS plus provider encryption-at-rest, or end-to-end encryption. Recommendation for the first release: HTTPS, strong authentication, encrypted provider storage/backups, and user export; investigate end-to-end encryption if the data sensitivity requires it because it complicates password recovery and server-side analytics.
3. **(Post-v1) Account recovery:** email/password, passkey, or another recovery method. Recommendation: standard low-friction owner sign-in with a tested recovery flow; no account sharing.
4. **iPhone support bar:** installable and foreground offline use may be sufficient, or must background-sync/notify like a native app. Recommendation: require installability and foreground offline use first; decide on background behavior after device validation.
5. **Default calendar preferences:** initial proposal is English + Gregorian display, selectable Jalali/Both, Saturday week start as a configurable default suited to the user's locale, and explicit timezone selection. User may choose different defaults during first-run setup.
6. **Capacity and prioritization defaults:** choose default daily capacity and whether essential/important/flexible labels are enough for the first release. Recommendation: user-configurable capacity with simple Must / Should / Could labels and no automatic overload.
7. **(v1) Backup file protection and forgotten passwords:** options A–E are compared in `BACKUP_FORMAT.md` ("Protection of the backup file"). With no account or server, a forgotten backup password cannot be recovered by anyone. Recommendation, not decided: optional password per export (AES-256-GCM, PBKDF2), off by default but offered at each export, with double entry, an explicit loss warning, an immediate verify step, and an optional hint; a recovery key (option D) as a later upgrade.
8. **(v1) How the app itself is delivered and installed:** a web app (PWA) must be downloaded once over HTTPS to be installed on Android and iPhone, and app updates are fetched online; daily use afterwards is offline. Its local data belongs to the app's **origin** (scheme + host + port), so the origin must stay stable; changing it later makes existing data invisible (a backup would be the migration path). Options, none chosen: (a) a static HTTPS host that serves only the app files; (b) a native wrapper (e.g. Capacitor) distributed as an Android package/Windows installer, which avoids web hosting but adds signing/store work and an iOS build later; (c) local network serving, for testing only. In every option the party serving the code is trusted: a host never receives user data, but malicious or tampered code served from the app's origin could technically read the local data (ARCHITECTURE, "Trust in whoever serves the app code"). No hosting provider has been selected or evaluated, including availability from Iran. This is not a data server and does not conflict with D-012, but it needs an owner choice.
9. **(v1) Stage 1 server code:** keep frozen in the repository (T-019, proposed) or move to an archive branch. Not decided.

## Environment findings (2026-10-20)

- Workspace folder was empty and not a Git repository.
- Git 2.53.0, Node.js 24.20.0, npm 11.19.0, and VS Code are available.
- About 7.8 GB of visible RAM was detected, with about 0.8 GB free at inspection time. Disk free space: C: about 16.5 GB; E: about 72.5 GB.
- Docker is unavailable and WSL reports no installed Linux distribution. Docker's [current Windows requirements](https://docs.docker.com/desktop/setup/install/windows-install/) call for 8 GB system RAM and WSL 2; do not install it by default on this machine.
- No Git author name/email is configured in this workspace. The Stage 0 documentation checkpoint used a one-time, non-personal author label (`Stage 0 Documentation <stage0@localhost>`); configure the owner's preferred Git identity before the next commit.

## Environment findings (Stage 1, 2026-10-20)

- The owner configured a repository-level Git identity in `.git/config`.
- `git` is not on PATH; a Git 2.53 binary inside the Codex runtime was used. Git reports "dubious ownership" because exFAT does not record ownership; commands passed `-c safe.directory=…` instead of changing global configuration.
- Drive E: is **exFAT** (C: is NTFS). Consequences: no npm workspaces (T-014), and PGlite cannot keep its data on E: (fails with errno 28), so its default folder is `%LOCALAPPDATA%\PersonalProductivitySystem\pglite-dev`.
- No system software was installed. `node_modules` is about 170 MB.
