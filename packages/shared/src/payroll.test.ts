import { describe, expect, it } from "vitest";
import { buildPayrollRow, payrollCsv, toHoursMinutes } from "./payroll.js";

describe("toHoursMinutes", () => {
  it("formats decimal hours as H:MM", () => {
    expect(toHoursMinutes(0)).toBe("0:00");
    expect(toHoursMinutes(1.5)).toBe("1:30");
    expect(toHoursMinutes(7.25)).toBe("7:15");
    expect(toHoursMinutes(40)).toBe("40:00");
  });
  it("rounds to the nearest minute and carries into the hour", () => {
    expect(toHoursMinutes(1.33)).toBe("1:20"); // 79.8 minutes
    expect(toHoursMinutes(0.999)).toBe("1:00"); // 59.94 minutes
  });
  it("keeps the sign for negative netting but never prints -0:00", () => {
    expect(toHoursMinutes(-0.5)).toBe("-0:30");
    expect(toHoursMinutes(-0.001)).toBe("0:00");
  });
  it("rejects non-finite input", () => {
    expect(() => toHoursMinutes(Number.NaN)).toThrow(RangeError);
  });
});

const day = (date: string, hours: number) => ({ date, hours });
const member = { memberId: 1, identifier: "JSmith", name: "Jane Smith" };

describe("buildPayrollRow", () => {
  // Week Sun 2026-11-15 .. Sat 11-21; 10h on each of the 15th-19th (docs/04 worked example).
  const worked = [
    day("2026-11-15", 10),
    day("2026-11-16", 10),
    day("2026-11-17", 10),
    day("2026-11-18", 10),
    day("2026-11-19", 10),
  ];

  it("pays straight time in the period that ends mid-week", () => {
    const r = buildPayrollRow(
      { ...member, worked, leave: [] },
      { start: "2026-11-01", end: "2026-11-15" },
    );
    expect(r).toMatchObject({ regularHours: 10, overtimeHours: 0, regularHm: "10:00" });
  });

  it("settles the whole week's overtime in the following period", () => {
    const r = buildPayrollRow(
      { ...member, worked, leave: [] },
      { start: "2026-11-16", end: "2026-11-30" },
    );
    expect(r).toMatchObject({ regularHours: 30, overtimeHours: 10, workedInPeriod: 40 });
    expect(r.regularHm).toBe("30:00");
    expect(r.overtimeHm).toBe("10:00");
  });

  it("nothing is lost across the two periods", () => {
    const a = buildPayrollRow(
      { ...member, worked, leave: [] },
      { start: "2026-11-01", end: "2026-11-15" },
    );
    const b = buildPayrollRow(
      { ...member, worked, leave: [] },
      { start: "2026-11-16", end: "2026-11-30" },
    );
    expect(a.regularHours + a.overtimeHours + b.regularHours + b.overtimeHours).toBe(50);
  });

  it("sums paid leave by type, only inside the period, and does not count it as worked", () => {
    const r = buildPayrollRow(
      {
        ...member,
        worked: [day("2026-11-16", 8)],
        leave: [
          { date: "2026-11-17", hours: 8, type: "pto" },
          { date: "2026-11-26", hours: 8, type: "holiday" },
          { date: "2026-12-01", hours: 8, type: "pto" }, // next period
        ],
      },
      { start: "2026-11-16", end: "2026-11-30" },
    );
    expect(r).toMatchObject({
      regularHours: 8,
      overtimeHours: 0,
      ptoHours: 8,
      holidayHours: 8,
      sickHours: 0,
    });
  });

  it("flags overtime that exceeds the settling period's own hours", () => {
    const r = buildPayrollRow(
      {
        ...member,
        worked: [
          day("2026-11-15", 12),
          day("2026-11-16", 12),
          day("2026-11-17", 12),
          day("2026-11-18", 12),
          day("2026-11-21", 1),
        ],
        leave: [],
      },
      { start: "2026-11-21", end: "2026-11-30" },
    );
    // Period holds 1h; week total 49h => 9h overtime, regular -8.
    expect(r.regularHours).toBe(-8);
    expect(r.overtimeHours).toBe(9);
    expect(r.warnings[0]).toContain("overtime_exceeds_period_hours");
  });
});

describe("payrollCsv", () => {
  it("writes a header and one CRLF-terminated line per member", () => {
    const row = buildPayrollRow(
      { ...member, worked: [day("2026-11-16", 7.5)], leave: [] },
      { start: "2026-11-16", end: "2026-11-30" },
    );
    const lines = payrollCsv([row]).split("\r\n");
    expect(lines[0]).toContain("Regular (h:mm)");
    expect(lines[1]).toBe(
      "JSmith,Jane Smith,7.50,7:30,0.00,0:00,0.00,0:00,0.00,0:00,0.00,0:00,0.00,",
    );
    expect(lines[2]).toBe("");
  });

  it("quotes commas and neutralises formula injection in names", () => {
    const row = buildPayrollRow(
      { memberId: 2, identifier: "x", name: '=HYPERLINK("evil"), Jr', worked: [], leave: [] },
      { start: "2026-11-16", end: "2026-11-30" },
    );
    const line = payrollCsv([row]).split("\r\n")[1] as string;
    expect(line.startsWith('x,"\'=HYPERLINK(""evil""), Jr"')).toBe(true);
  });
});
