-- 0002_iam
-- Staff identities, roles and permissions. Sign-in is Microsoft Entra ID (OIDC);
-- there are no local passwords. See docs/adr/0005-entra-sso.md and docs/08-security.md.

CREATE TABLE iam.member (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  identifier         citext NOT NULL UNIQUE,            -- short login-style id, e.g. 'JShaffer'
  first_name         text NOT NULL,
  last_name          text NOT NULL,
  email              citext NOT NULL UNIQUE,
  entra_subject      text UNIQUE,                       -- OIDC 'oid' claim, set at first sign-in
  title              text,
  mobile_phone       text,
  time_zone          text NOT NULL DEFAULT 'America/Indiana/Indianapolis',
  hire_date          date,
  is_active          boolean NOT NULL DEFAULT true,
  is_field_tech      boolean NOT NULL DEFAULT false,    -- appears on the dispatch board
  hourly_cost        numeric(10,2) CHECK (hourly_cost >= 0),  -- fully loaded labor cost
  overtime_exempt    boolean NOT NULL DEFAULT false,
  legacy_cw_member_id integer UNIQUE,                   -- ConnectWise members.id, import traceability
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN iam.member.hourly_cost IS
  'Loaded cost per hour. Snapshotted onto time entries so later changes never rewrite history.';

CREATE TABLE iam.role (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        citext NOT NULL UNIQUE,
  description text,
  is_system   boolean NOT NULL DEFAULT false,           -- system roles cannot be deleted
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Permission keys are defined in code (packages/shared/src/permissions.ts) and
-- synchronised into this table at deploy time so they can be referenced by FK.
CREATE TABLE iam.permission (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z]+(\.[a-z_]+)+$'),   -- e.g. 'service.ticket.update'
  description text NOT NULL
);

CREATE TABLE iam.role_permission (
  role_id        bigint NOT NULL REFERENCES iam.role (id) ON DELETE CASCADE,
  permission_key text   NOT NULL REFERENCES iam.permission (key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE iam.member_role (
  member_id bigint NOT NULL REFERENCES iam.member (id) ON DELETE CASCADE,
  role_id   bigint NOT NULL REFERENCES iam.role (id) ON DELETE CASCADE,
  PRIMARY KEY (member_id, role_id)
);
CREATE INDEX member_role_role_idx ON iam.member_role (role_id);

SELECT sys.attach_standard_triggers('iam.member');
SELECT sys.attach_standard_triggers('iam.role');

INSERT INTO iam.role (name, description, is_system) VALUES
  ('Administrator', 'Full access including security and system configuration.', true),
  ('Manager',       'Operations, dispatch, billing review and reporting.',      true),
  ('Dispatcher',    'Schedule board and ticket assignment.',                    true),
  ('Technician',    'Own tickets, own schedule, own time.',                     true),
  ('Sales',         'CRM, opportunities and quotes.',                           true),
  ('Billing',       'Invoicing, agreements, payments and accounting export.',   true);
