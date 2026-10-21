# Personal Productivity System

An offline personal planning and reflection app for Windows 11 and Android, with iPhone installability as a design goal. Version 1 works without internet once installed (installing and updating the app may need internet): each device keeps its own data, and a versioned backup file (merged on import) moves data between devices.

## Project status

**Stage 2: organization and quick capture — implemented on branch `feat/stage-2-organization` (automated acceptance reported as passing; manual device checks open).** It adds a quick-capture inbox, projects, optional workstreams, and task definitions (create, edit, archive, search, filter) and a project detail view with tasks grouped by workstream, all offline and included in backups. Stage 2 has **not been merged into `main` or deployed** yet. Still open: the manual offline and backup-transfer checks on the owner's Windows laptop and Android phone; they have not been done.

**Earlier stages:** Stage 1B (offline backup) is on `main`: an installable web app (React, IndexedDB, service worker) with shared preferences, device display settings, and a Backup screen — versioned export with optional password, import with preview and atomic merge, conflict resolution, and undo. The repository also contains a tested sync API, authentication, and PostgreSQL migrations from Stage 1; these stay in the repository but are **frozen and inactive in v1** (DECISIONS D-012, D-016). See [docs/ROADMAP.md](docs/ROADMAP.md), [docs/BACKUP_FORMAT.md](docs/BACKUP_FORMAT.md), and the test reports in [docs/TESTING.md](docs/TESTING.md).

**Hosting:** the app is hosted on GitHub Pages (DECISIONS D-018) at <https://moeintorabi90.github.io/personal-productivity-system/>, deployed from `main`. The deployed app is the current `main` branch (Stage 1B), not Stage 2. The owner has installed it on a Windows laptop and an Android phone; offline use and backup transfer on those devices are not yet verified.

**Do not rely on the app for real personal data yet:** backups have not been checked between real Windows and Android devices, iPhone has not been tested, and Stage 2 is not yet merged or deployed.

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
- The PWA is hosted on GitHub Pages, built and deployed from `main` by GitHub Actions; only static app files are published.
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

Review Stage 2 (branch `feat/stage-2-organization`) and decide on merging it into `main`, which deploys it to GitHub Pages. Then, on the owner's Windows laptop and Android phone: check offline use, and move data both ways with a backup file (Stage 1B and Stage 2 manual checks). iPhone feasibility remains open. Stage 3 (calendar and planning) follows.
