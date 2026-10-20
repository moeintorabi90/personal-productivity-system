# Product Specification

## Product summary

A private, offline-first personal productivity app that helps one person set goals, organize projects and tasks, plan time, record actual work and measurable outputs, and learn from weekly results. Once installed, it runs on the user's own devices without internet. Installing it the first time and receiving app updates may need internet, depending on how the app is delivered (DECISIONS open question 8).

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
- [ ] Task definitions support description, type, estimate, next action, recurrence, active weekdays, and relevant output metrics.

### Goals and measures

- [ ] Goals support numeric output, time, task count, and milestone types.
- [ ] A goal may link to a project and have a target, date range, deadline, status, weekly objective, and active-day schedule.
- [ ] Goal progress is derived from actual execution/output records.
- [ ] Pacing considers timezone, deadline, active days, progress to date, and explicit weekly objectives.
- [ ] The UI explains the assumptions behind pacing.
- [ ] Time/task-count contribution links to at most one goal per task/session as specified by the domain rules; output metrics may contribute to multiple goals.

### Planning and calendar

- [ ] Calendar supports day, week, and month views, navigation, search, and filters.
- [ ] User can create, edit, move, resize, and cancel planned blocks.
- [ ] Recurrence is evaluated using local calendar dates in the configured timezone.
- [ ] Planned work and actual work are visually distinct.
- [ ] Capacity warnings use user-configured or evidence-based daily capacity.
- [ ] Today view shows today's plan, actual work, habits/core activities, goal progress, and remaining capacity.
- [ ] A minimum-viable-day option identifies essential activities without forcing every flexible item into the schedule.

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

- [ ] All workflows work without internet after the app is installed; data is stored only on the device. First installation and app updates may require internet (delivery method: open question 8).
- [ ] Local data is tied to the app's origin (scheme, host, and port, not the full URL path). The user is told that a backup is needed before switching to an app served from a different origin, or before clearing browser data.
- [ ] User can export a single backup file containing all data, without internet (share sheet on phones, save/download on Windows).
- [ ] User can import a backup on Windows and Android; the format is designed to work for a future iPhone version.
- [ ] Import merges: new items are added; existing items are never replaced or deleted without the user's explicit choice.
- [ ] Importing the same file again creates no duplicates and changes nothing.
- [ ] Same ID with different content on device and in file: both versions are kept and shown side by side until the user chooses. Every item offers "keep this device's" or "use the backup's" version; items with links (projects, tasks, …) keep their ID so links and history stay attached; "keep both" (a copy) only for independent items without links. (Final UX approval pending, T-017.)
- [ ] Diagnostic data of the frozen sync code (`sync_probe`) is not part of backups.
- [ ] Unresolved conflicts survive restarts and can be resolved later; a wrong choice can be undone.
- [ ] Backup files are versioned; newer app versions import older backups; an older app refuses a newer file clearly without changing data.
- [ ] Corrupted or incomplete files are detected and refused without changing data.
- [ ] The app shows when the last backup was made.
- [ ] Backup protection (password/encryption) follows the owner's decision (DECISIONS open question 7); if a password is used, the user is warned before export that a forgotten password cannot be recovered.
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
