-- 0016_payments
-- Payments received and how they are applied to invoices (docs/10). This is the provider-neutral ledger:
-- today payments are recorded by hand (check, ACH, card taken elsewhere, cash); autopay and the payment
-- providers will write the same rows later. Card numbers are never stored.

CREATE SCHEMA payments;

CREATE TABLE payments.payment (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES crm.company (id),        -- who paid
  received_on   date NOT NULL,
  method        text NOT NULL CHECK (method IN ('check', 'ach', 'card', 'cash', 'wire', 'other')),
  reference     text,                                               -- check number, ACH trace, last four ...
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),          -- gross received
  fee_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0 AND fee_amount < amount),
  status        text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  provider      text,                                               -- null for a hand-entered payment
  provider_reference text,
  notes         text,
  voided_at     timestamptz,
  voided_by_member_id bigint REFERENCES iam.member (id),
  void_reason   text,
  recorded_by_member_id bigint REFERENCES iam.member (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_void_has_reason CHECK (status <> 'void' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CONSTRAINT payment_provider_ref_uq UNIQUE (provider, provider_reference)
);
CREATE INDEX payment_company_idx ON payments.payment (company_id, received_on DESC);
SELECT sys.attach_standard_triggers('payments.payment');

CREATE TABLE payments.payment_application (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id  bigint NOT NULL REFERENCES payments.payment (id),
  invoice_id  bigint NOT NULL REFERENCES billing.invoice (id),
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_application_payment_idx ON payments.payment_application (payment_id);
CREATE INDEX payment_application_invoice_idx ON payments.payment_application (invoice_id);
SELECT sys.attach_standard_triggers('payments.payment_application');

-- Backstop for the API's own checks: a payment is never spread past what was received, an invoice never
-- takes more than its balance, and only the payer's own open invoices can be paid. Both rows are locked so two
-- applications racing each other cannot both fit.
CREATE FUNCTION payments.guard_application() RETURNS trigger
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
  SELECT COALESCE(sum(a.amount), 0) INTO v_invoice_paid
    FROM payments.payment_application a JOIN payments.payment q ON q.id = a.payment_id
   WHERE a.invoice_id = NEW.invoice_id AND q.status = 'posted' AND (TG_OP = 'INSERT' OR a.id <> NEW.id);
  IF v_invoice_paid + NEW.amount > i.total THEN
    RAISE EXCEPTION 'More than the invoice balance' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_application_guard BEFORE INSERT OR UPDATE ON payments.payment_application
  FOR EACH ROW EXECUTE FUNCTION payments.guard_application();

-- Payments are a ledger: they are voided, never deleted, and what was received and from whom does not change.
CREATE FUNCTION payments.guard_payment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payments are voided, not deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'void' AND NEW.status <> 'void' THEN
    RAISE EXCEPTION 'A void payment stays void' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.received_on IS DISTINCT FROM OLD.received_on THEN
    RAISE EXCEPTION 'What was received, when and from whom cannot be changed: void and re-enter' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_guard BEFORE UPDATE OR DELETE ON payments.payment
  FOR EACH ROW EXECUTE FUNCTION payments.guard_payment();
