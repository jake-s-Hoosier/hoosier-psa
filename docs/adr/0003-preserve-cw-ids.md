# 0003. Preserve ConnectWise identifiers on import

Status: Accepted
Date: 2026-11-19

## Context
Ticket, project, company and invoice numbers appear in customer emails, QuickBooks memos
("Ticket #..."), vendor orders, EOS notes and years of reports. Warehouse queries and a classifier already
rely on them. Renumbering would break all of that and make reconciliation harder.

## Decision
Imported rows keep the ConnectWise id as their primary key (`OVERRIDING SYSTEM VALUE`), and each identity
sequence is then advanced past the maximum imported id so new records continue the numbering. Every
imported table also has a `legacy_cw_*` unique column, which makes the import idempotent (upsert on it) and
keeps the origin explicit even if a primary key is ever changed. Invoice numbers continue the CW sequence
so QuickBooks reference numbers stay unique and continuous.

## Consequences
- Numbers on existing paperwork and in QuickBooks remain valid; existing SQL keeps working with id joins.
- Identity columns are `GENERATED ALWAYS`, so the import tool must be the only code using
  `OVERRIDING SYSTEM VALUE`, and it must reset sequences (covered by import tests).
- Gaps in numbering are normal and expected (CW had deleted records).

## Alternatives considered
- **New ids with a CW id mapping table.** Cleaner in theory; breaks every external reference to old numbers.
- **UUIDs.** Good for distributed systems; unhelpful for humans reading ticket numbers over the phone.
