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

## Open questions

1. Invoice grouping preference: one invoice per company per run, or per agreement?
2. Late fees: used today? Automatic or manual?
3. Block-hour agreements: how many exist and how are they replenished?
4. Sales tax: single code per company, or line-level? (Mirror shows `tax_code` at invoice level.)
5. Statements: required, or invoices only?
6. Are CW addition prices per month or per bill cycle? (Decides how the importer maps them.)
