# Decisions and Open Questions

## Agreed product decisions

| ID | Decision | Status |
|---|---|---|
| D-001 | English is the default interface; Persian is selectable with full RTL support. | Agreed |
| D-002 | Windows 11 and Android are the primary devices; iPhone installation is desired if feasible. | Agreed |
| D-003 | Ordinary app workflows must work offline; internet is used to synchronize devices. | Agreed |
| D-004 | Start with a private sync service. | Agreed in principle; provider/hosting/security details open |
| D-005 | Initial product is for one person's own devices, without collaboration features. | Agreed |
| D-006 | Include quick capture, realistic prioritization/capacity, plan-vs-actual, weekly review, backup/export. | Agreed |
| D-007 | AI features are optional future additions; core product must not depend on AI connectivity. | Recommended and accepted as product direction |

## Proposed technical decisions

| ID | Proposal | Reason | Status |
|---|---|---|---|
| T-001 | Evaluate an installable PWA as the first client approach. | One codebase may serve desktop and phones; validate offline/install behavior on iOS before commitment. | Proposed; requires platform proof |
| T-002 | Keep an IndexedDB local store and sync through an authenticated TypeScript API to PostgreSQL. | Supports offline work with clear server validation and recoverable cross-device sync. | Proposed |
| T-003 | Detect concurrent edits using revisions and ask the user to resolve conflicts. | Prevents silent loss of changes while staying simpler than general CRDT replication. | Proposed |
| T-004 | Use managed private hosting for the sync API/database initially, with export/restore and reliable backups. | Less maintenance for a non-specialist owner. | Recommended; provider/cost/region open |

## Consequential open decisions

These should be settled before the architecture is treated as final and before Stage 1 creates an account or stores real personal data.

1. **Sync hosting and jurisdiction:** managed service provider, expected monthly budget, and preferred data region. Recommendation: managed service with a private owner account, transparent backup/restore, and no public sharing.
2. **Encryption model:** standard HTTPS plus provider encryption-at-rest, or end-to-end encryption. Recommendation for the first release: HTTPS, strong authentication, encrypted provider storage/backups, and user export; investigate end-to-end encryption if the data sensitivity requires it because it complicates password recovery and server-side analytics.
3. **Account recovery:** email/password, passkey, or another recovery method. Recommendation: standard low-friction owner sign-in with a tested recovery flow; no account sharing.
4. **iPhone support bar:** installable and foreground offline use may be sufficient, or must background-sync/notify like a native app. Recommendation: require installability and foreground offline use first; decide on background behavior after device validation.
5. **Default calendar preferences:** initial proposal is English + Gregorian display, selectable Jalali/Both, Saturday week start as a configurable default suited to the user's locale, and explicit timezone selection. User may choose different defaults during first-run setup.
6. **Capacity and prioritization defaults:** choose default daily capacity and whether essential/important/flexible labels are enough for the first release. Recommendation: user-configurable capacity with simple Must / Should / Could labels and no automatic overload.

## Environment findings (2026-10-20)

- Workspace folder was empty and not a Git repository.
- Git 2.53.0, Node.js 24.20.0, npm 11.19.0, and VS Code are available.
- Docker is not currently available on PATH. The proposed local PostgreSQL development flow may need Docker Desktop installation or a documented alternative before Stage 1.
- No Git author name/email is configured in this workspace. The Stage 0 documentation checkpoint used a one-time, non-personal author label (`Stage 0 Documentation <stage0@localhost>`); configure the owner's preferred Git identity before the next commit.
