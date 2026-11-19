import { describe, expect, it } from "vitest";
import { allocate, formatUsd, lineTotal, sumMoney, taxOn, toCents } from "./money.js";

describe("money", () => {
  it("avoids binary floating point error", () => {
    expect(toCents(0.1 + 0.2).toString()).toBe("0.3");
    expect(sumMoney(["0.10", "0.20"]).toString()).toBe("0.3");
  });

  it("rounds half away from zero at the cent", () => {
    expect(toCents("1.005").toString()).toBe("1.01");
    expect(toCents("-1.005").toString()).toBe("-1.01");
  });

  it("rounds each invoice line, not the grand total", () => {
    // 3 x 0.3333 = 0.9999 -> 1.00 per line; two such lines total 2.00 (not 1.9998 -> 2.00 by luck)
    expect(lineTotal(3, "0.3333").toString()).toBe("1");
    expect(lineTotal("2.5", "19.99").toString()).toBe("49.98"); // 49.975 -> 49.98
  });

  it("computes tax once on the taxable subtotal", () => {
    expect(taxOn("100.00", 7).toString()).toBe("7");
    expect(taxOn("19.99", 7).toString()).toBe("1.4"); // 1.3993 -> 1.40
  });

  it("formats USD with grouping and sign", () => {
    expect(formatUsd("1234.5")).toBe("$1,234.50");
    expect(formatUsd("-0.5")).toBe("-$0.50");
    expect(formatUsd(1000000)).toBe("$1,000,000.00");
  });

  it("allocates cents without losing or inventing a penny", () => {
    const parts = allocate("100.00", [1, 1, 1]);
    expect(parts.map((p) => p.toFixed(2))).toEqual(["33.34", "33.33", "33.33"]);
    expect(sumMoney(parts.map((p) => p.toString())).toString()).toBe("100");
    expect(() => allocate("10", [0, 0])).toThrow(RangeError);
  });

  it("rejects non-finite numbers", () => {
    expect(() => toCents(Number.NaN)).toThrow(RangeError);
  });
});
