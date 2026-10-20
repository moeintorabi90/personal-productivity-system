# Testing Strategy

Testing requirements are part of delivery. A reported result must name the exact command and observed outcome; skipped work includes the concrete reason.

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
- `apps/api/test/config.test.ts` (3): default data folder outside the repo; production refuses to start without `SETUP_TOKEN`/`DATABASE_URL`; invalid port.
- `apps/web/src/local/repository.test.ts` (6): device identity; no queueing while signed out; coalescing of edits; create+delete never sent; update→delete keeps base revision; no merging into an in-flight operation.
- `apps/web/src/sync/two-clients.test.ts` (5): two simulated devices (real sync engine + IndexedDB via fake-indexeddb) against the real API and database: offline write stays local; lost push response then retry → exactly one server record; edits and tombstones flow both ways; coalesced offline edits; preference conflict resolved both ways; edit-vs-delete conflict keeps the edit as a new note; revoked session stops sync and keeps local data.
- `apps/web/src/App.test.tsx` (5, jsdom): English LTR default with accessible navigation; Persian switches `dir="rtl"`/`lang="fa"` and persists; theme applied to the document; time zone never imposed and invalid names rejected; offline indicator and local writes while offline.
- `apps/web/e2e/offline.spec.ts` (3, Edge): installed shell reloads and works offline (with a local write); a note survives closing the browser and reopening it **offline** with a persistent profile; Persian RTL layout (navigation starts at the right edge) and dark theme persist after reload.

A defect found by these tests and fixed: the service worker missed cached JS/CSS offline because the server's `Vary: Origin` header made `caches.match` fail for `crossorigin` requests (now `ignoreVary: true`).

Not yet tested (Stage 1):

- **The full suite against a native PostgreSQL server** (`TEST_DATABASE_URL`): no server is available on this PC and Docker is excluded. Only the wire-protocol path against PGlite has run.
- **Android and iPhone** installation and offline use on real devices; PWA install prompt on Windows (headless E2E does not exercise installation UI).
- Screen-reader pass and contrast measurement (semantic labels and focus styles exist; not audited with assistive technology).
- Concurrent pushes from two devices at the same instant on real PostgreSQL (owner row lock is implemented; PGlite serializes transactions, so the race is not exercised).
