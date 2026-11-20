-- 0014_ticket_billing
-- Invoicing ticket time (docs/05). A ticket run bills approved, unbilled time by each ticket's billing
-- method. Time entries are linked to the draft invoice line the moment it is drafted, so nothing can be
-- billed twice, and are marked billed when the invoice is posted.

ALTER TABLE billing.billing_run DROP CONSTRAINT billing_run_kind_check;
ALTER TABLE billing.billing_run
  ADD CONSTRAINT billing_run_kind_check CHECK (kind IN ('agreement', 'ticket'));
-- A ticket run bills time worked up to and including this date; period_month holds its month.
ALTER TABLE billing.billing_run ADD COLUMN through_date date;
ALTER TABLE billing.billing_run
  ADD CONSTRAINT billing_run_ticket_has_through CHECK (kind <> 'ticket' OR through_date IS NOT NULL);

ALTER TABLE billing.invoice_line ADD COLUMN ticket_id bigint REFERENCES service.ticket (id);
-- Marks the single line that bills a fixed-fee ticket's fee.
ALTER TABLE billing.invoice_line ADD COLUMN ticket_fee boolean NOT NULL DEFAULT false;
ALTER TABLE billing.invoice_line
  ADD CONSTRAINT invoice_line_time_has_ticket CHECK (kind <> 'time' OR ticket_id IS NOT NULL);
CREATE INDEX invoice_line_ticket_idx ON billing.invoice_line (ticket_id) WHERE ticket_id IS NOT NULL;
-- A fixed fee is billed once; voiding the invoice frees it.
CREATE UNIQUE INDEX invoice_line_fixed_fee_once
  ON billing.invoice_line (ticket_id) WHERE ticket_fee AND NOT is_void;

-- Which draft or posted line a time entry is on. Draft lines that go away release their entries in code
-- (with the audited override, since an entry in a locked pay period is otherwise immutable).
ALTER TABLE timekeeping.time_entry
  ADD COLUMN invoice_line_id bigint REFERENCES billing.invoice_line (id) ON DELETE SET NULL;
CREATE INDEX time_entry_invoice_idx ON timekeeping.time_entry (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX time_entry_invoice_line_idx ON timekeeping.time_entry (invoice_line_id) WHERE invoice_line_id IS NOT NULL;
