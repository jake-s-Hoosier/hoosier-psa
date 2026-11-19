import { Decimal } from "decimal.js";

/**
 * Money rules (docs/adr/0006-money-and-rounding.md):
 *  - Never use JavaScript numbers for currency arithmetic. Amounts travel as strings or Decimal.
 *  - Unit prices/costs keep 4 decimal places; every invoice line total is rounded to cents,
 *    half away from zero (ROUND_HALF_UP), and invoice totals are the sum of rounded lines.
 *  - Tax is computed per invoice per tax code on the taxable subtotal, then rounded once.
 */
const D = Decimal.clone({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type MoneyInput = string | number | Decimal;

export function dec(value: MoneyInput): Decimal {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new RangeError("Money amount must be finite");
  }
  return new D(value);
}

/** Round to whole cents. */
export function toCents(value: MoneyInput): Decimal {
  return dec(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Extended line amount: quantity x unit price, rounded to cents. */
export function lineTotal(quantity: MoneyInput, unitPrice: MoneyInput): Decimal {
  return toCents(dec(quantity).mul(dec(unitPrice)));
}

/** Sum of already-rounded amounts. */
export function sumMoney(values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(toCents(v)), dec(0));
}

/** Tax on a taxable subtotal at a percentage rate (e.g. 7 for 7%). */
export function taxOn(taxableSubtotal: MoneyInput, ratePct: MoneyInput): Decimal {
  return toCents(dec(taxableSubtotal).mul(dec(ratePct)).div(100));
}

/** Format for display, e.g. "$1,234.50". */
export function formatUsd(value: MoneyInput): string {
  const n = toCents(value);
  const [whole = "0", frac = "00"] = n.abs().toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${n.isNegative() ? "-" : ""}$${grouped}.${frac}`;
}

/**
 * Splits an amount across weights so the parts sum exactly to the total
 * (largest-remainder method). Used for prorations and partial payments.
 */
export function allocate(total: MoneyInput, weights: number[]): Decimal[] {
  if (weights.length === 0 || weights.some((w) => w < 0) || weights.every((w) => w === 0)) {
    throw new RangeError("weights must be non-negative and not all zero");
  }
  const totalCents = toCents(total).mul(100).toNumber();
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (totalCents * w) / weightSum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder -= 1;
  }
  return floors.map((c) => dec(c).div(100));
}
