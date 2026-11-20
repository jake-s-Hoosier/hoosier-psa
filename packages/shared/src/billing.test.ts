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
