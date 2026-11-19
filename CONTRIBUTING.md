# Contributing

## Workflow

- `main` is always deployable. Work happens on short-lived branches named `type/short-description`
  (`feat/ticket-board`, `fix/overtime-edge`, `docs/billing-spec`) and merges by pull request.
- CI (lint, typecheck, build, tests) must pass before merging. Squash-merge keeps history readable.
- Commit messages use Conventional Commits: `feat(service): add ticket resources`,
  `fix(db): ...`, `docs: ...`, `chore: ...`. The scope is the package or module.
- A change that alters behaviour documented in `docs/` updates the document in the same pull request.
- A significant decision (a new dependency class, a data-model convention, an integration approach)
  gets an ADR in `docs/adr/` using the existing ones as the template.

## Database migrations

- One file per change in `packages/db/migrations`, named `NNNN_snake_case.sql`, numbered in order.
- **Applied migrations are immutable.** The runner stores a checksum and refuses to run if a file
  changed. Fix forward with a new migration.
- Each migration runs in a transaction. Do not use `CREATE INDEX CONCURRENTLY` in a migration; if a
  large table needs it, discuss first.
- Every table gets `created_at` and `updated_at`, a `bigint GENERATED ALWAYS AS IDENTITY` primary key,
  and `SELECT sys.attach_standard_triggers('schema.table')` (pass `false` as the second argument for
  high-volume, non-business tables that should skip auditing).
- Fixed value sets use `text` plus a `CHECK`; admin-editable lists get a lookup table.
- Money is `numeric`, never `float`/`real`/`money`. Timestamps are `timestamptz`.
- Imported rows carry a `legacy_cw_*` column so the import is re-runnable and traceable.
- Add or extend a test in `packages/db/src/schema.test.ts` for every constraint or trigger that
  carries a business rule.

## Code

- TypeScript `strict`, ES modules, no `any` (Biome enforces it).
- Business rules that do not need I/O live in `packages/shared` as pure functions with unit tests.
- API routes validate every input with a zod schema from `packages/shared`, authorize by permission
  key, and write inside `withActor(...)` so the audit trail records who acted.
- SQL is written by hand and parameterised. Never build SQL by string-concatenating user input.
- Errors returned to clients are `application/problem+json`; unexpected errors never leak details.

## Tests

- Unit tests sit next to the code (`*.test.ts`). Integration tests use `TEST_DATABASE_URL`.
- Bug fixes start with a failing test that reproduces the bug.

## Secrets

Never commit credentials, tokens, customer data, card data or exports from QuickBooks or
ConnectWise. `.env` files are ignored; `.env.example` documents every variable.

## Database safety rules

- Never point `DATABASE_URL` at `cw_datawarehouse` or a database you did not create for this project.
- Tests must use `TEST_DATABASE_URL` and create throwaway databases, never an existing one.
- Anything that writes outside our own database (QuickBooks, payment providers, email) must check
  `INTEGRATIONS_ENABLED` and must have a fake for tests.
- A new write path needs a test proving it is rejected in read-only mode.
