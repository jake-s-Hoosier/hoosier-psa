# Hoosier PSA

A professional services automation platform for Hoosier Security: CRM, service tickets, projects,
dispatch, detailed time capture, agreements, recurring-revenue (RMR) billing, invoicing and
accounting integration. It is built to replace ConnectWise Manage without copying it, and without
losing any capability Hoosier Security relies on today.

> **Status: milestone 0 (foundation).** The repository, database schema, shared business rules, API
> skeleton, web shell, CI and documentation are in place. Feature work follows
> [docs/07-roadmap.md](docs/07-roadmap.md).

## Documentation

| # | Document | What it answers |
|---|----------|-----------------|
| 00 | [Vision and scope](docs/00-vision-and-scope.md) | What are we building, for whom, and what is out of scope? |
| 01 | [ConnectWise parity matrix](docs/01-cw-parity-matrix.md) | Which CW capabilities must exist, where they land, and how much each is used today |
| 02 | [Architecture](docs/02-architecture.md) | Components, deployment on HSIN-UT01, API and module conventions |
| 03 | [Domain model](docs/03-domain-model.md) | Schemas, entities, relationships, conventions |
| 04 | [Time capture and payroll](docs/04-time-and-payroll.md) | Time entry lifecycle, rounding, pay periods, overtime |
| 05 | [Billing and agreements](docs/05-billing-and-agreements.md) | Agreements, RMR billing runs, invoicing, fixed-fee work |
| 06 | [Accounting integrations](docs/06-accounting-integrations.md) | QuickBooks Desktop now; QuickBooks Online and Stripe later |
| 07 | [Roadmap](docs/07-roadmap.md) | Milestones, sequencing and exit criteria |
| 08 | [Security](docs/08-security.md) | Authentication, authorization, audit, secrets, PCI scope |
| 09 | [Design system](docs/09-design-system.md) | Visual language and UI conventions |
| 10 | [Payments and autopay](docs/10-payments-and-autopay.md) | Provider abstraction for Stripe, WisePay and Global Payments |
| 11 | [CW migration and cutover](docs/11-cw-migration.md) | Import strategy, parallel run, reconciliation, go-live |
| | [Architecture decision records](docs/adr/) | Why each significant choice was made |

## Repository layout

```
apps/
  api/            Fastify HTTP API (TypeScript)
  web/            React + Vite single-page app
packages/
  db/             SQL migrations, migration runner, pool helpers, schema tests
  shared/         Business rules and contracts shared by api and web (money, time, permissions, zod schemas)
docs/             Specifications and architecture decision records
```

## Getting started

Requirements: Node 22+, pnpm 10+, PostgreSQL 16+.

```bash
pnpm install
cp .env.example .env            # then edit DATABASE_URL
createdb hoosier_psa_dev        # never cw_datawarehouse: the tools refuse it
APP_ENV=development pnpm db:migrate   # applies migrations and stamps the environment marker
DB_WRITE_MODE=read_write pnpm dev:api # http://127.0.0.1:4000 (omit DB_WRITE_MODE for read-only)
pnpm dev:web                    # http://127.0.0.1:5173
```

Staff sign in with a password plus an authenticator code (`AUTH_MODE=session`, needs `AUTH_SECRET`; see
[ADR 0010](docs/adr/0010-local-authentication.md)). Create a login with `pnpm auth set-password <identifier>`
(prints a one-time temporary password; first sign-in forces a new password and authenticator setup).
For quick local work `AUTH_MODE=dev` trusts an `x-dev-member-id` header; the API refuses to start that way in
production.

## Safety: nothing writes to production until we say so

The application is read-only by default, refuses to touch `cw_datawarehouse`, and the production
database stays locked until a documented go-live gate is passed. See
[docs/12-environments-and-safe-rollout.md](docs/12-environments-and-safe-rollout.md).

## Quality gates

```bash
pnpm lint         # Biome: formatting and lint
pnpm build        # compiles packages first; the API and web app consume their output
pnpm typecheck    # TypeScript strict mode in every package
TEST_DATABASE_URL=postgres://user:pw@localhost:5432/postgres pnpm test
```

`TEST_DATABASE_URL` points at any database on a server where the user may `CREATE DATABASE`; the
integration suites create and drop throwaway databases. Without it those suites are skipped and the
unit suites still run. CI runs everything against a Postgres 16 service container.

## Principles

1. **The database is the source of truth, and it enforces its own rules.** Invariants (one running
   timer per person, locked pay periods, no overlapping periods) are constraints and triggers, not
   just application checks.
2. **Money is never a floating-point number.** See [ADR 0006](docs/adr/0006-money-and-rounding.md).
3. **History is never rewritten.** Rates and costs are snapshotted onto time entries and invoice lines;
   changes are audited; applied migrations are immutable.
4. **Every rule has a written specification and a test.** If the docs and the code disagree, that is a bug.
5. **No lock-in to anyone's quirks.** CW concepts are mapped to cleaner ones; CW ids are preserved so
   history stays traceable ([ADR 0003](docs/adr/0003-preserve-cw-ids.md)).
