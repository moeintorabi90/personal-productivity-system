# Delivery Roadmap

Stages are sequential. Each stage ends with its acceptance criteria, focused automated tests, type checks, production build, diff/security review, documentation update, and a recoverable Git checkpoint. Do not move on with unexplained critical failures.

## Stage 0 — Requirements and architecture (current)

**Deliverables:** product checklist, architecture and relationship diagrams, data/API invariants, test strategy, staged acceptance criteria, Git/backup strategy, open decisions.

**Acceptance:** docs agree on offline-first scope, one-owner/multi-device model, planned-versus-actual separation, history preservation, and platform targets; no implementation code generated; consequential decisions are identified. Review docs and establish a recoverable documentation checkpoint.

## Stage 1 — Foundation and offline proof

**Deliverables:** npm-workspace monorepo, installable client shell, local database/outbox, sync API/authentication foundation, PostgreSQL schema/migrations, i18n/theme, offline/sync/error states, Windows setup docs.

**Acceptance:** clean setup; app shell opens offline after installation; local sample record survives restart; authenticated owner can sync an idempotent record between two clients; database can migrate from empty; English/Persian direction and themes work at shell level; platform feasibility documented. Private service hosting choice and security model settled before production-like data is used.

## Stage 2 — Organization and quick capture

**Deliverables:** inbox, projects, workstreams, task definitions, archive/search/filter, project detail.

**Acceptance:** CRUD works offline and syncs; server rejects foreign ownership and mismatched project/workstream links; conflict is recoverable; archived records do not erase history.

## Stage 3 — Calendar and planning

**Deliverables:** day/week/month calendar, block editing, recurrence, quick add, search/filter, capacity cues, Today screen.

**Acceptance:** planned blocks persist offline and sync; recurrence/week boundaries/DST pass tests; rescheduling one occurrence has documented scope; planned items remain separate from actual sessions.

## Stage 4 — Goals and milestones

**Deliverables:** numeric/time/task-count/milestone goals, attribution UI, progress and pacing.

**Acceptance:** goal progress derives from actual records; attribution limits are enforced server-side; pacing honors active days, timezone, deadline, and explicit weekly objective, with assumptions shown.

## Stage 5 — Actual execution and outputs

**Deliverables:** running and backfilled sessions, explicit corrections, output metric definitions and records, planned/actual comparison.

**Acceptance:** all state/chronology rules tested through HTTP handlers and database; unplanned session works; immutable/canonical snapshots survive edits; output correction is auditable; session actions do not mutate planned blocks.

## Stage 6 — Dashboard and analytics

**Deliverables:** documented planned-vs-actual metrics, goal progress, completion, allocation, estimation error, trends.

**Acceptance:** metric dictionary defines source/window/formula; empty/small samples are honest; client and server totals agree on seeded test cases; offline view indicates data freshness.

## Stage 7 — Weekly review and estimation learning

**Deliverables:** review workflow, immutable summary snapshot, observations/next-week adjustments, estimate suggestions.

**Acceptance:** finalized review remains unchanged after later edits; suggestions use actual history and never auto-change estimates; tests cover timezone and period boundaries.

## Stage 8 — Habits, daily core, accessibility, polish

**Deliverables:** user-defined habits and occurrences, completion records, minimum-viable-day support, responsive and accessible UI, localization parity.

**Acceptance:** planned occurrences and completions are separate; no personal routines hard-coded; essential workflows pass on Windows/Android and iPhone support status is documented; RTL/LTR/theme/accessibility checks pass.

## Stage 9 — Final verification and handoff

**Deliverables:** full test/security/migration report, backup/restore rehearsal, deployment and recovery guide, known limitations.

**Acceptance:** complete tests run; critical criteria verified; clean and upgrade migrations exercised; data export/restore verified; no secrets committed; Git tree and documentation recoverable; limitations stated plainly.
