# Development and Recovery (Windows 11 / PowerShell)

This is a planning document for future implementation. The commands below are intended after Stage 1 creates the application and should be updated to match its final scripts.

## Current workspace status

The workspace now contains Stage 0 documents and a Git checkpoint, but no application code or database. Node.js/npm, Git, and VS Code are available. Docker is not available on PATH. Hardware inspection found about 7.8 GB visible RAM, about 0.8 GB free at the time of inspection, 16.5 GB free on C:, and 72.5 GB free on E:. Avoid installing Docker Desktop unless a later requirement justifies it and resource usage is rechecked.

## Planned first-run workflow

1. Use the installed Node.js/npm and select a database development method that fits this PC. First evaluate a native PostgreSQL install on E: with its service stopped when not needed; Docker Desktop is not the default because available RAM is tight.
2. Open the project folder in VS Code.
3. Copy `.env.example` to a local `.env` and enter only local development settings; never commit `.env`.
4. Start the chosen PostgreSQL development database using the documented local command.
5. Run workspace dependency installation and database migrations.
6. Start the web/API development processes and complete first-run owner setup.

Exact commands will be documented after package scripts and database choice are implemented. PowerShell examples should use `npm.cmd` if execution policy blocks `npm`.

## Recovery principles

- Before upgrades, create a database backup and verify the restore procedure periodically.
- Keep source code in Git with small, understandable commits; keep database backups outside the repository and encrypted.
- Local device data is not a substitute for a backup. Sync replication can copy accidental changes/deletions, so backups need retention and restore points.
- Exported user data must include definitions, history, metric units, timezone context, and a versioned schema manifest.
- If sync is unavailable, continue using local data, show pending-change status, and retry without duplicating events.
- If migration or restore fails, preserve the prior database and logs; do not delete the only working copy.

## Git and backup strategy

- Initialize the repository at the project root and commit documentation/foundation checkpoints by stage.
- Use short-lived feature branches or isolated worktrees for parallel review; only one agent should be the primary writer on a given change set.
- Claude Code is the primary implementation agent; Codex reviews or handles separate, explicitly scoped work. The human owner accepts product decisions and reviews consequential changes.
- Never commit credentials, `.env`, database files, exports, generated build output, or user data.
- Keep local database backup files outside the repo. Use encrypted off-device backups for recovery once a hosting provider is selected.
- No remote repository has been selected; do not push or publish without the owner's decision.
