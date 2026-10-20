# Personal Productivity System

An offline-first personal planning and reflection app for Windows 11 and Android, with iPhone installability as a design goal and private sync when internet is available.

## Project status

**Stage 0: product and architecture definition.** The documents in `docs/` describe the proposed product, data rules, API, test strategy, and staged delivery. Application code has not started.

## Product decisions so far

- English is the default interface language; Persian is selectable and supports RTL.
- The app is for one person's own devices. It is not a collaboration or multi-user product.
- Daily use must work offline. Devices synchronize through a private service when connected.
- Windows 11 and Android are target platforms. iPhone installation is a desired capability.
- Core scope includes goals, projects, tasks, planning, actual-work logs, habits, weekly review, backup, and data export.

## Stage 0 documents

- [Product specification](docs/PRODUCT_SPEC.md)
- [Architecture proposal](docs/ARCHITECTURE.md)
- [Data model and invariants](docs/DATA_MODEL.md)
- [API and sync contract](docs/API_CONTRACT.md)
- [Testing strategy](docs/TESTING.md)
- [Delivery roadmap](docs/ROADMAP.md)
- [Decisions and open questions](docs/DECISIONS.md)
- [Windows development and recovery notes](docs/DEVELOPMENT.md)

## Next step

Resolve the consequential open decisions in `docs/DECISIONS.md`, then begin Stage 1. Do not treat the architecture proposal as a record of a working implementation.
