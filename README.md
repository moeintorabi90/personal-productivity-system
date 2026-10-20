# Personal Productivity System

An offline personal planning and reflection app for Windows 11 and Android, with iPhone installability as a design goal. Version 1 works without internet once installed (installing and updating the app may need internet): each device keeps its own data, and a versioned backup file (merged on import) moves data between devices.

## Project status

**Stage 1: foundation and offline proof — implemented; next is Stage 1B (offline backup).** The repository contains an installable web app shell (React, IndexedDB, service worker). It also contains a tested sync API, authentication, and PostgreSQL migrations from Stage 1; these are **frozen and not part of v1** (DECISIONS D-012, T-019). See [docs/ROADMAP.md](docs/ROADMAP.md), the backup design in [docs/BACKUP_FORMAT.md](docs/BACKUP_FORMAT.md), and the test report in [docs/TESTING.md](docs/TESTING.md).

**Do not rely on the app for real personal data yet:** backup export/import is not implemented, and the backup protection and app delivery decisions are still open.

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
- Windows 11 and Android are target platforms. iPhone installation is a desired capability.
- Core scope includes goals, projects, tasks, planning, actual-work logs, habits, weekly review, and backup.

## Documents

- [Product specification](docs/PRODUCT_SPEC.md)
- [Architecture proposal](docs/ARCHITECTURE.md)
- [Data model and invariants](docs/DATA_MODEL.md)
- [Offline backup format, merge, and conflicts](docs/BACKUP_FORMAT.md)
- [API and sync contract (after v1)](docs/API_CONTRACT.md)
- [Testing strategy](docs/TESTING.md)
- [Delivery roadmap](docs/ROADMAP.md)
- [Decisions and open questions](docs/DECISIONS.md)
- [Windows development and recovery notes](docs/DEVELOPMENT.md)

## Next step

Owner decisions in `docs/DECISIONS.md`: backup protection (open question 7), how the app is delivered (8), and keeping or archiving the frozen server code (9); review of the conflict-resolution proposal (T-017). Then Stage 1B: offline backup. Android/iPhone device checks remain open.
