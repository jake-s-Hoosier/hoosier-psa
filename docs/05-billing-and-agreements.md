# 05. Billing and agreements

Specification for milestone 2. Agreements and additions are implemented (`0012_agreements.sql`, `packages/shared/src/agreements.ts`);
billing runs and invoices are still planned and are what this document is built to guide. Open questions are listed at the end.

## Concepts

| Term | Meaning |
|---|---|
| Agreement | A contract with a company: type, term, bill cycle, bill-to company, coverage rules |
| Addition | A recurring line on an agreement (monitoring, licensing, cloud, support plan): product, quantity, unit price, unit cost, effective and cancelled dates |
| RMR | Recurring monthly revenue: the monthly-normalised sum of active additions |
| Billing run | A reviewable batch that turns billable things into draft invoices |
| Invoice | A numbered customer bill with lines, tax, terms and a payment balance |

Mirror evidence: 1,266 agreements and 828 additions in `production.agreements` and
`production.agreement_additions` (type, bill cycle, bill amount, prorating flag, unit price/cost/margin).

## Agreement model

- **Types** are configurable (Hoosier's service tiers ESP, BASE and JFI are agreement types with
  their own rules and pricing floors).
- **Term.** `start_date`, optional `end_date`, auto-renew flag, renewal notice window, cancellation date
  and reason.
- **Bill cycle:** monthly, quarterly, semi-annual or annual; `bill_start_date` anchors the cycle.
- **Bill-to.** The invoice goes to `bill_to_company_id` (defaults to the agreement's company).
- **Coverage** decides what ticket time and products cost the customer while the agreement is active:
  `none`, `block_hours` (deducts from a prepaid balance), `unlimited_remote` (e.g. JFI's unlimited remote
  support), or `covered` (labor billed at zero with cost still recorded). Work types flagged
  `counts_against_agreement` participate.
- **Additions** carry effective-from and effective-to dates, never edited in place for price or quantity
  changes: a change closes the old line and opens a new one so history and proration are exact.

## RMR billing run

Inputs: the run date and the period to bill. Output: draft invoices for review.

1. For each active agreement whose cycle falls due, take additions effective in the period.
2. Compute each line: `lineTotal(quantity, unitPrice)`, rounded to cents ([ADR 0006](adr/0006-money-and-rounding.md)).
3. **Proration.** A line starting or ending inside the period is prorated by days in the period when the
   addition's prorate flag is set. Amounts are allocated with `allocate` so cents are never lost.
4. Group lines by bill-to company, tax code and invoice description rules into invoices.
5. Apply tax per invoice per tax code on the taxable subtotal, rounded once.
6. Write drafts with the run id and, per agreement and period, a uniqueness guard so re-running a run
   can never double-bill.
7. A reviewer inspects, edits or removes drafts, then **posts** the run. Posting assigns invoice
   numbers and queues accounting export.

Idempotency: `(agreement_id, period_start, period_end)` is unique across non-void invoice lines of kind `agreement`.

## Invoicing other work

| Source | Rule |
|---|---|
| Service ticket, `actual_rates` | Approved billable time x snapshotted bill rate, one line per entry or grouped per ticket by company preference; products and expenses added |
| Service ticket, `fixed_fee` | One line for the fee; time recorded for cost but not billed |
| Service ticket, `not_to_exceed` | Time x rate capped at the amount |
| Project | Per project billing method: fixed fee (by milestone or percent complete), time and materials, or hybrid; deposits and progress billing |
| Products | Quantity x unit price at the time of sale, with cost snapshot; special-order and purchase-linked items link to POs (milestone 4) |
| Agreement coverage | Covered time appears on the invoice at zero or not at all, per company preference |

### Fixed-fee project labor (differs from ConnectWise)

ConnectWise bills fixed-fee labor as a "LABOR COST" product line with cost set equal to price, which
distorts project margins. Here, a fixed-fee project bills **revenue as labor revenue** and its
**labor cost always comes from time entries** (`cost_rate x actual_hours`). Margin reports therefore
reflect real effort, and post-mortems need no reclassification step.

## Invoice lifecycle

```
draft -> posted -> partially_paid -> paid
   \        \______________________\__> void (credit memo)
    \__ deleted (drafts only)
```

- Numbers are assigned at posting from a gap-free sequence seeded from the last ConnectWise invoice
  number, so QuickBooks reference numbers stay continuous across cutover.
- Posted invoices are immutable. Corrections are credit memos or voids that reverse the originals and,
  where necessary, release time entries back to `approved` (with `app.allow_locked_edit`).
- Each line snapshots description, quantity, unit price, unit cost, tax code and income-account mapping.
- Terms (`catalog.billing_terms`) set `due_date`; late-fee and statement behaviour is configurable per company.

## Margin and leakage reporting

Because lines carry cost snapshots and agreement additions carry unit cost, reports can compare
billed RMR with vendor cost per vendor (Alarm.com, Brivo, Verkada, monitoring centres and so on),
flag additions with negative or below-floor margin, and show **service expense against each agreement**
(labor logged to its tickets), the real cost of an agreement being visible over its life and not
precomputable.

## Decisions made while building agreements

- An addition's `unit_price` and `unit_cost` are **per month**; a quarterly or annual cycle multiplies by its months
  when billing. (Confirm against the CW import: if CW additions are priced per cycle, the importer divides.)
- The **cancellation date is the last day of coverage**; the agreement reads as cancelled the day after, its lines end
  on that date, and lines that never started are removed.
- Status (`pending`, `active`, `expired`, `cancelled`) is computed, never stored. An auto-renewing agreement past its
  end date stays active.

### Coverage on ticket time
- Covered labor is billed at no charge (cost still recorded) and carries the agreement id; the decision lives in
  `coverageDecision` (`@hoosier/shared`) and `coverageFor` (API). Which work types are covered is the work type's
  `counts_against_agreement` flag, which defaults to true, so an ESP "unlimited remote" agreement covers on-site work
  unless that work type is unflagged. Check the flags before the first billing run.
- Block hours are not split: an entry larger than the remaining balance bills in full.
- Entries are decided in order of entry, so editing an older entry can change what later ones cover.

### Billing runs as built
- A run bills **every agreement whose cycle starts in a chosen month**, in advance. Periods start at the agreement's
  `bill_start_date` and repeat every cycle, keeping the start day (clamped to month end), so a quarterly agreement
  appears in one run in three and nothing is ever back-billed by accident.
- The run **previews first** (nothing saved), then creates draft invoices, one per bill-to company, with a line per
  addition. Quarterly or annual lines are the monthly price times the cycle's months; lines in effect for part of
  the period are prorated by days when their flag is set. Tax is computed once per invoice on the taxable lines
  (taxable when the line's product is taxable; no product means not taxable) using the customer's tax code, and a
  customer with a tax-exempt id pays none. Terms set the due date; a customer with no terms is due on receipt.
- Drafts can be edited: invoice date (the due date follows it), PO, notes, a line's description, quantity, price and
  taxable flag, or a line or the whole invoice removed. Editing quantity or price replaces proration with quantity
  times price. Warnings flag a missing tax code, missing terms and no QuickBooks link.
- **No double billing.** A unique index on `(addition, period start, period end)` over non-void agreement lines, and
  the run's own check, mean a re-run or a second run only bills what is not already on a draft or posted invoice. A
  line added late to an already-billed period is picked up by the next run (prorated). Discarding a draft run or
  voiding a posted invoice frees its periods.
- **Posting** numbers the run's drafts in company-name order from a gap-free counter (`billing.invoice_counter`,
  locked row, rolled back with the transaction) and freezes them; the database rejects edits and deletes of posted
  invoices and their lines. A posted invoice is only voided, with a reason; the number stays on record and is not
  reused. Voiding an invoice with payments is refused.
- Until cutover the counter counts from 1 and posted invoices are test data. At cutover, seed the counter from the last
  ConnectWise invoice number and remove test invoices (a script to do this is part of the cutover checklist).

### Ticket time billing as built
- A **ticket run** bills approved, unbilled labor on service tickets worked **through a chosen date**, one draft
  invoice per bill-to company (the customer's `bill_to_company_id`, else the customer). Only time with status
  `approved`, billable and not already on an invoice is taken; submitted and no-charge time is left alone.
- Each ticket carries a **billing method**: `actual_rates` (one line per ticket and bill rate), `override_rate` (all
  hours at one hourly rate), `not_to_exceed` (hours at actual rates, capped at the amount less what was billed
  already; the excess is written off, not carried), or `fixed_fee` (one line for the fee). A method other than actual
  rates needs an amount. Set on the ticket detail screen.
- A **fixed-fee** ticket bills once, when the ticket is closed and none of its time is still open or submitted; all
  of its approved time is taken whatever the date. Otherwise it is listed as skipped with the reason.
- Labor lines are **not taxable** by default (confirm with the accountant; the line's flag can be changed on the draft).
- **No double billing.** Time is linked to its draft line when the run is created, so a second run cannot take it.
  Posting marks the time `billed`, which freezes it. Deleting a draft line or invoice, discarding the run, or voiding
  a posted invoice releases the time (billed time goes back to approved) so it bills again. Time in a locked pay
  period can still be linked and released; this uses the same audited override as the invoice void.
- The importer must mark historical ConnectWise time as billed so the first ticket run does not bill history.

### Materials and expenses as built
- A **charge** (`service.ticket_charge`) is a material (`product`) or an `expense` on a ticket: description, quantity,
  unit price and cost, a taxable flag, a billing choice (`billable`, `no_charge`, `do_not_bill`) and the date incurred.
  Choosing a catalog item fills the description, price, cost and taxable flag, and that item's QuickBooks item name
  rides along to the export. A material follows its catalog tax flag; an expense is not taxed unless set. Added on the
  ticket screen, with a catalog search.
- The **same ticket run** bills them: every billable, unbilled charge incurred through the run's date becomes one
  invoice line (kind `product` or `expense`), priced quantity times unit price, described `Ticket # <n>  <description>`,
  on the same invoice as the ticket's labor. Charges are billed whether or not the ticket is closed.
- **Fixed-fee and not-to-exceed** tickets cover labor only: materials and expenses bill separately, at their own
  prices, on top of the fee or cap. If a fixed-fee ticket's labor is held (not closed, time not approved), its
  materials still bill and the held labor is listed as skipped.
- **No double billing, same as time.** A charge is linked to its draft line when the run is created, and the database
  refuses to change or delete a charge that is on an invoice. Deleting the draft line or invoice, discarding the run,
  or voiding the invoice releases the charge; it can then be edited or billed again.
- Not yet built: parts ordering and receiving, purchase orders, inventory on hand, markup rules by vendor or category,
  billing materials for projects (only ticket charges bill), and expense approval or receipts.

- Not yet built: payments (the `partially_paid` and `paid` states and `amount_paid` exist), PDFs, email delivery,
  project invoices, credit memos, and the QuickBooks export.

## Open questions

1. Invoice grouping preference: one invoice per company per run, or per agreement?
2. Late fees: used today? Automatic or manual?
3. Block-hour agreements: how many exist and how are they replenished?
4. Sales tax: single code per company, or line-level? (Mirror shows `tax_code` at invoice level.)
5. Statements: required, or invoices only?
6. Are CW addition prices per month or per bill cycle? (Decides how the importer maps them.)
