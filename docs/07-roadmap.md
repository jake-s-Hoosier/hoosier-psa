# 07. Roadmap

Sequencing principle: **make the new system useful on real data early, and put the highest-risk
money paths (billing, QuickBooks) under a parallel run as soon as they exist.** Estimates are for planning, not
promises; each milestone ends with exit criteria that must be met before the next starts.

## M0. Foundation (done in the initial commit)

Repository, CI, strict TypeScript, Biome, migration runner with checksums; schemas for `iam`, `crm`,
`catalog`, `service`, `timekeeping` with audit, locking and uniqueness invariants; pure rules for money,
billing rounding, pay periods and overtime; API skeleton (health, companies) with problem+json errors and
validation; web shell; documentation set and ADRs.

**Exit:** `pnpm lint && pnpm typecheck && pnpm build && pnpm test` green locally and in CI.

## M1. Operations core: CRM, tickets, time (about 4-6 weeks)

- Local sign-in (password + authenticator code, done); permission enforcement on every route (done); role administration (done: Access screen and API).
- **CW import tool** (re-runnable, id-preserving): members, lookups, companies, sites, contacts and channels,
  catalog, boards and statuses, tickets, ticket notes, time entries. Shadow environment refreshed nightly ([11](11-cw-migration.md)).
- CRM: company, site and contact CRUD (done), notes and alerts (done), search by name and ID (done; phone and email search to do), caller lookup by E.164 number.
- Service: board and list views, ticket detail, notes, resources (done), status and priority changes, aging, attachments (done), inbound email to ticket (done, to be tried against a real mailbox in UAT).
- Time: timer, manual entry, day and week timesheet, submit and approve, pay-period lock, **payroll export**
  to replace the spreadsheet.
- Reconciliation reports: record counts and hours by member and period versus CW.

**Exit:** a technician can run a full day (see schedule list, open tickets, time them, add notes) in the
shadow environment; payroll export for two consecutive periods matches the current process to the minute.

## M2. Agreements and billing (about 6-8 weeks)

- Agreement types, agreements, additions with effective dating and proration (done: screen, rules and tests); coverage rules applied to ticket time (done).
- Agreement billing runs with draft review, gap-free posting and voids (done; screen, rules and tests). Ticket time invoicing with per-ticket billing methods (done). Ticket materials and expenses billed with the ticket run (done). Manual payments applied to invoices (done). Invoice PDF (done). Credit memos (done). Projects with phases, project tickets and project invoicing: time and materials, deposits, progress and final invoices (done). Still to come: emailing invoices, and payment providers with autopay (M5).
- **QuickBooks mapping spike**, then the Web Connector export with queue, idempotency and reconciliation ([06](06-accounting-integrations.md)).
- RMR and margin reports; recurring-vendor cost comparison.

**Exit:** two full monthly cycles run in parallel with CW; every invoice reconciles to CW within explained
differences; QuickBooks receives and matches invoices with no manual fixes.

## M3. Dispatch and projects (about 6 weeks)

- Schedule entries, dispatch board with unassigned queue, conflict detection, Outlook calendar sync, mobile technician view.
- Projects: phases, project tickets, budgets, billing methods (fixed fee, milestone, T&M), change orders, close-out analytics (post-mortems).
- Light asset register at sites.

**Exit:** dispatchers schedule a full week in the new board; one live project is run in parallel through close-out.

## M4. Sales and procurement (about 6 weeks, scope pending decisions)

- Opportunities, stages, activities, versioned quotes (retiring CW Sell/CPQ), quote-to-project conversion.
- Purchase orders, receiving, vendor costs linked to projects and invoices; automated distributor price updates into the catalog.

## M5. Payments and portal (about 6 weeks)

- Payment provider abstraction with Stripe first, then WisePay and Global Payments ([10](10-payments-and-autopay.md)).
- Autopay enrolment, scheduled charges, retries, dunning, payment application, fee capture, QuickBooks payment export.
- Customer portal (tickets, invoices, pay, manage methods); QuickBooks Online adapter.

## M6. Cutover (about 3-4 weeks including rehearsal)

Freeze, final import, reconciliation sign-off, go-live at a month boundary, CW read-only for a defined
period, then retirement ([11](11-cw-migration.md)).

## Sequencing risks

| Risk | Mitigation |
|---|---|
| QuickBooks Web Connector behaviour differs from assumptions | Spike first in M2; keep CW's export path available until parity is proven |
| Provider APIs (WisePay, Global Payments) lack needed features | Request sandbox access and API docs now; abstraction isolates the impact |
| CW data quality (orphaned and unlinked records) | Import reports exceptions instead of failing; known issues tracked in [11](11-cw-migration.md) |
| Scope growth (quoting, procurement) | Decisions recorded in [01](01-cw-parity-matrix.md); milestones are gated by exit criteria |
| Single-developer bus factor | Documentation-first, tests on every rule, ADRs for every decision |
