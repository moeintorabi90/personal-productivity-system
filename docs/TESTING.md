# Testing Strategy

Testing requirements are part of delivery. A reported result must name the exact command and observed outcome; skipped work includes the concrete reason. This document describes planned tests; no tests have been run because no application code exists yet.

## Test layers

- **Pure unit tests:** date/time conversion, recurrence, week boundaries, goal progress/pacing, metric aggregation, estimation suggestions, state transitions, and validation.
- **Client component tests:** React Testing Library for forms, accessible controls, RTL/LTR behavior, offline/sync indicators, and conflict resolution UI.
- **API integration tests:** real Express handlers with PostgreSQL, including authorization, error responses, transactions, idempotency, and conflicts.
- **Database integrity tests:** migrations from empty database; constraints, history preservation, tombstones, ownership isolation, and correction audit.
- **End-to-end tests:** Playwright workflows for first-run setup, project/task creation, planning, offline logging, reconnect/sync, conflict handling, review finalization, and export/restore.
- **Manual platform checks:** Windows 11 desktop, Android install/offline use, and iPhone install/offline feasibility on supported browsers. Record device/OS/browser versions and limitations.
- **Accessibility/localization checks:** English LTR, Persian RTL, keyboard and screen-reader labeling, theme contrast, and long text/date layouts.

## Minimum acceptance coverage

- Setup, account authentication, preference persistence, and one-owner isolation.
- Project/workstream/task relationship and ownership rejection at HTTP layer.
- Offline-first local edits and idempotent reconnect without duplicate records.
- Concurrent mutable edit conflict surfaced without lost update.
- Timezone, DST, week start, recurrence, Gregorian/Jalali display separation.
- Goal progress and active-day pacing against documented examples.
- Running/finished session invariants, chronology, unplanned execution, correction audit.
- Planned/actual separation, server snapshots, actual output recording.
- Dashboard definitions and calculation consistency.
- Weekly finalized snapshot stability and estimation suggestion behavior.
- Export/restore and migration from clean DB and previous app version.
- Essential responsive workflows and theme/language persistence.

## Release gate

A stage is not complete while a critical acceptance item has an unexplained failure. Do not claim an endpoint works based only on a pure helper test. Keep a small test report in the stage notes with passed, failed, skipped, and not-yet-tested items.
