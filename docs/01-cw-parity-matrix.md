# 01. ConnectWise parity matrix

Every capability Hoosier uses in ConnectWise must land here, ship, or be explicitly retired. Row
counts come from the `cw_datawarehouse` mirror as of 2026-11-19 and show how heavily each area is used.
**Status** values: `schema` (tables exist), `planned`, `decision` (needs your call).
Milestones are defined in [07-roadmap.md](07-roadmap.md).

## Core (from the project brief)

| Capability | CW evidence (mirror rows) | New-system design | Milestone | Status |
|---|---|---|---|---|
| Companies, sites, contacts | companies 4,462; contacts 7,845; contact phones 4,065; sites 792 | `crm.*`; contact channels normalised to E.164 for caller match | M1 | schema |
| Company/contact notes and alerts | n/a (notes not mirrored) | `crm.company_note` with alert flag | M1 | schema |
| Service tickets, boards, statuses, priorities, types | tickets 19,079; notes 24,647; boards 10 | `service.*`; ticket number = CW number | M1 | schema |
| Ticket resources and ownership | resources column on tickets | `service.ticket_resource`, `owner_member_id` | M1 | schema |
| Detailed time capture | time entries 43,423 | `timekeeping.time_entry`: timers, rate snapshots, approval, locking | M1 | schema |
| Payroll hours export | spreadsheet + manual Justworks entry | Pay periods, overtime allocation, CSV export ([04](04-time-and-payroll.md)) | M1 | rules coded |
| Dispatch / scheduling | schedule entries 77,315 | `dispatch.*`: schedule entries, board, calendar sync | M3 | planned |
| Project management | projects 2,162; phases 2,014; project tickets 4,450; project ticket notes 5,126 | `project.*`: phases, tickets, budgets, billing methods | M3 | planned |
| Agreements / contracts | agreements 1,266; additions 828 | `agreement.*` ([05](05-billing-and-agreements.md)) | M2 | planned |
| RMR billing | additions carry unit price, cost, margin | Billing runs from additions; cost-side margin tracking | M2 | planned |
| Invoicing | invoices 32,127; lines (mirror partial) | `billing.invoice*`, tax, terms, PDF, email | M2 | planned |
| QuickBooks Desktop mapping | qb_* tables (customers 1,980; items 2,044; invoices 34,404) | QBXML via Web Connector ([06](06-accounting-integrations.md)) | M2 | planned |
| Stripe / QuickBooks Online | not yet used | Provider interfaces, later | M5 | planned |
| WisePay / Global Payments autopay | New capability (card-processing fees are not visible in QB deposit detail today) | `payments.*` provider abstraction ([10](10-payments-and-autopay.md)) | M5 | planned |

## Also in use today (not named in the brief, but must not be lost)

| Capability | CW evidence | Proposed handling | Milestone | Status |
|---|---|---|---|---|
| Opportunities and CPQ quotes | opportunities 6,211; quotes 5,540; quote items 122,074 | Native opportunities and quoting; also retires CW Sell | M4 | **decision** |
| Product catalog and pricing | catalog items 2,760; products 72,766 | `catalog.product`, automated distributor price updates | M1 (catalog), M4 (automation) | schema |
| Purchase orders and receiving | POs 7,154; PO lines 13,481 | `procurement.*`, linked to projects and invoices | M4 | **decision** |
| Configurations (assets) | configurations 31 | Light asset register per site; low current use | M3 | planned |
| Activities / CRM tasks | activities 49,335 | Tasks and activity log on companies/opportunities | M4 | planned |
| Work roles and work types | roles 11; types 33 | `catalog.work_role`, `catalog.work_type` | M1 | schema |
| Attachments on tickets/projects | via API | Object storage with metadata table | M1 | planned |
| Project post-mortems | post_mortems 1,461 + 7 detail tables | Native project close-out analytics | M3 | planned |
| Email-to-ticket | n/a | Inbound mailbox via Microsoft Graph | M1 | planned |
| Reporting | many ad-hoc SQL reports on the mirror | Keep SQL reporting on Postgres; add curated views | M1+ | planned |
| Members and security roles | members 79 | `iam.*`; Entra sign-in | M1 | schema |

## Known ConnectWise quirks we deliberately do not copy

- **Fixed-fee project labor billed as a "LABOR COST" product line with cost equal to price** distorts
  post-mortems and margins. The new system bills fixed-fee labor as labor and derives labor cost from
  time entries ([05](05-billing-and-agreements.md)).
- **`po_amount` on projects is unreliable**; revenue comes from the accepted quote or contract value.
- **CW stores display names beside ids** (`status_id` + `status_name`). The new schema stores ids only
  and joins for names, so renames cannot leave stale copies.
- **Billing logic in CW is implicit** (spread across agreement, product and invoice settings). Here
  every billing rule has a written specification and tests.

## Decisions needed from you

1. Quoting: build native quoting now (M4), or keep CW Sell/CPQ until the rest is stable?
2. Procurement: native purchase orders at M4, or keep POs in QuickBooks until later?
3. Configurations: 31 records suggests light use; is a minimal asset register enough?
