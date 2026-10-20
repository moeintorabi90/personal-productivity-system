# Personal Productivity System

An offline-first personal planning and reflection app for Windows 11 and Android, with iPhone installability as a design goal and private sync when internet is available.

## Project status

**Stage 1: foundation and offline proof — implemented, with open acceptance items.** The repository contains an installable web app shell (React, IndexedDB, service worker), a local outbox and sync engine, an Express sync API with owner authentication, and PostgreSQL migrations. Domain features (projects, tasks, calendar, goals…) start in Stage 2. See the Stage 1 test report in [docs/TESTING.md](docs/TESTING.md) and open items in [docs/ROADMAP.md](docs/ROADMAP.md).

**Do not enter real personal data yet:** the private sync hosting, encryption, and recovery decisions are still open.

## Quick start (Windows, PowerShell)

```powershell
npm.cmd install
npm.cmd run dev:api   # terminal 1: sync API on http://127.0.0.1:8787 (this computer only)
npm.cmd run dev:web   # terminal 2: app on http://localhost:5173
npm.cmd test          # unit, API integration, and two-device sync tests
```

Details, database options, and workspace constraints: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Product decisions so far

- English is the default interface language; Persian is selectable and supports RTL.
- The app is for one person's own devices. It is not a collaboration or multi-user product.
- Daily use must work offline. Devices synchronize through a private service when connected.
- Windows 11 and Android are target platforms. iPhone installation is a desired capability.
- Core scope includes goals, projects, tasks, planning, actual-work logs, habits, weekly review, backup, and data export.

## Documents

- [Product specification](docs/PRODUCT_SPEC.md)
- [Architecture proposal](docs/ARCHITECTURE.md)
- [Data model and invariants](docs/DATA_MODEL.md)
- [API and sync contract](docs/API_CONTRACT.md)
- [Testing strategy](docs/TESTING.md)
- [Delivery roadmap](docs/ROADMAP.md)
- [Decisions and open questions](docs/DECISIONS.md)
- [Windows development and recovery notes](docs/DEVELOPMENT.md)

## Next step

Close the open Stage 1 items: run the suite against a real PostgreSQL server, check installation and offline use on Android and iPhone, and decide hosting, encryption, and account recovery (`docs/DECISIONS.md`). Then begin Stage 2.
