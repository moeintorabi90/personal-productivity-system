# Product Specification

## Product summary

A private, offline-first personal productivity app that helps one person set goals, organize projects and tasks, plan time, record actual work and measurable outputs, and learn from weekly results. It runs on the user's own devices without internet and synchronizes changes through a private service when connectivity returns.

## Product principles

1. Planning and actual execution are separate records.
2. Historical records are preserved. Changes to today's task definition must not rewrite yesterday's work log or a finalized review.
3. The app remains useful offline; sync is an enhancement to continuity across devices.
4. Every chart and metric has a plain definition and traceable source.
5. A missed plan helps adjust future plans; it must not automatically overload the next day.
6. English is the default language. Persian is fully supported, including RTL.
7. Data belongs to the user and must be exportable and recoverable.

## Intended user and platforms

- One person using their Windows 11 computer and Android phone.
- The app should be installable on iPhone if the chosen cross-platform approach supports the required offline behavior.
- The app is not initially a team product. Account access exists to protect and sync this user's devices, not to add collaboration features.

## Core user journey

1. Capture an idea or task quickly into an inbox.
2. Organize it under a project, optional workstream, or goal.
3. Decide what matters today and schedule flexible work around realistic capacity.
4. Work online or offline; record actual time, completion state, notes, and measurable output.
5. Compare planned work with actual work and review the week.
6. Adjust upcoming plans while keeping past records intact.
7. Sync devices when online and maintain a recoverable backup/export.

## Functional requirements checklist

### Personal setup and preferences

- [ ] First-run setup creates a real account for the owner; no fabricated user or silent identity selection.
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

### Offline use, sync, and recovery

- [ ] Core read/write workflows work without internet after the app is installed and initialized.
- [ ] Offline changes remain queued locally and sync idempotently after reconnection.
- [ ] Devices can recover after being offline for a long period without losing accepted history.
- [ ] Concurrent edits to the same mutable record are detected and surfaced; no silent last-write-wins for consequential conflicts.
- [ ] Historical execution, output corrections, and finalized reviews are append-only or explicitly audited.
- [ ] User can see sync state, unresolved conflicts, last successful sync, and retry failures.
- [ ] User can create and restore a backup and export their data in a documented portable format.

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

## Quality requirements

- Accessible keyboard navigation, focus, contrast, labels, and controls in English LTR and Persian RTL.
- Useful loading, offline, sync, empty, success, and error states.
- Responsive layouts for desktop and phone.
- Server-side validation and ownership enforcement for every synchronized record.
- No secrets in source control. No unverified claims about passing tests or supported platform behavior.
