# Testing Strategy

Testing requirements are part of delivery. A reported result must name the exact command and observed outcome; skipped work includes the concrete reason.

## Test layers

- **Pure unit tests:** date/time conversion, recurrence, week boundaries, goal progress/pacing, metric aggregation, estimation suggestions, state transitions, and validation.
- **Client component tests:** React Testing Library for forms, accessible controls, RTL/LTR behavior, offline/sync indicators, and conflict resolution UI.
- **Local repository/domain tests (v1):** IndexedDB repository through fake-indexeddb: relationship rules, history immutability, version vectors, tombstones, local schema upgrades.
- **Backup tests (v1):** export/import round-trip, merge classification, idempotent re-import, conflicts, upgrades, corrupted/foreign/newer files, optional password encryption (D-014) (see below).
- **API integration and server database tests (frozen Stage 1 code, after v1):** real Express handlers with PostgreSQL; kept running in `npm test` so the frozen code does not rot, but not a v1 release gate.
- **End-to-end tests:** Playwright workflows for first run, project/task creation, planning, offline logging, export and import with conflict handling, review finalization.
- **Manual platform checks (D-013):** install and offline use of the PWA from Edge on Windows 11, a compatible browser on Android, and Safari on iPhone (Add to Home Screen); update after a new build; file export/import; the items marked "(verify)" in ARCHITECTURE, "Platform installation, updates, and storage". Record device/OS/browser versions and limitations.
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
9b. **KDF bounds before work:** `iterations` of 599,999 or 1,000,001 (600,000 and 1,000,000 accepted), a non-integer, a salt that is not 16 bytes, an IV that is not 12 bytes, a `wrappedKey` that is not 48 bytes, zero or more than one key slot, a `recoveryKey` slot (reserved, not v1), a `hint` field, or an unknown cipher/hash → refused **before** the password prompt; a test spy on the PBKDF2 call confirms it was never invoked.
9c. **Pre-parse scan before `JSON.parse`:** a spy on `JSON.parse` confirms it is **never called** for: nesting of 33 levels (32 accepted); a pathological file of millions of `[` (up to the size limit), which is rejected without a stack overflow; mismatched brackets (`[}`); an unterminated string; a raw control character or invalid escape in a string; brackets inside strings, which must not count toward depth (accepted); trailing content after the top-level value; more than 4,000,000 values (exactly 4,000,000 accepted); invalid UTF-8 bytes. The same cases inside the decrypted plaintext of an encrypted file are rejected before its `JSON.parse`. A syntactically invalid file that passes the scan (e.g. a bad number literal) is refused by `JSON.parse` with the database unchanged.
10. **Scope:** an export never contains `sync_probe` or sync-machinery data, even when the device has diagnostic notes; a file that contains them is refused.
11. **Versioning:** a committed sample file for every released `formatVersion` imports into the current app; a file with a newer version is refused without changes.
12. **Integrity hash:** computed over the JCS-canonical document without `integrity`; matches an independent reference implementation on the committed sample files; a damaged encrypted file is reported as damaged before any password prompt.
13. **Optional encryption (D-014):** the password option is shown on every export and is off by default (an export with default settings is unencrypted, `encryption: null`); turning it on requires two matching entries (mismatch blocks export); the forgotten-password warning and the password-manager advice are shown before an encrypted export; the export is reported as successful only after the written file re-opens with the entered password; each export's choice is independent of earlier ones; correct password round-trips; wrong password fails without changes; modified ciphertext, IV, salt, iteration count (within bounds), or any header field fails authentication; a password containing a canonically equivalent sequence in another form (e.g. `آ` precomposed vs decomposed) still works; a password typed with Arabic Yeh `ي` instead of Persian Yeh `ی` is treated as a **different** password (documents the limited NFC guarantee).
14. **Preview accuracy:** preview counts equal what is applied.
15. **Identity is the UUID:** two records with different UUIDs and identical content (created separately on two devices) are both kept after import; `contentHash` equality only skips versions with the same ID.
16. **Preferences (D-017):** the shared preferences record has the reserved ID on every device; importing into a device with untouched defaults shows "newer in backup" (not a conflict); edits on both devices give a conflict with no "keep both" option; language and theme are never merged or turned into conflicts, and are changed only if the user accepts "use the display settings of …"; the Stage 1B migration of the existing `"self"` row keeps all values.

17. **Conflict flow (D-015):** bulk actions show and require confirmation of the number of affected items; history records with the same ID and different content produce an integrity warning and change nothing; a deletion conflict offers only the deletion choices (restore / keep deleted, delete here / keep).
18. **v1 stays offline (D-016):** with the build flag off (v1 default), the account/sync screens and "Sync check notes" are not shown, the sync engine does not start, and using the app, exporting, and importing make no network request carrying user data.

Until later stages add real product types, items 1–9, 14, 15, and 17 use test-only fixture record types (one independent, one linked parent/child pair) plus preferences. Since Stage 2 they are also run with the real linked types `projects`, `workstreams`, and `taskDefinitions` (`apps/web/src/backup/organization-backup.test.ts`); the independent fixture type remains the only test of "keep both", because every product type so far is linked.

Manual on real devices (record versions): export on Windows → import on Android, and the reverse; file picker/share sheet behavior; iPhone (Safari Home Screen app) export/import with `.json`; install and offline relaunch of the PWA on each platform (D-013).

## Stage 3 acceptance tests (implemented and merged into `main`; results in "Stage 3 test report")

Contract: PRODUCT_SPEC "Stage 3 planning contract"; decisions D-019 to D-023, T-025 to T-036. Tests are marked with the decision IDs they check (all approved by the owner, 2026-10-24). Fixed dates and zones are used so results do not depend on the test machine's clock or zone.

**Date/time and settings (pure unit tests; D-020, D-022, T-028, T-030, T-035)**

1. "Today" and the local date of an instant come from the configured zone, not the machine's (e.g. an instant that is still the previous day in `America/New_York` but the next day in `Asia/Tehran`).
2. Week ranges start on the configured week start for every value 0–6; the default (Saturday) gives Saturday–Friday.
3. Changing the language (English ↔ Persian) changes no computed date, week range, recurrence result, or capacity result; it changes only labels and direction.
4. Display calendar Gregorian / Jalali / Both changes only formatting; stored dates stay ISO Gregorian. Month ranges follow the display calendar (T-035), including Jalali month boundaries and the Jalali leap year.
5. Daylight saving, in a zone that has it (e.g. `Europe/London`) and one that does not (`Asia/Tehran`): a wall time in the spring gap is refused, not shifted; an ambiguous wall time resolves to the earlier instant and its offset is shown (T-030); a 23-hour and a 25-hour day are handled in day views and capacity.
6. Without a configured time zone, the planning screens ask for one and nothing is written; the device zone is only suggested.

**Recurring tasks and unscheduled items (D-019, D-023, T-026, T-029, T-034)**

7. A task recurring on chosen weekdays shows exactly one unscheduled item on each matching date within start/end dates (inclusive), none outside them, none on other weekdays; archived tasks show none; non-recurring tasks show none. Enabling recurrence pre-fills the start date with the current local date in the configured zone; the end date is optional; only weekday patterns can be entered (T-029).
8. Scheduling an item with one block: the block gets the user-entered start time (the form never pre-fills a time); the date and, with an estimate, the duration are pre-filled (T-033); the item then shows as scheduled; cancelling that block, the occurrence's only planned block, makes the item unscheduled again; restoring the block makes it scheduled again. A block whose date the user changed to another date still schedules its occurrence (T-033).
9. Several blocks for one occurrence (D-023): with two blocks A and B for the same task and occurrence date, the occurrence is scheduled; cancelling A leaves it scheduled (no unscheduled item, not listed by "only unscheduled", its estimate not counted in the capacity notice); then cancelling B, the last planned block, makes it unscheduled; restoring either A or B makes it scheduled again; restoring the other changes nothing further. Blocks of another task, or of the same task with another occurrence date, never schedule it.
10. No automatic action: creating, editing, or deleting tasks, changing recurrence, changing the time zone, opening any view, passing midnight, or importing a backup never creates, moves, resizes, or cancels a block (database snapshot unchanged except for the explicit action). A past unscheduled item is never shown on a later date.
11. Editing a task's recurrence, title, project, or archive state leaves every existing block unchanged (data, hash, version).

**Blocks and views (D-022, T-027, T-030, T-032, T-036)**

12. Block validation for typed-in data: end after start, at most 24 hours, minute precision, `localDate` matches `startsAt` in `timeZone` (T-030), live task link; violations are refused with no change.
13. Edit, move, resize, cancel, restore, and quick add (inbox task + block in one transaction, or a block for a selected existing task; T-032) work offline and persist after a restart; there is no delete.
14. A block crossing midnight appears on both dates, clipped; overlapping blocks are both shown and neither is moved.
15. Day, week, and month views show the right blocks, unscheduled items, and indicators for the range; navigation and "go to date" work; search by task title and filters (project incl. inbox, workstream, cancelled, only unscheduled) return the expected items; labels use the current task title, and the snapshot when the task is absent (T-036). Renaming a task, project, or workstream leaves every block's snapshot unchanged; editing the block itself refreshes it (T-036).
16. Changing the configured zone writes no block: every block's `startsAt`, `endsAt`, `occurrenceDate`, other fields, content hash, and version vector are unchanged; blocks display at their fixed instants in the new zone (D-022). Settings shows, next to the time-zone setting, the explanation that changing it may change the displayed time or date of existing blocks (English and Persian).
17. Time-zone change across a date boundary (D-022): a task recurs on Monday and Tuesday; with zone `Asia/Tehran`, its Monday 2026-11-02 occurrence is scheduled 23:00–23:45 (19:30–20:15 UTC). After changing the zone to `Asia/Tokyo`, the block is displayed on Tuesday 2026-11-03, 04:30–05:15, and counts toward that date's planned minutes; its stored `occurrenceDate` is still 2026-11-02; Monday 2026-11-02 shows **no** unscheduled item for the task (no duplicate); Tuesday 2026-11-03 still shows that task's own Tuesday item as unscheduled (the moved display does not schedule it). The reverse direction is checked too: a block at 00:30 on 2026-11-02 in `Asia/Tehran` displays on Sunday 2026-11-01 in `America/New_York` and still schedules the 2026-11-02 occurrence. Changing back to `Asia/Tehran` restores the original display with no stored change.
18. Today shows today's blocks, unscheduled items, and capacity summary.

**Capacity (D-021, T-031)**

19. Planned minutes per date = sum of planned (not cancelled) block durations within that date, overlaps counted, cross-midnight blocks split; warning exactly when planned minutes exceed capacity; notice when planned minutes do not exceed but planned plus unscheduled estimates do (items without estimates not counted and identified as having no estimate); no warning or notice without a set capacity; capacity accepts only whole minutes 1–1,440, one value for every day (T-031).
20. Saving a block that exceeds capacity is allowed after the warning; no block is ever changed, moved, cancelled, or deleted because of capacity (database unchanged apart from the explicit save).

**Backup and merge (T-025, D-022, D-023; BACKUP_FORMAT "Data schema version 3")**

21. Round-trip of blocks, recurrence, and capacity into an empty device (identical IDs, hashes, versions); merge, idempotent re-import, older copy, newer-with-confirmation, and deletion cases with blocks; a block moved on both devices is a conflict with keep/use only (no "keep both"); a task with live blocks cannot be deleted by a conflict choice. After a merge, an occurrence with two blocks where the chosen version cancels only one stays scheduled (D-023); importing preferences with a different time zone changes no stored block field and no `occurrenceDate` (D-022).
22. Upgrade without loss: a Stage 2 database opened by the Stage 3 app keeps every task and preference record byte-identical (data, content hash, version vector); exporting it and importing into a device that still holds a Stage 2 backup gives "already here", not conflicts.
23. Versioning: the committed version-1 and version-2 samples import unchanged; a new fabricated version-3 sample imports; a version-2 file containing `recurrence`, `dailyCapacityMinutes`, or `calendarBlocks` is refused with no change; version 4 is refused as newer; `null` for the optional new fields is refused.
24. Validation of every block version in a file (records, carried conflicts, archive): bad times, wrong `localDate`, unknown zone, inconsistent snapshot, or an unknown task → refused with no change.

**End-to-end (Playwright, Edge) and manual**

25. Offline in Edge: set zone and capacity, make a task recurring, schedule an item, quick-add a block, see the capacity warning, reload offline, export, import into a fresh profile, and see the same plan.
26. Persian RTL with Jalali display: calendar navigation and forms usable; dates and weekdays correct.
27. Manual on the owner's Windows laptop and Android phone: the Stage 3 flow offline, and moving a plan in both directions by backup.

## Stage 4 acceptance tests (goals and milestones)

Contract: PRODUCT_SPEC "Goals and measures" and "Stage 4 goal and milestone rules"; decisions T-037 to T-065, T-077 to T-080 (owner), T-081 to T-087 (derived). Fixed dates are used.

**Goals and milestones (local commands; T-038 to T-045, T-050 to T-065, T-077 to T-086)**

1. A goal needs a name; description, project, and deadline are optional; the start date defaults to today (configured zone, else device date) and may be past or future; a deadline before the start date is refused.
2. Each kind stores its target: numeric output with whole numbers and a required unit label; time as whole minutes from hours and minutes; task count as a whole number. Decimal, zero, negative, and out-of-range targets are refused; the kind cannot change, while target and unit can.
3. Status changes: pause, resume, complete from active and from paused, reopen to active; disallowed changes are refused; pausing or resuming never changes the dates.
4. Archive keeps the status and restore returns to it (active, paused, completed); while archived the goal and its milestones cannot be edited.
5. A milestone needs a name and belongs to one goal; description and deadline are optional; a deadline before the goal's start or after its deadline is refused; milestones complete and reopen independently; reopening a goal keeps every milestone's completion; a milestone can be deleted (tombstone kept).
6. A goal date change that would put a milestone deadline outside the range is refused and names that milestone; nothing is written.
7. No progress value is computed or stored; the UI shows the target and the "progress arrives with Stage 5" note.

**Backup (T-081, T-084)**

8. Round-trip: an empty device receives goals and milestones with identical IDs, hashes, and versions (`dataSchemaVersion` 4); re-import is idempotent; a goal edited on two devices is a conflict with keep/use only; a deleted milestone is not restored by an older backup.
9. Upgrade: Stage 3 records are unchanged under the Stage 4 app and a re-import of a version-3 backup is "already here"; the committed version-1 to version-3 samples import; a fabricated version-4 sample imports.
10. Versioning and validation: a version-3 file containing goals or milestones is refused as unknown data; version 5 is refused as newer; invalid goals or milestones (bad dates, unit rules, kind, status, target) are refused in records, carried conflicts, and the archive; unknown `projectId` or `goalId` is refused; a milestone whose `goalId` differs between versions is refused; a merged milestone outside its goal's dates is imported and flagged.

**UI (component and end-to-end)**

11. Goals screen in English and Persian (RTL, Jalali dates): create each kind, edit, pause/resume/complete/reopen, archive/restore, milestones with complete/reopen/delete-with-confirmation, and the date-clash message; every control is reachable by keyboard and labelled.
12. Manual on the owner's Windows laptop and Android phone: the Stage 4 flow offline, and moving goals in both directions by backup.

## Calendar interaction, project color, and streak acceptance tests (specified 2026-10-25; Stage 3 follow-up items implemented on branch `feat/calendar-follow-up`, results in "Stage 3 follow-up test report"; Stage 6 and Stage 8 items not implemented)

Contract: PRODUCT_SPEC "Stage 3 follow-up", "Planned versus actual calendar (Stage 6)", "Streaks"; decisions T-066 to T-076 and T-088 to T-090. Open details 1–4 are resolved (T-076, T-088 to T-090); tests depending on open details 5–7 follow the owner's answer. The project color arrives in data version 5, after Stage 4's version 4 (T-076). Fixed dates and zones as in Stage 3.

**Stage 3 follow-up: time grid and drag (T-066, T-067)**

1. Tapping/clicking an empty slot and dragging across an empty range open block creation with that start (and end) pre-filled; no block is written until a task or quick-add title is chosen and saved; cancelling writes nothing.
2. Drag-move and edge-resize of a planned block change only that block (same rules as a form edit: new instants, planning zone, refreshed snapshot; task and `occurrenceDate` unchanged); other blocks are never moved; cancelled blocks cannot be dragged.
3. A drop or selection in a daylight-saving gap is refused, not shifted; a resize beyond 24 hours or to zero length is refused; a resulting over-capacity date shows the warning and the change is still allowed (D-021). On a fall-back date (e.g. `America/New_York`, 2026-11-01): a block in the second occurrence of the repeated hour is unchanged by a drag that stays in its snapped slot, and a resize keeps the instant of the edge not dragged; a move or resize to an ambiguous wall time takes the earlier instant and its offset is shown (T-030).
4. Pointer input works with mouse and touch (touch scrolling still scrolls); every action remains possible with the forms and the keyboard; English/Persian, LTR/RTL.
4a. Time-grid details (T-089): a tap at 09:07 pre-fills 09:00–09:30; drag selection, move, and resize land on 15-minute boundaries in the configured zone (including on a daylight-saving date); at 560 px or narrower the week grid shows two days and Previous/Next (and swipe) reach every day of the week.
4b. Undo (T-090): after a drag-move or resize, Undo appears without any confirmation dialog, restores the previous start, end, zone, and local date as a new version (snapshot refreshed as for any block edit), and disappears after 5 seconds (unless it has keyboard focus) or when the block changes again — judged by its version, so an edit that keeps the times (e.g. cancel and restore) also removes it; form edits show no Undo.

**Stage 3 follow-up: project colors (T-068 to T-070)**

5. The palette has exactly the 8 identifiers `blue`, `teal`, `green`, `amber`, `orange`, `red`, `pink`, `purple` with names in English and Persian; a project without a chosen color shows the same derived default (FNV-1a mod 8) on every device; a chosen palette color is shown; items without a project are neutral; a block whose task moved to another project shows the new project's color; a block whose task is not on the device uses its snapshot's project.
6. Changing a project's color writes only the project record (blocks, snapshots, and other records unchanged by hash and version) and re-renders related items.
7. Planned items always carry a visible non-color status cue (label or marker); for each of the 8 palette colors and the neutral color, in the light and dark themes, measured against the app's actual theme tokens and component colors (DECISIONS "Contrast requirements"): normal text on the block tint is at least 4.5:1; accent borders, bars, icons, and markers are at least 3:1 against the tint, `--surface`, and `--surface-muted` they touch; any accent-colored text is at least 4.5:1 against its actual background.
8. Backup: color round-trips and merges as a project field (a color edited on two devices is a project conflict with keep/use only); existing projects without `color` keep their content hashes after the update and a re-import of an older backup is "already here"; the committed version-1 to version-4 samples import unchanged; a fabricated version-5 sample imports; a version-4 or older file containing `color`, a `null` color, or an unknown palette identifier is refused with no change (also in carried conflicts and the archive); the Stage 4 app (data version 4) refuses version 5 as newer.

**Stage 6: planned versus actual lanes and goal streaks (T-071 to T-073)**

9. Day and week time grids show planned and actual items in separate lanes on one time axis; the month view stays an overview; actual items use the stronger color treatment with a visible cue.
10. Dragging an actual session creates an explicit correction only after the user confirms; the original record and the correction/audit history are preserved and survive a backup round-trip; nothing is changed by a cancelled drag.
11. Goal streak on seeded cases: consecutive scheduled opportunities with attributed work count regardless of duration; unscheduled days neither add nor break; a missed opportunity resets the current streak only after its local day ends; the longest streak is kept; a planned block without recorded work never counts; one streak per goal, not per milestone; the result is identical after a backup round-trip. (Opportunity definition and paused/completed/archived handling: open detail 6.)

**Stage 8: app-use streak (T-074, T-075)**

12. Consecutive days of recorded app use (fixed dates) give the expected current and longest streaks; a day without use breaks the current streak and keeps the longest; the value is labelled as this device's, is not exported as mergeable data, and is unchanged by an import; no points, penalties, or pressure appear. (What counts as use and the day boundary: open detail 7.)

## Release gate

A stage is not complete while a critical acceptance item has an unexplained failure. Do not claim an endpoint works based only on a pure helper test. Keep a small test report in the stage notes with passed, failed, skipped, and not-yet-tested items.

## Stage 3 follow-up test report (2026-10-25, branch `feat/calendar-follow-up`)

Commands run on the Windows development machine (Edge for end-to-end tests): `npm.cmd run typecheck` passed; `npm.cmd test` 29 files, 306 tests passed (260 before; new: `planning/colors.test.ts` 8, `planning/grid.test.ts` 15, `local/calendar-follow-up.test.ts` 7, `backup/colors-backup.test.ts` 9, follow-up component tests in `App.test.tsx` 7); `npm.cmd run test:e2e` 11 passed (2 new). Coverage per item:

- Items 1, 4a (tap and range pre-fill, 15-minute snapping, daylight-saving gap refused): `planning/grid.test.ts`; `App.test.tsx` (tap at 09:07 → 09:00 for 30 minutes, drag selection, nothing written until Save) with jsdom pointer events; end-to-end with a real mouse and a touch tap.
- Items 2, 3 (drag-move and edge-resize change only that block; cancelled blocks not dragged; DST gap, zero and over-24-hour durations refused): `planning/grid.test.ts`, `local/calendar-follow-up.test.ts`, `App.test.tsx`, and the end-to-end mouse drag and resize.
- Item 4 (keyboard and forms; English/Persian, LTR/RTL): `App.test.tsx` (Add per day, a block opens its row with Enter; the list layout still drives the Stage 3 tests); a visual check of the Persian RTL week grid in the dark theme at 375 px.
- Item 4a, phone: `App.test.tsx` and end-to-end at 375 px with touch emulation (two days, Previous/Next reach all seven, no horizontal scroll).
- Item 4b (Undo without a dialog, restores as a new version, disappears after 5 seconds or when the block changes, stays while focused): `local/calendar-follow-up.test.ts` (version guard, refreshed snapshot), `App.test.tsx`, and end-to-end (hidden after 5 s; kept for 6 s while focused; Undo restores).
- Items 5–7 (palette, derived default, item colors, color change writes only the project, non-color cue, contrast): `planning/colors.test.ts` (reads `styles.css`), `local/calendar-follow-up.test.ts`, `App.test.tsx`.
- Item 8 (backup, data version 5): `backup/colors-backup.test.ts`; end-to-end color on a fresh device. New sample `apps/web/src/backup/samples/pps-backup-format-v1-data-v5.json` (fabricated, written by `PPS_WRITE_SAMPLE=1`).

**Review fixes (same branch):** (1) daylight saving: drags resolve only the dragged position and keep the other edge's instant; a drag within the current snapped slot writes nothing; regression tests on New York's fall-back date (2026-11-01) and the spring gap (`planning/grid.test.ts`, `App.test.tsx`, where a second-occurrence block shows "01:30 (UTC−05:00)"). (2) Undo visibility follows the block's version: `undoApplies` (`local/calendar-follow-up.test.ts`) and a component test where cancel-and-restore after a drag closes the Undo bar; the command's version guard stays.

Changed existing tests: exports are data version 5 and "newer" is version 6 (`organization-backup`, `planning-backup`, `goals-backup`, `validation`); three Stage 3 component tests and one Stage 3 end-to-end test choose Layout "List" before checking the list views, since day and week now open as the time grid. **Not yet tested:** manual checks on the owner's Windows laptop (mouse drags) and Android phone (long-press drag, swipe, both themes); touch drag-and-drop is not covered by an automated test (only the touch tap).

## Stage 4 test report (2026-10-25; merged into `main` at `771c534` and deployed as 0.5.0)

Commands run on the Windows development machine (Edge for end-to-end tests):

- `npm.cmd run typecheck` — passed (no errors).
- `npm.cmd test` — 25 files, 260 tests passed (229 before Stage 4; new: `local/goals.test.ts` 14, `backup/goals-backup.test.ts` 13, Stage 4 component tests in `App.test.tsx` 4).
- `npm.cmd run test:e2e` — 9 passed, including "Stage 4 offline: a goal with milestones, status changes, reload, and the same goal on a fresh device by backup".

Coverage of "Stage 4 acceptance tests": items 1–7 in `local/goals.test.ts`; items 8–10 in `backup/goals-backup.test.ts` (round-trip, idempotent re-import, keep/use conflicts for goals and milestones, deleted milestone not restored by an older backup, deletion in a backup as a decision, "delete here" refused for a goal with milestones, merged out-of-range milestone imported and flagged, Stage 3 records unchanged and "already here", samples 1–4, version-3 files with Stage 4 types refused, version 5 refused as newer, invalid shapes and links refused in records, carried conflicts, and the archive, immutable `goalId` and `kind`); item 11 in `App.test.tsx` (English and Persian RTL with Jalali entry) and the end-to-end test; a visual check of the Goals detail at desktop and 375 px width (no horizontal scroll, no console errors). **Not yet tested:** item 12, manual checks on the owner's Windows laptop and Android phone (awaiting the owner's report).

Before publishing, one full `npm.cmd test` run failed once in "is translated in Persian (RTL) with Jalali date entry": the test read Persian and Jalali elements synchronously while components were still loading the device language and display calendar. Reproduced with a temporary random delay on preference loading; `771c534` awaits those elements (test-only). After the fix: the focused test passed 5 of 5 runs, `npm.cmd run typecheck` passed, and one full `npm.cmd test` run passed 260 of 260. Deployment: GitHub Pages workflow run `40190499274` succeeded for `771c534`; the live app served version 0.5.0 (HTTP 200 for the app, manifest, service worker, and bundle).

Changed existing tests (version only): `organization-backup.test.ts`, `planning-backup.test.ts`, and `validation.test.ts` now expect exports with data version 4 and treat version 5 as newer; the navigation tests in `App.test.tsx` include "Goals". New sample: `apps/web/src/backup/samples/pps-backup-format-v1-data-v4.json` (fabricated, written by `PPS_WRITE_SAMPLE=1`).

## Stage 3 test report (2026-10-24)

Branch `feat/stage-3-calendar-planning` (from `main` at `52d30c7`). Windows 11, Node.js 24.20.0 (ICU 78.3, time-zone data 2026c), Vitest 5.0.5, Playwright 1.64, Microsoft Edge (headless). Fixed dates and zones in all tests; component tests fake only `Date` (2026-11-02 09:30 Tehran).

| Command | Result |
|---|---|
| `npm.cmd run typecheck` | Passed (shared, API, web; exit 0) |
| `npm.cmd test` | **228 passed, 0 failed** in 23 files (includes the frozen Stage 1 server/sync tests) |
| `npm.cmd run test:e2e` (production build + Edge) | **8 passed, 0 failed**; build precaches 11 files; Vite prints its advisory that the main chunk exceeds 500 kB (601.8 kB, 177.9 kB gzip) |
| Production bundle check | No test fixtures or `fake-indexeddb` in `apps/web/dist/assets` |
| Repeat runs of the Stage 3 component tests | 10 consecutive runs passed after two test-timing fixes (below) |
| Manual check in the browser pane (dev server) | Set the zone with the device suggestion, set capacity, quick-added a block in the week view (capacity warning in the form, then saved); week and month views at 375 px width without horizontal scrolling; no console errors |

Coverage by acceptance item ("Stage 3 acceptance tests" above):

- `apps/web/src/planning/time.test.ts` (10): items 1–5 — local date and time of one instant in New York vs Tehran; strict local dates; week ranges for every week start (Saturday default); language/display calendar only change formatting; Jalali conversion, Jalali month boundaries, 30 Esfand 1403 (leap) and not 1404, month shifting; London spring gap refused and autumn overlap → earlier instant with `UTC+01:00`; 23/25-hour London days, 24-hour Tehran days; a Havana day that starts at 01:00.
- `apps/web/src/local/planning.test.ts` (20): items 6–20 on the device store — no zone → blocks, quick add, and recurrence refused with nothing written; one unscheduled item per selected weekday within inclusive start/end, none for archived or non-recurring tasks; weekday storage and refused shapes (monthly, empty, 7, end before start, invalid date, unknown field); turning recurrence off removes the field (hash back to the original) and changes no block; scheduling with one block (instants from the entered time, cancel/restore, a block on another date still schedules its occurrence); several blocks (D-023: cancel one → still scheduled and not counted in the notice; cancel the last → unscheduled; restoring either → scheduled; other task / other occurrence never count); task, project, workstream, recurrence, archive, and zone changes write no block and the snapshot keeps planning-time names while labels use the current title; past items not carried forward; typed-in block validation (end, 24 h, whole minutes, `localDate`, zone, status, snapshot, broken link) with nothing written; DST gap refused and overlap → earlier instant; edit/cancel/restore/quick add persist after a restart, no delete; quick add is one transaction; a block write needs its task; cancel/restore refresh snapshot and planning zone but never instants or occurrence; midnight clipping, overlaps counted and grouped side by side, nothing moved; search (current and snapshot title) and filters; zone change writes no block; **item 17** (Tehran → Tokyo shows the Monday block on Tuesday 04:30, no duplicate Monday item, Tuesday's own item still unscheduled; reverse to New York; back to Tehran); capacity warning/notice/no-estimate/unset; capacity limits 1–1,440, saving over capacity allowed, removal deletes the field.
- `apps/web/src/backup/planning-backup.test.ts` (14; the sample writer runs only with `PPS_WRITE_SAMPLE=1`): items 21–24 — round-trip into an empty device (identical IDs, hashes, versions; `dataSchemaVersion` 3); idempotent re-import, older copy, newer block only after confirmation; a block changed on both devices → keep/use only, and choosing the version that cancels one of two blocks keeps the occurrence scheduled; imported zone change leaves blocks unchanged; a task with live blocks cannot be deleted by "delete here", a deleted block becomes a decision; the committed Stage 2 sample imported by the Stage 3 app keeps every record byte-identical across a restart, and re-exporting it into a device holding the Stage 2 backup gives only "already here"; recurrence/capacity stay absent (never null) after edits; version-1/2/3 samples import; a version-2 file with blocks (`UNKNOWN_RECORD_TYPE`), recurrence, or capacity (`INVALID_PAYLOAD`) is refused, the same file without them imports; version 4 refused as newer; `null` new fields refused; bad times, seconds, over 24 h, wrong `localDate`, unknown zone, inconsistent snapshot, unknown status, extra field, unknown task refused — also inside carried conflicts and the archive — with nothing changed.
- `apps/web/src/App.test.tsx` (+5, jsdom): navigation has Today and Calendar; without a zone the planning screens show the prompt, write nothing, and the recurrence checkbox is disabled; Settings shows the zone-change note in English and Persian and capacity can be set and removed; recurrence from the task editor (start date pre-filled with today in the zone), Today shows the item, "Schedule" form with empty start time, pre-filled date and estimate, save → block 18:30–19:15, cancel → item back, restore from the calendar with "Show cancelled"; quick add in the week view with the capacity warning shown before saving, a block for an existing task, project/inbox/search filters, month view with counts and the over-capacity marker, previous/next/today/go to date, opening a day; Persian RTL with the Jalali display: Aban 1405 month, Jalali date entry (1 Farvardin 1406 → 21 March 2027), weekday names.
- `apps/web/e2e/offline.spec.ts` (+2, Edge): **item 25** — offline: set zone and capacity, make a task recur, schedule its occurrence (empty start time, estimate pre-filled, capacity warning), quick-add a block, reload offline, export a real file, import it into a fresh profile (4 new items + newer preferences) and see the same two blocks and warning on Today; **item 26** — Persian RTL with the Jalali display: Jalali month heading and 29–31 day month, navigation, Jalali date entry, weekday name; no request outside the app's path in either test.
- Changed: `organization-backup.test.ts` (exports are now data version 3; "newer" is version 4) and `validation.test.ts` (version 4 is the newer version).

Fixes found while testing: (1) the capacity field could drop an edit typed while the previous save was finishing (it now clears its draft only if unchanged); (2) month cells on a phone wrapped "Over capacity" letter by letter (now compact marks with the full text in the label); (3) two component tests clicked before shared preferences had loaded (now they wait). Overlapping blocks were first listed one under another; they are now grouped side by side as PRODUCT_SPEC says.

### Owner Stage 3 device checks (2026-10-25)

Reported by the owner; not run by the implementer. Build: `main` at `fe83acf`, published as version 0.4.0. Devices: the owner's Windows laptop and Android phone; device models, OS versions, and browser names/versions unspecified.

| Check | Result (owner report) |
|---|---|
| Stage 3 planning flow works offline on Windows | Passed |
| Stage 3 planning flow works offline on Android | Passed |
| Backup transfer Windows → Android | Passed |
| Backup transfer Android → Windows | Passed |

This completes manual acceptance item 27 as reported by the owner. No claim is made about device or browser versions. Still not tested: iPhone; a screen-reader pass of the new forms; behavior across a real midnight with the app left open (covered only by the pure functions and the per-minute clock re-read).

**Deployment check (2026-10-25):** the GitHub Actions workflow for `fe83acf` completed successfully (run [40087458776](https://github.com/moeintorabi90/personal-productivity-system/actions/runs/40087458776)). From the development PC, the app URL and `manifest.webmanifest` returned HTTP 200; the served JavaScript bundle identified version 0.4.0. This verifies the deployment and static assets from this PC, not reachability from every network or region.

## Stage 2 test report (2026-10-21)

Branch `feat/stage-2-organization` (from `main` at `6055bf7`). Windows 11, Node.js 24, Vitest 5.0.5, Playwright 1.64, Microsoft Edge (headless).

| Command | Result |
|---|---|
| `npm.cmd run typecheck` | Passed (shared, API, web; exit 0) |
| `npm.cmd test` | **179 passed, 0 failed** in 20 files (includes the frozen Stage 1 server/sync tests) |
| `npm.cmd run test:e2e` (production build + Edge) | **6 passed, 0 failed**; build precaches 11 files |
| Production bundle check | No test fixtures or `fake-indexeddb` in `apps/web/dist/assets` |
| Manual check in the browser pane (dev server) | Capture in Inbox, create project and workstream, add a workstream task, organize the inbox item into the project with an estimate; project detail grouped correctly; no console errors |

New and changed automated tests:

- `apps/web/src/local/organization.test.ts` (10): capture (trimmed, newest first, leaves the inbox when organized); blank/over-long titles refused; a workstream needs an existing project and never moves (even a direct write is refused); a task's workstream must belong to its project, an inbox task has no workstream, a link to a missing or deleted project is refused, and a refused move changes nothing; version bump per edit and no-op edits; archiving a project changes no linked record, creates no tombstone, and can be undone; project outline grouping and status filters; search across types and fields; Persian search folds Arabic/Persian Yeh and Kaf and ignores ZWNJ.
- `apps/web/src/backup/organization-backup.test.ts` (18; the sample writer runs only with `PPS_WRITE_SAMPLE=1`): round-trip into an empty device with identical IDs, hashes, and versions (`dataSchemaVersion` 2); merge into a device with its own same-content project (both kept) and an idempotent second import; a task moved to another project elsewhere is "newer in backup" and applied only after confirmation (old version archived); an old file does not undo newer edits; project and task conflicts offer only keep/use (no "keep both"), survive a restart, keep the ID, and leave tasks attached; deletions from a backup become decisions, "delete here" works for a task and is refused for a project that still has tasks; refused with no change: a task whose workstream belongs to another project, an inbox task with a workstream, the same in an archived version, a workstream whose project differs between device and file, a missing project, a blank title, an unknown field, an estimate of 0; a resolution that would activate a rule-breaking version is refused; the committed data-version-1 sample still imports; a data-version-1 file containing Stage 2 types (as records or tombstones) is refused; data version 3 is refused as newer; the committed data-version-2 sample imports.
- `apps/web/src/backup/validation.test.ts`: the "newer version" case now uses `dataSchemaVersion` 3, and version 0 is refused.
- `apps/web/src/App.test.tsx` (+4): navigation now has Inbox and Projects; capture → organize into a project's workstream → grouped project detail (with next action and estimate), no network use; archive without deletion, status filter, search across projects/workstreams/tasks; Persian navigation and screens; a project conflict shows field labels and no "Keep both", and "use the backup's version" keeps the project.
- `apps/web/e2e/offline.spec.ts` (+1): offline in Edge, create a project and workstream, capture and organize an item, reload offline, export a real backup file, import it into a fresh profile (3 new items), and see the same grouping; no request outside the app's path.

Manual checks on the owner's devices: see "Owner device checks (2026-10-23)" below. Not covered by that report: a conflict from the same project edited independently on both devices and then merged by backup (automated tests only), and iPhone.

## Owner device checks (2026-10-23)

Reported by the owner; not run by the implementer. Build: `main` with Stage 2, published to GitHub Pages by the workflow run for `644843b` (completed successfully on 2026-10-21; see the hosting note below for the live site's later status). Devices: a Windows laptop and an Android phone; **device models, OS versions, and browser names/versions unspecified**.

| Check | Result (owner report) |
|---|---|
| The app opens and remains usable offline after being loaded | Passed (Windows, Android) |
| Project/task workflows work offline and persist after closing and reopening the app | Passed (Windows, Android) |
| Backup export on Windows → import on Android | Passed |
| Backup export on Android → import on Windows | Passed |
| Importing the backup does not create duplicate records | Passed |
| Persian text entry and search | Passed (device not specified) |
| Phone layout | Passed (Android) |

Still open (not in the report): iPhone (Safari Home Screen app) install, offline use, and export/import; a conflict from the same project edited independently on both devices, then merged by backup; other on-device items not listed above (e.g. encrypted backups, the share sheet, refused files, persistent-storage grant and eviction, update after a new build).

Historical hosting note: on 2026-10-23 the app URL, its manifest, and the GitHub Pages API returned HTTP 404 from the development PC even though earlier Actions runs had succeeded. The site was restored by the successful deployment for `fe83acf`; see the Deployment check above.

## Stage 1B test report (2026-10-21)

Branch `feat/stage-1b-offline-backup`. Environment as in the Stage 1 report (Windows 11, Node.js 24.20.0, TypeScript 7.0.2, Vitest 5.0.5, Playwright 1.64, Microsoft Edge 155.0.4283.62 headless). Tests run one file at a time (memory limit of this PC).

| Command | Result |
|---|---|
| `npm run typecheck` | Passed (shared, API, web; exit 0) |
| `npm test` | **130 passed, 0 failed** in 16 files (includes the frozen Stage 1 server/sync tests, still passing) |
| `npm run test:e2e` (build + Edge) | **4 passed, 0 failed**; build precaches 11 files |
| Production bundle check | Test fixtures and `fake-indexeddb` are not in `apps/web/dist/assets` |
| Manual check in the browser pane (dev server) | Backup screen texts and password warning present; no console errors; no request to `/v1` |

New and changed automated tests:

- `apps/web/src/backup/primitives.test.ts` (13): JCS against RFC 8785 rules (key order, numbers, escaping); synchronous SHA-256 equals Node's on 9 lengths; base64; version-vector order/merge; pre-parse scan: 32 levels accepted / 33 rejected, 8,000,000 `[` rejected at position 32, mismatched brackets, unterminated string, control character, invalid escape, trailing content, brackets inside strings not counted, exactly 4,000,000 values accepted / one more rejected.
- `apps/web/src/backup/merge.test.ts` (16): backup items 1–7 (round-trip, merge without loss, idempotent re-import, older copy, newer in backup only after confirmation with archive, conflicts surviving restart, keep both for independent type, use backup / keep device with undo, linked parent without "keep both" and children still attached, deletions both ways as conflicts, old backup does not resurrect a deleted item, deleting a linked parent refused), 8 (history integrity warning, corrections appended), 14 (preview counts equal applied), 15 (UUID identity), 17 (bulk action count), an apply failure leaving the database unchanged, and carried pending conflicts without duplicates.
- `apps/web/src/backup/validation.test.ts` (18): item 9 (truncated, foreign, damaged, schema violations, wrong content hash, unknown type, unresolved reference, unknown header fields, newer format/data versions, invalid JSON number → all refused, database unchanged); 9a (32 MiB + 1 byte refused without reading; exactly 32 MiB accepted; 200,001 entries refused before per-entry checks, 200,000 passes the count; envelope over 256 KiB refused on export and import; 33-device version vector refused); 9c (JSON.parse never called for nine malformed/deep/oversized inputs; same inside an encrypted payload); 10 (no `sync_probe` or outbox data in exports even when present; a file containing them refused); 12 (integrity hash equals an independent Node-crypto computation; damaged encrypted file reported before any PBKDF2).
- `apps/web/src/backup/encryption.test.ts` (6): 13 (default export unencrypted; one password slot, 600,000 iterations, no hint, no plaintext; right/wrong password, database unchanged on failure; NFC-equivalent `آ` works, Arabic Yeh is a different password; modified ciphertext, IV, salt, iterations, creation time, or device name fail authentication even with a recomputed integrity hash); 9b (13 malformed or out-of-bounds parameter sets refused before the password prompt, PBKDF2 spy never called; 600,000 and 1,000,000 accepted).
- `apps/web/src/backup/preferences.test.ts` (10): 16 (reserved ID; untouched defaults → newer in backup; both edited → conflict without "keep both"; language/theme only via the optional display-settings choice); migration of the legacy row (values kept, version vector rule, legacy row untouched, defaults without a row); 11 (committed format-version-1 sample with fabricated data imports; newer format refused).
- `apps/web/src/App.test.tsx` (10, jsdom): v1 navigation without sync screens, engine never started, no `fetch` at all; frozen screens only with the flag on; Persian RTL as a device setting; theme; time zone as a shared preference; offline state; export password off by default, double entry, warning and password-manager advice, verified encrypted export, last-backup indicator; import preview with updates and display settings unchecked by default, re-import message, confirmed update with undo entry; refused file message and nothing changed; conflict shown side by side and resolved (item 18 and the UI parts of 13, 16, 17).
- `apps/web/e2e/offline.spec.ts` (4, Edge): offline shell (sync UI absent, offline settings edit, no request to `/v1` or other origins); data survives a browser restart reopened offline; Persian RTL and dark theme persist; **real file flow**: export a download in one profile while offline, import it into a fresh profile while offline, confirm the update, re-import shows "already imported" and no duplicates, no network use.

Defect found by these tests and fixed: a refused import (unresolved reference) still created the default preferences record, because preview wrote it before validation. Preview now writes nothing; the default is created only inside the import transaction.

**Fixes after Codex review (same branch, 2026-10-21):** (1) conflicts were shown and resolved against a stored snapshot labelled "On this device" — now the current version is shown and used, choices follow the current state, a stale choice is refused, carried conflicts name the device that found them (`detectedOn`), and every version not kept (including a differing snapshot) is archived; (2) links were checked only in active records — now every version in the file is checked, and activation (import, resolution, undo) requires live targets inside the transaction. Re-verified: `npm run typecheck` passed; `npm test` **143 passed, 0 failed** in 17 files; `npm run test:e2e` **4 passed** (Edge). New `apps/web/src/backup/conflict-integrity.test.ts` (13): edit after detection (old choice refused as STALE with no change; current shown; snapshot labelled; `useBackup`/`keepDevice`/`keepBoth` each act on the shown versions and archive the rest); conflict carried from another device compared with this device's own version, snapshot archived; current deleted or missing at resolution (options follow state, nothing dropped); unknown link targets in carried conflict or archived versions refuse the file with no change; archived version linking to a deleted item imports as history but undo refuses to activate it; conflict backup version whose parent was deleted here cannot be restored; a link target deleted between preview and apply makes the import fail as a whole; a new child may link to a parent added by the same import but not to one deleted here. `App.test.tsx` now also checks that an edit after detection updates the "On this device now" column, shows the earlier snapshot, and that keeping this device's version archives both other versions.

**Compatibility fix after Codex review (same branch, 2026-10-21):** `detectedOn` had been made required in format-version-1 conflict entries, so files from the first Stage 1B build (`53d38c2`) with pending conflicts were refused, and a device holding a conflict stored by that build could not export at all (export's re-open check failed). `detectedOn` is now optional; missing means unknown and is never filled in (`BACKUP_FORMAT.md`, implementation notes). New `apps/web/src/backup/legacy-conflicts.test.ts` (3): a version-1 file without `detectedOn` imports with both versions, the carried conflict stays without a device (not this device, not the file's source) while this device's own new conflict records it, and it resolves with both other versions archived; a stored legacy row exports (field not invented) and re-imports through two more devices with `local` and `incoming` unchanged, and still resolves on its own device; new conflicts record `detectedOn`, keep it through export/import, and `null`/malformed values are still refused. With the previous schema restored temporarily, the first two failed (`INVALID_PAYLOAD`; `EXPORT_VERIFICATION_FAILED`). `App.test.tsx` checks that a new conflict's earlier snapshot names the device that found it, and that a legacy row shows "Which device that was is not known" and names neither this device nor the backup's. Verified: `npm.cmd run typecheck` passed; `npm.cmd test` **147 passed, 0 failed** in 18 files; `npm.cmd run test:e2e` **4 passed** (Edge).

Not tested in Stage 1B (remaining manual items):

- **Windows → Android and Android → Windows** backup export/import on real devices: **owner-reported as passed on 2026-10-23** (versions unspecified; see "Owner device checks (2026-10-23)"). **iPhone** (Safari Home Screen app) export/import feasibility: still open; no iPhone device is available to the implementer.
- Share-sheet export ("Share or save…") on phones: only shown where the browser supports sharing files; not available in headless Edge.
- PWA install UI on Windows (headless E2E does not exercise it).
- A decrypted payload over 32 MiB: unreachable through a valid file (see BACKUP_FORMAT "Implementation notes"); the check stays as defense in depth.

## GitHub Pages hosting preparation (2026-10-21, branch `feat/github-pages-deploy`, D-018)

Production builds and `vite preview` now serve the app under `/personal-productivity-system/`, and the E2E suite runs there. New E2E test "the app works under the GitHub Pages subpath": the service worker's scope is `http://localhost:4173/personal-productivity-system/` and its script is `<base>sw.js`; the manifest link, and the manifest's `id`, `start_url`, and `scope`, resolve to the base URL; every manifest icon returns 200. All E2E tests now also fail on any same-origin request outside the base path. Verified on Windows 11 with Edge (headless): `npm.cmd run typecheck` passed; `npm.cmd test` **147 passed, 0 failed** in 18 files; `npm.cmd run test:e2e` (production build + Playwright) **5 passed, 0 failed**; the build emits hashed assets under `/personal-productivity-system/assets/` and `sw.js` precaches 11 files relative to its scope.

Not verified yet at that time: the workflow `.github/workflows/deploy-pages.yml` had not run. **Update (2026-10-21):** `main` at `6055bf7` was pushed and deployed by the owner; the app and manifest returned HTTP 200 from the development PC. The owner reports installing the app on a Windows laptop and an Android phone. **Later status (2026-10-23):** the URLs and Pages API returned HTTP 404; the site was restored by the successful `fe83acf` deployment on 2026-10-25 (see the Deployment check under Stage 3). iPhone is still not verified.

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
- `apps/web/src/App.test.tsx` (5, jsdom; replaced in Stage 1B): English LTR default with accessible navigation; Persian switches `dir="rtl"`/`lang="fa"` and persists; theme applied to the document; time zone never imposed and invalid names rejected; offline indicator and local writes while offline.
- `apps/web/e2e/offline.spec.ts` (3, Edge; replaced in Stage 1B): installed shell reloads and works offline (with a local write); a note survives closing the browser and reopening it **offline** with a persistent profile; Persian RTL layout (navigation starts at the right edge) and dark theme persist after reload.

Security fix after Codex review (branch `fix/api-loopback-bind`, DECISIONS T-015), re-verified: `npm run typecheck` passed; `npm test` **62 passed, 0 failed** in 11 files; `npm run test:e2e` 3 passed. Manual runtime check: with `HOST` unset, only `127.0.0.1:<port>` was listening and the PC's LAN address could not connect (`Test-NetConnection` false); `HOST=0.0.0.0` without `SETUP_TOKEN` exited with an explanatory error; the Vite dev proxy reached the API (`/v1/setup/status` → 200).

A defect found by these tests and fixed: the service worker missed cached JS/CSS offline because the server's `Vary: Origin` header made `caches.match` fail for `crossorigin` requests (now `ignoreVary: true`).

Scope note (D-012, added after this report): the server, authentication, and sync tests above cover the frozen post-v1 code; they keep running but are no longer v1 gates.

Not yet tested (Stage 1):

- **(Post-v1, no longer a v1 gate)** The full suite against a native PostgreSQL server (`TEST_DATABASE_URL`): no server is available on this PC and Docker is excluded. Only the wire-protocol path against PGlite has run.
- **Android and iPhone** installation and offline use on real devices; PWA install prompt on Windows (headless E2E does not exercise installation UI).
- Screen-reader pass and contrast measurement (semantic labels and focus styles exist; not audited with assistive technology).
- Concurrent pushes from two devices at the same instant on real PostgreSQL (owner row lock is implemented; PGlite serializes transactions, so the race is not exercised).
