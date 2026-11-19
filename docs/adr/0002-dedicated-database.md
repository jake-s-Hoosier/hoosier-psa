# 0002. Dedicated application database, separate from the CW mirror

Status: Accepted
Date: 2026-11-19

## Context
`cw_datawarehouse` already holds 123 tables of CW and QuickBooks data, but it is a **mirror**: the nightly
ETL reloads it, its schemas (`production`, `psa`, `vis`, `app`) are owned by other tooling, and it stores
CW's denormalised shapes (names beside ids, raw JSON). A system of record needs transactional writes,
constraints, and a schema it controls.

## Decision
Create a separate database `hoosier_psa` on the same PostgreSQL server, owned by this repository's
migrations, with module schemas (`iam`, `crm`, `catalog`, `service`, `timekeeping`, and later `agreement`,
`billing`, `accounting`, `dispatch`, `project`, `sales`, `procurement`, `payments`) plus `sys`. The mirror
stays read-only to this project and is consumed only by the import tool. A shadow copy
(`hoosier_psa_shadow`) is rebuilt nightly during the parallel run ([11](../11-cw-migration.md)).

## Consequences
- The ETL can keep reloading the mirror without risk to application data.
- Existing SQL reports and MCP tools keep working unchanged against the mirror until cutover; afterward they
  are re-pointed at `hoosier_psa` views.
- Cross-database queries are not possible directly; the import tool copies data, and reporting that needs
  both uses explicit extracts or `postgres_fdw`.
- Same server means shared resources; revisit if load requires separation.

## Alternatives considered
- **A new schema inside `cw_datawarehouse`.** Rejected: couples backups, permissions and the ETL lifecycle to
  an unrelated system and invites accidental writes into mirror tables.
- **Writing directly into the mirror's `production` schema.** Rejected: the nightly ETL would overwrite it.
