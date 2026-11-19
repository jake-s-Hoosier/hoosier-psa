# 04. Time capture and payroll

Implemented in `packages/db/migrations/0006_timekeeping.sql` (storage and invariants) and
`packages/shared/src/time.ts` (rules, unit-tested).

## Entities

- **`timekeeping.time_entry`**: one block of work by one member for one company, charged to a service
  ticket, project ticket, agreement, or nothing specific (`non_ticket`, e.g. internal or sales time).
- **`timekeeping.leave_entry`**: PTO, holiday, sick and unpaid leave. Separate from time entries because
  it is never billed and has no company.
- **`timekeeping.pay_period`**: the payroll calendar. Periods cannot overlap.

## Capturing time

Three input modes produce the same record:

1. **Timer.** Start creates an entry with `is_timer = true`, `started_at = now()`, `ended_at = NULL`.
   Stop sets `ended_at` and computes hours. A partial unique index allows one running timer per member;
   starting another prompts to stop or switch.
2. **Start and end.** The member enters both times; hours are derived.
3. **Duration only.** The member enters hours for a date; no start or end is stored.

`actual_hours` is the real elapsed work. `billed_hours` is what the customer is charged after rounding.
Both are kept so margin analysis uses real effort and invoices use contractual time.

Each entry also records `notes` (customer-visible work description) and `internal_notes`. Posting a note
with time creates a `service.ticket_note` linked by `time_entry_id`.

## Rate snapshots

When an entry is written the system stores `bill_rate` and `cost_rate`:

```
bill_rate = override (ticket, then agreement)
            else by work_type.rate_type:
                   multiplier  -> work_role.hourly_rate x rate_multiplier
                   custom      -> custom_rate (the role rate is ignored)
                   adjustment  -> work_role.hourly_rate + rate_adjustment
cost_rate = member.hourly_cost
```

Work types also carry `bill_time` (`billable`, `do_not_bill`, `no_charge`; the default for a new entry's
billable setting), `hours_min` and `hours_max` per entry (0 means no cap) and an optional
`round_billing_hours_to`. Billed hours apply the minimum, then rounding, then the maximum. Example from
CW history: "Onsite - Service" is a custom rate with a one-hour minimum; "Dispatch" is capped at one hour.

Later changes to rate cards or member costs never alter existing entries. Re-pricing is an explicit,
audited action on open entries only.

## Billing rounding

`billedHours(actual, rule)` applies, in order: the minimum block (e.g. 30 minutes), then rounding to
an increment (e.g. 15 minutes) by `up`, `nearest` or `down`. Zero stays zero. The rule resolves from the
most specific source: agreement, then company, then work type, then the global default. The 15-minute round-up default matches CW history (99.8% of billed hours are quarter-hour multiples) but remains a placeholder until the docs/05 decisions. *(Resolution
order is specified here and implemented with agreements in milestone 2; today the function is applied
with an explicit rule.)*

## Lifecycle

```
open -> submitted -> approved -> billed
  \________________________\______> void
```

| State | Meaning | Editable by |
|---|---|---|
| `open` | Being worked or entered | The member; managers |
| `submitted` | Member says it is final for the period | The member (can recall); managers |
| `approved` | Manager or billing reviewed; eligible for invoicing | Managers with `timekeeping.time.write_all` |
| `billed` | On a posted invoice | Nobody (immutable) |
| `void` | Cancelled with a reason; excluded from billing and payroll | Nobody |

Database guards: a `billed` entry cannot be updated or deleted, and entries inside a `locked` or
`exported` pay period cannot be changed. Privileged code paths (for example crediting an invoice) set
`app.allow_locked_edit = 'on'` for their transaction, which is audited.

## Payroll rules (Hoosier Security)

- Pay periods are **semi-monthly**: the 1st-15th and the 16th-end of month. Pay dates are the 7th and
  22nd; the mapping of period to pay date is stored in `pay_period.pay_date` and confirmed against the
  Justworks calendar before use.
- The workweek runs **Sunday through Saturday**.
- **Overtime** is paid for worked hours beyond 40 in a workweek. PTO and holiday hours do not count
  as worked hours.
- A period can end mid-week. The period that ends mid-week pays straight time for its part of the week.
  The next period, the one containing the end of that week, pays the rest of the week plus all overtime
  accrued across the whole week.

`allocateOvertime(entries, period, threshold)` implements this per workweek touching a period and returns
`hoursInPeriod`, `weekTotal`, `regularHours`, `overtimeHours` and warnings. Callers must pass every worked
day of those weeks, including days in the neighbouring period.

**Worked example** (periods Nov 1-15 and Nov 16-30; week Sun Nov 15 to Sat Nov 21; 10 hours on each of
Nov 15, 16, 17, 18 and 19):

| Period | Hours in period | Week total | Regular | Overtime |
|---|---|---|---|---|
| Nov 1-15 | 10 (Sun 15th) | not settled | 10 | 0 |
| Nov 16-30 | 40 (Mon-Thu) | 50 | 30 | 10 |

Across both periods: 40 regular + 10 overtime = 50 worked hours, nothing lost or double counted.

**Edge case.** If overtime exceeds the settling period's own hours (a heavy first part of a week and a
light second part) `regularHours` is negative: it nets against straight time already paid. The result carries
the `overtime_exceeds_period_hours` warning and must be reviewed before export.

## Payroll export

For a period the export lists, per member: regular hours, overtime hours, PTO and holiday hours, in both
decimal and hours-and-minutes form (the format entered into Justworks today), plus warnings. The export
is a CSV and an on-screen review table. The period is `locked` when reviewed and `exported` when the file
is produced, after which entries in it cannot change. Justworks has declined a direct time API, so entry
into Justworks stays manual; the export replaces the spreadsheet and the hand conversion.

## Edge cases to handle in the UI and API

- Entries crossing midnight belong to the local date they started; split on request.
- Overlapping entries for one person are allowed but flagged (technicians legitimately multitask on
  remote work); overlaps are listed on the approval screen.
- A timer left running past a configurable limit raises a prompt and is flagged at approval.
- Entering time on a company whose status disallows new work (`allows_new_work = false`) is blocked unless
  overridden by a manager.
- Daylight saving changes: durations come from `timestamptz` differences, never from clock-time subtraction.

## Implemented API (milestone 1)

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/timesheets/submit` / `recall` | Member submits or recalls their own open/submitted time for a date range. Submit is refused while a timer is running. |
| `POST /api/v1/timesheets/approve` | Marks a member's submitted time approved. Needs `timekeeping.time.approve`; you cannot approve your own time. |
| `GET /api/v1/timesheets/summary` | Per-member entry and hour counts by status for a range. Needs `timekeeping.time.read_all`. |
| `POST /api/v1/pay-periods/generate` | Creates the 1-15 and 16-end periods for a month; safe to repeat. |
| `GET /api/v1/pay-periods/:id/payroll` | Review table for any period, with warnings and the count of unsubmitted entries. |
| `POST /api/v1/pay-periods/:id/lock` | Refused while any time in the period is still open; otherwise stamps entries and freezes them. |
| `POST /api/v1/pay-periods/:id/export?format=csv` | Requires a locked period; first call marks it exported. |

All pay-period endpoints need `timekeeping.period.lock`. Listing time entries shows your own unless you hold `timekeeping.time.read_all`.

Payroll counts **actual hours** of submitted, approved and billed time, whether or not it is billable.
*Assumption to confirm against the current spreadsheet:* CW-derived payroll uses actual (not billed) hours.
Pay dates are not set automatically; confirm the period-to-pay-date mapping with the Justworks calendar.
