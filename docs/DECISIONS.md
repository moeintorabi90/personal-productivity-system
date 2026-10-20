# Decisions and Open Questions

## Agreed product decisions

| ID | Decision | Status |
|---|---|---|
| D-001 | English is the default interface; Persian is selectable with full RTL support. | Agreed |
| D-002 | Windows 11 and Android are the primary devices; iPhone installation is desired if feasible. | Agreed |
| D-003 | Ordinary app workflows must work offline; internet is used to synchronize devices. | Agreed |
| D-004 | Start with a private sync service. | Agreed in principle; provider/hosting/security details open |
| D-005 | Initial product is for one person's own devices, without collaboration features. | Agreed |
| D-006 | Include quick capture, realistic prioritization/capacity, plan-vs-actual, weekly review, backup/export. | Agreed |
| D-007 | AI features are optional future additions; core product must not depend on AI connectivity. | Recommended and accepted as product direction |

## Proposed technical decisions

| ID | Proposal | Reason | Status |
|---|---|---|---|
| T-001 | Evaluate an installable PWA as the first client approach. | One codebase may serve desktop and phones; validate offline/install behavior on iOS before commitment. | Proposed; requires platform proof |
| T-002 | Keep an IndexedDB local store and sync through an authenticated TypeScript API to PostgreSQL. | Supports offline work with clear server validation and recoverable cross-device sync. | Proposed |
| T-003 | Detect concurrent edits using revisions and ask the user to resolve conflicts. | Prevents silent loss of changes while staying simpler than general CRDT replication. | Proposed |
| T-004 | Use managed private hosting for the sync API/database initially, with export/restore and reliable backups. | Less maintenance for a non-specialist owner. | Recommended; provider/cost/region open |
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
| T-014 | The repository keeps a monorepo folder layout (`apps/web`, `apps/api`, `packages/shared`) but uses **one root `package.json`** instead of npm workspaces. Internal packages are resolved by path aliases: TypeScript `paths`, Vite/Vitest `resolve.alias`, and a small Node resolve hook (`tools/node-aliases.mjs`) for the API runtime. | The project folder is on drive E:, which is **exFAT**; exFAT supports neither symlinks nor junctions, and `npm install` with workspaces failed with `EISDIR … symlink`. Moving the repository to an NTFS drive was not chosen because the owner specified this location. | Adopted. If the repository moves to NTFS, npm workspaces can be restored without code changes. |

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

These should be settled before the architecture is treated as final and before Stage 1 creates an account or stores real personal data.

1. **Sync hosting and jurisdiction:** managed service provider, expected monthly budget, and preferred data region. Recommendation: managed service with a private owner account, transparent backup/restore, and no public sharing.
2. **Encryption model:** standard HTTPS plus provider encryption-at-rest, or end-to-end encryption. Recommendation for the first release: HTTPS, strong authentication, encrypted provider storage/backups, and user export; investigate end-to-end encryption if the data sensitivity requires it because it complicates password recovery and server-side analytics.
3. **Account recovery:** email/password, passkey, or another recovery method. Recommendation: standard low-friction owner sign-in with a tested recovery flow; no account sharing.
4. **iPhone support bar:** installable and foreground offline use may be sufficient, or must background-sync/notify like a native app. Recommendation: require installability and foreground offline use first; decide on background behavior after device validation.
5. **Default calendar preferences:** initial proposal is English + Gregorian display, selectable Jalali/Both, Saturday week start as a configurable default suited to the user's locale, and explicit timezone selection. User may choose different defaults during first-run setup.
6. **Capacity and prioritization defaults:** choose default daily capacity and whether essential/important/flexible labels are enough for the first release. Recommendation: user-configurable capacity with simple Must / Should / Could labels and no automatic overload.

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
