import { describe, expect, it } from "vitest";
import { addDays, allocateOvertime, billedHours, payPeriodFor, workweekFor } from "./time.js";

describe("billedHours", () => {
  const quarter = { incrementMinutes: 15, mode: "up" as const };

  it("rounds up to the increment", () => {
    expect(billedHours(0.01, quarter)).toBe(0.25);
    expect(billedHours(0.25, quarter)).toBe(0.25);
    expect(billedHours(0.26, quarter)).toBe(0.5);
  });

  it("is stable around float noise", () => {
    expect(billedHours(0.1 + 0.15, quarter)).toBe(0.25); // 0.25000000000000006
  });

  it("applies the minimum block before rounding", () => {
    expect(billedHours(0.1, { ...quarter, minimumMinutes: 30 })).toBe(0.5);
    expect(billedHours(1.1, { ...quarter, minimumMinutes: 30 })).toBe(1.25);
  });

  it("supports nearest and down, and never bills zero time", () => {
    expect(billedHours(0.4, { incrementMinutes: 15, mode: "nearest" })).toBe(0.5); // 24 min -> 30
    expect(billedHours(0.4, { incrementMinutes: 15, mode: "down" })).toBe(0.25);
    expect(billedHours(0, { ...quarter, minimumMinutes: 30 })).toBe(0);
  });

  it("rejects bad input", () => {
    expect(() => billedHours(-1, quarter)).toThrow(RangeError);
  });
});

describe("pay periods and workweeks", () => {
  it("splits the month at the 15th", () => {
    expect(payPeriodFor("2026-11-15")).toEqual({ start: "2026-11-01", end: "2026-11-15" });
    expect(payPeriodFor("2026-11-16")).toEqual({ start: "2026-11-16", end: "2026-11-30" });
  });

  it("handles month lengths including leap February", () => {
    expect(payPeriodFor("2028-02-20").end).toBe("2028-02-29");
    expect(payPeriodFor("2026-02-20").end).toBe("2026-02-28");
    expect(payPeriodFor("2026-12-31").end).toBe("2026-12-31");
  });

  it("uses Sunday-Saturday workweeks", () => {
    // 2026-11-19 is a Thursday
    expect(workweekFor("2026-11-19")).toEqual({ start: "2026-11-15", end: "2026-11-21" });
    expect(workweekFor("2026-11-15").start).toBe("2026-11-15"); // Sunday starts its own week
    expect(workweekFor("2026-11-21").start).toBe("2026-11-15"); // Saturday ends it
  });

  it("does arithmetic across month and year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
  });
});

describe("allocateOvertime", () => {
  const day = (date: string, hours: number) => ({ date, hours });

  it("pays no overtime at or under the threshold", () => {
    // Week Sun 2026-11-01 .. Sat 2026-11-07, 40h exactly, fully inside period 11-01..11-15
    const entries = ["02", "03", "04", "05", "06"].map((d) => day(`2026-11-${d}`, 8));
    const [w] = allocateOvertime(entries, { start: "2026-11-01", end: "2026-11-15" });
    expect(w).toMatchObject({ weekTotal: 40, regularHours: 40, overtimeHours: 0 });
  });

  it("splits overtime inside a single period", () => {
    const entries = ["02", "03", "04", "05", "06"].map((d) => day(`2026-11-${d}`, 9)); // 45h
    const [w] = allocateOvertime(entries, { start: "2026-11-01", end: "2026-11-15" });
    expect(w).toMatchObject({ weekTotal: 45, regularHours: 40, overtimeHours: 5 });
  });

  it("defers overtime to the period that contains the end of the week", () => {
    // Week Sun 11-15 .. Sat 11-21 straddles the cut between period A (1-15) and B (16-30).
    const entries = [
      day("2026-11-15", 10), // period A
      day("2026-11-16", 10), // period B
      day("2026-11-17", 10),
      day("2026-11-18", 10),
      day("2026-11-19", 10), // 50h for the week
    ];
    const periodA = allocateOvertime(entries, { start: "2026-11-01", end: "2026-11-15" });
    const lastWeekA = periodA.at(-1);
    expect(lastWeekA).toMatchObject({
      settlesOvertime: false,
      hoursInPeriod: 10,
      regularHours: 10,
      overtimeHours: 0,
    });

    const periodB = allocateOvertime(entries, { start: "2026-11-16", end: "2026-11-30" });
    const firstWeekB = periodB[0];
    expect(firstWeekB).toMatchObject({
      settlesOvertime: true,
      hoursInPeriod: 40,
      weekTotal: 50,
      overtimeHours: 10,
      regularHours: 30,
    });
    // Nothing lost or double counted: 10 + 30 regular, 10 overtime = 50h.
    expect((lastWeekA?.regularHours ?? 0) + (firstWeekB?.regularHours ?? 0)).toBe(40);
  });

  it("flags overtime larger than the settling period's own hours", () => {
    // Period Dec 1-15, 2026. The week of Sun 11-29 starts in the prior period (Dec 1 is a Tuesday).
    const entries = [day("2026-11-29", 22.5), day("2026-11-30", 22.5), day("2026-12-01", 2)];
    const [w] = allocateOvertime(entries, { start: "2026-12-01", end: "2026-12-15" });
    expect(w).toMatchObject({
      weekTotal: 47,
      overtimeHours: 7,
      hoursInPeriod: 2,
      regularHours: -5,
      warnings: ["overtime_exceeds_period_hours"],
    });
  });

  it("validates input", () => {
    expect(() => allocateOvertime([], { start: "2026-11-10", end: "2026-11-01" })).toThrow(
      RangeError,
    );
    expect(() =>
      allocateOvertime([{ date: "2026-11-02", hours: -1 }], {
        start: "2026-11-01",
        end: "2026-11-15",
      }),
    ).toThrow(RangeError);
  });
});

import { DEFAULT_BILLING_ROUNDING, roundingRuleFor, workTypeBillRate } from "./time.js";

const wt = (over: Partial<Parameters<typeof workTypeBillRate>[1]> = {}) => ({
  rateType: "multiplier" as const,
  rateMultiplier: 1,
  customRate: null,
  rateAdjustment: null,
  hoursMin: 0,
  hoursMax: 0,
  roundBillingHoursTo: null,
  ...over,
});

describe("workTypeBillRate", () => {
  it("multiplies the role rate", () => {
    expect(workTypeBillRate(100, wt({ rateMultiplier: 1.5 }))).toBe(150);
  });
  it("uses a custom rate and ignores the role rate", () => {
    expect(workTypeBillRate(100, wt({ rateType: "custom", customRate: 197 }))).toBe(197);
  });
  it("adds an adjustment to the role rate and never goes negative", () => {
    expect(workTypeBillRate(100, wt({ rateType: "adjustment", rateAdjustment: -25 }))).toBe(75);
    expect(workTypeBillRate(10, wt({ rateType: "adjustment", rateAdjustment: -25 }))).toBe(0);
  });
  it("rejects a custom type without a rate", () => {
    expect(() => workTypeBillRate(100, wt({ rateType: "custom" }))).toThrow(RangeError);
  });
});

describe("roundingRuleFor and the maximum block", () => {
  it("applies the work type minimum (Onsite - Service bills at least 1 hour)", () => {
    const rule = roundingRuleFor(wt({ hoursMin: 1 }), DEFAULT_BILLING_ROUNDING);
    expect(billedHours(0.42, rule)).toBe(1);
    expect(billedHours(1.1, rule)).toBe(1.25);
  });
  it("caps billing at the work type maximum (Dispatch is capped at 1 hour)", () => {
    const rule = roundingRuleFor(wt({ hoursMax: 1 }), DEFAULT_BILLING_ROUNDING);
    expect(billedHours(2.5, rule)).toBe(1);
    expect(billedHours(0.4, rule)).toBe(0.5);
  });
  it("uses the work type's own increment when it defines one", () => {
    const rule = roundingRuleFor(wt({ roundBillingHoursTo: 0.5 }), DEFAULT_BILLING_ROUNDING);
    expect(billedHours(0.6, rule)).toBe(1);
  });
  it("matches CW history: 25 minutes bills as half an hour under the default", () => {
    expect(billedHours(0.42, DEFAULT_BILLING_ROUNDING)).toBe(0.5);
    expect(billedHours(2.33, DEFAULT_BILLING_ROUNDING)).toBe(2.5);
    expect(billedHours(1.67, DEFAULT_BILLING_ROUNDING)).toBe(1.75);
  });
});
