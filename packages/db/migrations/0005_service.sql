-- 0005_service
-- Service boards and tickets. Ticket numbers are the ticket id; imported tickets keep their
-- ConnectWise numbers and the identity sequence is advanced past them (docs/adr/0003).
-- agreement_id and project_id are plain columns for now; their FKs are added by the
-- agreement and project migrations (milestone 2).

CREATE TABLE service.board (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        citext NOT NULL UNIQUE,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  inbound_email text,                                   -- mailbox that creates tickets on this board
  default_priority_id bigint,
  legacy_cw_board_id integer UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE service.priority (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        citext NOT NULL UNIQUE,
  sort_order  integer NOT NULL,                         -- 1 = most urgent
  color       text NOT NULL DEFAULT '#6b7280' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  is_active   boolean NOT NULL DEFAULT true,
  legacy_cw_priority_id integer UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE service.board
  ADD CONSTRAINT board_default_priority_fk FOREIGN KEY (default_priority_id) REFERENCES service.priority (id);

CREATE TABLE service.board_status (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  board_id    bigint NOT NULL REFERENCES service.board (id),
  name        citext NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  is_closed   boolean NOT NULL DEFAULT false,           -- ticket is finished (no more work expected)
  is_default  boolean NOT NULL DEFAULT false,           -- status given to new tickets
  pauses_sla  boolean NOT NULL DEFAULT false,           -- e.g. 'Waiting on customer'
  is_active   boolean NOT NULL DEFAULT true,
  legacy_cw_status_id integer UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (board_id, name)
);
CREATE UNIQUE INDEX board_status_one_default_uq ON service.board_status (board_id) WHERE is_default;

CREATE TABLE service.ticket_type (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  board_id    bigint NOT NULL REFERENCES service.board (id),
  name        citext NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  legacy_cw_type_id integer UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (board_id, name)
);

CREATE TABLE service.ticket_subtype (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  board_id    bigint NOT NULL REFERENCES service.board (id),
  name        citext NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  legacy_cw_subtype_id integer UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (board_id, name)
);

CREATE TABLE service.ticket_source (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        citext NOT NULL UNIQUE,                   -- Phone, Email, Portal, Alarm.com, Verkada ...
  is_active   boolean NOT NULL DEFAULT true,
  legacy_cw_source_id integer UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE service.ticket (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- the ticket number
  summary       text NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  company_id    bigint NOT NULL REFERENCES crm.company (id),
  site_id       bigint REFERENCES crm.site (id),
  contact_id    bigint REFERENCES crm.contact (id),
  board_id      bigint NOT NULL REFERENCES service.board (id),
  status_id     bigint NOT NULL REFERENCES service.board_status (id),
  priority_id   bigint NOT NULL REFERENCES service.priority (id),
  type_id       bigint REFERENCES service.ticket_type (id),
  subtype_id    bigint REFERENCES service.ticket_subtype (id),
  source_id     bigint REFERENCES service.ticket_source (id),
  owner_member_id bigint REFERENCES iam.member (id),    -- accountable owner; resources are separate
  billing_method text NOT NULL DEFAULT 'actual_rates'
                CHECK (billing_method IN ('actual_rates', 'fixed_fee', 'not_to_exceed', 'override_rate')),
  billing_amount numeric(14,2) CHECK (billing_amount >= 0),    -- fixed fee / NTE cap / override rate
  agreement_id  bigint,                                  -- FK added in the agreements migration
  project_id    bigint,                                  -- FK added in the projects migration
  parent_ticket_id bigint REFERENCES service.ticket (id),
  budget_hours  numeric(8,2) CHECK (budget_hours >= 0),
  required_by   timestamptz,
  entered_at    timestamptz NOT NULL DEFAULT now(),
  entered_by_member_id bigint REFERENCES iam.member (id),
  first_response_at timestamptz,
  resolved_at   timestamptz,
  closed_at     timestamptz,
  closed_by_member_id bigint REFERENCES iam.member (id),
  customer_updated_at timestamptz,                       -- last customer-originated change (flags the ticket)
  legacy_cw_ticket_id integer UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_closed_after_entered CHECK (closed_at IS NULL OR closed_at >= entered_at),
  CONSTRAINT ticket_parent_not_self CHECK (parent_ticket_id IS NULL OR parent_ticket_id <> id)
);
CREATE INDEX ticket_company_idx ON service.ticket (company_id, entered_at DESC);
CREATE INDEX ticket_open_board_idx ON service.ticket (board_id, status_id) WHERE closed_at IS NULL;
CREATE INDEX ticket_owner_open_idx ON service.ticket (owner_member_id) WHERE closed_at IS NULL;
CREATE INDEX ticket_agreement_idx ON service.ticket (agreement_id) WHERE agreement_id IS NOT NULL;
CREATE INDEX ticket_summary_trgm_idx ON service.ticket USING gin (summary gin_trgm_ops);

-- Everyone working a ticket (the dispatch board schedules against these).
CREATE TABLE service.ticket_resource (
  ticket_id  bigint NOT NULL REFERENCES service.ticket (id) ON DELETE CASCADE,
  member_id  bigint NOT NULL REFERENCES iam.member (id),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, member_id)
);
CREATE INDEX ticket_resource_member_idx ON service.ticket_resource (member_id);

CREATE TABLE service.ticket_note (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id   bigint NOT NULL REFERENCES service.ticket (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('description', 'discussion', 'internal', 'resolution')),
  body        text NOT NULL,
  author_member_id  bigint REFERENCES iam.member (id),
  author_contact_id bigint REFERENCES crm.contact (id),
  time_entry_id     bigint,                              -- FK added in 0006 (note written with time)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  legacy_cw_note_id integer UNIQUE,
  CONSTRAINT ticket_note_one_author CHECK (num_nonnulls(author_member_id, author_contact_id) <= 1)
);
CREATE INDEX ticket_note_ticket_idx ON service.ticket_note (ticket_id, created_at);

SELECT sys.attach_standard_triggers('service.board');
SELECT sys.attach_standard_triggers('service.priority');
SELECT sys.attach_standard_triggers('service.board_status');
SELECT sys.attach_standard_triggers('service.ticket');
SELECT sys.attach_standard_triggers('service.ticket_note', false);

INSERT INTO service.priority (name, sort_order, color) VALUES
  ('Emergency', 1, '#dc2626'), ('High', 2, '#ea580c'), ('Normal', 3, '#2563eb'), ('Low', 4, '#6b7280');
