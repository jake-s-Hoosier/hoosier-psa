-- 0015_ticket_charges
-- Materials and expenses charged on a service ticket (docs/05). A ticket run bills them with the ticket's
-- labor. A charge is linked to its draft invoice line the moment the line is drafted, so it cannot be billed
-- twice, and it is frozen while it sits on an invoice.

CREATE TABLE service.ticket_charge (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id     bigint NOT NULL REFERENCES service.ticket (id),
  kind          text NOT NULL CHECK (kind IN ('product', 'expense')),
  -- The catalog item. Optional for an expense, but its QuickBooks item name comes from here.
  product_id    bigint REFERENCES catalog.product (id),
  description   text NOT NULL CHECK (length(trim(description)) > 0),
  quantity      numeric(12,4) NOT NULL CHECK (quantity > 0),
  unit_price    numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  unit_cost     numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  taxable       boolean NOT NULL DEFAULT true,
  -- no_charge is shown on the ticket but not billed; do_not_bill is written off.
  billable      text NOT NULL DEFAULT 'billable' CHECK (billable IN ('billable', 'no_charge', 'do_not_bill')),
  incurred_on   date NOT NULL DEFAULT current_date,
  invoice_id    bigint REFERENCES billing.invoice (id),
  invoice_line_id bigint REFERENCES billing.invoice_line (id) ON DELETE SET NULL,
  added_by_member_id bigint REFERENCES iam.member (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_charge_ticket_idx ON service.ticket_charge (ticket_id);
CREATE INDEX ticket_charge_unbilled_idx ON service.ticket_charge (incurred_on)
  WHERE invoice_id IS NULL AND billable = 'billable';
CREATE INDEX ticket_charge_invoice_idx ON service.ticket_charge (invoice_id) WHERE invoice_id IS NOT NULL;
SELECT sys.attach_standard_triggers('service.ticket_charge');

-- A charge on an invoice does not change or go away. Linking and releasing it are done by billing code,
-- which turns on the audited override (app.allow_locked_edit) for those steps only.
CREATE FUNCTION service.guard_ticket_charge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_locked_edit', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF OLD.invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'A charge on an invoice cannot be changed; remove it from the invoice first'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ticket_charge_guard BEFORE UPDATE OR DELETE ON service.ticket_charge
  FOR EACH ROW EXECUTE FUNCTION service.guard_ticket_charge();
