import { describe, expect, it } from "vitest";
import { agreementInvoiceLines, dueDate, invoiceTotals, periodStartingIn } from "./billing.js";

const line = (over: object = {}) => ({
  id: 1,
  description: "Camera licence",
  quantity: 4,
  unitPrice: 10,
  unitCost: 6,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  prorate: true,
  ...over,
});

describe("periodStartingIn", () => {
  it("bills monthly agreements every month, anchored on the start day", () => {
    expect(periodStartingIn("2026-01-15", "monthly", "2026-03")).toEqual({
      start: "2026-03-15",
      end: "2026-04-14",
    });
  });
  it("bills quarterly agreements only in the months a cycle starts", () => {
    expect(periodStartingIn("2026-01-01", "quarterly", "2026-04")).toEqual({
      start: "2026-04-01",
      end: "2026-06-30",
    });
    expect(periodStartingIn("2026-01-01", "quarterly", "2026-05")).toBeNull();
    expect(periodStartingIn("2026-01-01", "annual", "2027-01")?.end).toBe("2027-12-31");
  });
  it("is null before the first cycle and clamps a late anchor day to month end", () => {
    expect(periodStartingIn("2026-03-01", "monthly", "2026-02")).toBeNull();
    expect(periodStartingIn("2026-01-31", "monthly", "2026-02")).toEqual({
      start: "2026-02-28",
      end: "2026-03-30",
    });
    expect(periodStartingIn("2026-01-31", "monthly", "2026-03")?.start).toBe("2026-03-31");
  });
  it("crosses year ends", () => {
    expect(periodStartingIn("2026-11-01", "semi_annual", "2027-05")).toEqual({
      start: "2027-05-01",
      end: "2027-10-31",
    });
  });
});

describe("agreementInvoiceLines", () => {
  const period = { start: "2026-04-01", end: "2026-06-30" };
  it("multiplies the monthly price by the cycle's months", () => {
    const [l] = agreementInvoiceLines([line()], "quarterly", period);
    expect(l).toMatchObject({
      amount: "120.00",
      costAmount: "72.00",
      unitPrice: "30.0000",
      prorated: false,
    });
  });
  it("prorates a line that starts or ends inside the period, only when asked", () => {
    const late = line({ effectiveFrom: "2026-05-16" });
    const [p] = agreementInvoiceLines([late], "quarterly", period);
    expect(p).toMatchObject({ prorated: true });
    expect(Number(p?.amount)).toBeLessThan(120);
    const [f] = agreementInvoiceLines([{ ...late, prorate: false }], "quarterly", period);
    expect(f).toMatchObject({ amount: "120.00", prorated: false });
  });
  it("leaves out lines outside the period and keeps zero-priced lines in effect", () => {
    expect(
      agreementInvoiceLines([line({ effectiveTo: "2026-03-31" })], "quarterly", period),
    ).toEqual([]);
    expect(
      agreementInvoiceLines([line({ effectiveFrom: "2026-07-01" })], "quarterly", period),
    ).toEqual([]);
    const [z] = agreementInvoiceLines([line({ unitPrice: 0 })], "monthly", {
      start: "2026-04-01",
      end: "2026-04-30",
    });
    expect(z?.amount).toBe("0.00");
  });
});

describe("invoiceTotals", () => {
  it("rounds tax once on the taxable subtotal", () => {
    const t = invoiceTotals(
      [
        { amount: "10.01", taxable: true },
        { amount: "10.01", taxable: true },
        { amount: "5.00", taxable: false },
      ],
      7,
    );
    expect(t).toEqual({ subtotal: "25.02", taxable: "20.02", tax: "1.40", total: "26.42" });
  });
  it("charges no tax to an exempt customer", () => {
    expect(invoiceTotals([{ amount: 100, taxable: true }], 7, true).tax).toBe("0.00");
  });
});

describe("dueDate", () => {
  it("adds the terms' days, or is due on receipt", () => {
    expect(dueDate("2026-04-01", 30)).toBe("2026-05-01");
    expect(dueDate("2026-04-01", null)).toBe("2026-04-01");
  });
});

import { ticketInvoiceLines } from "./billing.js";

describe("ticketInvoiceLines", () => {
  const ticket = (over: object = {}) => ({
    method: "actual_rates" as const,
    amount: null,
    closed: false,
    feeBilled: false,
    billedSoFar: 0,
    unapprovedEntries: 0,
    ...over,
  });
  const entry = (id: number, hours: number, rate: number, over: object = {}) => ({
    id,
    workDate: `2026-11-0${id}`,
    actualHours: hours,
    billedHours: hours,
    billRate: rate,
    costRate: 30,
    billable: true,
    ...over,
  });

  it("bills actual rates with one line per rate, from the entries' own snapshots", () => {
    const r = ticketInvoiceLines(ticket(), [
      entry(1, 1.5, 125),
      entry(2, 2, 125),
      entry(3, 1, 187.5),
    ]);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({
      quantity: "3.5",
      unitPrice: "125.0000",
      amount: "437.50",
      entryIds: [1, 2],
      periodStart: "2026-11-01",
      periodEnd: "2026-11-02",
    });
    expect(r.lines[1]).toMatchObject({ amount: "187.50", costAmount: "30.00" });
    expect(r.lines[0]?.costAmount).toBe("105.00");
  });
  it("skips non-billable and zero-hour time, and says so when nothing is left", () => {
    expect(
      ticketInvoiceLines(ticket(), [
        entry(1, 2, 100, { billable: false }),
        entry(2, 0, 100, { billedHours: 0 }),
      ]).skip,
    ).toMatch(/No approved billable/);
  });
  it("bills an override rate for every hour", () => {
    const r = ticketInvoiceLines(ticket({ method: "override_rate", amount: 90 }), [
      entry(1, 2, 125),
      entry(2, 1, 187.5),
    ]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ quantity: "3", unitPrice: "90.0000", amount: "270.00" });
  });
  it("caps not-to-exceed at what is left of the cap", () => {
    const t = ticket({ method: "not_to_exceed", amount: 300 });
    expect(ticketInvoiceLines(t, [entry(1, 1, 125)]).lines[0]).toMatchObject({
      kind: "capped",
      amount: "125.00",
    });
    expect(ticketInvoiceLines(t, [entry(1, 4, 125)]).lines[0]).toMatchObject({
      amount: "300.00",
      hours: "4",
    });
    expect(
      ticketInvoiceLines({ ...t, billedSoFar: 250 }, [entry(1, 4, 125)]).lines[0],
    ).toMatchObject({ amount: "50.00" });
    expect(ticketInvoiceLines({ ...t, billedSoFar: 300 }, [entry(1, 1, 125)]).skip).toMatch(
      /already billed/,
    );
  });
  it("bills a fixed fee once, when the ticket is closed and all time is approved", () => {
    const t = ticket({ method: "fixed_fee", amount: 500, closed: true });
    const r = ticketInvoiceLines(t, [entry(1, 2, 125), entry(2, 1, 125, { billable: false })]);
    expect(r.lines[0]).toMatchObject({
      kind: "fixed_fee",
      amount: "500.00",
      entryIds: [1, 2],
      costAmount: "90.00",
    });
    expect(ticketInvoiceLines({ ...t, closed: false }, [entry(1, 1, 1)]).skip).toMatch(
      /not closed/,
    );
    expect(ticketInvoiceLines({ ...t, feeBilled: true }, [entry(1, 1, 1)]).skip).toMatch(
      /already billed/,
    );
    expect(ticketInvoiceLines({ ...t, unapprovedEntries: 1 }, [entry(1, 1, 1)]).skip).toMatch(
      /not approved/,
    );
  });
  it("needs an amount for fixed, capped and override methods", () => {
    for (const method of ["fixed_fee", "not_to_exceed", "override_rate"] as const)
      expect(ticketInvoiceLines(ticket({ method }), [entry(1, 1, 100)]).skip).toMatch(
        /needs an amount/,
      );
  });
});
