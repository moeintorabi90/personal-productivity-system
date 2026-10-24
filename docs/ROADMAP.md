# Delivery Roadmap

Stages are sequential. Each stage ends with its acceptance criteria, focused automated tests, type checks, production build, diff/security review, documentation update, and a recoverable Git checkpoint. Do not move on with unexplained critical failures.

**Version 1 scope (DECISIONS D-008 to D-012):** works without internet; each device keeps its own data; manual backup export/import with merge moves data between devices. No sync, data server, accounts, or email recovery in v1. From Stage 1B on, **every new record type must be included in the backup format** and covered by round-trip and merge tests before its stage is complete.

## Stage 0 — Requirements and architecture (done)

**Deliverables:** product checklist, architecture and relationship diagrams, data/API invariants, test strategy, staged acceptance criteria, Git/backup strategy, open decisions.

**Acceptance:** docs agree on offline-first scope, one-owner/multi-device model, planned-versus-actual separation, history preservation, and platform targets; no implementation code generated; consequential decisions are identified. Review docs and establish a recoverable documentation checkpoint.

## Stage 1 — Foundation and offline proof

**Deliverables (original plan, before D-012):** npm-workspace monorepo, installable client shell, local database/outbox, sync API/authentication foundation, PostgreSQL schema/migrations, i18n/theme, offline/sync/error states, Windows setup docs.

**Acceptance (original plan, re-scoped below):** clean setup; app shell opens offline after installation; local sample record survives restart; authenticated owner can sync an idempotent record between two clients; database can migrate from empty; English/Persian direction and themes work at shell level; platform feasibility documented. Private service hosting choice and security model settled before production-like data is used. Migrations and the API suite also pass against a real PostgreSQL server (DECISIONS T-007).

**Status (2026-10-20): implemented; acceptance re-scoped for v1.** Verified by tests (see `TESTING.md`): offline shell after installation (Edge), local record survives a browser restart, English/Persian direction and themes; also idempotent two-client sync and migration from empty (PGlite and the `pg` wire protocol). A single root `package.json` replaces npm workspaces because drive E: is exFAT (DECISIONS T-014).

After D-012 (no server in v1), Stage 1 acceptance for v1 is: clean setup, offline shell after installation, local record survives restart (proved with the diagnostic note, which is not product data), English/Persian direction and themes, platform feasibility documented. **Owner report (2026-10-23):** on a Windows laptop and an Android phone (device, OS, and browser versions unspecified) the installed app opens and stays usable offline after being loaded, and data persists after closing and reopening (`TESTING.md`, "Owner device checks (2026-10-23)"). The app was installed from the GitHub Pages URL (`https://moeintorabi90.github.io/personal-productivity-system/`, D-018); at the latest check (2026-10-23) that live site returned HTTP 404. **Still open for v1:** Safari on iPhone (install and offline use), and the "(verify)" items in ARCHITECTURE, "Platform installation, updates, and storage", that the report does not cover (e.g. persistent-storage grant, eviction, install UI details). The server-related items (two-client sync, PostgreSQL migrations, real PostgreSQL run, hosting and security model) are **moved to the post-v1 Sync stage**; the code stays in the repository, frozen and inactive (D-016).

## Stage 1B — Offline backup and v1 shell adjustments

**Deliverables:** record envelope with version vectors, content hashes, and tombstones in the local store (T-016); backup export (share sheet / save dialog / download); import with validation, preview, atomic merge, import log, and pending-conflict storage (T-017, T-018); conflict resolution screen as decided in D-015; optional per-export password encryption, off by default, with double entry, forgotten-password warning, and password-manager advice (D-014); preferences split into shared preferences and device settings with migration of the existing row (D-017); account/sync screens and the diagnostic "Sync check notes" (`sync_probe`) hidden by the same build-time flag (D-016, T-019); "last backup" indicator; short install instructions per platform (iPhone has no install prompt). The only product record type that exists now is preferences. `sync_probe` is sync diagnostics, not product data, and is **excluded from backups** (`BACKUP_FORMAT.md`, "What a backup contains"). The merge engine is therefore exercised with test-only fixture record types (one independent, one linked parent/child pair) defined in the test suite and never shipped; each later stage adds its real record types.

**Acceptance:** export then import into an empty device reproduces all product data; `sync_probe` records are never written to a backup, and a file containing them is refused; import into a device with data only adds and never replaces or deletes; importing the same file twice creates no duplicates and changes nothing the second time; same ID with different content becomes a visible pending conflict and both versions survive an app restart; "keep both" is offered only for independent record types, while linked records offer a choice between versions with links preserved; an older backup does not undo newer local edits; corrupted, truncated, foreign, or newer-version files, and files outside the documented input limits (size, entry counts, KDF parameters), are refused without changing data and without running key derivation; separately created items with different IDs are never merged as duplicates; the existing preferences row is migrated to shared preferences (reserved ID) plus device settings without losing values; a stored version-1 sample file is imported by the current app; language and theme are never changed by an import unless the user accepts the optional "use the source device's display settings"; the password option is visible on every export and off by default; enabling it requires matching double entry and shows the forgotten-password warning before export; an encrypted file round-trips with the right password and is refused with a wrong one; no sync service is started and no network request carries user data; export on Windows and import on Android (and the reverse) verified manually on real devices, and export/import on iPhone checked for feasibility.

**Status (updated 2026-10-23): implemented (merged into `main`); automated acceptance passed; Windows ↔ Android backup transfer owner-reported as passed; other manual device checks open.** All automated acceptance items above pass (see `TESTING.md`, "Stage 1B test report"), including a real export/import of a file between two browser profiles in Edge. **Owner report (2026-10-23):** backup export on Windows and import on Android, and the reverse, worked on the owner's Windows laptop and Android phone (versions unspecified), and importing created no duplicates (`TESTING.md`, "Owner device checks (2026-10-23)"). This covers the Windows ↔ Android item of the acceptance above; it does not make the whole Stage 1B acceptance verified on devices. **Still open:** iPhone export/import feasibility, and on-device checks the report does not mention (e.g. encrypted files, share sheet, refused files, conflicts).

## Stage 2 — Organization and quick capture

**Deliverables:** inbox, projects, workstreams, task definitions, archive/search/filter, project detail.

**Acceptance:** CRUD works offline and persists locally; local validation rejects mismatched project/workstream links (including in imported backups); new record types are included in backup export/import with merge and conflict tests; archived records do not erase history.

**Status (2026-10-23): merged into `main`; automated acceptance passed; owner-reported Windows/Android checks passed; iPhone and the two-device project conflict open; live site returned HTTP 404 at the latest check.** Inbox (quick capture of task definitions without a project), projects, optional workstreams, and task definitions with create, edit, archive/restore, search, and active/archived filters; project detail with workstreams, tasks grouped by workstream, and tasks directly in the project. Design choices: DECISIONS T-020 to T-024 (`dataSchemaVersion` 2, inbox = tasks without a project, workstreams never change project, archive instead of delete, deferred task fields). Task fields in Stage 2: title, notes (the task's descriptive text), project, optional workstream, next action, estimate, archive state; **not implemented and deferred** (owner-approved, 2026-10-21, T-024): recurrence and active weekdays (Stage 3), relevant output metrics (Stage 5), and a task type (until the owner defines a use case and categories). The automated items pass (see `TESTING.md`, "Stage 2 test report"), including creating and organizing items offline in Edge and moving them to a fresh browser profile by a real backup file. Merged into `main` (`c0a37d5`, with docs up to `644843b`); the GitHub Pages workflow run for `644843b` completed successfully on 2026-10-21, but at the latest check (2026-10-23) the app URL, its manifest, and the GitHub Pages API returned HTTP 404, so the live site is unavailable. **Owner report (2026-10-23)** on a Windows laptop and an Android phone (device, OS, and browser versions unspecified): project/task workflows work offline and persist after closing and reopening the app; backup export/import works Windows → Android and Android → Windows without duplicate records; Persian text entry/search and the phone layout work (`TESTING.md`, "Owner device checks (2026-10-23)"). **Still open:** iPhone, and a conflict from the same project edited independently on both devices and then merged by backup (covered only by automated tests so far).

## Stage 3 — Calendar and planning

**Deliverables:** day/week/month calendar, block editing, recurrence, quick add, search/filter, capacity cues, Today screen. Includes the task-definition fields deferred from Stage 2: recurrence and active weekdays (DECISIONS T-024; new `dataSchemaVersion` with an upgrade step). Contract: PRODUCT_SPEC "Stage 3 planning contract", DATA_MODEL "Stage 3 record types and fields", BACKUP_FORMAT "Data schema version 3", TESTING "Stage 3 acceptance tests".

**Owner decisions (2026-10-24):** D-019 (recurring tasks appear as unscheduled items on their active weekdays; never given a time automatically; other planned work never moved), D-020 (Gregorian display by default, Jalali selectable; Saturday week start by default, configurable; calculations in the explicitly configured time zone; language never changes calendar or calculations), D-021 (configurable daily capacity; warnings only; nothing rescheduled, changed, or deleted automatically), D-022 (blocks are fixed instants shown in the configured zone; a zone change edits no block and keeps each block scheduling its original occurrence), D-023 (an occurrence stays scheduled while at least one of its blocks is planned). The owner also approved the contract details T-029 to T-036 (DECISIONS): weekly-by-weekday recurrence with start and optional end date; block time zone, local date, and daylight-saving input rules; one shared daily capacity, unset by default; quick add; the scheduling form; no skip/dismiss; month boundaries by display calendar; block snapshots.

**Acceptance:**

- Planned blocks can be created (from a task, an unscheduled item, or quick add), edited, moved, resized, cancelled, and restored offline, and persist after closing and reopening the app.
- A recurring task shows exactly one unscheduled item on each selected weekday within its start/end dates, none on other days, none for archived tasks; scheduling creates an explicit block with the user-entered start time; the item then shows as scheduled. An occurrence stays scheduled while at least one of its blocks is planned: cancelling one of several blocks leaves it scheduled, cancelling the last planned block makes it unscheduled again, and restoring a block makes it scheduled again. The app never assigns a time, creates a block, or moves another block by itself, and never carries a past unscheduled item forward.
- Day, week, and month views, navigation, search, and filters work; the week starts on the configured week start (Saturday by default); Gregorian is the default display and Jalali is selectable; switching the language changes no date, week, recurrence, or capacity result.
- Changing the configured time zone edits no block: blocks keep their instants and occurrence link and are displayed in the new zone, possibly at another time or date; a block for a recurring occurrence still schedules that occurrence and no duplicate unscheduled item appears; Settings explains that displayed block times or dates may change.
- All calculations use the configured time zone; without one, planning asks the user to set it and writes nothing; recurrence, week boundaries, and blocks across daylight-saving changes and midnight pass the tests in TESTING.
- With a daily capacity set, over-capacity days show a warning (and the softer notice when unscheduled estimates do not fit); no block is changed, moved, cancelled, or deleted because of capacity; without capacity, no warning appears.
- Today shows today's blocks, unscheduled items, and capacity summary.
- Backups: `dataSchemaVersion` 3; blocks, recurrence, and capacity round-trip and merge (new / already here / older / newer-with-confirmation / conflict / deletion), block conflicts offer keep/use only; the committed version-1 and version-2 samples still import unchanged; version-1/2 files with version-3 fields or types are refused; existing task and preference records keep their content hashes after the update (no false conflicts with not-yet-updated backups).
- Planned items remain separate from actual execution: blocks have no completion or actual-time data.
- Manual (owner's devices): the Stage 3 flow offline on the Windows laptop and Android phone, and backup transfer of blocks in both directions.

**Status (2026-10-24): contract specified and approved by the owner (D-019 to D-023, T-029 to T-036); implementation not started.** The contract is to be independently reviewed before implementation begins on its own feature branch.

## Stage 4 — Goals and milestones

**Deliverables:** numeric/time/task-count/milestone goals, attribution UI, progress and pacing.

**Acceptance:** goal progress derives from actual records; attribution limits are enforced by the shared domain layer, including for imported data; pacing honors active days, timezone, deadline, and explicit weekly objective, with assumptions shown.

## Stage 5 — Actual execution and outputs

**Deliverables:** running and backfilled sessions, explicit corrections, output metric definitions and records, planned/actual comparison. Includes the task-definition field deferred from Stage 2: relevant output metrics (DECISIONS T-024; new `dataSchemaVersion` with an upgrade step).

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
