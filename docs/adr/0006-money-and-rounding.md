# 0006. Money representation and rounding

Status: Accepted
Date: 2026-11-19

## Context
Billing, tax, proration and accounting export must reconcile to the cent against ConnectWise and
QuickBooks. Floating-point arithmetic produces off-by-a-cent errors that surface as reconciliation noise.
Distributor unit pricing often needs more than two decimal places.

## Decision
- Database: `numeric`. Amounts are `numeric(14,2)`; unit prices and unit costs are `numeric(14,4)`.
- Application: money is a `decimal.js` value or a string; JavaScript `number` is never used for currency
  arithmetic (`packages/shared/src/money.ts`).
- Rounding: **half away from zero** (`ROUND_HALF_UP`) to cents, applied to each invoice line's extended amount
  (`quantity x unit price`). An invoice's subtotal is the sum of rounded lines. Tax is computed once per
  invoice per tax code on the taxable subtotal and rounded once.
- Splitting an amount (proration, partial payments) uses largest-remainder allocation so the parts sum exactly
  to the whole.
- Stored amounts never change when rate cards change; lines and time entries carry snapshots.

## Consequences
- The rounding rule is explicit and testable; if CW or QuickBooks round differently the reconciliation reports
  show it and this ADR is updated, not the tests silently.
- Slightly more verbose code than native numbers; worth it for correctness.

## Alternatives considered
- **Integer cents everywhere.** Simple, but awkward for four-decimal unit prices and tax rates.
- **Round only the invoice total.** Produces line items that do not sum to the displayed total.
