# 0004. SQL-first data access without an ORM

Status: Accepted
Date: 2026-11-19

## Context
The domain is relational and money-sensitive: billing runs, proration, margin reports, locked periods,
exclusion constraints, partial indexes, audit triggers. Reporting is already done in hand-written SQL against
the mirror. Rules live in the database as constraints and triggers.

## Decision
Use `pg` with hand-written, parameterised SQL in route and service modules. Schema changes are plain SQL
migrations run by a small checksummed runner. Row shapes are mapped to typed objects at the boundary, and
request/response contracts are zod schemas shared with the web app. No ORM and no query builder.

## Consequences
- Queries are explicit, reviewable and tunable with `EXPLAIN`; database features (partial indexes, `EXCLUDE`,
  `FOR UPDATE SKIP LOCKED`, window functions) are used directly.
- Migrations are the single definition of the schema; there is no model layer to keep in sync.
- More boilerplate per query and no compile-time column checking. Mitigation: integration tests against a
  real database for every query-bearing module; revisit a type-safe SQL generator (such as a schema-to-types
  tool) once the schema stabilises, which would not change this ADR's core.

## Alternatives considered
- **Prisma / Drizzle / TypeORM.** Productive for CRUD, but they hide or fight the features this schema
  depends on and add a second schema definition.
- **Kysely.** A good future option for typed query building; deferred, not rejected.
