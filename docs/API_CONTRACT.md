# API and Sync Contract (after v1)

**Not part of version 1** (DECISIONS D-012): v1 has no server, no accounts, and no sync; data moves between devices through backup files (`BACKUP_FORMAT.md`). This contract documents the frozen Stage 1 server code and the direction for a later sync version (T-019).

This began as the Stage 0 outline. The routes listed under "Implemented in Stage 1" exist and have handler-level integration tests; all other route groups are still proposals. All routes require HTTPS and authenticated owner context except explicit first-run account creation/login. Server derives owner identity from the session/token.

## Request conventions

- JSON payloads validated with shared Zod schemas on the server.
- Client-generated UUIDs for offline-created records; `Idempotency-Key` for retryable writes.
- Mutable updates include `baseRevision`; stale revisions return a structured conflict response.
- Instants are ISO-8601 UTC; local date, IANA timezone, and calendar display context are explicit separate fields.
- Errors use stable `code`, user-safe `message`, and optional field errors/conflict details. Internal stack traces never reach clients.

## Implemented in Stage 1

Schemas live in `packages/shared/src`. Errors are `{ "error": { "code", "message", "fieldErrors?", "details?" } }` with codes from `ERROR_CODES`.

| Route | Auth | Notes |
|---|---|---|
| `GET /v1/health` | none | `{ status, database }` |
| `GET /v1/setup/status` | none | `{ setupCompleted }`, used by the first-run screen |
| `POST /v1/setup` | `X-Setup-Token` when configured | Body: email, password (≥ 12), device `{ id, name }`, optional initial preferences. Creates the only owner; second call → `409 SETUP_ALREADY_COMPLETED`. Returns a session. |
| `POST /v1/auth/session` | none | Body: email, password, device. Enrolls (or re-enrolls) the device, returns a session. Wrong email or password → the same `401 INVALID_CREDENTIALS`; repeated failures → `429 RATE_LIMITED`. |
| `DELETE /v1/auth/session` | bearer | Revokes the current session |
| `GET /v1/me` | bearer | Owner and current device |
| `GET /v1/devices`, `POST /v1/devices/:id/revoke` | bearer | List devices; revoking ends all of that device's sessions |
| `GET /v1/preferences` | bearer | Current preferences with `revision` |
| `PATCH /v1/preferences` | bearer | `{ baseRevision, changes }`; stale base → `409 CONFLICT` with `details.current` and `details.submitted` |
| `POST /v1/sync/push` | bearer | `{ operations: [...] }` (1–100), kinds `preferences.update`, `sync_probe.create|update|delete`. Response `{ results }` in input order, each `applied` (with `revision`, `record`, `replayed`), `conflict` (`current`, `submitted`) or `rejected` (`error`). |
| `GET /v1/sync/pull?cursor=&limit=` | bearer | `{ changes, nextCursor, hasMore }`; changes carry `recordType`, `recordId`, `revision`, `deleted`, `data`, `changedAt`, `deviceId` |

When the server listens on loopback (default), every route answers `403 HOST_NOT_ALLOWED` if the `Host` header is not `localhost`, `127.0.0.1`, or `::1` (DECISIONS T-015).

Sessions are opaque bearer tokens (stored server-side only as SHA-256 hashes), bound to a device, valid 365 days unless revoked. `sync_probe` is a Stage 1 diagnostic record type (DECISIONS T-011).

## Initial route groups (proposal)

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

Each operation includes operation UUID, record type/UUID, operation type, base revision if applicable, and payload. The device ID is taken from the authenticated session, not from the payload. The server processes an ordered batch transactionally where dependencies require it. Repeating an accepted operation UUID returns the prior result. A batch can report per-operation validation failures without claiming the failed operations were applied.

For updates to mutable definitions, a base-revision mismatch returns `CONFLICT` with current and submitted field values. User resolves locally and submits against the new revision. Append-only history records are deduplicated by UUID; correction records refer to the original record and never erase it. A server cursor is opaque to clients.

Stage 1 implementation details:

- Each operation runs in its own transaction, after locking the owner row, so one owner's change-log sequence is committed in order and cursors cannot skip changes (DECISIONS T-012).
- Applied results are stored with a hash of the request. Repeating the same opId and content returns the stored result with `replayed: true`; the same opId with different content is rejected with `IDEMPOTENCY_KEY_REUSED`. Conflicts and rejections are not stored, so they are re-evaluated on retry.
- Record IDs are unique per owner. Referring to a record that does not exist for the authenticated owner returns `NOT_FOUND`, whether or not another owner has that ID.
- Deletes keep a tombstone (`deleted_at`) and append a `deleted: true` change; Stage 1 never purges tombstones.
- The client keeps at most one pending operation per record (coalescing offline edits), sends at most one operation per record per batch, and rebases queued operations onto revisions produced by its own applied operations. A pulled change never overwrites a record that has local pending work or an unresolved conflict.

## Server integrity requirements

- Verify every referenced record belongs to the authenticated owner.
- Check same-project workstream/task relation, metric compatibility, goal attribution limits, timestamps, and state transitions.
- Derive owner ID, canonical snapshots, revision numbers, and audit metadata server-side.
- Apply multi-record domain operations transactionally.
- Avoid returning sensitive internals; log structured diagnostics without credentials or private notes unless explicitly needed.
- Every endpoint gets handler-level integration tests; helper-only coverage is insufficient for ownership/security claims.
