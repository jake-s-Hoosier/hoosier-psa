-- 0019_project_billing
-- Invoicing projects (docs/05). A project run bills one scope (a project, or one phase billed separately):
--   time_materials  approved unbilled time and charges through a date (actual rates, override rate, not-to-exceed)
--   deposit         a down payment against a fixed fee
--   progress        a progress or milestone payment against a fixed fee
--   final           the rest of a fixed fee plus any materials, and the close-out of the scope's time
-- Fee lines (deposit, progress, final) can never add up to more than the scope's fixed fee.

ALTER TABLE billing.billing_run DROP CONSTRAINT billing_run_kind_check;
ALTER TABLE billing.billing_run
  ADD CONSTRAINT billing_run_kind_check CHECK (kind IN ('agreement', 'ticket', 'project'));
ALTER TABLE billing.billing_run ADD COLUMN project_id bigint REFERENCES project.project (id);
ALTER TABLE billing.billing_run ADD COLUMN phase_id bigint REFERENCES project.phase (id);
ALTER TABLE billing.billing_run ADD COLUMN project_mode text
  CHECK (project_mode IN ('time_materials', 'deposit', 'progress', 'final'));
ALTER TABLE billing.billing_run
  ADD CONSTRAINT billing_run_project_shape CHECK (
    (kind = 'project' AND project_id IS NOT NULL AND project_mode IS NOT NULL)
    OR (kind <> 'project' AND project_id IS NULL AND phase_id IS NULL AND project_mode IS NULL));
CREATE INDEX billing_run_project_idx ON billing.billing_run (project_id) WHERE project_id IS NOT NULL;

ALTER TABLE billing.invoice_line ADD COLUMN project_id bigint REFERENCES project.project (id);
ALTER TABLE billing.invoice_line ADD COLUMN phase_id bigint REFERENCES project.phase (id);
-- Marks a line that bills part of a scope's fixed fee (deposit, progress, final).
ALTER TABLE billing.invoice_line ADD COLUMN project_fee boolean NOT NULL DEFAULT false;
CREATE INDEX invoice_line_project_idx ON billing.invoice_line (project_id) WHERE project_id IS NOT NULL;

-- Project labor is billed as lines of the project rather than of one ticket.
ALTER TABLE billing.invoice_line DROP CONSTRAINT invoice_line_time_has_ticket;
ALTER TABLE billing.invoice_line
  ADD CONSTRAINT invoice_line_time_has_ticket
  CHECK (kind <> 'time' OR ticket_id IS NOT NULL OR project_id IS NOT NULL);
ALTER TABLE billing.invoice_line
  ADD CONSTRAINT invoice_line_fee_has_project CHECK (NOT project_fee OR project_id IS NOT NULL);

-- Whatever the order of drafts, voids and edits, the fee lines of a scope never exceed its fixed fee.
CREATE FUNCTION billing.guard_project_fee() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_fee numeric;
  v_billed numeric;
BEGIN
  IF NEW.is_void OR NOT NEW.project_fee THEN RETURN NEW; END IF;
  IF NEW.phase_id IS NULL THEN
    SELECT billing_amount INTO v_fee FROM project.project
     WHERE id = NEW.project_id AND billing_method = 'fixed_fee' FOR SHARE;
  ELSE
    SELECT billing_amount INTO v_fee FROM project.phase
     WHERE id = NEW.phase_id AND bill_separately AND billing_method = 'fixed_fee' FOR SHARE;
  END IF;
  IF v_fee IS NULL THEN
    RAISE EXCEPTION 'That project or phase is not billed at a fixed fee' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO v_billed FROM billing.invoice_line
   WHERE project_id = NEW.project_id AND phase_id IS NOT DISTINCT FROM NEW.phase_id
     AND project_fee AND NOT is_void AND id IS DISTINCT FROM NEW.id;
  IF v_billed + NEW.amount > v_fee THEN
    RAISE EXCEPTION 'Billing % would exceed the fixed fee of % (already billed %)',
      NEW.amount, v_fee, v_billed USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_line_project_fee_guard
  BEFORE INSERT OR UPDATE OF amount, is_void, project_fee, project_id, phase_id ON billing.invoice_line
  FOR EACH ROW WHEN (NEW.project_fee)
  EXECUTE FUNCTION billing.guard_project_fee();
