-- 0017_credit_memos
-- Credit memos (docs/05 "Credit memos"). A memo is a customer credit that shares the invoice number series (as in
-- ConnectWise, where a credit memo is an invoice with a negative total), is immutable once issued, and is applied to
-- invoices the way a payment is. Nothing here talks to QuickBooks.

CREATE TABLE billing.credit_memo (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      bigint NOT NULL REFERENCES crm.company (id),
  source_invoice_id bigint REFERENCES billing.invoice (id),        -- the invoice being corrected, when there is one
  memo_number     bigint NOT NULL UNIQUE,                           -- from billing.next_invoice_number(), assigned at issue
  status          text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  memo_date       date NOT NULL,
  reason          text NOT NULL CHECK (length(btrim(reason)) >= 3),
  tax_code_id     bigint REFERENCES catalog.tax_code (id),
  tax_rate_pct    numeric(7,4) NOT NULL DEFAULT 0 CHECK (tax_rate_pct >= 0),
  tax_exempt      boolean NOT NULL DEFAULT false,
  subtotal        numeric(14,2) NOT NULL CHECK (subtotal > 0),      -- amounts are stored positive: the memo is the credit
  tax_total       numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total           numeric(14,2) NOT NULL CHECK (total > 0),
  issued_by_member_id bigint REFERENCES iam.member (id),
  voided_at       timestamptz,
  voided_by_member_id bigint REFERENCES iam.member (id),
  void_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_memo_total_adds_up CHECK (total = subtotal + tax_total),
  CONSTRAINT credit_memo_void_has_reason CHECK (status <> 'void' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX credit_memo_company_idx ON billing.credit_memo (company_id);
CREATE INDEX credit_memo_source_idx ON billing.credit_memo (source_invoice_id);
SELECT sys.attach_standard_triggers('billing.credit_memo');

CREATE TABLE billing.credit_memo_line (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  credit_memo_id bigint NOT NULL REFERENCES billing.credit_memo (id),
  line_no        integer NOT NULL CHECK (line_no > 0),
  source_line_id bigint REFERENCES billing.invoice_line (id),
  description    text NOT NULL,
  quantity       numeric(12,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price     numeric(14,4) NOT NULL CHECK (unit_price >= 0),
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  taxable        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (credit_memo_id, line_no)
);
CREATE INDEX credit_memo_line_memo_idx ON billing.credit_memo_line (credit_memo_id);
SELECT sys.attach_standard_triggers('billing.credit_memo_line');

CREATE TABLE billing.credit_application (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  credit_memo_id bigint NOT NULL REFERENCES billing.credit_memo (id),
  invoice_id     bigint NOT NULL REFERENCES billing.invoice (id),
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  applied_by_member_id bigint REFERENCES iam.member (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_application_memo_idx ON billing.credit_application (credit_memo_id);
CREATE INDEX credit_application_invoice_idx ON billing.credit_application (invoice_id);
SELECT sys.attach_standard_triggers('billing.credit_application');

-- What has been paid or credited on an invoice, and the status that follows from it. One place, used by payments
-- and credit memos alike. Draft and void invoices are left alone.
CREATE FUNCTION billing.refresh_invoice_paid(p_invoice_id bigint) RETURNS void
LANGUAGE sql AS $$
  UPDATE billing.invoice i
     SET amount_paid = s.paid,
         status = CASE WHEN s.paid >= i.total THEN 'paid' WHEN s.paid > 0 THEN 'partially_paid' ELSE 'posted' END
    FROM (SELECT (SELECT COALESCE(sum(a.amount), 0)
                    FROM payments.payment_application a JOIN payments.payment p ON p.id = a.payment_id
                   WHERE a.invoice_id = p_invoice_id AND p.status = 'posted')
                 + (SELECT COALESCE(sum(c.amount), 0)
                      FROM billing.credit_application c JOIN billing.credit_memo m ON m.id = c.credit_memo_id
                     WHERE c.invoice_id = p_invoice_id AND m.status = 'posted') AS paid) s
   WHERE i.id = p_invoice_id AND i.status NOT IN ('draft', 'void');
$$;

-- A memo is credit to a customer, applied only to that customer's open invoices, never beyond the memo or the balance.
CREATE FUNCTION billing.guard_credit_application() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m billing.credit_memo%ROWTYPE;
  i billing.invoice%ROWTYPE;
  v_applied numeric;
  v_paid numeric;
BEGIN
  SELECT * INTO m FROM billing.credit_memo WHERE id = NEW.credit_memo_id FOR UPDATE;
  SELECT * INTO i FROM billing.invoice WHERE id = NEW.invoice_id FOR UPDATE;
  IF m.status <> 'posted' THEN
    RAISE EXCEPTION 'A void credit memo cannot be applied' USING ERRCODE = 'check_violation';
  END IF;
  IF i.company_id <> m.company_id THEN
    RAISE EXCEPTION 'A credit memo can only be applied to its own customer''s invoices' USING ERRCODE = 'check_violation';
  END IF;
  IF i.status NOT IN ('posted', 'partially_paid') THEN
    RAISE EXCEPTION 'Only a posted, unpaid invoice can take a credit' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO v_applied FROM billing.credit_application
   WHERE credit_memo_id = NEW.credit_memo_id AND (TG_OP = 'INSERT' OR id <> NEW.id);
  IF v_applied + NEW.amount > m.total THEN
    RAISE EXCEPTION 'More than the credit memo' USING ERRCODE = 'check_violation';
  END IF;
  SELECT (SELECT COALESCE(sum(a.amount), 0)
            FROM payments.payment_application a JOIN payments.payment p ON p.id = a.payment_id
           WHERE a.invoice_id = NEW.invoice_id AND p.status = 'posted')
         + (SELECT COALESCE(sum(c.amount), 0)
              FROM billing.credit_application c JOIN billing.credit_memo q ON q.id = c.credit_memo_id
             WHERE c.invoice_id = NEW.invoice_id AND q.status = 'posted' AND (TG_OP = 'INSERT' OR c.id <> NEW.id))
    INTO v_paid;
  IF v_paid + NEW.amount > i.total THEN
    RAISE EXCEPTION 'More than the invoice balance' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_application_guard BEFORE INSERT OR UPDATE ON billing.credit_application
  FOR EACH ROW EXECUTE FUNCTION billing.guard_credit_application();

-- Payments must count credits already on the invoice (replaces the 0016 body; only the invoice-paid sum changes).
CREATE OR REPLACE FUNCTION payments.guard_application() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p payments.payment%ROWTYPE;
  i billing.invoice%ROWTYPE;
  v_applied numeric;
  v_invoice_paid numeric;
BEGIN
  SELECT * INTO p FROM payments.payment WHERE id = NEW.payment_id FOR UPDATE;
  SELECT * INTO i FROM billing.invoice WHERE id = NEW.invoice_id FOR UPDATE;
  IF p.status <> 'posted' THEN
    RAISE EXCEPTION 'A void payment cannot be applied' USING ERRCODE = 'check_violation';
  END IF;
  IF i.company_id <> p.company_id THEN
    RAISE EXCEPTION 'A payment can only be applied to its own customer''s invoices' USING ERRCODE = 'check_violation';
  END IF;
  IF i.status NOT IN ('posted', 'partially_paid') THEN
    RAISE EXCEPTION 'Only a posted, unpaid invoice can take a payment' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO v_applied FROM payments.payment_application
   WHERE payment_id = NEW.payment_id AND (TG_OP = 'INSERT' OR id <> NEW.id);
  IF v_applied + NEW.amount > p.amount THEN
    RAISE EXCEPTION 'More than the payment received' USING ERRCODE = 'check_violation';
  END IF;
  SELECT (SELECT COALESCE(sum(a.amount), 0)
            FROM payments.payment_application a JOIN payments.payment q ON q.id = a.payment_id
           WHERE a.invoice_id = NEW.invoice_id AND q.status = 'posted' AND (TG_OP = 'INSERT' OR a.id <> NEW.id))
         + (SELECT COALESCE(sum(c.amount), 0)
              FROM billing.credit_application c JOIN billing.credit_memo m ON m.id = c.credit_memo_id
             WHERE c.invoice_id = NEW.invoice_id AND m.status = 'posted')
    INTO v_invoice_paid;
  IF v_invoice_paid + NEW.amount > i.total THEN
    RAISE EXCEPTION 'More than the invoice balance' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Issued memos are immutable: only the move to void (with a reason) is allowed, and nothing is deleted.
CREATE FUNCTION billing.guard_credit_memo() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Credit memos are voided, not deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'void' AND NEW.status <> 'void' THEN
    RAISE EXCEPTION 'A void credit memo stays void' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.source_invoice_id IS DISTINCT FROM OLD.source_invoice_id
     OR NEW.memo_number IS DISTINCT FROM OLD.memo_number
     OR NEW.memo_date IS DISTINCT FROM OLD.memo_date
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.tax_rate_pct IS DISTINCT FROM OLD.tax_rate_pct
     OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
     OR NEW.tax_total IS DISTINCT FROM OLD.tax_total
     OR NEW.total IS DISTINCT FROM OLD.total THEN
    RAISE EXCEPTION 'An issued credit memo cannot be edited: void and reissue' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_memo_guard BEFORE UPDATE OR DELETE ON billing.credit_memo
  FOR EACH ROW EXECUTE FUNCTION billing.guard_credit_memo();

-- Lines go in with the memo and never change. An insert may not add up to more than the memo's subtotal, and a
-- deferred check at commit makes sure they add up to exactly that.
CREATE FUNCTION billing.guard_credit_memo_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_subtotal numeric;
  v_have numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'The lines of a credit memo cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  SELECT subtotal INTO v_subtotal FROM billing.credit_memo WHERE id = NEW.credit_memo_id;
  SELECT COALESCE(sum(amount), 0) INTO v_have FROM billing.credit_memo_line WHERE credit_memo_id = NEW.credit_memo_id;
  IF v_have + NEW.amount > v_subtotal THEN
    RAISE EXCEPTION 'The lines add up to more than the credit memo' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_memo_line_guard BEFORE INSERT OR UPDATE OR DELETE ON billing.credit_memo_line
  FOR EACH ROW EXECUTE FUNCTION billing.guard_credit_memo_line();

CREATE FUNCTION billing.check_credit_memo_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_have numeric;
BEGIN
  SELECT COALESCE(sum(l.amount), 0) INTO v_have FROM billing.credit_memo_line l WHERE l.credit_memo_id = NEW.id;
  IF v_have <> NEW.subtotal THEN
    RAISE EXCEPTION 'The lines of credit memo % do not add up to its subtotal', NEW.memo_number USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER credit_memo_lines_total AFTER INSERT ON billing.credit_memo
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing.check_credit_memo_lines();
