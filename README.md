# Personal Productivity System

An offline personal planning and reflection app for Windows 11 and Android, with iPhone installability as a design goal. Version 1 works without internet once installed (installing and updating the app may need internet): each device keeps its own data, and a versioned backup file (merged on import) moves data between devices.

## Project status

**Stage 1B: offline backup — implemented (automated acceptance passed; manual phone checks open).** The app is an installable web app shell (React, IndexedDB, service worker) with shared preferences, device display settings, and a Backup screen: versioned export with optional password, import with preview and atomic merge, conflict resolution, and undo. The repository also contains a tested sync API, authentication, and PostgreSQL migrations from Stage 1; these stay in the repository but are **frozen and inactive in v1** (DECISIONS D-012, D-016). See [docs/ROADMAP.md](docs/ROADMAP.md), [docs/BACKUP_FORMAT.md](docs/BACKUP_FORMAT.md), and the test reports in [docs/TESTING.md](docs/TESTING.md).

**Do not rely on the app for real personal data yet:** product features start in Stage 2, backups have not been checked on real Android/iPhone devices, and no hosting for installing the PWA on phones has been chosen.

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

Close Stage 1B's manual checks (backup export/import between Windows and Android, iPhone feasibility), which need real devices and a hosting origin for the PWA (open question 8). Then Stage 2.
