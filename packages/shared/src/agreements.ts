import { dec, toCents } from "./money.js";

/**
 * Agreement rules (docs/05-billing-and-agreements.md). Pure functions, unit-tested; the API and the
 * future billing run both use them so a figure on screen is the figure that is billed.
 */
import type { IsoDate } from "./time.js";
export type BillCycle = "monthly" | "quarterly" | "semi_annual" | "annual";
export type Coverage = "none" | "block_hours" | "unlimited_remote" | "covered";
export type AgreementStatus = "pending" | "active" | "expired" | "cancelled";

export const BILL_CYCLES: readonly BillCycle[] = ["monthly", "quarterly", "semi_annual", "annual"];
export const COVERAGES: readonly Coverage[] = [
  "none",
  "block_hours",
  "unlimited_remote",
  "covered",
];
export const CYCLE_MONTHS: Record<BillCycle, number> = {
  monthly: 1,
  quarterly: 3,
  semi_annual: 6,
  annual: 12,
};
export const COVERAGE_LABEL: Record<Coverage, string> = {
  none: "No coverage",
  block_hours: "Block hours",
  unlimited_remote: "Unlimited remote",
  covered: "Labor covered",
};

const DAY_MS = 86_400_000;
const ms = (d: IsoDate) => Date.parse(`${d}T00:00:00Z`);
const isoOf = (t: number) => new Date(t).toISOString().slice(0, 10);

export const addDaysIso = (d: IsoDate, n: number): IsoDate => isoOf(ms(d) + n * DAY_MS);
/** Inclusive number of days from a to b. */
export const daysInclusive = (a: IsoDate, b: IsoDate): number =>
  Math.max(0, Math.round((ms(b) - ms(a)) / DAY_MS) + 1);

export interface AgreementTerms {
  startDate: IsoDate;
  endDate: IsoDate | null;
  autoRenew: boolean;
  cancelledDate: IsoDate | null;
}

/**
 * The cancellation date is the last day of coverage, so the agreement reads as cancelled from the day
 * after it. Pending before the start; an agreement past its end
 * date is expired unless it auto-renews, in which case it simply continues.
 */
export function agreementStatus(a: AgreementTerms, today: IsoDate): AgreementStatus {
  if (a.cancelledDate !== null && a.cancelledDate < today) return "cancelled";
  if (a.startDate > today) return "pending";
  if (a.endDate !== null && a.endDate < today && !a.autoRenew) return "expired";
  return "active";
}

export interface AdditionTerms {
  quantity: number | string;
  unitPrice: number | string;
  unitCost: number | string;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  prorate: boolean;
}

export const additionActiveOn = (a: AdditionTerms, date: IsoDate): boolean =>
  a.effectiveFrom <= date && (a.effectiveTo === null || a.effectiveTo >= date);

const monthly = (a: AdditionTerms, price: "unitPrice" | "unitCost") =>
  toCents(dec(a.quantity).mul(dec(a[price])));

/** Monthly recurring revenue: quantity x unit price of every line in effect on the date. */
export function monthlyRevenue(additions: AdditionTerms[], asOf: IsoDate): string {
  return additions
    .filter((a) => additionActiveOn(a, asOf))
    .reduce((s, a) => s.plus(monthly(a, "unitPrice")), dec(0))
    .toFixed(2);
}

/** Monthly recurring cost of the same lines. */
export function monthlyCost(additions: AdditionTerms[], asOf: IsoDate): string {
  return additions
    .filter((a) => additionActiveOn(a, asOf))
    .reduce((s, a) => s.plus(monthly(a, "unitCost")), dec(0))
    .toFixed(2);
}

/** Margin as a percentage of revenue, or null when there is no revenue. */
export function marginPct(revenue: string | number, cost: string | number): number | null {
  const r = dec(revenue);
  if (r.isZero()) return null;
  return r.minus(dec(cost)).div(r).mul(100).toDecimalPlaces(1).toNumber();
}

/**
 * What one addition bills for a period of whole days. A line that is only partly in effect is
 * prorated by days when its prorate flag is set; without the flag any overlap bills the full month.
 * A period covering several months bills months x the monthly amount before proration.
 */
export function additionAmountForPeriod(
  a: AdditionTerms,
  period: { start: IsoDate; end: IsoDate },
  months = 1,
): string {
  const from = a.effectiveFrom > period.start ? a.effectiveFrom : period.start;
  const to = a.effectiveTo !== null && a.effectiveTo < period.end ? a.effectiveTo : period.end;
  const overlap = daysInclusive(from, to);
  if (overlap === 0) return "0.00";
  const full = dec(a.quantity).mul(dec(a.unitPrice)).mul(months);
  if (!a.prorate || overlap === daysInclusive(period.start, period.end))
    return toCents(full).toFixed(2);
  return toCents(full.mul(overlap).div(daysInclusive(period.start, period.end))).toFixed(2);
}

/** Days until the term ends, when the agreement has an end date and is not cancelled. */
export function daysToRenewal(
  a: Pick<AgreementTerms, "endDate" | "cancelledDate">,
  today: IsoDate,
): number | null {
  if (a.endDate === null || a.cancelledDate !== null) return null;
  return Math.round((ms(a.endDate) - ms(today)) / DAY_MS);
}

export const renewalDue = (
  a: Pick<AgreementTerms, "endDate" | "cancelledDate"> & { renewalNoticeDays: number },
  today: IsoDate,
): boolean => {
  const d = daysToRenewal(a, today);
  return d !== null && d >= 0 && d <= a.renewalNoticeDays;
};
