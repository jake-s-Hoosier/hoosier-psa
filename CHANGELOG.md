# Changelog

All notable changes are recorded here. Format follows Keep a Changelog; versions follow milestones until
the first production release.

## [Unreleased]

### Fixed
- Date-only values (agreement dates, invoice dates, pay-period dates) showed one day early in US time zones; they are
  now formatted as calendar days.

### Added
- Purchasing: purchase orders to vendors (permissions `procurement.read`, `procurement.write`, `procurement.receive`).
  Draft, mark as ordered, receive in parts with packing slip and serial numbers, close short or cancel. A PO can be
  tied to a project, sales order or ticket; the project margin report shows vendor cost received and still on order.
  Dispatchers can receive but not edit orders. Nothing is sent to vendors or QuickBooks.
- Reports (permission `reports.read`, Manager and Billing): recurring revenue and margin as of any date, grouped by
  agreement type, vendor, customer or agreement, with flags for lines that have no cost, lose money or fall below a
  margin floor, and for agreements that bill nothing; agreement service cost (billed recurring revenue less recurring
  cost and labor not billed); project margin (posted invoices against labor and material cost, budget hours, unbilled
  value). Each report downloads as CSV. Read-only: no report writes to the database.
- Dispatch board. Migration 0022: `dispatch.schedule_entry` puts a person on a ticket for a block of time, or marks a
  meeting or time off. Week board with a row per field technician, an unscheduled queue of open tickets with no upcoming
  visit (most urgent first), add, move, reassign, confirm, complete, cancel and remove. Scheduling someone adds them as a
  ticket resource. Overlapping visits for the same person are allowed but flagged on the board and reported when saved.
  New permissions `dispatch.read` (Manager, Dispatcher, Technician) and `dispatch.write` (Manager, Dispatcher).
  Outlook sync, drag-and-drop and the phone view for technicians are still to come.
- Sales orders and billing milestones (sales slice B). Migration 0021: `sales.sales_order` (from an opportunity; fixed
  fee, actual rates, not to exceed or override rate, with PO), `sales.sales_order_line` (budget and bill of materials,
  never charges), `sales.billing_milestone` (planned deposit and progress payments, by percent or dollars, never more
  than the fixed fee) and `billing_run.milestone_id`. An approved order converts to a project in one step: billing
  method, fee and PO carry over, labor hours become the budget, optional phases are created, milestones move to the
  project, quote and design links are copied, and the opportunity moves to Won. The project Bill dialog offers the
  unbilled milestones to fill in the amount and wording; a milestone shows Billed while its invoice is not void.
  New permissions `sales.order.read` and `.write` (Manager, Sales); converting also needs `project.write`.
- Opportunities (sales slice A). Migration 0020: `sales.stage` (seeded Qualify, Site walk and design, Proposal sent,
  Negotiation, Won, Lost, each with a win probability), `sales.opportunity`, `sales.activity` (calls, emails, meetings,
  site visits, notes and dated tasks) and `sales.external_ref`, a provider-neutral link from an opportunity, order or
  project to a quote, estimate or design held in another system (Smart Pricing Tables, SembleAI). Moving to Won or Lost
  stamps the close date; Lost needs a reason. Opportunities page with pipeline by stage, weighted value, activity log and
  task checklist, and the link panel. New permissions `sales.opportunity.read` and `.write` (Manager, Sales).
  Nothing calls the external systems yet; links are entered by hand until their APIs are available.
- Projects and project invoicing. Migration 0018: `project.project` and `project.phase`, and `service.ticket` gains
  `phase_id` (with the existing `project_id` now a real foreign key). A project has a customer, a billing method (fixed
  fee, actual rates, not-to-exceed, override rate), PO, budget hours and dates; a phase can be billed separately, with
  terms of its own. Project tickets are ordinary tickets that point at the project, and the database guards that the
  ticket is the project's customer's and the phase is the project's own. Migration 0019 adds project billing runs for
  one scope (the project, or a separately billed phase): time and materials through a date, a deposit, a progress or
  milestone payment (dollars or percent of the fee), and a final invoice that bills the rest of the fixed fee plus any
  unbilled materials and closes out the scope's time. A database trigger keeps a scope's fee lines from adding up to
  more than its fixed fee. Ticket runs no longer pick up project tickets. New Projects page (list, detail with billing
  position, phases, tickets, and a Bill dialog with preview), `project.read` / `project.write` permissions.
- Credit memos. Migration 0017: `billing.credit_memo`, `credit_memo_line` and `credit_application`. A memo is issued
  for a customer (optionally against one of their invoices, whose tax it copies and whose total it cannot exceed across
  all its memos), takes its number from the same gap-free series as invoices (as in ConnectWise, where a credit memo is
  an invoice with a negative total), is immutable once issued, and is voided rather than deleted. It is applied to the
  customer's open invoices exactly like a payment; whatever is not applied stays as credit on account to apply later.
  One SQL function, `billing.refresh_invoice_paid`, now sets an invoice's paid amount and status from its payments and
  its credits together, and the payment guard counts credits too. API under `/api/v1/credit-memos`
  (`billing.credit.read`, `billing.credit.write`). New Credit memos tab on the Billing screen, and on each invoice an
  "Issue credit memo" dialog (pick lines and quantities, or add another credit), the credits applied to it with Take
  back, and any credit on account that can pay it. Credits appear on the invoice PDF. Not yet sent to QuickBooks
  (`CreditMemoAdd` comes with the export queue). Time and charges on a credited invoice are not released; to rebill
  them, void the invoice instead.
- Invoice PDF. `GET /api/v1/billing/invoices/:id/pdf` (billing.invoice.read) draws a letter-size invoice: seller header,
  bill-to with the customer's billing address, lines, tax, total, payments received and balance due, repeated column
  headings and page numbers on long invoices, and a DRAFT, VOID or PAID watermark. "Open PDF" or "Preview PDF" on the
  invoice screen. Read-only: nothing is emailed or stored. The seller block comes from `INVOICE_SELLER_NAME`,
  `INVOICE_SELLER_ADDRESS` (lines separated by `|`), `INVOICE_SELLER_PHONE` and `INVOICE_REMIT_NOTE`; the defaults are
  Hoosier Security and the Indianapolis address.
- Payments, recorded by hand. Migration 0016: schema `payments` with `payment` and `payment_application`, database
  guards (payer must match the invoice, only posted unpaid invoices take money, applications cannot exceed the payment
  or the invoice balance, a payment is voided and never deleted) and the usual audit trail. API under `/api/v1/payments`
  (list, record with or without applications, apply credit later, take an application back, edit reference/notes/fee,
  void) with permissions `billing.payment.read` and `billing.payment.write`. An invoice becomes part paid or paid as
  applications arrive, goes back when a payment is voided or an application is taken back, and an invoice with live
  payments still cannot be voided. Overpayment stays as credit on the customer. New Payments tab on the Billing screen
  and a Payments section with Record payment on each posted invoice. Nothing is sent to QuickBooks or a card processor.
- Materials and expenses on tickets, billed with the ticket run. Migration 0015: `service.ticket_charge` with a guard
  that freezes a charge once it is on an invoice. New "Materials and expenses" section on the ticket screen (catalog
  search fills description, price, cost and tax flag), an API under `/api/v1/tickets/:id/charges`, and a catalog search
  at `/api/v1/lookups/products`. A ticket run now bills charges by the date incurred as product or expense lines next
  to the ticket's labor, and deleting a draft line, discarding a run or voiding an invoice releases them. Fixed-fee and
  not-to-exceed tickets cover labor only.
- QuickBooks mapping spike. `docs/06` records how ConnectWise fills QuickBooks invoices (read from 8,630 recent
  invoices): header fields, tax codes, terms, items, ticket-labor lines and the invoice number series. A pure
  `qbInvoiceAdd` builder in `@hoosier/shared` turns an invoice into an `InvoiceAdd` request and lists what is missing,
  with tests, and `GET /api/v1/billing/invoices/:id/qbxml` shows it for any invoice. Read-only: nothing is queued or
  sent. Ticket invoice lines now start `Ticket # <n>` to match ConnectWise's text.
- Ticket time invoicing. A billing run can now bill approved ticket time through a chosen date, one draft invoice per
  bill-to company. Each ticket has a billing method (actual rates, override rate, not to exceed, fixed fee) set on the
  ticket screen. Time is linked to its draft line so it cannot be billed twice, frozen when the run is posted, and
  released when a line, invoice or run is thrown away or an invoice is voided. Migration 0014. Skipped tickets are
  listed with the reason (fixed fee not closed, time not approved, cap used up, amount missing).
- Billing runs and invoices for agreements (milestone 2). Migration 0013: billing runs, invoices, invoice lines, a
  gap-free invoice counter, a unique guard so a recurring line bills once per period, and database rules that freeze
  posted invoices. Pure rules in `@hoosier/shared` (billing periods by cycle, prorated lines, totals, due dates) with
  tests. Billing screen (`#/billing`): preview and create a run for a month, review and edit the draft invoices, post
  the run (assigns numbers) or discard it, search invoices, void a posted invoice with a reason. New permissions
  `billing.invoice.read`, `billing.invoice.write` and `billing.invoice.post`. Nothing is sent to QuickBooks and no
  payments are taken yet.
- Agreement coverage on ticket time. Labor on a ticket whose agreement is in force on the work date bills at no charge
  and records the agreement, when the work type is flagged "counts against agreement": `covered` and
  `unlimited_remote` agreements cover all such labor; `block_hours` covers it while the prepaid balance lasts, and an
  entry that would overdraw the balance bills normally (it is not split). Applied when time is added, edited or a
  timer stops, and re-applied to a ticket's open time when its agreement changes; submitted, approved and billed time
  never changes, and an explicit billing choice on an entry stands. The agreement shows hours covered and block hours
  left. Work types default to "counts against agreement", so unflag on-site or other work types that should still bill.
- Agreements (milestone 2, first stage). New `billing` schema: agreement types, agreements and recurring lines
  ("additions"), plus the agreement links on tickets and time that earlier migrations had deferred. Lines are
  effective-dated and never edited in place; a price or quantity change ends the old line and starts a new one (a
  database guard enforces it). Pure rules in `@hoosier/shared` for status, monthly recurring revenue and cost, margin,
  proration and renewal windows, with tests. Agreements screen (`#/agreements/12`): list with status and type filters,
  detail with terms, lines and history, service hours and cost logged on covered tickets; create, edit, cancel, add,
  change and end lines. The company page lists its agreements, and a ticket can be set to the agreement that covers it.
  New permissions `billing.agreement.read` and `billing.agreement.write`. Nothing here bills anyone yet.
- Time screen (`#/time`). **My timesheet**: week view (Sunday to Saturday) with day totals, add, edit and remove
  entries, submit and recall the week. **Approvals** (approvers): per-member open, submitted and approved hours for a
  week, with approve (never your own time). **Pay periods** (period lock): create a month's two periods, preview the
  payroll table with warnings and unsubmitted-time check, lock, and download the payroll CSV.
  Backend: time can be logged without a ticket against a company (shop, training, admin; always paid, never billed),
  open entries can be edited (`PATCH /time-entries/:id`, refused once submitted, in a locked period, or while a timer
  runs), and entries now carry the company and ticket names.
- Connected records. Every record has an address (`#/companies/12`, `#/tickets/55`, `#/tickets?contactId=7`), so any
  screen can link to any other. New **company page**: alerts, activity stats, contacts and sites (add, edit, remove),
  the company's tickets, recent time and notes, with "New ticket" prefilled from the company, a site or a contact.
  Tickets now show and link to their company, site and contact; the ticket list can be narrowed to a site or contact.
  Company create/edit, site and contact CRUD, company notes (including alerts) and `/companies/:id/overview` in the API;
  tickets and time entries can be filtered by company, site and contact.
- Inbound email to tickets through Microsoft 365 ([ADR 0012](docs/adr/0012-microsoft-365-mail.md), migration 0011):
  Graph reader (`Mail.Read`, polled, read-only), processor that opens tickets for known contacts, adds replies to the
  ticket named in the subject or threaded by `In-Reply-To`/`References` (only from a known contact of that company or staff),
  sends unknown or ambiguous senders to a fallback company, ignores automatic mail and our own mailboxes, stores attachments,
  and is safe to repeat. New **Email** screen (mailboxes, message log), `/api/v1/mailboxes`, permission `service.mailbox.manage`,
  "Move to another company" on tickets (`PATCH companyId`; site and contact must belong to the ticket's company).
  `MAIL_POLL_ENABLED` and `GRAPH_*` settings, off by default and refused in the shadow.
- Role administration: **Access** screen and `/api/v1/admin/*` (needs `iam.manage`): list roles with effective
  grants, create custom roles, edit any role's permissions, reset a built-in role to its defaults, delete
  unused custom roles, set each member's roles, deactivate or reactivate members (signs them out). A change that
  would leave nobody able to manage roles is refused. Migration 0010 audits role grants, role membership and
  ticket resources (composite-key tables) with the acting member.
- Ticket resources (add and remove people on a ticket) and file attachments (upload up to 25 MB, list, download as
  attachment only, remove; [ADR 0011](docs/adr/0011-attachments-in-postgres.md), migration 0010). Lookups now include active members.
- Permission enforcement: every `/api/v1` route declares the permission it needs and is refused without it
  (deny by default, proven by a route-table test). Permissions are the union of a member's roles, using
  stored `iam.role_permission` rows when present and the code defaults otherwise. Own versus all scoping for
  time entries, approval needs `timekeeping.time.approve` and never your own time, `/auth/me` returns the
  member's permissions, and the web app hides navigation and actions they cannot use. The API syncs the
  permission catalogue at startup (writable environments only); the admin CLI gained `grant-role`,
  `revoke-role` (never the last Administrator), `sync-permissions` and roles in `status`.
- Staff sign-in without Entra (ADR 0010, supersedes 0005; migration 0009): local password (scrypt) plus
  authenticator-app code, recovery codes, forced first-login password change and MFA enrolment, signed
  session cookies re-checked against the database each request, CSRF header, sign-in throttling, admin CLI
  (`pnpm auth set-password | reset-mfa | status`), login screens in the web app. Credentials sit in an
  unaudited table so secrets never reach the audit log. `AUTH_MODE` is now `dev` or `session`;
  `AUTH_SECRET` replaces the unused Entra settings. Signing in works in read-only environments.
- Web: service tickets page (search, state and board filters, create, status and priority changes, notes,
  start timer, log time) and a running-timer bar on every page. API: read-only `/api/v1/lookups` for form
  reference data.
- Importer now brings over sites, contacts (with normalised phone and email channels), company default
  contacts and sites, work roles and types, CW board statuses with closed flags, priorities with colours,
  ticket notes and ticket-to-contact links. Report summaries count high-volume problems instead of
  listing each one. Shared `toE164` / `phoneExtension` helpers.
- Migration 0008 (work type pricing): rate type (multiplier, custom, adjustment), bill time
  (billable, do not bill, no charge), minimum and maximum billable hours, optional rounding increment.
  Time entries price from these rules; replaces `is_billable_default`.
- Timesheets and payroll: submit, recall and approve by date range; pay period generation (semi-monthly),
  lock (blocked while any time is unsubmitted; stamps and freezes entries) and export (JSON and CSV in
  decimal and h:mm, with weekly overtime across periods and paid leave). Payroll math lives in
  `packages/shared/src/payroll.ts`.
- CW import tool (`packages/importer`): read-only mirror access, transactional dry-run, id-preserving
  idempotent upserts for members, companies, ticket lookups, tickets and time entries, exception report
  and reconciliation counts. Documented mirror gaps in docs/11.
- Tickets API (`/api/v1/tickets`): list with filters, create with board defaults, update with
  status-on-board validation and close/reopen stamping, notes, first-response tracking.
- Time API (`/api/v1/time-entries`): one-per-member timer, manual entries by hours or range, rate and
  cost snapshots, billing rounding from exact duration, locked pay period refusal, void instead of delete.
  Rounding default (15 min, up) is a placeholder pending the billing decisions in docs/05.
- Write safety: environment marker table (migration 0007) with one-way go-live approval, refusal to
  target `cw_datawarehouse`, read-only database connections by default (`DB_WRITE_MODE`), API read-only
  guard, `/api/v1/system/status` and an environment banner in the web UI. See docs/12 and ADR 0009.
- Milestone 0 foundation: pnpm TypeScript monorepo, Biome, Vitest, GitHub Actions CI.
- PostgreSQL migrations 0001-0006: foundation (audit, triggers), `iam`, `catalog`, `crm`, `service`,
  `timekeeping`; checksummed migration runner with advisory locking.
- Shared business rules: money and rounding, billing rounding, semi-monthly pay periods,
  Sunday-Saturday workweeks, overtime allocation across periods, permission keys, API contracts.
- API skeleton: health endpoints, companies resource, problem+json errors, validation, dev-only auth.
- Web shell with design tokens and a companies list.
- Documentation set (vision, parity matrix, architecture, domain model, time and payroll, billing,
  accounting, roadmap, security, design system, payments, migration) and ADRs 0001-0008.
