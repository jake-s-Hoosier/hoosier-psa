-- 0018_projects
-- Projects and their phases (docs/03, docs/05). A project is work for one customer with a billing method of its
-- own. Its tickets are ordinary service tickets that point at the project (and optionally a phase); time and
-- materials are logged on those tickets as usual. Project work is never billed by a ticket run: project billing
-- (next migration) bills it by the project's method. Nothing here talks to ConnectWise or QuickBooks.

CREATE SCHEMA project;

CREATE TABLE project.project (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     bigint NOT NULL REFERENCES crm.company (id),
  site_id        bigint REFERENCES crm.site (id),
  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
  project_type   text,                                   -- Installation - CCTV, Access Control ... (free text for now)
  status         text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('planning', 'open', 'on_hold', 'ready_to_invoice', 'closed', 'canceled')),
  manager_member_id bigint REFERENCES iam.member (id),
  -- How the project's labor is billed. The amount is the fixed fee, the not-to-exceed cap or the override rate.
  billing_method text NOT NULL DEFAULT 'fixed_fee'
                 CHECK (billing_method IN ('actual_rates', 'fixed_fee', 'not_to_exceed', 'override_rate')),
  billing_amount numeric(14,2) CHECK (billing_amount >= 0),
  po_number      text,
  po_amount      numeric(14,2) CHECK (po_amount >= 0),
  estimated_start date,
  estimated_end   date,
  actual_start    date,
  actual_end      date,
  budget_hours   numeric(9,2) CHECK (budget_hours >= 0),
  notes          text,
  closed_at      timestamptz,
  legacy_cw_project_id integer UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_estimated_dates CHECK (estimated_end IS NULL OR estimated_start IS NULL OR estimated_end >= estimated_start),
  CONSTRAINT project_actual_dates CHECK (actual_end IS NULL OR actual_start IS NULL OR actual_end >= actual_start)
);
CREATE INDEX project_company_idx ON project.project (company_id);
CREATE INDEX project_open_idx ON project.project (status) WHERE status NOT IN ('closed', 'canceled');
CREATE INDEX project_name_trgm_idx ON project.project USING gin (name gin_trgm_ops);
SELECT sys.attach_standard_triggers('project.project');

CREATE TABLE project.phase (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id     bigint NOT NULL REFERENCES project.project (id),
  name           citext NOT NULL CHECK (length(btrim(name::text)) BETWEEN 1 AND 300),
  description    text,
  sort_order     integer NOT NULL DEFAULT 0,
  budget_hours   numeric(9,2) CHECK (budget_hours >= 0),
  scheduled_start date,
  scheduled_end   date,
  -- A phase billed separately gets its own invoices and, optionally, its own billing method and amount.
  -- Otherwise it is structure and budget only, and bills with its project.
  bill_separately boolean NOT NULL DEFAULT false,
  billing_method  text CHECK (billing_method IN ('actual_rates', 'fixed_fee', 'not_to_exceed', 'override_rate')),
  billing_amount  numeric(14,2) CHECK (billing_amount >= 0),
  notes          text,
  legacy_cw_phase_id integer UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name),
  CONSTRAINT phase_dates CHECK (scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end >= scheduled_start),
  CONSTRAINT phase_billing_only_when_separate CHECK (bill_separately OR (billing_method IS NULL AND billing_amount IS NULL))
);
CREATE INDEX phase_project_idx ON project.phase (project_id, sort_order);
SELECT sys.attach_standard_triggers('project.phase');

-- A ticket joins a project (and one of its phases) through these two columns.
ALTER TABLE service.ticket ADD COLUMN phase_id bigint REFERENCES project.phase (id);
ALTER TABLE service.ticket
  ADD CONSTRAINT ticket_project_fk FOREIGN KEY (project_id) REFERENCES project.project (id);
CREATE INDEX ticket_project_idx ON service.ticket (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX ticket_phase_idx ON service.ticket (phase_id) WHERE phase_id IS NOT NULL;

-- A ticket's phase must be one of its own project's phases, and a ticket in a project is the project customer's.
CREATE FUNCTION service.guard_ticket_project() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_phase_project bigint;
  v_project_company bigint;
BEGIN
  IF NEW.phase_id IS NOT NULL THEN
    IF NEW.project_id IS NULL THEN
      RAISE EXCEPTION 'A ticket cannot be in a phase without being in the project' USING ERRCODE = 'check_violation';
    END IF;
    SELECT project_id INTO v_phase_project FROM project.phase WHERE id = NEW.phase_id;
    IF v_phase_project IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'That phase belongs to a different project' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.project_id IS NOT NULL THEN
    SELECT company_id INTO v_project_company FROM project.project WHERE id = NEW.project_id;
    IF v_project_company IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'A project ticket must be for the project''s customer' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ticket_project_guard BEFORE INSERT OR UPDATE OF project_id, phase_id, company_id ON service.ticket
  FOR EACH ROW WHEN (NEW.project_id IS NOT NULL OR NEW.phase_id IS NOT NULL)
  EXECUTE FUNCTION service.guard_ticket_project();
