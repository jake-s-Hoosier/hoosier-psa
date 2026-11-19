# 0009. Environment markers and write guards

Status: Accepted
Date: 2026-11-19

## Context
Hoosier PSA will run alongside ConnectWise for a long parallel period before a hard cutover
(docs/11). During that time nothing in this system may write to a production table, and nothing may
ever write to `cw_datawarehouse`, which the nightly ETL owns. A single mistyped connection string or
environment variable must not be able to cause either.

## Decision
Defense in depth, so that no single mistake is enough:

1. **Separate databases per environment** (development, test, uat, shadow, production). No production
   database exists until cutover.
2. **Environment marker.** Migration 0007 creates a singleton `sys.environment` row naming the
   database's environment. A trigger forbids deleting it, renaming it, or changing go-live approval
   once set. The app refuses to start if `APP_ENV` differs from the marker.
3. **Protected-database denylist.** `assertSafeTarget` rejects `cw_datawarehouse`, `postgres` and
   template databases for every connection, migration and import.
4. **Read-only by default.** `createPool` requires an explicit `readOnly` flag; read-only pools set
   `default_transaction_read_only=on`, so PostgreSQL rejects writes (SQLSTATE 25006, surfaced as 503).
   `DB_WRITE_MODE` defaults to `read_only`; the API additionally returns 403 for non-GET requests.
5. **Production go-live lock.** A production database is write-locked until `approve-go-live` is run
   with an explicit checklist flag; the approval is recorded and one-way.
6. **Shadow is import-only.** The API never writes to the shadow environment.
7. **Integrations off.** `INTEGRATIONS_ENABLED` can be true only when `APP_ENV=production`.

## Consequences
- Safe by default; enabling writes is always a deliberate, visible act.
- Slightly more setup friction in development (`DB_WRITE_MODE=read_write`).
- The guards are code-level; the database role used by the app should also have no grants on
  `cw_datawarehouse` (operational control, docs/12).

## Alternatives considered
- Config flags only: one wrong value defeats it.
- Database roles only: necessary but not sufficient; no marker mismatch detection.
- Row-level "test data" flags in one database: too easy to leak test rows into real reports.
