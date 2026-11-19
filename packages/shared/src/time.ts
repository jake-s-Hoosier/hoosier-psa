/**
 * Pure time and payroll rules. No I/O, no clocks, no time zones: callers pass local ISO dates
 * ("YYYY-MM-DD") already resolved in the member's time zone. Specification: docs/04-time-and-payroll.md.
 */

export type IsoDate = string; // 'YYYY-MM-DD'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parse(date: IsoDate): Date {
  if (!ISO_DATE.test(date)) throw new RangeError(`Invalid ISO date: ${date}`);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const out = new Date(Date.UTC(y, m - 1, d));
  if (out.getUTCFullYear() !== y || out.getUTCMonth() !== m - 1 || out.getUTCDate() !== d) {
    throw new RangeError(`Invalid calendar date: ${date}`);
  }
  return out;
}

function format(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return format(d);
}

// ---------------------------------------------------------------------------------------------
// Billing rounding
// ---------------------------------------------------------------------------------------------

export interface RoundingRule {
  /** Increment in minutes, e.g. 15. 0 disables rounding. */
  incrementMinutes: number;
  mode: "up" | "nearest" | "down";
  /** Smallest billable block in minutes (applied before rounding), e.g. 30. */
  minimumMinutes?: number;
}

/** Converts actual hours into billed hours under a rounding rule. Zero stays zero. */
export function billedHours(actualHours: number, rule: RoundingRule): number {
  if (!Number.isFinite(actualHours) || actualHours < 0) {
    throw new RangeError("actualHours must be a non-negative finite number");
  }
  if (actualHours === 0) return 0;
  let minutes = actualHours * 60;
  if (rule.minimumMinutes && minutes < rule.minimumMinutes) minutes = rule.minimumMinutes;
  if (rule.incrementMinutes > 0) {
    const n = minutes / rule.incrementMinutes;
    // Guard against 14.999999999 style float noise before ceil/floor.
    const snapped = Math.abs(n - Math.round(n)) < 1e-9 ? Math.round(n) : n;
    const blocks =
      rule.mode === "up"
        ? Math.ceil(snapped)
        : rule.mode === "down"
          ? Math.floor(snapped)
          : Math.round(snapped);
    minutes = blocks * rule.incrementMinutes;
  }
  return Math.round((minutes / 60) * 100) / 100;
}

// ---------------------------------------------------------------------------------------------
// Pay periods and workweeks (Hoosier Security: semi-monthly 1-15 and 16-end; week Sun-Sat)
// ---------------------------------------------------------------------------------------------

export interface DateRange {
  start: IsoDate;
  end: IsoDate; // inclusive
}

export function lastDayOfMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/** Semi-monthly pay period containing the date: 1st-15th or 16th-end of month. */
export function payPeriodFor(date: IsoDate): DateRange {
  const d = parse(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const mm = String(m).padStart(2, "0");
  if (d.getUTCDate() <= 15) return { start: `${y}-${mm}-01`, end: `${y}-${mm}-15` };
  return { start: `${y}-${mm}-16`, end: `${y}-${mm}-${lastDayOfMonth(y, m)}` };
}

/** Workweek (Sunday through Saturday) containing the date. */
export function workweekFor(date: IsoDate): DateRange {
  const d = parse(date);
  const start = addDays(date, -d.getUTCDay());
  return { start, end: addDays(start, 6) };
}

export interface DailyHours {
  date: IsoDate;
  hours: number;
}

export type OvertimeWarning = "overtime_exceeds_period_hours";

export interface WeekOvertime {
  week: DateRange;
  /** Hours worked inside the pay period for this week. */
  hoursInPeriod: number;
  /** Hours worked in the whole week, including days outside the period. */
  weekTotal: number;
  /** True when the workweek ends inside the pay period (the period that settles overtime). */
  settlesOvertime: boolean;
  regularHours: number;
  overtimeHours: number;
  warnings: OvertimeWarning[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Overtime allocation for one pay period, per Hoosier Security's payroll rules:
 *  - Overtime is paid for worked hours beyond `thresholdHours` in a Sunday-Saturday week.
 *  - When a period ends mid-week, that period pays straight time for its part of the week.
 *  - The period containing the end of the week pays the rest of the week plus all overtime
 *    accrued across the whole week.
 *
 * `entries` must include every worked day of every workweek that touches the period,
 * including days in the neighbouring period, so the week total is complete.
 *
 * Edge case: if overtime exceeds the hours worked in the settling period (e.g. 45h in the prior
 * period's part of the week, 2h in this one), regularHours goes negative. That is correct
 * (it nets against straight time already paid) and is flagged with a warning for review.
 */
export function allocateOvertime(
  entries: DailyHours[],
  period: DateRange,
  thresholdHours = 40,
): WeekOvertime[] {
  parse(period.start);
  parse(period.end);
  if (period.end < period.start) throw new RangeError("period end precedes start");

  const weeks = new Map<IsoDate, DateRange>();
  for (let d = period.start; d <= period.end; d = addDays(d, 1)) {
    const w = workweekFor(d);
    weeks.set(w.start, w);
  }

  const result: WeekOvertime[] = [];
  for (const week of [...weeks.values()].sort((a, b) => a.start.localeCompare(b.start))) {
    let weekTotal = 0;
    let hoursInPeriod = 0;
    for (const e of entries) {
      if (e.hours < 0 || !Number.isFinite(e.hours)) throw new RangeError("hours must be >= 0");
      parse(e.date);
      if (e.date >= week.start && e.date <= week.end) {
        weekTotal += e.hours;
        if (e.date >= period.start && e.date <= period.end) hoursInPeriod += e.hours;
      }
    }
    const settlesOvertime = week.end <= period.end;
    const overtime = settlesOvertime ? Math.max(0, weekTotal - thresholdHours) : 0;
    const regular = hoursInPeriod - overtime;
    const warnings: OvertimeWarning[] = regular < 0 ? ["overtime_exceeds_period_hours"] : [];
    result.push({
      week,
      hoursInPeriod: round2(hoursInPeriod),
      weekTotal: round2(weekTotal),
      settlesOvertime,
      regularHours: round2(regular),
      overtimeHours: round2(overtime),
      warnings,
    });
  }
  return result;
}
