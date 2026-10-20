# Development and Recovery (Windows 11 / PowerShell)

## Workspace facts that shape the setup

- **Drive E: is exFAT.** exFAT supports neither symlinks nor junctions, so npm workspaces cannot be installed here (`EISDIR … symlink`). The repository therefore uses one root `package.json` with path aliases (DECISIONS T-014).
- **PGlite cannot store data on exFAT** (`ErrnoError 28`). Its default data folder is `%LOCALAPPDATA%\PersonalProductivitySystem\pglite-dev` on C: (NTFS), outside the repository.
- **Git is not on PATH** in this environment. A Git 2.53 binary exists inside the Codex runtime (`%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd\git.exe`). Because exFAT does not record file ownership, Git reports "dubious ownership"; pass `-c safe.directory="E:/Moein/My AI Projects/Personal Productivity System"` per command, or add that exception once to your global Git config. Installing Git for Windows is the cleaner long-term fix.
- About 7.8 GB RAM with little free memory: Docker Desktop is not used (DECISIONS T-005). Vitest runs one test file at a time.
- `node_modules` is about 170 MB after `npm install`. No system packages, services, or browsers were installed; end-to-end tests use the installed Microsoft Edge.

## Prerequisites

- Node.js 24.11 or newer (24.20 verified). The API runs TypeScript directly with Node's built-in type stripping.
- npm 11 (bundled). In PowerShell use `npm.cmd` if script execution policy blocks `npm`.
- Microsoft Edge (only for `npm run test:e2e`).

## First run

```powershell
npm.cmd install
Copy-Item apps/api/.env.example apps/api/.env   # optional; defaults work without it
npm.cmd run db:migrate                            # creates/updates the dev database
```

Start the API and the web app in two terminals:

```powershell
npm.cmd run dev:api    # http://localhost:8787 (PGlite; or PostgreSQL if DATABASE_URL is set)
npm.cmd run dev:web    # http://localhost:5173 (proxies /v1 to the API)
```

Open http://localhost:5173, then **Account & sync** to create the owner account. Use test values only: real personal data must wait for the hosting and security decisions (DECISIONS open questions 1–3). Without an account the app works fully on the device; nothing is synced.

To try the installable/offline build: `npm.cmd run build`, then `npm.cmd run preview:web` (http://localhost:4173, service worker active). Stop with Ctrl+C.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev:api` / `start:api` | Sync API with auto-migration (`--watch` in dev) |
| `npm run db:migrate` | Apply pending SQL migrations from `apps/api/migrations` |
| `npm run dev:web` | Vite dev server (no service worker) |
| `npm run build` | Production web build to `apps/web/dist`, including `sw.js` |
| `npm run preview:web` | Serve the production build on port 4173 |
| `npm run typecheck` | TypeScript 7 checks for shared, API, and web |
| `npm test` | Unit, API integration, database, and two-device sync tests (Vitest) |
| `npm run test:e2e` | Build, then Playwright tests in Edge (offline shell, restart persistence, RTL/theme) |
| `npm run icons` | Regenerate PNG icons from the SVG geometry |

## Database options

- **Default (development/tests): PGlite**, PostgreSQL compiled to WASM, in-process. Override the folder with `PGLITE_DATA_DIR` (must be on NTFS).
- **Real PostgreSQL:** set `DATABASE_URL=postgres://…` in `apps/api/.env`. Production (`NODE_ENV=production`) requires `DATABASE_URL` and `SETUP_TOKEN`.
- **Run the API test suite against real PostgreSQL:** set `TEST_DATABASE_URL` to a disposable database; each test file creates and drops its own schema. This has **not yet been run** (no PostgreSQL server is available on this PC); it remains an open Stage 1 acceptance item.
- To reset the development database, stop the API and delete `%LOCALAPPDATA%\PersonalProductivitySystem\pglite-dev`.

## Repository layout

```
apps/api        Express sync API, SQL migrations, integration tests
apps/web        React client: local IndexedDB store, outbox/sync engine, service worker, E2E tests
packages/shared Zod schemas and types shared by client and server
tools/          Node alias hook, icon generator
docs/           Product, architecture, data/API contracts, decisions, testing
```

## Recovery principles

- Before upgrades, create a database backup and verify the restore procedure periodically.
- Keep source code in Git with small, understandable commits; keep database backups outside the repository and encrypted.
- Local device data is not a substitute for a backup. Sync replication can copy accidental changes/deletions, so backups need retention and restore points.
- Exported user data must include definitions, history, metric units, timezone context, and a versioned schema manifest.
- If sync is unavailable, the app keeps using local data, shows pending changes, and retries with backoff; operation IDs prevent duplicates.
- Never edit an applied migration (the runner refuses on checksum mismatch); add a new numbered file.
- If migration or restore fails, preserve the prior database and logs; do not delete the only working copy.

## Git and backup strategy

- Commit by stage with small, understandable checkpoints. The repository-level Git identity is configured in `.git/config`.
- Use short-lived feature branches or isolated worktrees for parallel review.

## Roles and collaboration

| Role | Responsibility |
|---|---|
| Owner (human) | Product owner and final decision-maker. Accepts product decisions and reviews consequential changes. |
| Claude Code | Lead software engineer; primary writer of main repository changes. |
| ChatGPT | Helps the owner with product definition, requirements, and decisions. Its outcomes enter the project only as owner-approved updates to `docs/`. |
| Codex | Independent review, or separate, explicitly scoped tasks. |
| Gemini | Only when needed, for a second opinion (e.g. user experience or Persian localization). |

Rules that prevent conflicts:

- **One primary writer per change.** Each change set has exactly one tool writing files; others review or advise. A separately scoped task for Codex uses its own branch or worktree and touches files no one else is changing.
- **The repository is the source of truth.** Everyone follows this repository's `docs/` and Git history. Advice from any tool counts only once it is recorded here (decisions in `docs/DECISIONS.md`).
- Before starting, check `git status` and the latest commits; do not overwrite or revert another writer's uncommitted work.
- Reviews report findings; the primary writer of that change applies fixes.
- A short summary for AI tools lives in the root `AGENTS.md` (read automatically by Codex); keep it consistent with this section.
- Never commit credentials, `.env`, database files, exports, generated build output, or user data.
- No remote repository has been selected; do not push or publish without the owner's decision.
