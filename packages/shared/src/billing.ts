import { type BillCycle, CYCLE_MONTHS, addDaysIso, additionAmountForPeriod } from "./agreements.js";
import { dec, lineTotal, taxOn, toCents } from "./money.js";
import type { IsoDate } from "./time.js";

/**
 * Billing run rules (docs/05-billing-and-agreements.md). Pure and unit-tested: the API builds draft
 * invoices from these, so what the reviewer sees is exactly what posting will number.
 */

export interface BillingPeriod {
  start: IsoDate;
  end: IsoDate;
}

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const iso = (y: number, m: number, d: number): IsoDate =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** The k-th cycle start: the anchor shifted by k cycles, keeping the anchor's day (clamped to month end). */
function cycleStart(anchor: IsoDate, months: number, k: number): IsoDate {
  const y = Number(anchor.slice(0, 4));
  const m = Number(anchor.slice(5, 7));
  const d = Number(anchor.slice(8, 10));
  const total = y * 12 + (m - 1) + months * k;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return iso(ny, nm, Math.min(d, daysIn(ny, nm)));
}

/**
 * The billing period that starts inside a calendar month, or null when none does. Periods start at
 * the agreement's bill start date and repeat every cycle; each is billed in advance, in the month it
 * starts. `month` is "YYYY-MM".
 */
export function periodStartingIn(
  billStartDate: IsoDate,
  cycle: BillCycle,
  month: string,
): BillingPeriod | null {
  const months = CYCLE_MONTHS[cycle];
  const by = Number(billStartDate.slice(0, 4));
  const bm = Number(billStartDate.slice(5, 7));
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const diff = y * 12 + m - (by * 12 + bm);
  if (diff < 0 || diff % months !== 0) return null;
  const k = diff / months;
  return {
    start: cycleStart(billStartDate, months, k),
    end: addDaysIso(cycleStart(billStartDate, months, k + 1), -1),
  };
}

export interface BillableAddition {
  id: number;
  description: string;
  quantity: number | string;
  unitPrice: number | string;
  unitCost: number | string;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  prorate: boolean;
}

export interface AgreementInvoiceLine {
  additionId: number;
  description: string;
  quantity: string;
  /** Price per unit for the whole period (monthly price times the cycle's months), before proration. */
  unitPrice: string;
  unitCost: string;
  /** What is billed: prorated when the line is in effect for part of the period. */
  amount: string;
  /** The cost of the same lines, so margin reports can compare. */
  costAmount: string;
  prorated: boolean;
}

/** Lines one agreement bills for a period; lines not in effect during the period are left out. */
export function agreementInvoiceLines(
  additions: BillableAddition[],
  cycle: BillCycle,
  period: BillingPeriod,
): AgreementInvoiceLine[] {
  const months = CYCLE_MONTHS[cycle];
  const lines: AgreementInvoiceLine[] = [];
  for (const a of additions) {
    // Lines wholly outside the period are left out; a zero-priced line in effect is kept.
    if (a.effectiveFrom > period.end || (a.effectiveTo !== null && a.effectiveTo < period.start))
      continue;
    const amount = additionAmountForPeriod(a, period, months);
    const costAmount = additionAmountForPeriod({ ...a, unitPrice: a.unitCost }, period, months);
    const full = toCents(dec(a.quantity).mul(dec(a.unitPrice)).mul(months)).toFixed(2);
    lines.push({
      additionId: a.id,
      description: a.description,
      quantity: dec(a.quantity).toString(),
      unitPrice: dec(a.unitPrice).mul(months).toFixed(4),
      unitCost: dec(a.unitCost).mul(months).toFixed(4),
      amount,
      costAmount,
      prorated: a.prorate && amount !== full,
    });
  }
  return lines;
}

export interface TotalsInput {
  amount: string | number;
  taxable: boolean;
}

export interface InvoiceTotals {
  subtotal: string;
  taxable: string;
  tax: string;
  total: string;
}

/**
 * Invoice totals: the subtotal is the sum of rounded lines; tax is computed once on the taxable
 * subtotal and rounded once (ADR 0006). A tax-exempt customer pays none.
 */
export function invoiceTotals(
  lines: TotalsInput[],
  taxRatePct: string | number,
  taxExempt = false,
): InvoiceTotals {
  const subtotal = lines.reduce((s, l) => s.plus(toCents(l.amount)), dec(0));
  const taxable = lines
    .filter((l) => l.taxable)
    .reduce((s, l) => s.plus(toCents(l.amount)), dec(0));
  const tax = taxExempt ? dec(0) : taxOn(taxable, taxRatePct);
  return {
    subtotal: subtotal.toFixed(2),
    taxable: taxable.toFixed(2),
    tax: tax.toFixed(2),
    total: subtotal.plus(tax).toFixed(2),
  };
}

/** Due date from the invoice date and the customer's terms; due on receipt without terms. */
export const dueDate = (invoiceDate: IsoDate, dueDays: number | null): IsoDate =>
  addDaysIso(invoiceDate, dueDays ?? 0);

// ---- Ticket time (docs/05 "Invoicing other work") ----

export type TicketBillingMethod = "actual_rates" | "fixed_fee" | "not_to_exceed" | "override_rate";

export interface TicketBillingInput {
  method: TicketBillingMethod;
  /** Fixed fee, the not-to-exceed cap, or the override hourly rate; null when none was set. */
  amount: string | number | null;
  closed: boolean;
  /** A fixed-fee line is already on a non-void invoice. */
  feeBilled: boolean;
  /** Already billed on earlier invoices for this ticket (counts against a not-to-exceed cap). */
  billedSoFar: string | number;
  /** Time still open or submitted: a fixed fee waits until everything is approved. */
  unapprovedEntries: number;
}

export interface TimeBillingEntry {
  id: number;
  workDate: IsoDate;
  actualHours: string | number;
  /** Hours after the billing rounding rule. */
  billedHours: string | number;
  billRate: string | number;
  costRate: string | number;
  /** False for no-charge and do-not-bill time: never billed hourly, but its cost still counts. */
  billable: boolean;
}

export interface TicketBillingLine {
  kind: "hourly" | "capped" | "fixed_fee";
  quantity: string;
  unitPrice: string;
  amount: string;
  costAmount: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  /** Every entry this line accounts for; they are marked billed together. */
  entryIds: number[];
  /** Hours worth showing next to a capped or fixed line. */
  hours: string;
}

export interface TicketBillingResult {
  lines: TicketBillingLine[];
  skip: string | null;
}

const costOf = (es: TimeBillingEntry[]) =>
  toCents(es.reduce((s, e) => s.plus(dec(e.costRate).mul(dec(e.actualHours))), dec(0))).toFixed(2);
const span = (es: TimeBillingEntry[]) => {
  const days = es.map((e) => e.workDate).sort();
  return { start: days[0] ?? "", end: days[days.length - 1] ?? "" };
};
const hoursOf = (es: TimeBillingEntry[]) => es.reduce((s, e) => s.plus(dec(e.billedHours)), dec(0));

/**
 * What one ticket's approved, unbilled time bills, by the ticket's billing method:
 *  - actual_rates: billed hours x the rate snapshotted on each entry, one line per rate.
 *  - override_rate: billed hours x the ticket's override rate, one line.
 *  - not_to_exceed: as actual_rates, capped at the cap less what earlier invoices already billed; the
 *    hours over the cap are written off, not carried forward.
 *  - fixed_fee: one line for the fee once the ticket is closed and all its time is approved. Time is kept
 *    for cost, never billed.
 * Rates come from the entries (snapshots), never the current rate card.
 */
export function ticketInvoiceLines(
  t: TicketBillingInput,
  entries: TimeBillingEntry[],
): TicketBillingResult {
  const none = (skip: string): TicketBillingResult => ({ lines: [], skip });
  const billable = entries.filter((e) => e.billable && dec(e.billedHours).gt(0));
  const needsAmount = t.method !== "actual_rates";
  if (needsAmount && (t.amount === null || dec(t.amount).lte(0)))
    return none("The ticket's billing method needs an amount");

  if (t.method === "fixed_fee") {
    if (t.feeBilled) return none("Fixed fee already billed");
    if (!t.closed) return none("Fixed-fee ticket is not closed");
    if (t.unapprovedEntries > 0) return none("Fixed-fee ticket has time that is not approved yet");
    const { start, end } = span(entries);
    const day = entries.length > 0 ? { start, end } : null;
    return {
      skip: null,
      lines: [
        {
          kind: "fixed_fee",
          quantity: "1",
          unitPrice: toCents(t.amount as string).toFixed(4),
          amount: toCents(t.amount as string).toFixed(2),
          costAmount: costOf(entries),
          periodStart: day?.start ?? "",
          periodEnd: day?.end ?? "",
          entryIds: entries.map((e) => e.id),
          hours: hoursOf(entries.filter((e) => dec(e.billedHours).gt(0))).toString(),
        },
      ],
    };
  }

  if (billable.length === 0) return none("No approved billable time");

  if (t.method === "override_rate" || t.method === "actual_rates") {
    const groups = new Map<string, TimeBillingEntry[]>();
    for (const e of billable) {
      const rate =
        t.method === "override_rate"
          ? toCents(t.amount as string).toFixed(2)
          : toCents(e.billRate).toFixed(2);
      groups.set(rate, [...(groups.get(rate) ?? []), e]);
    }
    const lines = [...groups.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map<TicketBillingLine>(([rate, es]) => {
        const qty = hoursOf(es);
        const { start, end } = span(es);
        return {
          kind: "hourly",
          quantity: qty.toString(),
          unitPrice: dec(rate).toFixed(4),
          amount: lineTotal(qty, rate).toFixed(2),
          costAmount: costOf(es),
          periodStart: start,
          periodEnd: end,
          entryIds: es.map((e) => e.id),
          hours: qty.toString(),
        };
      });
    return { lines, skip: null };
  }

  // not_to_exceed
  const groups = new Map<string, TimeBillingEntry[]>();
  for (const e of billable) {
    const rate = toCents(e.billRate).toFixed(2);
    groups.set(rate, [...(groups.get(rate) ?? []), e]);
  }
  const worth = [...groups.entries()].reduce(
    (s, [rate, es]) => s.plus(lineTotal(hoursOf(es), rate)),
    dec(0),
  );
  const remaining = dec(t.amount as string).minus(dec(t.billedSoFar));
  if (remaining.lte(0)) return none("Not-to-exceed amount already billed");
  const bill = worth.lessThan(remaining) ? worth : remaining;
  const { start, end } = span(billable);
  return {
    skip: null,
    lines: [
      {
        kind: "capped",
        quantity: "1",
        unitPrice: toCents(bill).toFixed(4),
        amount: toCents(bill).toFixed(2),
        costAmount: costOf(billable),
        periodStart: start,
        periodEnd: end,
        entryIds: billable.map((e) => e.id),
        hours: hoursOf(billable).toString(),
      },
    ],
  };
}
