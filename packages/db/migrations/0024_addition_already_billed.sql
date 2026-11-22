-- 0024_addition_already_billed
-- A line can be prepaid: billed in full up front (for example a 5-year license) with the revenue already
-- recognized. It stays on its agreement for history, but is left out of billing runs and of monthly recurring
-- revenue so it is not counted again every month. Nothing here bills anyone.

ALTER TABLE billing.agreement_addition
  ADD COLUMN already_billed boolean NOT NULL DEFAULT false;
