# Delivery Roadmap

Stages are sequential. Each stage ends with its acceptance criteria, focused automated tests, type checks, production build, diff/security review, documentation update, and a recoverable Git checkpoint. Do not move on with unexplained critical failures.

**Version 1 scope (DECISIONS D-008 to D-012):** works without internet; each device keeps its own data; manual backup export/import with merge moves data between devices. No sync, data server, accounts, or email recovery in v1. From Stage 1B on, **every new record type must be included in the backup format** and covered by round-trip and merge tests before its stage is complete.

## Stage 0 — Requirements and architecture (done)

**Deliverables:** product checklist, architecture and relationship diagrams, data/API invariants, test strategy, staged acceptance criteria, Git/backup strategy, open decisions.

**Acceptance:** docs agree on offline-first scope, one-owner/multi-device model, planned-versus-actual separation, history preservation, and platform targets; no implementation code generated; consequential decisions are identified. Review docs and establish a recoverable documentation checkpoint.

## Stage 1 — Foundation and offline proof (current)

**Deliverables (original plan, before D-012):** npm-workspace monorepo, installable client shell, local database/outbox, sync API/authentication foundation, PostgreSQL schema/migrations, i18n/theme, offline/sync/error states, Windows setup docs.

**Acceptance (original plan, re-scoped below):** clean setup; app shell opens offline after installation; local sample record survives restart; authenticated owner can sync an idempotent record between two clients; database can migrate from empty; English/Persian direction and themes work at shell level; platform feasibility documented. Private service hosting choice and security model settled before production-like data is used. Migrations and the API suite also pass against a real PostgreSQL server (DECISIONS T-007).

**Status (2026-10-20): implemented; acceptance re-scoped for v1.** Verified by tests (see `TESTING.md`): offline shell after installation (Edge), local record survives a browser restart, English/Persian direction and themes; also idempotent two-client sync and migration from empty (PGlite and the `pg` wire protocol). A single root `package.json` replaces npm workspaces because drive E: is exFAT (DECISIONS T-014).

After D-012 (no server in v1), Stage 1 acceptance for v1 is: clean setup, offline shell after installation, local record survives restart (proved with the diagnostic note, which is not product data), English/Persian direction and themes, platform feasibility documented. **Still open for v1:** installation and offline checks of the PWA (D-013) on real devices — Edge on Windows (install UI), a compatible browser on Android, Safari on iPhone — covering the items marked "(verify)" in ARCHITECTURE, "Platform installation, updates, and storage"; the hosting provider and proposed stable URL are decided (GitHub Pages, `https://moeintorabi90.github.io/personal-productivity-system/`, D-018), but the site is **not deployed yet** (workflow prepared, not merged or run); its reachability from the owner's region and real-device installation from it are **not yet verified**. The server-related items (two-client sync, PostgreSQL migrations, real PostgreSQL run, hosting and security model) are **moved to the post-v1 Sync stage**; the code stays in the repository, frozen and inactive (D-016).

## Stage 1B — Offline backup and v1 shell adjustments

**Deliverables:** record envelope with version vectors, content hashes, and tombstones in the local store (T-016); backup export (share sheet / save dialog / download); import with validation, preview, atomic merge, import log, and pending-conflict storage (T-017, T-018); conflict resolution screen as decided in D-015; optional per-export password encryption, off by default, with double entry, forgotten-password warning, and password-manager advice (D-014); preferences split into shared preferences and device settings with migration of the existing row (D-017); account/sync screens and the diagnostic "Sync check notes" (`sync_probe`) hidden by the same build-time flag (D-016, T-019); "last backup" indicator; short install instructions per platform (iPhone has no install prompt). The only product record type that exists now is preferences. `sync_probe` is sync diagnostics, not product data, and is **excluded from backups** (`BACKUP_FORMAT.md`, "What a backup contains"). The merge engine is therefore exercised with test-only fixture record types (one independent, one linked parent/child pair) defined in the test suite and never shipped; each later stage adds its real record types.

**Acceptance:** export then import into an empty device reproduces all product data; `sync_probe` records are never written to a backup, and a file containing them is refused; import into a device with data only adds and never replaces or deletes; importing the same file twice creates no duplicates and changes nothing the second time; same ID with different content becomes a visible pending conflict and both versions survive an app restart; "keep both" is offered only for independent record types, while linked records offer a choice between versions with links preserved; an older backup does not undo newer local edits; corrupted, truncated, foreign, or newer-version files, and files outside the documented input limits (size, entry counts, KDF parameters), are refused without changing data and without running key derivation; separately created items with different IDs are never merged as duplicates; the existing preferences row is migrated to shared preferences (reserved ID) plus device settings without losing values; a stored version-1 sample file is imported by the current app; language and theme are never changed by an import unless the user accepts the optional "use the source device's display settings"; the password option is visible on every export and off by default; enabling it requires matching double entry and shows the forgotten-password warning before export; an encrypted file round-trips with the right password and is refused with a wrong one; no sync service is started and no network request carries user data; export on Windows and import on Android (and the reverse) verified manually on real devices, and export/import on iPhone checked for feasibility.

**Status (2026-10-21): implemented on branch `feat/stage-1b-offline-backup`; automated acceptance passed, manual device checks open.** All automated acceptance items above pass (see `TESTING.md`, "Stage 1B test report"), including a real export/import of a file between two browser profiles in Edge. **Still open:** the manual checks on real devices (Windows → Android and the reverse, iPhone feasibility), because no Android or iPhone device is available to the implementer. Installing on a phone needs the hosted app: GitHub Pages was chosen (D-018) and the deployment workflow is prepared (branch `feat/github-pages-deploy`); after the first deployment, the site's reachability from the owner's region and installation on each device are still to be checked.

## Stage 2 — Organization and quick capture

**Deliverables:** inbox, projects, workstreams, task definitions, archive/search/filter, project detail.

**Acceptance:** CRUD works offline and persists locally; local validation rejects mismatched project/workstream links (including in imported backups); new record types are included in backup export/import with merge and conflict tests; archived records do not erase history.

## Stage 3 — Calendar and planning

**Deliverables:** day/week/month calendar, block editing, recurrence, quick add, search/filter, capacity cues, Today screen.

**Acceptance:** planned blocks persist offline and round-trip through backup with merge; recurrence/week boundaries/DST pass tests; rescheduling one occurrence has documented scope; planned items remain separate from actual sessions.

## Stage 4 — Goals and milestones

**Deliverables:** numeric/time/task-count/milestone goals, attribution UI, progress and pacing.

**Acceptance:** goal progress derives from actual records; attribution limits are enforced by the shared domain layer, including for imported data; pacing honors active days, timezone, deadline, and explicit weekly objective, with assumptions shown.

## Stage 5 — Actual execution and outputs

**Deliverables:** running and backfilled sessions, explicit corrections, output metric definitions and records, planned/actual comparison.

**Acceptance:** all state/chronology rules tested through the local repository/domain layer; unplanned session works; immutable snapshots survive edits and backup round-trips; output correction is auditable and imported corrections are appended, never merged into originals; session actions do not mutate planned blocks.

## Stage 6 — Dashboard and analytics

**Deliverables:** documented planned-vs-actual metrics, goal progress, completion, allocation, estimation error, trends.

**Acceptance:** metric dictionary defines source/window/formula; empty/small samples are honest; totals match documented examples on seeded test cases; totals are identical before and after a backup round-trip.

## Stage 7 — Weekly review and estimation learning

**Deliverables:** review workflow, immutable summary snapshot, observations/next-week adjustments, estimate suggestions.

**Acceptance:** finalized review remains unchanged after later edits and after importing backups; suggestions use actual history and never auto-change estimates; tests cover timezone and period boundaries.

## Stage 8 — Habits, daily core, accessibility, polish

**Deliverables:** user-defined habits and occurrences, completion records, minimum-viable-day support, responsive and accessible UI, localization parity.

**Acceptance:** planned occurrences and completions are separate; no personal routines hard-coded; essential workflows pass on Windows/Android and iPhone support status is documented; RTL/LTR/theme/accessibility checks pass.

## Stage 9 — Final verification and handoff

**Deliverables:** full test/security/upgrade report, cross-device backup/restore rehearsal, app installation and recovery guide for the owner, known limitations.

**Acceptance:** complete tests run; critical criteria verified; local data and backup files from every earlier v1 release upgrade correctly; export/restore verified between Windows and Android (and iPhone if supported); no secrets committed; Git tree and documentation recoverable; limitations stated plainly.

## After v1 — Sync (not scheduled)

Automatic sync through a private service, accounts, and recovery (DECISIONS open questions 1–3). Starts from the frozen Stage 1 server code (D-016), which must first be reviewed and may need changes, adapted to the v1 record envelope (T-016, T-019): run the suite against a real PostgreSQL server, choose hosting and security model, and add account recovery before any real data reaches a server.
