# Architecture decision records

Short records of significant decisions: the context, what we chose, and the consequences. They are
append-only history: to change a decision, add a new ADR that supersedes the old one and update the old one's status.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-typescript-monorepo.md) | TypeScript monorepo with pnpm workspaces | Accepted |
| [0002](0002-dedicated-database.md) | Dedicated application database, separate from the CW mirror | Accepted |
| [0003](0003-preserve-cw-ids.md) | Preserve ConnectWise identifiers on import | Accepted |
| [0004](0004-sql-first-data-access.md) | SQL-first data access without an ORM | Accepted |
| [0005](0005-entra-sso.md) | Staff authentication with Microsoft Entra ID | Superseded by 0010 |
| [0006](0006-money-and-rounding.md) | Money representation and rounding | Accepted |
| [0007](0007-payment-provider-abstraction.md) | Payment provider abstraction and tokenisation | Accepted |
| [0008](0008-quickbooks-desktop-web-connector.md) | QuickBooks Desktop integration via Web Connector | Proposed (pending spike) |
| [0009](0009-environment-markers-and-write-guards.md) | Environment markers and write guards | Accepted |
| [0010](0010-local-authentication.md) | Staff authentication with local passwords and TOTP | Accepted |

## Template

```
# NNNN. Title
Status: Proposed | Accepted | Superseded by NNNN
Date: YYYY-MM-DD

## Context
## Decision
## Consequences
## Alternatives considered
```
