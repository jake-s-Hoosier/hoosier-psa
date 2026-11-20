import { type BillCycle, CYCLE_MONTHS, addDaysIso, additionAmountForPeriod } from "./agreements.js";
import { dec, taxOn, toCents } from "./money.js";
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
