import { type DailyHours, type DateRange, type IsoDate, allocateOvertime } from "./time.js";

/** Leave kinds that are paid and reported on the payroll export. Unpaid leave is excluded upstream. */
export type PaidLeaveType = "pto" | "holiday" | "sick" | "other";

export interface LeaveDay {
  date: IsoDate;
  hours: number;
  type: PaidLeaveType;
}

export interface PayrollMemberInput {
  memberId: number;
  identifier: string;
  name: string;
  /** Every worked day of every workweek touching the period (including the neighbouring period). */
  worked: DailyHours[];
  /** Leave inside the period only. */
  leave: LeaveDay[];
}

export interface PayrollRow {
  memberId: number;
  identifier: string;
  name: string;
  regularHours: number;
  overtimeHours: number;
  ptoHours: number;
  holidayHours: number;
  sickHours: number;
  otherLeaveHours: number;
  /** Worked hours inside the period (regular + overtime + any netting). */
  workedInPeriod: number;
  regularHm: string;
  overtimeHm: string;
  ptoHm: string;
  holidayHm: string;
  sickHm: string;
  warnings: string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Decimal hours to "H:MM", the format typed into Justworks. Rounds to the nearest whole minute
 * (59.5+ seconds carries into the next minute) and keeps the sign for negative netting.
 */
export function toHoursMinutes(decimalHours: number): string {
  if (!Number.isFinite(decimalHours)) throw new RangeError("hours must be finite");
  const totalMinutes = Math.round(Math.abs(decimalHours) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const sign = decimalHours < 0 && totalMinutes > 0 ? "-" : "";
  return `${sign}${h}:${String(m).padStart(2, "0")}`;
}

/** One member's payroll line for a period, applying the weekly overtime rules in time.ts. */
export function buildPayrollRow(
  input: PayrollMemberInput,
  period: DateRange,
  thresholdHours = 40,
): PayrollRow {
  const weeks = allocateOvertime(input.worked, period, thresholdHours);
  let regular = 0;
  let overtime = 0;
  let workedInPeriod = 0;
  const warnings: string[] = [];
  for (const w of weeks) {
    regular += w.regularHours;
    overtime += w.overtimeHours;
    workedInPeriod += w.hoursInPeriod;
    for (const warning of w.warnings) {
      warnings.push(`${warning} (week of ${w.week.start})`);
    }
  }
  const leave = { pto: 0, holiday: 0, sick: 0, other: 0 };
  for (const l of input.leave) {
    if (l.date < period.start || l.date > period.end) continue;
    leave[l.type] += l.hours;
  }
  const row: PayrollRow = {
    memberId: input.memberId,
    identifier: input.identifier,
    name: input.name,
    regularHours: round2(regular),
    overtimeHours: round2(overtime),
    ptoHours: round2(leave.pto),
    holidayHours: round2(leave.holiday),
    sickHours: round2(leave.sick),
    otherLeaveHours: round2(leave.other),
    workedInPeriod: round2(workedInPeriod),
    regularHm: "",
    overtimeHm: "",
    ptoHm: "",
    holidayHm: "",
    sickHm: "",
    warnings,
  };
  row.regularHm = toHoursMinutes(row.regularHours);
  row.overtimeHm = toHoursMinutes(row.overtimeHours);
  row.ptoHm = toHoursMinutes(row.ptoHours);
  row.holidayHm = toHoursMinutes(row.holidayHours);
  row.sickHm = toHoursMinutes(row.sickHours);
  return row;
}

/** Neutralises spreadsheet formula injection and quotes fields that need it. */
function csvField(value: string | number): string {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && typeof value === "string") s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const PAYROLL_CSV_HEADER = [
  "Identifier",
  "Name",
  "Regular (decimal)",
  "Regular (h:mm)",
  "Overtime (decimal)",
  "Overtime (h:mm)",
  "PTO (decimal)",
  "PTO (h:mm)",
  "Holiday (decimal)",
  "Holiday (h:mm)",
  "Sick (decimal)",
  "Sick (h:mm)",
  "Other leave (decimal)",
  "Warnings",
] as const;

export function payrollCsv(rows: PayrollRow[]): string {
  const lines = [PAYROLL_CSV_HEADER.map(csvField).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.identifier,
        r.name,
        r.regularHours.toFixed(2),
        r.regularHm,
        r.overtimeHours.toFixed(2),
        r.overtimeHm,
        r.ptoHours.toFixed(2),
        r.ptoHm,
        r.holidayHours.toFixed(2),
        r.holidayHm,
        r.sickHours.toFixed(2),
        r.sickHm,
        r.otherLeaveHours.toFixed(2),
        r.warnings.join("; "),
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
