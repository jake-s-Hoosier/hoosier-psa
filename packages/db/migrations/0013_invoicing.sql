-- 0013_invoicing
-- Billing runs, invoices and invoice lines (docs/05-billing-and-agreements.md). A run builds draft
-- invoices for review; posting assigns gap-free numbers and freezes them. Nothing here talks to
-- QuickBooks or takes payment yet.

-- Gap-free invoice numbers. The counter is seeded from the last ConnectWise invoice number at cutover so
-- numbers stay continuous in QuickBooks; until then it counts from 1 and posted test invoices are wiped.
CREATE TABLE billing.invoice_counter (
  singleton   boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing.invoice_counter (singleton, last_number) VALUES (true, 0);

-- The row lock serialises concurrent posts, and a rolled-back post gives its numbers back.
CREATE FUNCTION billing.next_invoice_number() RETURNS bigint
LANGUAGE sql AS $$
  UPDATE billing.invoice_counter
     SET last_number = last_number + 1, updated_at = now()
   WHERE singleton
  RETURNING last_number;
$$;

CREATE TABLE billing.billing_run (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind           text NOT NULL DEFAULT 'agreement' CHECK (kind IN ('agreement')),
  period_month   date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  invoice_date   date NOT NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'discarded')),
  notes          text,
  created_by_member_id bigint REFERENCES iam.member (id),
  posted_by_member_id  bigint REFERENCES iam.member (id),
  posted_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'posted' OR posted_at IS NOT NULL)
);
CREATE INDEX billing_run_month_idx ON billing.billing_run (period_month);
SELECT sys.attach_standard_triggers('billing.billing_run');

CREATE TABLE billing.invoice (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id          bigint REFERENCES billing.billing_run (id),
  company_id      bigint NOT NULL REFERENCES crm.company (id),     -- who is billed
  invoice_number  bigint UNIQUE,                                   -- assigned at posting
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'posted', 'partially_paid', 'paid', 'void')),
  invoice_date    date NOT NULL,
  due_date        date NOT NULL,
  billing_terms_id bigint REFERENCES catalog.billing_terms (id),
  po_number       text,
  notes           text,
  -- Tax is a snapshot: later changes to the tax code never alter an invoice.
  tax_code_id     bigint REFERENCES catalog.tax_code (id),
  tax_rate_pct    numeric(7,4) NOT NULL DEFAULT 0 CHECK (tax_rate_pct >= 0),
  tax_exempt      boolean NOT NULL DEFAULT false,
  subtotal        numeric(14,2) NOT NULL DEFAULT 0,
  tax_total       numeric(14,2) NOT NULL DEFAULT 0,
  total           numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid     numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  posted_by_member_id bigint REFERENCES iam.member (id),
  posted_at       timestamptz,
  voided_by_member_id bigint REFERENCES iam.member (id),
  voided_at       timestamptz,
  void_reason     text,
  legacy_cw_invoice_id integer UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_posted_has_number CHECK (status = 'draft' OR invoice_number IS NOT NULL),
  CONSTRAINT invoice_void_has_reason CHECK (status <> 'void' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CONSTRAINT invoice_total_adds_up CHECK (total = subtotal + tax_total)
);
CREATE INDEX invoice_company_idx ON billing.invoice (company_id);
CREATE INDEX invoice_run_idx ON billing.invoice (run_id);
CREATE INDEX invoice_status_idx ON billing.invoice (status);
SELECT sys.attach_standard_triggers('billing.invoice');

CREATE TABLE billing.invoice_line (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id    bigint NOT NULL REFERENCES billing.invoice (id) ON DELETE CASCADE,
  line_no       integer NOT NULL CHECK (line_no > 0),
  kind          text NOT NULL CHECK (kind IN ('agreement', 'time', 'product', 'expense', 'fee', 'adjustment')),
  agreement_id  bigint REFERENCES billing.agreement (id),
  agreement_addition_id bigint REFERENCES billing.agreement_addition (id),
  product_id    bigint REFERENCES catalog.product (id),
  period_start  date,
  period_end    date,
  description   text NOT NULL,
  quantity      numeric(12,4) NOT NULL DEFAULT 1,
  unit_price    numeric(14,4) NOT NULL DEFAULT 0,
  unit_cost     numeric(14,4) NOT NULL DEFAULT 0,
  amount        numeric(14,2) NOT NULL,                -- billed amount (prorated for part periods)
  cost_amount   numeric(14,2) NOT NULL DEFAULT 0,      -- cost of the same, for margin reports
  taxable       boolean NOT NULL DEFAULT false,
  is_void       boolean NOT NULL DEFAULT false,        -- set when the invoice is voided; frees the period to rebill
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, line_no),
  CONSTRAINT invoice_line_agreement_has_period CHECK (
    kind <> 'agreement' OR (agreement_id IS NOT NULL AND agreement_addition_id IS NOT NULL
                            AND period_start IS NOT NULL AND period_end IS NOT NULL)),
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
);
CREATE INDEX invoice_line_invoice_idx ON billing.invoice_line (invoice_id);
CREATE INDEX invoice_line_agreement_idx ON billing.invoice_line (agreement_id);
-- A recurring line is billed once per period: re-running a run, or a second run, cannot double-bill it.
-- Voiding an invoice sets is_void and frees the period.
CREATE UNIQUE INDEX invoice_line_agreement_period_once
  ON billing.invoice_line (agreement_addition_id, period_start, period_end)
  WHERE kind = 'agreement' AND NOT is_void;
SELECT sys.attach_standard_triggers('billing.invoice_line');

-- Posted invoices are immutable. Only payment bookkeeping and the draft-to-posted-to-void progression
-- may change; anything else needs the audited override (app.allow_locked_edit).
CREATE FUNCTION billing.guard_invoice() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_locked_edit', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Posted invoices are not deleted: void them instead' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.status = 'draft'
       OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
       OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
       OR NEW.due_date IS DISTINCT FROM OLD.due_date
       OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
       OR NEW.tax_total IS DISTINCT FROM OLD.tax_total
       OR NEW.total IS DISTINCT FROM OLD.total
       OR NEW.tax_rate_pct IS DISTINCT FROM OLD.tax_rate_pct
       OR NEW.po_number IS DISTINCT FROM OLD.po_number THEN
      RAISE EXCEPTION 'Posted invoices cannot be edited: void and reissue' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'void' AND NEW.status <> 'void' THEN
      RAISE EXCEPTION 'A void invoice stays void' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_guard BEFORE UPDATE OR DELETE ON billing.invoice
  FOR EACH ROW EXECUTE FUNCTION billing.guard_invoice();

CREATE FUNCTION billing.guard_invoice_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF current_setting('app.allow_locked_edit', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO v_status FROM billing.invoice
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  -- A cascade from deleting a draft invoice finds no parent row; allow it.
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'Lines of a posted invoice cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_line_guard BEFORE INSERT OR UPDATE OR DELETE ON billing.invoice_line
  FOR EACH ROW EXECUTE FUNCTION billing.guard_invoice_line();

-- The foreign key that 0006 deferred.
ALTER TABLE timekeeping.time_entry
  ADD CONSTRAINT time_entry_invoice_fk FOREIGN KEY (invoice_id) REFERENCES billing.invoice (id);
