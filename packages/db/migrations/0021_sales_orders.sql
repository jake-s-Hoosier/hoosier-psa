-- 0021_sales_orders
-- A sales order is what the customer accepted: the scope, the price and how it will be billed. It comes from an
-- opportunity (usually after a quote from Smart Pricing Tables) and converts to a project. The billing method can be any
-- of the project methods (fixed fee, actual rates, not to exceed, override rate), so a quote can become either.
-- Order lines are the budget and bill of materials for reference; they never create charges by themselves.
-- Milestones are the planned deposit and progress billings of a fixed fee. They copy to the project when the order
-- converts, and the Bill dialog uses them to fill in and then mark off each payment.

CREATE TABLE sales.sales_order (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opportunity_id bigint REFERENCES sales.opportunity (id),
  company_id     bigint NOT NULL REFERENCES crm.company (id),
  site_id        bigint REFERENCES crm.site (id),
  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'converted', 'canceled')),
  billing_method text NOT NULL DEFAULT 'fixed_fee'
                 CHECK (billing_method IN ('actual_rates', 'fixed_fee', 'not_to_exceed', 'override_rate')),
  billing_amount numeric(14,2) CHECK (billing_amount >= 0),
  po_number      text,
  po_amount      numeric(14,2) CHECK (po_amount >= 0),
  notes          text,
  project_id     bigint UNIQUE REFERENCES project.project (id),
  approved_at    timestamptz,
  created_by_member_id bigint REFERENCES iam.member (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_order_amount_matches_method CHECK (
    (billing_method = 'actual_rates' AND billing_amount IS NULL) OR billing_method <> 'actual_rates'),
  CONSTRAINT sales_order_converted_has_project CHECK ((status = 'converted') = (project_id IS NOT NULL))
);
CREATE INDEX sales_order_opportunity_idx ON sales.sales_order (opportunity_id);
CREATE INDEX sales_order_company_idx ON sales.sales_order (company_id);
SELECT sys.attach_standard_triggers('sales.sales_order');

CREATE TABLE sales.sales_order_line (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    bigint NOT NULL REFERENCES sales.sales_order (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('labor', 'material', 'other')),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  quantity    numeric(12,3) NOT NULL CHECK (quantity > 0),     -- hours for labor
  unit_price  numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  unit_cost   numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_order_line_order_idx ON sales.sales_order_line (order_id, sort_order, id);
SELECT sys.attach_standard_triggers('sales.sales_order_line');

-- A milestone belongs to an order until it converts, and to the project after (the order stays on it for history).
CREATE TABLE sales.billing_milestone (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   bigint REFERENCES sales.sales_order (id) ON DELETE CASCADE,
  project_id bigint REFERENCES project.project (id),
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
  kind       text NOT NULL DEFAULT 'progress' CHECK (kind IN ('deposit', 'progress')),
  percent    numeric(7,4) CHECK (percent > 0 AND percent <= 100),
  amount     numeric(14,2) CHECK (amount > 0),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT milestone_percent_xor_amount CHECK ((percent IS NULL) <> (amount IS NULL)),
  CONSTRAINT milestone_has_owner CHECK (order_id IS NOT NULL OR project_id IS NOT NULL)
);
CREATE INDEX billing_milestone_order_idx ON sales.billing_milestone (order_id);
CREATE INDEX billing_milestone_project_idx ON sales.billing_milestone (project_id);
SELECT sys.attach_standard_triggers('sales.billing_milestone');

-- The run that billed a milestone. A milestone is billed while one of its runs has an invoice that is not void.
ALTER TABLE billing.billing_run ADD COLUMN milestone_id bigint REFERENCES sales.billing_milestone (id);
CREATE INDEX billing_run_milestone_idx ON billing.billing_run (milestone_id) WHERE milestone_id IS NOT NULL;
ALTER TABLE billing.billing_run
  ADD CONSTRAINT billing_run_milestone_is_project CHECK (milestone_id IS NULL OR kind = 'project');
