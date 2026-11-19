-- 0004_crm
-- Companies, sites and contacts.
-- Companies keep their ConnectWise ids on import (see docs/adr/0003-preserve-cw-ids.md), so
-- ticket, company and invoice numbers already printed on paperwork and QuickBooks memos remain valid.

CREATE TABLE crm.company_status (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       citext NOT NULL UNIQUE,
  is_active  boolean NOT NULL DEFAULT true,
  allows_new_work boolean NOT NULL DEFAULT true,       -- false blocks new tickets/time (e.g. Credit Hold)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm.company_type (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       citext NOT NULL UNIQUE,                   -- Customer, Prospect, Vendor, Competitor ...
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm.territory (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       citext NOT NULL UNIQUE,
  manager_member_id bigint REFERENCES iam.member (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm.company (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  identifier         citext NOT NULL UNIQUE,           -- short company id used in search and on tickets
  name               text NOT NULL,
  status_id          bigint NOT NULL REFERENCES crm.company_status (id),
  territory_id       bigint REFERENCES crm.territory (id),
  account_number     text,
  phone              text,
  fax                text,
  website            text,
  date_acquired      date,
  annual_revenue     numeric(16,2),
  employee_count     integer CHECK (employee_count >= 0),
  lead_source        text,
  is_lead            boolean NOT NULL DEFAULT false,
  is_vendor          boolean NOT NULL DEFAULT false,
  is_marketing_opt_out boolean NOT NULL DEFAULT false,
  time_zone          text,
  -- Billing profile
  bill_to_company_id bigint REFERENCES crm.company (id),   -- parent billing entity, if different
  tax_code_id        bigint REFERENCES catalog.tax_code (id),
  tax_exempt_id      text,
  billing_terms_id   bigint REFERENCES catalog.billing_terms (id),
  invoice_delivery   text NOT NULL DEFAULT 'email' CHECK (invoice_delivery IN ('email', 'mail', 'both', 'portal')),
  invoice_email      text,
  autopay_status     text NOT NULL DEFAULT 'none' CHECK (autopay_status IN ('none', 'pending', 'active', 'paused')),
  -- Accounting linkage
  qb_customer_list_id   text,                           -- QB Desktop ListID (stable)
  qb_customer_full_name text,                           -- QB Desktop FullName (can change in QB)
  qbo_customer_id       text,                           -- reserved for QuickBooks Online
  stripe_customer_id    text,                           -- reserved for Stripe
  -- Defaults filled after contacts exist (FKs added below)
  default_contact_id bigint,
  billing_contact_id bigint,
  deleted_at         timestamptz,                       -- soft delete; hard deletes are blocked by FKs anyway
  legacy_cw_company_id integer UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_bill_to_not_self CHECK (bill_to_company_id IS NULL OR bill_to_company_id <> id)
);
CREATE INDEX company_name_trgm_idx ON crm.company USING gin (name gin_trgm_ops);
CREATE INDEX company_status_idx ON crm.company (status_id) WHERE deleted_at IS NULL;
CREATE INDEX company_territory_idx ON crm.company (territory_id);
CREATE INDEX company_bill_to_idx ON crm.company (bill_to_company_id);
CREATE UNIQUE INDEX company_qb_list_id_uq ON crm.company (qb_customer_list_id) WHERE qb_customer_list_id IS NOT NULL;

CREATE TABLE crm.company_company_type (
  company_id bigint NOT NULL REFERENCES crm.company (id) ON DELETE CASCADE,
  type_id    bigint NOT NULL REFERENCES crm.company_type (id),
  PRIMARY KEY (company_id, type_id)
);

CREATE TABLE crm.site (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES crm.company (id),
  name          text NOT NULL,
  address_line1 text,
  address_line2 text,
  city          text,
  state         text,
  postal_code   text,
  country       text NOT NULL DEFAULT 'US',
  phone         text,
  latitude      numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude     numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  is_default_service boolean NOT NULL DEFAULT false,
  is_billing         boolean NOT NULL DEFAULT false,
  access_notes  text,                                   -- gate codes, check-in rules; shown to dispatch/techs
  deleted_at    timestamptz,
  legacy_cw_site_id integer UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
CREATE UNIQUE INDEX site_one_default_service_uq ON crm.site (company_id) WHERE is_default_service AND deleted_at IS NULL;
CREATE UNIQUE INDEX site_one_billing_uq ON crm.site (company_id) WHERE is_billing AND deleted_at IS NULL;

CREATE TABLE crm.contact (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES crm.company (id),
  site_id       bigint REFERENCES crm.site (id),
  first_name    text NOT NULL,
  last_name     text,
  title         text,
  department    text,
  is_inactive   boolean NOT NULL DEFAULT false,
  is_marketing_opt_out boolean NOT NULL DEFAULT false,
  notes         text,
  deleted_at    timestamptz,
  legacy_cw_contact_id integer UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_company_idx ON crm.contact (company_id) WHERE deleted_at IS NULL;
CREATE INDEX contact_name_trgm_idx ON crm.contact
  USING gin ((coalesce(first_name, '') || ' ' || coalesce(last_name, '')) gin_trgm_ops);

-- Phones, emails and other ways to reach a contact. Phone numbers are stored in
-- E.164 in value_normalized so inbound calls can be matched to people (call routing, caller id).
CREATE TABLE crm.contact_channel (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id  bigint NOT NULL REFERENCES crm.contact (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('email', 'direct', 'mobile', 'office', 'home', 'fax', 'other')),
  value       text NOT NULL,
  value_normalized text NOT NULL,                       -- lower(email) or E.164 phone
  extension   text,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, kind, value_normalized)
);
CREATE INDEX contact_channel_lookup_idx ON crm.contact_channel (value_normalized);
CREATE UNIQUE INDEX contact_channel_one_default_uq
  ON crm.contact_channel (contact_id, (kind = 'email')) WHERE is_default;

ALTER TABLE crm.company
  ADD CONSTRAINT company_default_contact_fk FOREIGN KEY (default_contact_id) REFERENCES crm.contact (id),
  ADD CONSTRAINT company_billing_contact_fk FOREIGN KEY (billing_contact_id) REFERENCES crm.contact (id);

ALTER TABLE catalog.product
  ADD CONSTRAINT product_vendor_company_fk FOREIGN KEY (vendor_company_id) REFERENCES crm.company (id);

CREATE TABLE crm.company_note (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  bigint NOT NULL REFERENCES crm.company (id),
  contact_id  bigint REFERENCES crm.contact (id),
  member_id   bigint REFERENCES iam.member (id),
  kind        text NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'call', 'meeting', 'alert')),
  body        text NOT NULL,
  is_alert    boolean NOT NULL DEFAULT false,           -- alert notes pop up when the company is opened
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_note_company_idx ON crm.company_note (company_id, created_at DESC);

SELECT sys.attach_standard_triggers('crm.company_status');
SELECT sys.attach_standard_triggers('crm.company_type');
SELECT sys.attach_standard_triggers('crm.territory');
SELECT sys.attach_standard_triggers('crm.company');
SELECT sys.attach_standard_triggers('crm.site');
SELECT sys.attach_standard_triggers('crm.contact');
SELECT sys.attach_standard_triggers('crm.contact_channel');
SELECT sys.attach_standard_triggers('crm.company_note', false);

INSERT INTO crm.company_status (name, allows_new_work) VALUES
  ('Active', true), ('Prospect', true), ('Inactive', false), ('Credit Hold', false);
INSERT INTO crm.company_type (name) VALUES
  ('Customer'), ('Prospect'), ('Vendor'), ('Partner'), ('Competitor');
