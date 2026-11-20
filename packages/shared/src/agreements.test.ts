import { describe, expect, it } from "vitest";
import {
  additionAmountForPeriod,
  agreementStatus,
  marginPct,
  monthlyCost,
  monthlyRevenue,
  renewalDue,
} from "./agreements.js";

const line = (over: Partial<Parameters<typeof monthlyRevenue>[0][number]> = {}) => ({
  quantity: 1,
  unitPrice: 100,
  unitCost: 40,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  prorate: true,
  ...over,
});

describe("agreementStatus", () => {
  const base = { startDate: "2026-01-01", endDate: null, autoRenew: true, cancelledDate: null };
  it("is pending before the start and active after", () => {
    expect(agreementStatus(base, "2025-12-31")).toBe("pending");
    expect(agreementStatus(base, "2026-01-01")).toBe("active");
  });
  it("keeps an auto-renewing agreement active past its end date", () => {
    expect(agreementStatus({ ...base, endDate: "2026-06-30" }, "2026-07-15")).toBe("active");
  });
  it("expires one that does not renew", () => {
    expect(
      agreementStatus({ ...base, endDate: "2026-06-30", autoRenew: false }, "2026-07-01"),
    ).toBe("expired");
  });
  it("covers through the cancellation date and reads cancelled the day after", () => {
    const c = { ...base, cancelledDate: "2026-03-15" };
    expect(agreementStatus(c, "2026-03-15")).toBe("active");
    expect(agreementStatus(c, "2026-03-16")).toBe("cancelled");
  });
});

describe("recurring revenue and cost", () => {
  it("counts only lines in effect on the date", () => {
    const lines = [
      line({ quantity: 2, unitPrice: 49.99 }),
      line({ unitPrice: 500, effectiveFrom: "2026-06-01" }),
      line({ unitPrice: 75, effectiveTo: "2026-02-28" }),
    ];
    expect(monthlyRevenue(lines, "2026-01-15")).toBe("174.98");
    expect(monthlyRevenue(lines, "2026-06-15")).toBe("599.98");
    expect(monthlyCost(lines, "2026-06-15")).toBe("120.00");
  });
  it("computes margin and tolerates zero revenue", () => {
    expect(marginPct("100.00", "40.00")).toBe(60);
    expect(marginPct("100", "130")).toBe(-30);
    expect(marginPct("0", "10")).toBeNull();
  });
});

describe("proration", () => {
  const june = { start: "2026-06-01", end: "2026-06-30" };
  it("bills a full month for a line in effect all period", () => {
    expect(additionAmountForPeriod(line({ unitPrice: 90 }), june)).toBe("90.00");
  });
  it("prorates a line starting mid-period by days", () => {
    expect(
      additionAmountForPeriod(line({ unitPrice: 90, effectiveFrom: "2026-06-16" }), june),
    ).toBe("45.00");
  });
  it("prorates a line ending mid-period", () => {
    expect(additionAmountForPeriod(line({ unitPrice: 90, effectiveTo: "2026-06-10" }), june)).toBe(
      "30.00",
    );
  });
  it("bills the full amount for a partial month when proration is off", () => {
    expect(
      additionAmountForPeriod(
        line({ unitPrice: 90, effectiveFrom: "2026-06-16", prorate: false }),
        june,
      ),
    ).toBe("90.00");
  });
  it("bills nothing outside the period", () => {
    expect(additionAmountForPeriod(line({ effectiveTo: "2026-05-31" }), june)).toBe("0.00");
    expect(additionAmountForPeriod(line({ effectiveFrom: "2026-07-01" }), june)).toBe("0.00");
  });
  it("multiplies a quarterly period by its months before prorating", () => {
    const q = { start: "2026-04-01", end: "2026-06-30" };
    expect(additionAmountForPeriod(line({ unitPrice: 100 }), q, 3)).toBe("300.00");
  });
});

describe("renewal window", () => {
  const a = { endDate: "2026-09-30", cancelledDate: null, renewalNoticeDays: 60 };
  it("is due within the notice window only", () => {
    expect(renewalDue(a, "2026-08-01")).toBe(true);
    expect(renewalDue(a, "2026-06-01")).toBe(false);
    expect(renewalDue(a, "2026-10-05")).toBe(false);
  });
  it("is never due once cancelled", () => {
    expect(renewalDue({ ...a, cancelledDate: "2026-08-01" }, "2026-08-02")).toBe(false);
  });
});
