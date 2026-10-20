# API and Sync Contract (Proposal)

This is a Stage 0 contract outline, not an implemented API. All routes require HTTPS and authenticated owner context except explicit first-run account creation/login. Server derives owner identity from the session/token.

## Request conventions

- JSON payloads validated with shared Zod schemas on the server.
- Client-generated UUIDs for offline-created records; `Idempotency-Key` for retryable writes.
- Mutable updates include `baseRevision`; stale revisions return a structured conflict response.
- Instants are ISO-8601 UTC; local date, IANA timezone, and calendar display context are explicit separate fields.
- Errors use stable `code`, user-safe `message`, and optional field errors/conflict details. Internal stack traces never reach clients.

## Initial route groups

- `POST /v1/setup` — create the owner's account and initial preferences exactly once.
- `POST /v1/auth/session`, `DELETE /v1/auth/session`, `GET /v1/me` — sign-in/session and owner profile.
- `GET|PATCH /v1/preferences` — validated preference changes, retaining history-sensitive context.
- `GET|POST /v1/projects`, `GET|PATCH|DELETE /v1/projects/:id` — project management; delete defaults to archive where history exists.
- `GET|POST /v1/workstreams`, `GET|PATCH|DELETE /v1/workstreams/:id` — validate project ownership.
- `GET|POST /v1/task-definitions`, `GET|PATCH|DELETE /v1/task-definitions/:id` — task definitions and recurrence.
- `GET|POST /v1/goals`, `GET|PATCH /v1/goals/:id`, `GET /v1/goals/:id/progress` — goals and authoritative progress/pacing.
- `GET|POST /v1/calendar-blocks`, `GET|PATCH|DELETE /v1/calendar-blocks/:id` — planned occurrences only.
- `GET|POST /v1/execution-sessions`, `GET|PATCH /v1/execution-sessions/:id`, `POST /v1/execution-sessions/:id/corrections` — actual work and explicit corrections.
- `POST /v1/execution-sessions/:id/outputs`, `POST /v1/output-records/:id/corrections` — actual measured outputs and audit.
- `GET|POST /v1/habits`, `/v1/habit-occurrences`, `/v1/habit-completions` — definitions, planned occurrences, and completion events.
- `GET /v1/analytics/summary?from=&to=` — documented aggregation for a selected local period.
- `GET|POST /v1/weekly-reviews`, `POST /v1/weekly-reviews/:id/finalize` — draft and immutable finalized snapshot.
- `POST /v1/sync/push` — submit ordered outbox operations; response includes accepted revisions and conflicts.
- `GET /v1/sync/pull?cursor=` — return changes/tombstones after a cursor and next cursor.
- `POST /v1/backups/exports`, `POST /v1/backups/imports` — authenticated export/restore flow with validation and preview.

## Sync push semantics

Each operation includes operation UUID, device ID, record type/UUID, operation type, base revision if applicable, and payload. The server processes an ordered batch transactionally where dependencies require it. Repeating an accepted operation UUID returns the prior result. A batch can report per-operation validation failures without claiming the failed operations were applied.

For updates to mutable definitions, a base-revision mismatch returns `CONFLICT` with current and submitted field values. User resolves locally and submits against the new revision. Append-only history records are deduplicated by UUID; correction records refer to the original record and never erase it. A server cursor is opaque to clients.

## Server integrity requirements

- Verify every referenced record belongs to the authenticated owner.
- Check same-project workstream/task relation, metric compatibility, goal attribution limits, timestamps, and state transitions.
- Derive owner ID, canonical snapshots, revision numbers, and audit metadata server-side.
- Apply multi-record domain operations transactionally.
- Avoid returning sensitive internals; log structured diagnostics without credentials or private notes unless explicitly needed.
- Every endpoint gets handler-level integration tests; helper-only coverage is insufficient for ownership/security claims.
