# Product Specification

## Product summary

A private, offline-first personal productivity app that helps one person set goals, organize projects and tasks, plan time, record actual work and measurable outputs, and learn from weekly results. Version 1 is an installable web app (PWA): installed from Microsoft Edge on Windows, from a compatible browser on Android, and from Safari on iPhone (DECISIONS D-013). Once installed, it runs on the user's own devices without internet. Installing it the first time and receiving app updates need internet.

**Version 1** keeps each device's data locally and moves or restores data through a manual backup file that is merged on import (DECISIONS D-008 to D-012, `BACKUP_FORMAT.md`). Automatic sync through a private service is a possible later version.

## Product principles

1. Planning and actual execution are separate records.
2. Historical records are preserved. Changes to today's task definition must not rewrite yesterday's work log or a finalized review.
3. The app is fully useful offline after installation. In v1 user data never needs the internet; only installing and updating the app itself may. Any later sync is an enhancement, never a requirement.
4. Every chart and metric has a plain definition and traceable source.
5. A missed plan helps adjust future plans; it must not automatically overload the next day.
6. English is the default language. Persian is fully supported, including RTL.
7. Data belongs to the user and must be exportable and recoverable. Importing data never silently replaces or deletes existing data.

## Intended user and platforms

- One person using their Windows 11 computer and Android phone.
- The app should be installable on iPhone if the chosen cross-platform approach supports the required offline behavior.
- The app is not a team product. Version 1 has no accounts: each device holds its data locally, and the user moves data between devices with backup files.

## Core user journey

1. Capture an idea or task quickly into an inbox.
2. Organize it under a project, optional workstream, or goal.
3. Decide what matters today and schedule flexible work around realistic capacity.
4. Work without internet; record actual time, completion state, notes, and measurable output.
5. Compare planned work with actual work and review the week.
6. Adjust upcoming plans while keeping past records intact.
7. Export a backup regularly; import it on another device (or the same one after a reset) to merge data.

## Functional requirements checklist

### Personal setup and preferences

- [ ] First run needs no account (v1); the device gets a local identity (device ID and a user-editable device name) used only to label backups and versions.
- [ ] English default; selectable Persian with complete translations and RTL layout.
- [ ] Light, dark, and system theme preference.
- [ ] Explicit timezone, configurable week start, and calendar display preference.
- [ ] Gregorian and Jalali date display are supported; language selection does not silently change date calculations.
- [ ] Browser timezone may be suggested but is not silently imposed.

### Capture and organization

- [ ] Quick-capture inbox for unsorted tasks and ideas.
- [ ] Flat hierarchy: Project → optional Workstream → Task. Tasks may belong directly to a project.
- [ ] Projects, workstreams, and task definitions can be created, edited, archived, searched, and filtered.
- [ ] Workstreams belong to one project; tasks' project and workstream must agree.
- [ ] Project detail shows its workstreams and grouped tasks, including direct-to-project tasks.
- [ ] Task definitions support a title, descriptive notes, an estimate (whole minutes), a next action, and archiving; they belong to a project and optionally a workstream, or to the inbox (no project). Implemented in Stage 2; the `notes` field is the task's description (owner decision, 2026-10-21; DECISIONS T-024).
- [ ] Deferred task-definition fields: **recurrence and active weekdays** — implemented in Stage 3 (contract below, "Stage 3 planning contract"); **relevant output metrics** in Stage 5 (actual execution and outputs); a task **type**, only once the owner defines a clear use case and meaningful categories (DECISIONS T-024).

### Goals and measures

- [ ] Goals support numeric output, time, and task-count targets, and may contain milestones (T-040).
- [ ] Numeric output goals use a custom unit label entered by the owner (T-050).
- [ ] Numeric output goal targets are whole numbers in the initial release; decimal targets are deferred to a later, fuller version (T-051).
- [ ] A goal may optionally link to a project (T-041) and has a date range whose start date defaults to today but can be changed to the past or future (T-042), one overall target (T-052), optional deadline (T-039), and status. Weekly objectives and choosing goal workdays are deferred until after Stage 5 (T-052, T-053).
- [ ] The owner manually marks a goal complete; reaching its target does not automatically change its status (T-043).
- [ ] The owner can pause a goal and resume it later without completing or deleting it (T-044).
- [ ] Pausing or resuming a goal does not change its start date or deadline (T-045).
- [ ] Actual work or output explicitly attributed to a paused goal still counts toward its progress (T-046).
- [ ] Goal progress is derived from actual execution/output records.
- [ ] After Stage 5, pacing considers timezone, deadline, chosen goal workdays, progress to date, and explicit weekly objectives. Neither weekly objectives nor chosen goal workdays are part of the initial goal setup (T-052, T-053).
- [ ] The UI explains the assumptions behind pacing.
- [ ] The duration of one work session may contribute to at most one goal (T-047).
- [ ] One completed task may count toward at most one task-count goal (T-048).
- [ ] An output record may contribute to multiple goals only when the owner explicitly attributes it to each one (T-049).

**Delivery sequence (owner-approved 2026-10-25; DECISIONS T-037):** define and build goals and milestones in Stage 4 first. Calculated progress and pacing that depend on actual execution/output records are delivered after Stage 5 introduces those records. Do not display fabricated progress before then. Exact goal and milestone behavior remains to be specified with the owner before implementation.

**Milestone completion (owner-approved 2026-10-25; DECISIONS T-038):** the owner manually marks a milestone complete. The app does not infer milestone completion from work sessions or output records.

**Milestone relationship (owner-approved 2026-10-25; DECISIONS T-040):** each milestone belongs to a parent goal and cannot exist on its own.

### Planning and calendar

- [ ] Calendar supports day, week, and month views, navigation, search, and filters. (Stage 3)
- [ ] User can create, edit, move, resize, cancel, and restore planned blocks. (Stage 3)
- [ ] A recurring task appears as an unscheduled item on each selected active weekday; it is never given a time automatically and never moves other planned work (D-019). (Stage 3)
- [ ] Recurrence is evaluated using local calendar dates in the configured timezone. (Stage 3)
- [ ] Gregorian display by default, Jalali selectable; Saturday week start by default, configurable; calculations use the explicitly configured time zone; changing the language never changes the calendar or calculations (D-020). (Stage 3)
- [ ] Planned work and actual work are visually distinct. (Planned blocks in Stage 3; actual work arrives in Stage 5.)
- [ ] Capacity warnings use user-configured daily capacity and never reschedule, change, or delete planned blocks (D-021). (Stage 3; evidence-based capacity suggestions belong to estimation learning, Stage 7.)
- [ ] Today view shows today's plan, actual work, habits/core activities, goal progress, and remaining capacity. (Stage 3: plan, unscheduled items, and capacity; the other parts arrive with their stages.)
- [ ] A minimum-viable-day option identifies essential activities without forcing every flexible item into the schedule. (Stage 8)

### Stage 3 planning contract (approved by the owner: D-019 to D-023, T-029 to T-036)

Status: **specified and approved; implemented on branch `feat/stage-3-calendar-planning` (2026-10-24), not yet merged or deployed.** Implementation choices that refine presentation details are listed under "Implementation notes (Stage 3)" at the end of this section. The behavior below is owner-approved: D-019 to D-023 and T-029 to T-036 (2026-10-24); the rest follows from those and earlier recorded decisions (T-025 to T-028, adopted as derived). Storage encodings in DATA_MODEL are technical choices serving this behavior. Data shapes: DATA_MODEL "Stage 3 record types and fields".

**Time zone, dates, and display (D-020, T-028)**

- All calendar calculations — "today", the days of a view, week ranges, recurrence dates, and capacity per day — use the shared time zone set in Settings. Language (English/Persian) changes only labels and direction, never the calendar display, the week start, or any calculation.
- While no time zone is set, calendar views, Today, and scheduling show a prompt to set one; the device's zone may be offered as a one-tap suggestion but is never applied silently; no planning data is written until a zone is set.
- Display calendar: Gregorian (default), Jalali, or Both. Stored dates are always ISO Gregorian (`YYYY-MM-DD`) and instants are UTC; the display calendar never changes stored data or calculations.
- Week start: Saturday by default, configurable (Settings). The week view always starts on it. Month boundaries follow the display calendar: Gregorian months for Gregorian, Jalali months for Jalali, Gregorian months with Jalali day labels for Both (T-035).
- A planned block represents a **fixed instant** (D-022). Changing the configured zone never edits a block's stored instants or its occurrence link (`occurrenceDate`); blocks are always displayed in the currently configured zone, so an existing block's displayed local time or calendar date may change. A block made for a recurring occurrence keeps scheduling that occurrence even when it is now displayed on another local date; no duplicate unscheduled item appears for it.
- Settings explains, next to the time-zone setting, that changing the time zone may change the displayed time or date of existing planned blocks (D-022).
- Each block also keeps the time zone it was planned in and its local date there (T-030). Entering a wall time that does not exist (daylight-saving gap) is refused with a message, never shifted; an ambiguous wall time (clocks going back) uses the earlier instant and shows its offset (T-030).

**Recurring tasks and unscheduled items (D-019, T-026)**

- A task definition may have a weekly recurrence (T-029): the selected active weekdays (1–7); a required start date, defaulting to the current local date when recurrence is enabled; and an optional inclusive end date. No every-N-weeks, monthly, or yearly patterns in Stage 3. Turning recurrence off removes the field; no blocks change.
- For a local date D, a recurring task has an **unscheduled item** on D when: the task exists on this device and is not archived; D is within its start and end dates; D's weekday is selected; and no planned (not cancelled) block exists for that task with occurrence date D. Items are computed when shown, not stored.
- An occurrence is **scheduled while at least one** of its blocks (same task, occurrence date D) is planned, wherever those blocks are displayed (D-022, D-023). Cancelling one of several blocks leaves the occurrence scheduled while another planned block remains; cancelling the last planned block makes it unscheduled again; restoring any of its blocks makes it scheduled again.
- The app never gives an unscheduled item a time, never creates a block on its own, and never moves or shortens other blocks to make room (D-019).
- An unscheduled item of a past date stays on that date; it is never carried forward to today or later (principle 5). There is no skip/dismiss action in Stage 3 (T-034).
- Editing a task's recurrence, title, project, or archive state never changes existing blocks; it changes only which unscheduled items are computed.

**Scheduling into explicit planned blocks (T-027)**

- "Schedule" on an unscheduled item opens a form with the occurrence date pre-filled and, if the task has an estimate, the duration pre-filled; the user must enter the start time (T-033). The user may change the date, so the block may lie on a different date from the occurrence; it still schedules that occurrence. One occurrence may have several blocks (D-023). Saving creates a block linked to the task with that occurrence date; the item then shows as scheduled.
- A block may also be created for any task (recurring or not) from the calendar or the task, and by **quick add** from a title, which creates an inbox task and its block in one transaction; the user may instead select an existing task (T-032).
- Blocks can be edited: date, start, end/duration ("move" and "resize"), done by forms that work with keyboard and screen readers; drag-and-drop is optional and never the only way.
- Blocks are **cancelled, not deleted**, and can be restored. A cancelled block does not count toward capacity. Cancelling a block makes its occurrence unscheduled only when no other planned block for that occurrence remains (D-023).
- Overlapping blocks are allowed and shown side by side with an overlap marker; the app never moves either block.
- A block's end is after its start and at most 24 hours later; a block that crosses midnight appears on both days (clipped per day).
- Blocks are plans only: there is no "done" state or actual time in Stage 3 (actual execution is Stage 5). Past blocks remain as planned.

**Calendar views, search, and filters**

- Day view: the date's blocks in time order, its unscheduled items, and its capacity summary.
- Week view: seven days from the configured week start containing the focus date; per day the blocks, unscheduled items, and a capacity indicator.
- Month view: one cell per date with counts of blocks and unscheduled items and an over-capacity marker (month boundaries: T-035).
- Navigation: previous / next / today, and go to a date (date entry follows the display calendar).
- Search: by task title (current and snapshot); filters by project (including the inbox), workstream, "show cancelled", and "only unscheduled items". Search and filters apply to the range shown.
- Block labels show the task's current title; the block's snapshot (taken at creation, refreshed only when the block itself is edited) is used when the task is not on this device and for historical context (T-036).

**Today screen (Stage 3 part)**

- Today's date in the display calendar (configured zone); today's blocks; today's unscheduled items with "Schedule"; today's capacity summary. Actual work, habits, and goal progress are added by their stages.

**Capacity (D-021)**

- Daily capacity is set in Settings: one shared value in whole minutes (1–1,440) that applies equally to every day, unset by default (T-031). No per-weekday capacity or days-off settings in Stage 3.
- For each local date: planned minutes = durations of planned (not cancelled) blocks within that date. If planned minutes exceed capacity, a **warning** shows the planned time, the capacity, and the excess. If not, but planned minutes plus the estimates of that date's unscheduled items exceed capacity, a softer **notice** says the remaining items may not fit (items without estimates are not counted and are identified as having no estimate) (T-031).
- Warnings and notices only inform: saving a block that exceeds capacity is allowed after the warning, and no block is ever changed, moved, cancelled, or deleted because of capacity.
- Without a set capacity, no warning or notice is shown.

**Backup and merge**

- Calendar blocks, task recurrence, and daily capacity are included in backups (`dataSchemaVersion` 3, BACKUP_FORMAT). Import never creates, moves, or cancels a block by itself beyond the usual rules (new blocks are added; changed or deleted ones need the user's choice). A conflict on a block offers "keep this device's" or "use the backup's" version (blocks are linked records). Existing data and older backup files remain importable.

**Acceptance criteria (Stage 3)** — see ROADMAP Stage 3 and TESTING "Stage 3 acceptance tests".

**Implementation notes (Stage 3)** — presentation choices where the contract left details open; none changes an approved decision:

- Navigation gains **Today** and **Calendar**. The calendar opens in the week view on today's week; day, week, and month are chosen from a "View" list. Opening a date in the month view shows that day.
- Day and week views are lists per date (blocks in time order, then unscheduled items, with "Schedule"), not a time grid. Overlapping planned blocks are grouped **side by side** in one row, each marked "Overlaps"; on a narrow phone screen the row wraps. A block that crosses midnight is listed on both dates and says it continues from / into the other day; a block placed on another date than its occurrence names the occurrence date.
- Planned blocks have a dashed edge (plans, not actual work); cancelled blocks are hidden unless "Show cancelled blocks" is on, and are shown struck through.
- The block form is shared by "Add a planned block" (calendar day: pick an existing task or type a new title for quick add), "Plan" on a task row (date pre-filled with today), "Schedule" on an unscheduled item (occurrence date and estimate pre-filled), and "Edit". The start time is never pre-filled for a new block; editing shows the block's current time. Duration is entered in whole minutes (1–1,440). A daylight-saving gap is shown as an error and disables saving; an ambiguous time shows the offset that will be used; the capacity warning for the affected date(s) appears in the form before saving.
- Date entry follows the display calendar: the browser's date field for Gregorian, the same field with the Jalali date shown below it for "Both", and year/month/day fields in Jalali for Jalali.
- In the month view on a phone, each date shows compact marks (planned-block count, unscheduled count, "!" when over capacity); the full text is in the date button's accessible label.
- Today invites setting a daily capacity when none is set; Settings has the capacity field (empty = not set) and, next to the time zone, the note that a zone change may change displayed block times or dates.
- Without a configured zone, Today and Calendar show only the prompt (with the device-zone suggestion button); the recurrence checkbox in the task editor is disabled with a hint.

### Actual work and outputs

- [ ] User can start/finish a running session or record a past session, whether planned or unplanned.
- [ ] A session references a task definition and optionally a planned block.
- [ ] Finished sessions require end time and completed/partial/cancelled state; running sessions have no end time/final state.
- [ ] End time cannot precede start time.
- [ ] Session stores actual timestamps, optional energy/distraction context and notes, plus historical task/project/workstream snapshots.
- [ ] Editing actual timestamps is explicit and audited; finished sessions are not silently reopened.
- [ ] Measured outputs are recorded against a session and metric definition. Planned output is never assumed achieved.
- [ ] Editing a session never implicitly creates or changes a planned block.

### Offline use, backup, and recovery (v1)

- [ ] The app installs as a PWA from Edge (Windows), a compatible browser (Android), and Safari (iPhone, Add to Home Screen), with short install instructions where the platform shows no prompt (D-013).
- [ ] All workflows work without internet after the app is installed; data is stored only on the device. First installation and app updates require internet. Platform limits on installation, updates, and storage are explained to the user where they matter (e.g. iPhone: use only the Home Screen app; data can be lost if site data is cleared).
- [ ] Local data is tied to the app's origin (scheme, host, and port, not the full URL path). The user is told that a backup is needed before switching to an app served from a different origin, or before clearing browser data.
- [ ] User can export a single backup file containing all data, without internet (share sheet on phones, save/download on Windows).
- [ ] User can import a backup on Windows and Android; the format is designed to work for a future iPhone version.
- [ ] Import merges: new items are added; existing items are never replaced or deleted without the user's explicit choice.
- [ ] Importing the same file again creates no duplicates and changes nothing.
- [ ] Same ID with different content on device and in file: both versions are kept and shown side by side until the user chooses. Every item offers "keep this device's" or "use the backup's" version; items with links (projects, tasks, …) keep their ID so links and history stay attached; "keep both" (a copy) only for independent items without links. Deletions have their own choices; bulk actions need a confirmation stating the number of items (D-015).
- [ ] Diagnostic data of the frozen sync code (`sync_probe`) is not part of backups.
- [ ] Unresolved conflicts survive restarts and can be resolved later; a wrong choice can be undone.
- [ ] Backup files are versioned; newer app versions import older backups; an older app refuses a newer file clearly without changing data.
- [ ] Corrupted or incomplete files are detected and refused without changing data.
- [ ] The app shows when the last backup was made.
- [ ] Each export offers an optional password (clearly visible, off by default). If enabled: the password is entered twice; the user is warned that forgetting it makes that file impossible to restore; the app recommends a password manager (D-014). No recovery key in v1.
- [ ] Shared preferences (time zone, week start, calendar display) travel in backups; language and theme stay per device and never change automatically on import; the import preview may offer to apply the source device's display settings (D-017).
- [ ] Historical execution, output corrections, and finalized reviews are append-only or explicitly audited, also across imports.

### Reviews and useful analytics

- [ ] Weekly review compares planned and actual time/output, goal pace, completion, unplanned work, estimates, and allocation.
- [ ] Finalized review saves a stable computed snapshot with source/window metadata.
- [ ] Estimation learning offers suggestions; it never silently changes estimates or past records.
- [ ] Dashboard shows only actionable metrics, documents their definitions and time windows, and is candid about missing/small samples.

## Non-goals for the initial product

- Team collaboration, shared workspaces, public profiles, social feeds, or role management.
- Mandatory AI features, external calendar integration, email ingestion, or third-party automation.
- Arbitrary-depth task trees, general workflow engines, streak pressure, points, or meaningless quality scores.
- Requiring internet for ordinary planning, logging, searching, or reviewing locally available data.
- **In v1:** automatic sync, any server that stores user data, user accounts, and email or password-reset recovery (DECISIONS D-012). The data structure stays ready for sync later.

## Quality requirements

- Accessible keyboard navigation, focus, contrast, labels, and controls in English LTR and Persian RTL.
- Useful loading, empty, success, error, backup, import-preview, and conflict states.
- Responsive layouts for desktop and phone.
- The same validation rules apply to data entered in the app and to data in imported backups.
- No secrets in source control. No unverified claims about passing tests or supported platform behavior.
