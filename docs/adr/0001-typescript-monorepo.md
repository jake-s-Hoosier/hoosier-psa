# 0001. TypeScript monorepo with pnpm workspaces

Status: Accepted
Date: 2026-11-19

## Context
The product needs an API, a web app, background workers and shared business rules (money, rounding,
overtime, permissions). The server host already runs Node apps under PM2, and the existing ETL and MCP
tooling is Python and Node. One developer-owner, so cognitive load matters.

## Decision
One repository, one language (TypeScript, strict), pnpm workspaces: `apps/api`, `apps/web`,
`packages/db`, `packages/shared`. Business rules that need no I/O live in `packages/shared` and are
imported by both the API and the web app, so the UI preview and the server computation cannot drift.
Biome handles formatting and linting; Vitest handles tests.

## Consequences
- Contracts (zod schemas) and types are shared with no code generation.
- Billing and payroll logic is unit-testable without a database or a browser.
- Python ETL stays as is; the new system talks to it only through Postgres.
- One toolchain to learn, secure and upgrade.

## Alternatives considered
- **Python (FastAPI) + React.** Matches the ETL, but duplicates types and validation across languages.
- **.NET + React.** Strong QuickBooks tooling, but a new runtime on the server and a second language for the UI.
- **Polyrepo.** Rejected: shared rules and migrations change together with the API.
