# Data Model and Invariants

## Relationship sketch

```mermaid
erDiagram
  USER ||--|| USER_PREFERENCE : has
  USER ||--o{ PROJECT : owns
  PROJECT ||--o{ WORKSTREAM : groups
  PROJECT ||--o{ TASK_DEFINITION : contains
  WORKSTREAM o|--o{ TASK_DEFINITION : optionally_groups
  TASK_DEFINITION ||--o{ CALENDAR_BLOCK : planned_as
  TASK_DEFINITION |o--o{ EXECUTION_SESSION : optionally_performed_as
  CALENDAR_BLOCK o|--o{ EXECUTION_SESSION : optionally_links
  EXECUTION_SESSION ||--o{ OUTPUT_RECORD : records
  OUTPUT_METRIC ||--o{ OUTPUT_RECORD : measures
  USER ||--o{ GOAL : defines
  PROJECT o|--o{ GOAL : optionally_supports
  GOAL ||--o{ GOAL_CONTRIBUTION : receives
  TASK_DEFINITION ||--o{ GOAL_CONTRIBUTION : may_contribute
  USER ||--o{ HABIT : defines
  HABIT ||--o{ HABIT_OCCURRENCE : schedules
  HABIT_OCCURRENCE ||--o| HABIT_COMPLETION : may_complete
  USER ||--o{ WEEKLY_REVIEW : finalizes
  USER ||--o{ SYNC_DEVICE : enrolls
```

Names in the diagram are conceptual. Tables are defined by plain SQL migrations in `apps/api/migrations` (DECISIONS T-006); later stages add their own migrations.

## Implemented in Stage 1 server (`0001_foundation.sql`) — frozen, not part of v1

| Table | Purpose and key constraints |
|---|---|
| `app_user` | Owner account; unique `lower(email)`; scrypt password hash |
| `app_installation` | Singleton row (`CHECK (singleton)`) naming the one owner, which makes setup race-free |
| `sync_device` | Client-generated device IDs, unique per owner (`PRIMARY KEY (user_id, id)`); `revoked_at` |
| `auth_session` | SHA-256 token hash, expiry, revocation; FK to the owner's device |
| `user_preference` | Language, theme, calendar display, week start, nullable IANA time zone, `revision`; CHECK constraints mirror the shared Zod schema |
| `sync_probe` | Stage 1 sync diagnostic record (T-011), not product data and not in v1 backups; `PRIMARY KEY (user_id, id)`; tombstone via `deleted_at` |
| `sync_operation` | Applied push results by `(user_id, op_id)` with request hash, for idempotent retries |
| `change_log` | Append-only per-owner change stream (`seq` identity) read by pull; deletions are `deleted = true` rows |
| `schema_migrations` | Applied migration versions and checksums (created by the runner) |

Foreign keys use `ON DELETE RESTRICT`: nothing referenced by history is removed by cascade.

## On the device (IndexedDB, `apps/web/src/local/db.ts`, schema version 2 since Stage 1B)

| Table | Contents | In backups |
|---|---|---|
| `records` | Product records as envelopes, primary key `[type+id]`: shared preferences under its reserved ID; since Stage 2 `projects`, `workstreams`, and `taskDefinitions`; since Stage 3 `calendarBlocks` (no IndexedDB schema change was needed) | Yes |
| `tombstones` | Deletion markers `[type+id]` with version vector | Yes |
| `pendingConflicts` | Undecided import conflicts with both versions (D-015) | Yes |
| `replacedVersions` | Versions replaced by a choice or a confirmed update (undo) | Yes |
| `importLog` | One row per import: backup ID, source device, counts | No |
| `meta` | Device identity (ID, name), `deviceSettings` (language, theme; D-017), `lastBackupAt`; frozen sync: session, cursor, last sync | Device settings only as informational `sourceDeviceSettings` |
| `preferences` (legacy `"self"` row), `probes` (`sync_probe`), `outbox`, `conflicts` | Frozen post-v1 sync code (D-016). The v2 migration copies `"self"` into shared preferences and device settings and leaves it unchanged; v1 never reads it again | Never |

## Entities

- **User:** in v1 there is no account; "the owner" is whoever uses the device. (A future sync service would add an owner account.)
- **Device:** local identity of each installation (UUID and editable name). Used in version vectors and to label backups; never sent anywhere in v1.
- **UserPreference:** shared, transferable settings (explicit IANA time zone, week start, calendar display, later capacity preferences) as one singleton record with a reserved ID; plus device-local settings (language, theme) that stay on each device (decided split, D-017; `BACKUP_FORMAT.md`).
- **Project / Workstream:** user-created organization. A workstream belongs to one project and is not nestable. A project has a color (chosen from a palette, or a derived default), approved for the Stage 3 follow-up (T-068; "Stage 3 follow-up: project color" below).
- **TaskDefinition:** reusable task details (and, from Stage 3, recurrence configuration). It is not evidence that work occurred.

### Stage 2 record types (implemented; `dataSchemaVersion` 2)

| Type | Data fields | Links | Rules |
|---|---|---|---|
| `projects` | `name` (1–200 characters, not blank), `description` (≤ 20,000), `archivedAt` (UTC instant or null) | — | — |
| `workstreams` | `projectId`, `name`, `description`, `archivedAt` | `projectId` → `projects` | `projectId` never changes (DECISIONS T-022) |
| `taskDefinitions` | `title` (1–200, not blank), `notes` (≤ 20,000), `projectId` (or null), `workstreamId` (or null), `nextAction` (≤ 500), `estimateMinutes` (whole minutes 1–10,080, or null), `archivedAt` | `projectId` → `projects`, `workstreamId` → `workstreams` | a workstream requires a project, and must belong to that project |

- **Inbox:** task definitions with `projectId` null (DECISIONS T-021). Organizing a captured item edits the same record; nothing is copied.
- **Archive** is data (`archivedAt`), not a deletion; archiving never changes linked records (T-023). Stage 2 offers no delete; deleting a record that live records link to is refused (restrict).
- `notes` is the task's descriptive text; there is no separate description field (owner-approved, T-024).
- **Deferred in Stage 2** (owner-approved, T-024): recurrence and active weekdays (added in Stage 3 as the optional `recurrence` field, below in "Stage 3 record types and fields"), relevant output metrics (Stage 5), and a task type (only after the owner defines a use case and categories). Each is added with a new `dataSchemaVersion` and an upgrade step. Under the approved order (T-076), Stage 5's data uses `dataSchemaVersion` 6; the output-metrics task field becomes a list of suggested output definitions (owner, T-138; field `outputDefinitionIds`, T-146).
- All three types are **linked** (they link to, or are linked from, another type), so a conflict on any of them offers "keep this device's" or "use the backup's" version, never "keep both".
- **OutputMetric (output definition):** reusable, user-named measure with a unit (e.g. pages, words, minutes of content covered), archivable (T-104, T-107). Definitions have revisions so historical outputs retain their meaning (T-111); all revisions of a definition measure the same unit, and a different unit is a new definition (T-165).
- **Goal / Milestone / GoalContribution:** a measurable outcome with a required name and optional description (T-054), optional project link, start date, target/window/status (including pause/resume) and explicit attribution rules; goals the owner no longer intends to pursue can be archived without deleting the goal or its history (T-063), and an archived goal may be restored at any time (T-064) to its pre-archive status (T-065). A paused goal may be completed without resuming it first (T-062), and the owner may reopen a completed goal to make it active again (T-060), preserving all milestone completion statuses (T-061). Milestones have a required name and optional description (T-055), plus an optional deadline (T-056) that falls within the parent goal's date range (T-057). The owner marks each milestone complete independently; no other milestone must be complete first (T-058), and may later return it to incomplete (T-059). Numeric output goals have an owner-entered unit label and whole-number targets in the initial release (decimal targets deferred to a later version). A work session's time may be attributed to at most one goal, a completed task may count toward at most one task-count goal, and an output record may contribute to multiple goals only when explicitly attributed to each. Pausing or resuming does not alter goal dates or suppress explicitly attributed work/output. A goal may contain milestones, which cannot exist independently. The owner manually marks goals and milestones complete. Progress is derived from sessions, task completion events, and output records.
- **CalendarBlock:** planned occurrence with planned start/end, local-date key, timezone, source recurrence, relationship IDs, and task/project/workstream snapshot/revision. Implemented in Stage 3 as record type `calendarBlocks` (below).
- **ExecutionSession:** one period of actual work (at most 24 hours of work time; paused time does not count, T-136, T-158), planned or unplanned, with optional task ID (T-095), optional block ID of the same task, set at start or linked later (T-094, T-135), exact start and end instants, pause intervals (T-092), an optional note and energy and focus ratings 1–5 (T-140), snapshots when a task is linked, and a deletion state (trash for 30 days, T-103, T-142). No end status (T-098). Its duration is separate from any output (T-099).
- **OutputRecord:** whole-number actual value for one output definition, always belonging to one session (T-104), optionally attributed to several goals that track the same definition (T-105, T-137). Corrections, attribution changes, and its deletion append a history entry (T-102, T-113, T-131, T-143).
- **Habit / HabitOccurrence / HabitCompletion:** user-defined recurring activity, planned local-date occurrence, and separate completion record.
- **WeeklyReview:** selected local week, computed immutable summary snapshot, source record IDs/revisions, user observations, and next-week adjustments.
- **Tombstone:** deletion marker (record type, ID, deletion time, version vector) kept locally and exported in backups.
- **PendingConflict / ReplacedVersion / ImportLog (v1, local only):** both versions of an unresolved import conflict; versions replaced by a user's choice (for undo); and the record of each import (backup ID, source device, counts). See `BACKUP_FORMAT.md`.
- **SyncDevice / ChangeLog (after v1, server):** enrolled device cursor and accepted change stream; implemented in the frozen Stage 1 code.

### Stage 3 record types and fields (implemented and merged into `main`; `dataSchemaVersion` 3)

Contract: PRODUCT_SPEC "Stage 3 planning contract"; decisions D-019 to D-023, T-025 to T-036 in DECISIONS. The behavior behind each field is owner-approved (D-022, D-023, T-029 to T-036, 2026-10-24); field names and value encodings below are technical implementation choices serving that behavior.

Common value formats: **local date** = ISO Gregorian `YYYY-MM-DD` (a real calendar date); **instant** = UTC ISO-8601 timestamp; **weekday** = integer 0 (Sunday) … 6 (Saturday), the same numbering as `weekStart`; **zone** = valid IANA time zone name.

| Type / field | Shape | Rules |
|---|---|---|
| `taskDefinitions.recurrence` (new, optional) | absent = not recurring; otherwise `{ kind: "weekdays", weekdays, startDate, endDate }` (T-029) | `weekdays`: 1–7 distinct weekdays (0 = Sunday … 6 = Saturday), stored in ascending order; `startDate`: local date (required; defaults in the UI to the current local date when recurrence is enabled); `endDate`: local date ≥ `startDate` (inclusive), or null. Never stored as `null` (absent instead). |
| `preferences.dailyCapacityMinutes` (new, optional) | absent = not set; otherwise whole minutes 1–1,440, applying to every day (T-031) | Shared preference (D-017): travels in backups, merges as the preferences singleton. |
| `calendarBlocks` (new type) | `taskId`, `startsAt`, `endsAt`, `timeZone`, `localDate`, `occurrenceDate`, `status`, `snapshot` (time model: D-022, T-030; snapshot: T-036) | see below |

`calendarBlocks` fields and rules:

- `taskId` — link → `taskDefinitions` (required). The only link of a block; blocks are therefore **linked** records (keep/use, never "keep both").
- `startsAt`, `endsAt` — fixed UTC instants (D-022), minute precision (seconds and milliseconds zero); `endsAt` > `startsAt`; duration ≤ 24 hours. Displayed in the currently configured zone; a zone change never rewrites them.
- `timeZone` — the zone the block was planned in (the configured zone at creation or last edit), as an IANA zone name (T-030).
- `localDate` — the local date of `startsAt` in `timeZone`; must match it exactly (T-030). It is not the display date: after a zone change, views place the block by `startsAt` in the configured zone.
- `occurrenceDate` — local date of the recurring item this block schedules, or null for a block not made from an unscheduled item. Changing the configured zone never changes it (D-022), even when the block is then displayed on another date. Not checked against the task's current recurrence (the recurrence may have changed since; plans are not rewritten).
- `status` — `"planned"` or `"cancelled"`. Cancel and restore are ordinary edits; there is no deletion in the UI (T-027). As edits of the block they also set `timeZone` to the configured zone (with `localDate` recomputed from the unchanged `startsAt`) and refresh the snapshot; instants, task, and `occurrenceDate` stay unchanged (implementation, Stage 3).
- `snapshot` — `{ taskTitle (1–200), projectId (or null), projectName (≤ 200, or null), workstreamId (or null), workstreamName (≤ 200, or null) }`, taken when the block is created and refreshed when the block itself is edited (move, resize, cancel, restore), never because a task, project, or workstream is renamed (T-036); `workstreamId` requires `projectId`; names are null exactly when their ID is null. Snapshot IDs are history, **not links** (they may refer to items deleted later).
- No completion, actual time, or output fields (planning only; Stage 5 adds execution sessions that may reference a block, and an optional expected output list on the block, T-141, T-150, which is a plan, not an output).

Derived, not stored (T-026):

- **Unscheduled item** of task T on local date D: T exists and is not archived; T has a recurrence; `startDate` ≤ D and (`endDate` null or D ≤ `endDate`); weekday(D) ∈ `weekdays`; and no block with `taskId` = T, `occurrenceDate` = D, `status` = planned exists. Weekday(D) comes from the Gregorian date and does not depend on the zone; which date is "today" does (configured zone).
- **Scheduled occurrence** (D-022, D-023): the occurrence (T, D) is scheduled while **at least one** block with `taskId` = T, `occurrenceDate` = D has `status` = planned, regardless of the date on which that block is displayed in the configured zone. Cancelling one such block leaves it scheduled while another planned one remains; it becomes unscheduled only when the last one is cancelled, and scheduled again when any one is restored. A block displayed on date D′ never schedules task T's occurrence on D′ unless its `occurrenceDate` is D′.
- **Planned minutes** of local date D in the configured zone: the sum, over blocks with `status` = planned, of the part of [`startsAt`, `endsAt`) that falls inside D (overlapping blocks are each counted) (T-031).

Invariants added in Stage 3:

- A block's task must exist when the block is created, edited, restored, imported as active, or activated by a conflict choice or undo (live link). Editing, moving, archiving, or changing the recurrence of a task never changes its blocks.
- A task that live blocks link to cannot be deleted (restrict, as for projects with tasks). Archiving it is allowed and leaves its blocks unchanged.
- Changing the configured time zone writes no block: `startsAt`, `endsAt`, `occurrenceDate`, and every other block field, content hash, and version vector stay unchanged (D-022).
- Nothing in the app creates, moves, shortens, cancels, or deletes a block except an explicit user action on that block (D-019, D-021); imports follow the backup rules (only new blocks are added automatically).
- No IndexedDB schema version change is required: blocks are stored in `records` like other types. An index for date-range queries may be added as an implementation detail (a Dexie version step that rewrites no data); Stage 3 does not add one (blocks are read by type).

### Stage 4 record types (`dataSchemaVersion` 4)

Decisions: T-037 to T-065 and T-077 to T-080 (owner), T-081 to T-087 (derived). Field names and encodings are technical choices.

| Type | Data fields | Links | Rules |
|---|---|---|---|
| `goals` | `name` (1–200, not blank), `description` (≤ 20,000), `projectId` (or null), `startDate` (`YYYY-MM-DD`), `deadline` (`YYYY-MM-DD` or null), `kind` (`output`, `time`, or `taskCount`), `target` (whole number, see T-085), `unit` (1–50 characters, not blank; present **only** for `output`), `status` (`active`, `paused`, `completed`), `archivedAt` (UTC instant or null) | `projectId` → `projects` | `deadline` ≥ `startDate`; `kind` never changes (T-079); `target` is whole minutes for `time` |
| `milestones` | `goalId`, `name` (1–200, not blank), `description` (≤ 20,000), `deadline` (`YYYY-MM-DD` or null), `completedAt` (UTC instant or null) | `goalId` → `goals` | `goalId` never changes; a deadline lies within the goal's range for the owner's edits (T-084) |

- **No progress fields** (T-037, T-087): progress and pacing are derived from Stage 5 records later; nothing is cached now. No attribution records exist yet (T-047 to T-049 apply from Stage 5).
- **Archive, not delete, for goals** (T-063): `archivedAt` set; `status` is kept, so restore returns to it (T-065, T-082). An archived goal and its milestones are read-only. Milestones can be deleted (tombstone, T-080).
- Both types are **linked**: conflicts offer "keep this device's" or "use the backup's" version, never "keep both". A goal with live milestones cannot be deleted by a conflict choice (restrict).
- No IndexedDB schema change: both types are stored in `records`.

### Stage 3 follow-up: project color (approved 2026-10-25; merged into `main` at `7fabdcd` and deployed as 0.6.0; `dataSchemaVersion` 5)

Built after Stage 4 and before Stage 5 (T-076). Decisions: T-068 to T-070 (owner) and the derived technical choices in DECISIONS ("Calendar interaction, project color, and streak decisions"). Field name and encoding are technical choices.

| Type / field | Shape | Rules |
|---|---|---|
| `projects.color` (new, optional) | absent = no color chosen; otherwise the identifier of a palette entry | Must be one of the palette identifiers of the file's data version; never stored as `null` (absent instead). Arrives in `dataSchemaVersion` 5, after Stage 4's goal and milestone records take version 4 (approved order T-076; BACKUP_FORMAT "Project color"). |

- **Default color (derived, not stored):** a project without `color` is shown in a default palette color computed deterministically from its project ID, the same on every device; nothing is written. Existing projects therefore keep their data, content hash, and version vector.
- **Neutral color:** items without a project (inbox tasks and their blocks).
- **Presentation only:** blocks, sessions, and snapshots store no color. An item uses the current color of its task's current project; when the task is not on this device, the project ID in the item's snapshot; with no project, neutral. Changing a color writes only the project record and rewrites no history (T-069).
- **Palette identifiers in data version 5** (T-088; values in DECISIONS "Derived technical choices"): `blue`, `teal`, `green`, `amber`, `orange`, `red`, `pink`, `purple`. `color` must be one of these; the neutral color is never stored. The default for a project without `color` is the palette entry at index FNV-1a 32-bit(project ID) mod 8. Theme values are presentation and may change without a data-version step; identifiers may not.
- **Undo after a drag** (T-090) adds no field: it writes the block's previous values as a new version of the same `calendarBlocks` record.

### Stage 5 record types (proposed; `dataSchemaVersion` 6; not implemented)

Owner decisions T-091 to T-108, T-117, T-118, T-120 to T-125, T-129 to T-145, T-153 to T-159, T-162, T-163, T-165, T-166; field names, encodings, and the record split are **proposed technical choices** (T-109 to T-116, T-119, T-126 to T-128, T-146 to T-152, T-160, T-161, T-164, T-167), not owner decisions. DECISIONS S-1 to S-15 are resolved; one derived proposal awaits confirmation (T-167).

| Type / field | Data fields (proposed) | Links | Rules |
|---|---|---|---|
| `sessions` (new type; every field present, `null` = none) | `taskId` (or `null`), `blockId` (or `null`), `startedAt`, `endedAt` (`null` while open), `pauses` (list of `{ start, end }`, last `end` `null` while paused), `timeZone`, `localDate`, `goalId` (the one time goal its work time counts toward, or `null`; T-122, T-127), `expectedOutputs` (list of `{ definitionId, amount }`, amount a whole number ≥ 0; an entry with 0 means "0 expected", no entry for a definition means unset; empty = none; T-125, T-128, T-163), `snapshot` (task/project/workstream IDs and names, or `null` without a task), `startedOnDevice`, `notes`, `energy` and `focus` (1–5, or `null`; T-140, T-146), `deletedAt` (or `null`) | `taskId` → `taskDefinitions`, `blockId` → `calendarBlocks`, `goalId` → `goals` | block only of the same task, at start or linked later without changing times (T-094, T-135); `goalId` one of the task's linked time goals or `null` when it has such links, else any time goal or `null` (T-129); instants at whole minutes; end ≥ start, not in the future (T-096); work time at most 24 hours, paused time not counted (T-136, T-158, T-149); pauses inside the session and not overlapping; one open session (running or paused) per device (T-092, T-117) |
| `outputDefinitions` (new type; every field present) | `revisions` (list of `{ name, unit }`), `archivedAt` (or `null`) | — | archived: not selectable for new outputs (T-107); a revision changes the name or the wording of the same unit, never the unit itself (T-111, T-165, T-167) |
| `outputRecords` (new type; every field present) | `sessionId`, `definitionId`, `revision`, `value` (whole number ≥ 0; 0 is a recorded result, unlike no record, T-159), `goalIds` (explicit attribution; empty list = none), `deletedAt` (or `null`; T-143, T-146) | `sessionId` → `sessions`, `definitionId` → `outputDefinitions`, `goalIds` → `goals` | `sessionId` never changes; no standalone outputs (T-104); every goal in `goalIds` tracks `definitionId` (T-137); a deleted output is hidden and never counted, and can be restored for 30 days (T-148, T-153, T-160) |
| `corrections` (new type, append-only; every field present) | `target` (`sessions` or `outputRecords` + ID), `field` (times, value, goal attribution, or the deletion of an output), `before`, `after`, `reason` (text, or `null` when none was given), `device`, `at` | target record | never edited; imported ones are appended (T-113, T-131, T-148) |
| `taskCompletions` (new type; every field present; T-119) | `taskId`, `occurrenceDate` (`YYYY-MM-DD` of a recurring task's occurrence, or `null` for a one-off task), `completedAt`, `goalId` (the one task-count goal it counts toward, or `null` for "none"; T-123, T-127, T-130), `reopenedAt` (or `null`; T-133, T-147) | `taskId` → `taskDefinitions`, `goalId` → `goals` | ID derived from task ID and occurrence date (one record per completion on every device); created only by the explicit "complete" action (T-108, T-118); reopening and completing again edit the same record; an occurrence dated in the future cannot be completed, while today's can be completed at any time that day (T-133, T-155); a completed one-off task is shown on the local date of `completedAt` (T-156); the task definition is not changed |
| `goals.definitionId` (added to an existing type: optional, **omitted** when unused, never `null`) | omitted = no definition chosen yet; output goals only | → `outputDefinitions` | exactly one definition per output goal (T-137); required by the app for output goals created from Stage 5 on; existing goals are linked when the owner chooses or creates a definition whose unit matches the goal's stored `unit` (a mismatch is rejected), keeping the target and converting nothing (T-139, T-151, T-166, T-167) |
| `goals.unit` (existing field; rule changed in version 6, T-161) | output goals created from Stage 5 on **omit** it; existing output goals keep their stored value unchanged | — | an output goal has `definitionId` or `unit` (or both); the unit shown is the definition's, not editable on the goal (T-154); the stored `unit` is shown until a definition is chosen and is the unit that definition must match (T-166); versions 4–5 keep requiring it on output goals |
| `taskDefinitions.goalIds` (added to an existing type: optional, **omitted** when the task has no links; T-126) | list of linked goal IDs of any type (T-120); project links are not inherited (T-121) | → `goals` | a session's time goal and a completion's task-count goal are one of these or "none" when the task has links of that kind (T-129, T-130); changes never re-attribute earlier records (T-132) |
| `taskDefinitions.outputDefinitionIds` (added to an existing type: optional, **omitted** when none; T-138, T-146) | list of suggested output definition IDs (the T-024 "relevant output metrics" field) | → `outputDefinitions` | suggestions only: never limit the outputs recorded or the goals chosen |
| `calendarBlocks.expectedOutputs` (added to an existing type: optional, **omitted** when none; T-141, T-150) | list of `{ definitionId, amount }`, as on sessions | → `outputDefinitions` | copied once into a session started from the block; never counts toward goals |

- **Duration versus outputs (T-099):** session work time is computed from instants and pauses; content minutes or other quantities are output records and never change the session's time.
- **Goal progress inputs (T-116):** time goals from the work time of sessions whose `goalId` is the goal; output goals from attributed output records of their definition (a session may advance several non-time goals through its outputs, T-124); task-count goals from completion records whose `goalId` is the goal and that are not reopened (one per completed one-off task or occurrence, T-118, T-123, T-133). Deleted outputs and sessions in the trash do not count (T-142, T-143); the current attribution is used (T-131). Expected output amounts never count (T-125). Calculated, never stored; shown in Stage 6.
- **Deletion (T-103, T-114, T-115, T-142):** `deletedAt` moves a session and its outputs to the trash, where they can be restored for 30 days; after that, or at once when the owner empties the trash, the session, its outputs, and its corrections become tombstones, which never expire. A single output is deleted by setting its own `deletedAt` and appending a correction (T-143, T-148); it can be restored for 30 days and then, or when the trash is emptied, becomes a tombstone with its corrections (T-153, T-160).
- **Open sessions in backups (T-144, T-152):** running and paused sessions are exported unchanged. A running session that an import adds or updates is treated on the receiving device as paused from the backup's creation time; it takes that device's open-session slot, and a second open session must be ended or deleted before any session is started or resumed.
- **Field conventions and upgrade (T-109, T-146):** new types use present-and-nullable fields, as Stages 2–4 did; fields added to existing types (`goals.definitionId`, `taskDefinitions.goalIds`, `taskDefinitions.outputDefinitionIds`, `calendarBlocks.expectedOutputs`) are optional and omitted when unused (T-025 pattern). No stored record is rewritten.
- **Recurring tasks (T-118, T-119):** completing an occurrence writes a `taskCompletions` record for that task and date; the recurring task stays active and unchanged, and its later occurrences stay scheduled (T-134). An occurrence is a task and a local date (T-026), with or without a planned block. A completed occurrence is no longer an active item but stays visible on its date with a completed marker (T-134).

### Streak data (approved 2026-10-25; not implemented)

- **Goal streak (Stage 6, T-073):** derived, not stored. Computed per goal from its scheduled goal-work opportunities and the actual-work records attributed to the goal (T-047 to T-049), in the configured time zone. Current streak = consecutive past opportunities, each with at least one attributed attempt or work record, ending at the latest passed opportunity; longest = the maximum over the goal's history. Unscheduled days are skipped; an opportunity is missed only after its local day ends; a planned block alone never counts. The definition of an opportunity awaits the post-Stage-5 goal workday decision (T-053; DECISIONS, open detail 6).
- **App-use streak (Stage 8, T-074):** device-local. The local dates on which the app was used are kept in device metadata (`meta`, like language and theme, D-017); current and longest streaks are computed from them. Never exported as mergeable data and never changed by an import; not a cross-device value in v1. What counts as use is open (DECISIONS, open detail 7).

## Core invariants

### Ownership and relationships

- v1: all records on a device belong to the device's user. (After v1, with a server: all private records are scoped by the authenticated owner ID; client-supplied owner IDs are ignored/rejected.)
- A workstream's project must match the task's project. A workstream's project never changes, and a task without a project (inbox) has no workstream. Enforced for typed-in data by the repository (`putRecord`) and for imported data for every version in a backup file (Stage 2).
- A calendar block's task, project, workstream, and snapshots must be mutually consistent at its recorded revision.
- An execution session may reference a task definition (optional, T-095); it is linked to a planned block only when the block is for the same task, automatically at start (T-094) or manually later without changing its times (T-135).
- Deletes of records referenced by history use archive/restrict/tombstone behavior, not destructive cascades.

### Planning versus actual

- CalendarBlock stores intended work and planned duration/output; ExecutionSession and OutputRecord store what happened.
- Creating/editing/deleting an execution never implicitly creates/edits/deletes a CalendarBlock.
- Completing a task definition does not imply a measurable output was produced.
- Actual unplanned sessions are valid without a calendar block.

### Time and recurrence

- Store instants as UTC timestamp-with-time-zone values; retain the relevant IANA timezone and local-date context for interpretation.
- Use date-only values for deadlines and local-date keys for occurrences/review periods.
- Recurrence and configured week boundaries are computed in the user's timezone before conversion to UTC; handle daylight-saving changes.
- Persian UI does not alter Gregorian-based instants or calculations. Calendar choice is explicit.

### Execution state and history

- Open: start exists; end is absent; the session may be running or paused. At most one open session per device; a paused session keeps the slot until it is ended, with or without resuming it first (T-092, T-117), also when it has been paused for more than 24 hours, which only triggers a reminder when the app opens (T-162, T-164).
- Ended: end is present and not before start; there is no final-state label (T-098). Work time = end − start − paused time (T-092, T-110). An ended session is never in the future (T-096) and has at most 24 hours of work time; paused time does not count (T-136, T-158).
- Finished sessions are never silently reopened. Any correction/reopen operation must be explicit and audited.
- Historical names/definitions are captured as snapshots when the event is recorded; later edits (and later imports) do not change prior session or block snapshots.
- Corrections to session times and output values, changes of goal attribution, and deletions of outputs keep their history, with an optional reason, and the history travels in backups (T-102, T-131, T-143); its proposed content is before and after values, device, and time (T-113, T-148). Changes to a session's note, ratings, expected amounts, task association, and block association keep no history; only current values are stored (T-157).
- Finalized review snapshots remain stable after preferences, definitions, schedules, or source records change.

### Goals and metrics

- Goal progress is recomputed from underlying records and is rebuildable; cached totals are disposable.
- A session's time counts toward at most one time goal: one of the task's linked time goals or none, or, without such links, a manually chosen time goal or none (T-047, T-100, T-122, T-129); a task explicitly marked complete, or a completed occurrence of a recurring task, counts toward at most one task-count goal, chosen likewise, and a manual choice adds no task–goal link (T-048, T-108, T-118, T-123, T-130). Outputs may advance several goals that track their definition (T-105, T-124, T-137). Attribution is recorded with the session, completion, or output and is never recalculated from later link changes (T-132). Tasks link to goals only explicitly, never through their project (T-120, T-121). Session completion never completes a task (T-091).
- Output metric values may support multiple goals only through explicit compatible attribution records.
- After Stage 5, pacing uses target, progress, deadline, timezone, owner-chosen goal workdays, and explicit weekly objective. Choosing goal workdays is deferred until after Stage 5 (DECISIONS T-053). Do not union multiple task schedules to invent a goal schedule.

### Identity, versions, and merging (v1 backup; also the basis for later sync)

- Every record has a client-created UUID that is never reused; the same ID on two devices means the same item.
- Every record carries a version vector (device ID → edit counter) and a content hash (T-016). A local edit increments only this device's counter. The content hash only compares versions of the same ID; records with different UUIDs are never merged as duplicates, even with identical content.
- Singletons use a reserved constant ID defined by the backup format (shared preferences: `00000000-0000-4000-8000-000000000001`), so every device refers to the same logical record.
- Preferences are split (D-017): shared preferences (time zone, week start, calendar display, later calculation settings) are one exported record; device settings (language, theme) stay on the device, are never merged, and are never changed automatically by an import (`BACKUP_FORMAT.md`, "Preferences").
- Conflict resolution follows D-015 (`BACKUP_FORMAT.md`, "Showing and resolving conflicts"): both versions are kept until the user decides; linked records keep their ID; "keep both" only for independent types; replaced versions are archived for undo.
- Import never deletes and never replaces existing data automatically: new items are added; identical and older copies are skipped; newer-in-backup items need confirmation; edits on both sides, and deletions on either side, become pending conflicts that keep both versions.
- Importing the same backup again changes nothing and creates no duplicates.
- Only product record types are exported; diagnostic and sync-machinery data (`sync_probe`, outbox, session, cursor) never are, and a backup containing them is refused.
- Each record type declares its links. Resolving a conflict on a **linked** record (project, workstream, task, calendar block, session, goal, …) keeps its ID and chooses one version, so links and history stay attached; "keep both" creates a copy only for **independent** record types (no links in either direction).
- Concurrent edits to one mutable record produce an explicit conflict; no silent last-write-wins.
- History events and finalized snapshots are append-only; corrections add records. The same ID with different content in history is an integrity warning, never merged.
- Tombstones are retained and exported (no expiry in v1) and are not confused with ordinary archive state.
- Relationship rules are checked for imported records too; a backup whose references cannot be resolved is refused.

### Sync and concurrency (after v1; implemented in the frozen Stage 1 server code)

- Client-created UUIDs plus idempotency keys prevent duplicate creation on retry.
- Mutable definitions have server revisions and base revision on update (to be adapted to version vectors).
