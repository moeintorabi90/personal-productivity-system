# Instructions for AI agents

This file is for any AI tool working in this repository (Codex, Claude Code, Gemini, and others). The full rules are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), section "Roles and collaboration".

## Roles

- **Owner (human):** product owner and final decision-maker.
- **Claude Code:** lead engineer and primary writer of main repository changes.
- **Codex:** independent review, or separate, explicitly scoped tasks.
- **ChatGPT:** product definition and requirements help for the owner (outside the repo).
- **Gemini:** occasional second opinion (e.g. UX or Persian localization).

## Rules

1. **One primary writer per change.** If you were asked to review, report findings; do not edit files. If you were given a scoped task, work on your own branch or worktree and touch only that task's files.
2. **Before starting:** run `git status` and read the latest commits. Never overwrite, revert, or reformat another writer's uncommitted work.
3. **The repository is the source of truth.** Follow `docs/` (product spec, architecture, data model, API contract, testing, roadmap). Decisions count only when recorded in `docs/DECISIONS.md`; do not reverse a recorded decision without the owner's approval.
4. **Stay within the current stage** of `docs/ROADMAP.md`. Version 1 is an offline-only installable PWA with manual backup (`docs/BACKUP_FORMAT.md`; decisions D-008 to D-017). The server/sync code (`apps/api`, `apps/web/src/sync`) stays in the repository but is frozen and inactive in v1 (D-016): do not extend it, start a sync service, or choose a hosting provider unless the owner decides so.
5. **Report only tests you actually ran**, with the exact command and the observed result.
6. **No real personal data, no secrets in Git** (`.env`, database files, exports). Do not push or publish without the owner's decision.
7. **Do not install Docker Desktop** or other system software without checking resource needs and asking the owner.

## Workspace facts

- The repo is on an **exFAT** drive: no symlinks, so no npm workspaces (one root `package.json` with path aliases). PGlite data must live on NTFS (default `%LOCALAPPDATA%\PersonalProductivitySystem\pglite-dev`).
- `git` may not be on PATH; Git may report "dubious ownership" on this drive. Pass `-c safe.directory="<repository path>"` per command instead of changing global config.
- In PowerShell use `npm.cmd`.

## Commands

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test          # Vitest: unit, API integration, two-device sync, components
npm.cmd run test:e2e  # build + Playwright in installed Edge
npm.cmd run dev:api   # frozen post-v1 sync API, http://127.0.0.1:8787 (loopback only; HOST needs SETUP_TOKEN)
npm.cmd run dev:web   # web app, http://localhost:5173
```
