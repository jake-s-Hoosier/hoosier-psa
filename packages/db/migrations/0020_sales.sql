-- 0020_sales
-- Opportunities, their activities and tasks, and references to records that live in other systems (docs/03).
-- Quotes are built in Smart Pricing Tables and estimates and designs in SembleAI; the PSA does not edit them. It
-- keeps a reference (provider, kind, external id, version, status, amount, link) on the opportunity, sales order
-- or project, so the pipeline and the order can show them and adapters can refresh them later. Nothing here calls
-- any other system.

CREATE SCHEMA sales;

CREATE TABLE sales.stage (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         citext NOT NULL UNIQUE,
  sort_order   integer NOT NULL,
  probability  integer NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  is_won       boolean NOT NULL DEFAULT false,
  is_lost      boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  legacy_cw_stage_id integer UNIQUE,
  CHECK (NOT (is_won AND is_lost))
);
INSERT INTO sales.stage (name, sort_order, probability, is_won, is_lost) VALUES
  ('Qualify', 10, 10, false, false),
  ('Site walk and design', 20, 25, false, false),
  ('Proposal sent', 30, 50, false, false),
  ('Negotiation', 40, 75, false, false),
  ('Won', 90, 100, true, false),
  ('Lost', 99, 0, false, true);

CREATE TABLE sales.opportunity (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES crm.company (id),
  site_id       bigint REFERENCES crm.site (id),
  contact_id    bigint REFERENCES crm.contact (id),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
  stage_id      bigint NOT NULL REFERENCES sales.stage (id),
  owner_member_id bigint REFERENCES iam.member (id),
  expected_amount numeric(14,2) CHECK (expected_amount >= 0),
  expected_close  date,
  source        text,
  notes         text,
  lost_reason   text,
  closed_at     timestamptz,                 -- set when the opportunity is won or lost
  legacy_cw_opportunity_id integer UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunity_company_idx ON sales.opportunity (company_id);
CREATE INDEX opportunity_stage_idx ON sales.opportunity (stage_id);
CREATE INDEX opportunity_owner_idx ON sales.opportunity (owner_member_id);
CREATE INDEX opportunity_name_trgm_idx ON sales.opportunity USING gin (name gin_trgm_ops);
SELECT sys.attach_standard_triggers('sales.opportunity');

-- Calls, emails, meetings and notes are logged; a task has a due date and is completed later.
CREATE TABLE sales.activity (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opportunity_id bigint NOT NULL REFERENCES sales.opportunity (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('call', 'email', 'meeting', 'site_visit', 'note', 'task')),
  subject       text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 300),
  body          text,
  due_date      date,
  completed_at  timestamptz,
  assigned_member_id bigint REFERENCES iam.member (id),
  created_by_member_id bigint REFERENCES iam.member (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_due_only_for_task CHECK (due_date IS NULL OR kind = 'task')
);
CREATE INDEX activity_opportunity_idx ON sales.activity (opportunity_id, created_at DESC);
CREATE INDEX activity_open_task_idx ON sales.activity (due_date) WHERE kind = 'task' AND completed_at IS NULL;
SELECT sys.attach_standard_triggers('sales.activity');

-- A link to a record in another system, held against an opportunity, a sales order or a project.
CREATE TABLE sales.external_ref (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type   text NOT NULL CHECK (entity_type IN ('opportunity', 'sales_order', 'project')),
  entity_id     bigint NOT NULL,
  provider      text NOT NULL CHECK (provider IN ('smart_pricing_tables', 'sembleai', 'other')),
  kind          text NOT NULL CHECK (kind IN ('quote', 'estimate', 'design', 'document', 'other')),
  external_id   text NOT NULL CHECK (length(btrim(external_id)) > 0),
  version       text,
  status        text,
  title         text,
  url           text CHECK (url IS NULL OR url ~* '^https?://'),
  amount        numeric(14,2),
  -- What the provider last told us, kept as received so an adapter can be fixed and replayed.
  payload       jsonb,
  synced_at     timestamptz,
  created_by_member_id bigint REFERENCES iam.member (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, provider, kind, external_id)
);
CREATE INDEX external_ref_entity_idx ON sales.external_ref (entity_type, entity_id);
CREATE INDEX external_ref_lookup_idx ON sales.external_ref (provider, kind, external_id);
SELECT sys.attach_standard_triggers('sales.external_ref');

-- Won and lost are fixed by the stage; keep closed_at and lost_reason in step with it.
CREATE FUNCTION sales.sync_opportunity_close() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_won boolean;
  v_lost boolean;
BEGIN
  SELECT is_won, is_lost INTO v_won, v_lost FROM sales.stage WHERE id = NEW.stage_id;
  IF v_won OR v_lost THEN
    NEW.closed_at := COALESCE(NEW.closed_at, now());
  ELSE
    NEW.closed_at := NULL;
  END IF;
  IF NOT v_lost THEN NEW.lost_reason := NULL; END IF;
  IF v_lost AND (NEW.lost_reason IS NULL OR length(btrim(NEW.lost_reason)) = 0) THEN
    RAISE EXCEPTION 'Say why the opportunity was lost' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_close_sync BEFORE INSERT OR UPDATE OF stage_id, lost_reason ON sales.opportunity
  FOR EACH ROW EXECUTE FUNCTION sales.sync_opportunity_close();
