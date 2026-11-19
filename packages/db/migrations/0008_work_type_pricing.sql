-- 0008_work_type_pricing
-- ConnectWise work types are richer than a rate multiplier (found by profiling the mirror):
--   * rate type: multiplier of the work role rate, a custom absolute rate, or a role rate plus an adjustment
--   * bill_time: billable / do not bill / no charge
--   * minimum and maximum billable hours per entry (e.g. Onsite - Service bills at least 1 hour,
--     Dispatch is capped at 1 hour)
--   * optional rounding increment in hours
-- docs/04-time-and-payroll.md describes how these combine.

ALTER TABLE catalog.work_type
  ADD COLUMN rate_type text NOT NULL DEFAULT 'multiplier'
    CHECK (rate_type IN ('multiplier', 'custom', 'adjustment')),
  ADD COLUMN custom_rate numeric(10,2) CHECK (custom_rate >= 0),
  ADD COLUMN rate_adjustment numeric(10,2),
  ADD COLUMN bill_time text NOT NULL DEFAULT 'billable'
    CHECK (bill_time IN ('billable', 'do_not_bill', 'no_charge')),
  ADD COLUMN hours_min numeric(6,2) NOT NULL DEFAULT 0 CHECK (hours_min >= 0),
  ADD COLUMN hours_max numeric(6,2) NOT NULL DEFAULT 0 CHECK (hours_max >= 0),   -- 0 means no cap
  ADD COLUMN round_billing_hours_to numeric(6,2) CHECK (round_billing_hours_to > 0),
  ADD CONSTRAINT work_type_custom_rate_present CHECK (rate_type <> 'custom' OR custom_rate IS NOT NULL),
  ADD CONSTRAINT work_type_adjustment_present CHECK (rate_type <> 'adjustment' OR rate_adjustment IS NOT NULL),
  ADD CONSTRAINT work_type_min_le_max CHECK (hours_max = 0 OR hours_min <= hours_max);

-- The boolean it replaces could not express "no charge".
UPDATE catalog.work_type SET bill_time = CASE WHEN is_billable_default THEN 'billable' ELSE 'do_not_bill' END;
ALTER TABLE catalog.work_type DROP COLUMN is_billable_default;
