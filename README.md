# Personal Productivity System

An offline personal planning and reflection app for Windows 11 and Android, with iPhone installability as a design goal. Version 1 works without internet once installed (installing and updating the app may need internet): each device keeps its own data, and a versioned backup file (merged on import) moves data between devices.

## Project status

**Stage 3: calendar and planning — implemented on branch `feat/stage-3-calendar-planning` (not merged, not deployed; automated acceptance passed; manual device checks open).** It adds Today and Calendar screens (day/week/month, search, filters), weekly recurrence on tasks shown as unscheduled items, explicit planned blocks (schedule, quick add, edit, cancel, restore), a daily capacity with warnings that never change anything, Jalali date entry, and backups with data version 3. Details: [docs/ROADMAP.md](docs/ROADMAP.md) Stage 3 and [docs/TESTING.md](docs/TESTING.md), "Stage 3 test report". Backups made by this version cannot be imported by the Stage 2 app (update every device first).

**Stage 2: organization and quick capture — merged into `main` (automated acceptance passed; owner-reported Windows/Android checks passed on 2026-10-23). The GitHub Pages workflow run for `main` (`644843b`) succeeded, but the live site is currently unavailable (HTTP 404 at the latest check, 2026-10-23; see "Hosting").** It adds a quick-capture inbox, projects, optional workstreams, and task definitions (create, edit, archive, search, filter) and a project detail view with tasks grouped by workstream, all offline and included in backups. The owner reports that on a Windows laptop and an Android phone (device, OS, and browser versions unspecified) the app stays usable offline, project/task work persists after reopening, backup export/import works in both directions without duplicates, and Persian entry/search and the phone layout work. Still open: iPhone, and a conflict from the same project edited independently on both devices. Details: [docs/TESTING.md](docs/TESTING.md), "Owner device checks (2026-10-23)".

**Earlier stages:** Stage 1B (offline backup) is also on `main`: an installable web app (React, IndexedDB, service worker) with shared preferences, device display settings, and a Backup screen — versioned export with optional password, import with preview and atomic merge, conflict resolution, and undo. The repository also contains a tested sync API, authentication, and PostgreSQL migrations from Stage 1; these stay in the repository but are **frozen and inactive in v1** (DECISIONS D-012, D-016). See [docs/ROADMAP.md](docs/ROADMAP.md), [docs/BACKUP_FORMAT.md](docs/BACKUP_FORMAT.md), and the test reports in [docs/TESTING.md](docs/TESTING.md).

**Hosting:** GitHub Pages is the selected host (DECISIONS D-018); app URL <https://moeintorabi90.github.io/personal-productivity-system/>, published from `main` by a GitHub Actions workflow. The workflow run for `main` with Stage 2 (`644843b`) completed successfully on 2026-10-21, but a successful run does not show that the site is served now. **Latest check (2026-10-23, from the development PC):** the app URL, its manifest, and the GitHub Pages API all returned HTTP 404 — the live site is **unavailable**. GitHub Pages may need to be turned on again in the repository settings (Settings → Pages → Source: GitHub Actions) and the workflow re-run.

**Before relying on the app for real personal data:** iPhone has not been tested, and keep exporting backups regularly — local data exists only on each device.

## Quick start (Windows, PowerShell)

```powershell
npm.cmd install
npm.cmd run dev:web   # app on http://localhost:5173 (works without the API)
npm.cmd test          # all automated tests (including the frozen server code)
# optional, frozen post-v1 code: npm.cmd run dev:api  (http://127.0.0.1:8787)
```

Details, database options, and workspace constraints: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Product decisions so far

- English is the default interface language; Persian is selectable and supports RTL.
- The app is for one person's own devices. It is not a collaboration or multi-user product.
- Version 1 works without internet; each device stores its own data.
- Manual backup: export one versioned file; importing merges without replacing, deleting, or duplicating; differing items become visible conflicts the user resolves.
- No sync, data server, accounts, or email recovery in v1; the structure stays ready for sync later.
- Windows 11 and Android are target platforms; iPhone is supported through Safari. v1 is an installable PWA (Edge on Windows, a compatible browser on Android, Safari on iPhone); daily use is offline, while installing and updating need internet.
- Optional password protection for each backup file (off by default); a forgotten password cannot be recovered.
- GitHub Pages is the selected host for the PWA, published from `main` by GitHub Actions; only static app files are published (live-site status: see "Hosting" above).
- Core scope includes goals, projects, tasks, planning, actual-work logs, habits, weekly review, and backup.

## Documents

- [Product specification](docs/PRODUCT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Data model and invariants](docs/DATA_MODEL.md)
- [Offline backup format, merge, and conflicts](docs/BACKUP_FORMAT.md)
- [API and sync contract (after v1)](docs/API_CONTRACT.md)
- [Testing strategy](docs/TESTING.md)
- [Delivery roadmap](docs/ROADMAP.md)
- [Decisions and open questions](docs/DECISIONS.md)
- [Windows development and recovery notes](docs/DEVELOPMENT.md)

## Next step

Independent review of the Stage 3 branch, then the owner's decision to merge it; the owner's Stage 3 checks on the Windows laptop and Android phone. Get the GitHub Pages site served again (it returned HTTP 404 on 2026-10-23) and confirm the app URL loads. Open checks: iPhone feasibility, and a conflict from the same project edited on both devices then merged by backup.
