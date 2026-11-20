-- 0012_agreements
-- Agreements (contracts with a company) and their additions (recurring billed lines), per
-- docs/05-billing-and-agreements.md. Billing runs and invoices come in a later migration; nothing
-- here bills anyone.

CREATE SCHEMA IF NOT EXISTS billing;

CREATE TABLE billing.agreement_type (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        citext NOT NULL UNIQUE,                  -- 'ESP', 'BASE', 'JFI', 'Monitoring' ...
  bill_cycle  text NOT NULL DEFAULT 'monthly'
              CHECK (bill_cycle IN ('monthly', 'quarterly', 'semi_annual', 'annual')),
  coverage    text NOT NULL DEFAULT 'none'
              CHECK (coverage IN ('none', 'block_hours', 'unlimited_remote', 'covered')),
  auto_renew  boolean NOT NULL DEFAULT true,
  is_active   boolean NOT NULL DEFAULT true,
  legacy_cw_agreement_type_id integer UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
SELECT sys.attach_standard_triggers('billing.agreement_type');

CREATE TABLE billing.agreement (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id          bigint NOT NULL REFERENCES crm.company (id),
  bill_to_company_id  bigint NOT NULL REFERENCES crm.company (id),
  type_id             bigint NOT NULL REFERENCES billing.agreement_type (id),
  name                text NOT NULL,
  start_date          date NOT NULL,
  end_date            date,
  auto_renew          boolean NOT NULL DEFAULT true,
  renewal_notice_days integer NOT NULL DEFAULT 60 CHECK (renewal_notice_days >= 0),
  cancelled_date      date,
  cancel_reason       text,
  bill_cycle          text NOT NULL DEFAULT 'monthly'
                      CHECK (bill_cycle IN ('monthly', 'quarterly', 'semi_annual', 'annual')),
  bill_start_date     date NOT NULL,                   -- anchors the billing cycle
  coverage            text NOT NULL DEFAULT 'none'
                      CHECK (coverage IN ('none', 'block_hours', 'unlimited_remote', 'covered')),
  block_hours         numeric(10,2) CHECK (block_hours >= 0),
  po_number           text,
  notes               text,
  legacy_cw_agreement_id integer UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (cancelled_date IS NULL OR cancelled_date >= start_date)
);
CREATE INDEX agreement_company_idx ON billing.agreement (company_id);
CREATE INDEX agreement_bill_to_idx ON billing.agreement (bill_to_company_id);
CREATE INDEX agreement_type_idx ON billing.agreement (type_id);
SELECT sys.attach_standard_triggers('billing.agreement');

-- An addition is a recurring line. Its unit_price is the amount per month (docs/05 open question 6).
CREATE TABLE billing.agreement_addition (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agreement_id   bigint NOT NULL REFERENCES billing.agreement (id),
  product_id     bigint REFERENCES catalog.product (id),
  description    text NOT NULL,
  quantity       numeric(12,4) NOT NULL CHECK (quantity > 0),
  unit_price     numeric(14,4) NOT NULL CHECK (unit_price >= 0),
  unit_cost      numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  effective_from date NOT NULL,
  effective_to   date,
  prorate        boolean NOT NULL DEFAULT true,
  vendor_company_id bigint REFERENCES crm.company (id),  -- who the cost is paid to, for margin reports
  legacy_cw_addition_id integer UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX agreement_addition_agreement_idx ON billing.agreement_addition (agreement_id);
SELECT sys.attach_standard_triggers('billing.agreement_addition');

-- Price, quantity and start never change in place: a change closes the line and opens a new one, so
-- history and proration stay exact. Only the end date, description and flags may be edited.
CREATE OR REPLACE FUNCTION billing.guard_addition_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_locked_edit', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.unit_price IS DISTINCT FROM OLD.unit_price
     OR NEW.unit_cost IS DISTINCT FROM OLD.unit_cost
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id THEN
    RAISE EXCEPTION 'Agreement additions are not edited in place: end the line and add a new one'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agreement_addition_history BEFORE UPDATE ON billing.agreement_addition
  FOR EACH ROW EXECUTE FUNCTION billing.guard_addition_history();

-- The foreign keys that 0005 and 0006 deferred.
ALTER TABLE service.ticket
  ADD CONSTRAINT ticket_agreement_fk FOREIGN KEY (agreement_id) REFERENCES billing.agreement (id);
ALTER TABLE timekeeping.time_entry
  ADD CONSTRAINT time_entry_agreement_fk FOREIGN KEY (agreement_id) REFERENCES billing.agreement (id);
