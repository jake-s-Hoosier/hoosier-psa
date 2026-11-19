# 00. Vision and scope

## Purpose

Hoosier Security runs its business on ConnectWise Manage (PSA) with QuickBooks Desktop for
accounting, Justworks for payroll and RingCentral for telephony. ConnectWise is expensive, mirrors a
generic MSP workflow rather than a commercial security integrator's, and exposes data only through
an API that Hoosier already copies nightly into PostgreSQL (`cw_datawarehouse`). This project
replaces it with a system that Hoosier owns, built around how a security integrator actually works:
projects with long install phases, recurring monitoring/licensing revenue (RMR), service agreements
with response commitments, and tight margin tracking against vendor costs.

## Goals

1. **Full replacement.** CRM, service tickets, project management, dispatch, detailed time capture,
   invoicing, agreements/contracts, RMR billing and QuickBooks Desktop synchronisation. Nothing
   Hoosier does in ConnectWise today is lost ([parity matrix](01-cw-parity-matrix.md)).
2. **Clean and modern.** Fast, keyboard-friendly, mobile-capable for technicians. Not a visual copy
   of ConnectWise ([design system](09-design-system.md)).
3. **Correct money.** Billing, tax, proration and accounting export are specified, tested and
   reconcilable to the penny against ConnectWise during a parallel run.
4. **Professionally engineered.** Typed end to end, constraint-enforced data model, audited changes,
   CI on every change, every rule documented.
5. **Extensible integrations.** QuickBooks Desktop now; Stripe and QuickBooks Online later; WisePay
   and Global Payments for autopay. Integrations sit behind interfaces so providers can change.

## Non-goals (for now)

- Multi-tenant SaaS. This is single-tenant software for one company. Tenancy is not designed in, to
  avoid its cost; the schema does not preclude adding it later.
- Replacing QuickBooks. The PSA is the operational system of record; QuickBooks remains the general
  ledger until a deliberate decision says otherwise.
- Replacing Justworks. Payroll hours are exported for entry into Justworks; no payroll calculation of
  taxes or deductions.
- Rebuilding adjacent tools (RingCentral, Verkada partner portal, Operational Guardian). These keep
  running and integrate through APIs and the shared Postgres.

## Users

| Role | Primary needs |
|------|---------------|
| Technician | Today's schedule, ticket detail and site access notes on a phone, one-tap timers, quick notes and photos |
| Dispatcher / Operations | Schedule board, unassigned queue, SLA and aging visibility, reassignment |
| Project manager | Phases, budgets vs actuals, schedule, change orders, billing milestones |
| Sales | Companies, contacts, opportunities, quotes, pipeline |
| Billing / Finance | Billing runs, invoice review, agreements, AR, QuickBooks export, margin reports |
| Management (GM/Integrator) | EOS scorecard data, utilisation, margin, RMR growth, post-mortems |
| Customers (later) | Portal for tickets, invoices, payment methods and autopay enrolment |

## Constraints and assumptions

- Hosted on HSIN-UT01 (Windows, PM2, Cloudflare tunnel) with PostgreSQL 16; QuickBooks Desktop on
  HSIN-QB01. These are inputs, not choices ([architecture](02-architecture.md)).
- Staff authenticate with local passwords and an authenticator code; the PSA does not depend on Microsoft Entra ([ADR 0010](adr/0010-local-authentication.md)).
- Payroll rules: semi-monthly periods (1st-15th, 16th-end), Sunday-Saturday workweeks, overtime
  after 40 worked hours ([time and payroll](04-time-and-payroll.md)).
- ConnectWise remains the system of record until cutover; the app is fed from the nightly mirror
  during development and parallel run ([migration](11-cw-migration.md)).

## Success criteria

- A billing cycle run in parallel produces invoices and RMR totals that reconcile to ConnectWise
  within documented, explained differences.
- Payroll hours exported for a period match the current spreadsheet process.
- Every active CW capability in the parity matrix is delivered or has an explicit, signed-off
  retirement decision.
- Cutover happens at a month boundary with a rehearsed rollback.
