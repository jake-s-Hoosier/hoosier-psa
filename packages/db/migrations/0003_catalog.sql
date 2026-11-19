-- 0003_catalog
-- Reference data that billing and time capture depend on: tax codes, terms,
-- rate cards (work roles / work types) and the product catalog.

CREATE TABLE catalog.tax_code (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        citext NOT NULL UNIQUE,
  rate_pct    numeric(7,4) NOT NULL DEFAULT 0 CHECK (rate_pct >= 0 AND rate_pct <= 100),
  is_active   boolean NOT NULL DEFAULT true,
  qb_tax_code text,                                    -- QB Desktop sales tax code name
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog.billing_terms (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       citext NOT NULL UNIQUE,                   -- 'Net 30'
  due_days   integer NOT NULL CHECK (due_days >= 0),
  discount_pct  numeric(5,2) NOT NULL DEFAULT 0,
  discount_days integer NOT NULL DEFAULT 0,
  qb_terms   text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Work role = what a person is doing (Technician, Senior Tech, Project Manager).
-- Carries the standard bill rate; member-specific overrides come later.
CREATE TABLE catalog.work_role (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        citext NOT NULL UNIQUE,
  hourly_rate numeric(10,2) NOT NULL CHECK (hourly_rate >= 0),
  is_active   boolean NOT NULL DEFAULT true,
  legacy_cw_work_role_id integer UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Work type = how the work is billed (Regular, After Hours, Emergency, Remote).
CREATE TABLE catalog.work_type (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            citext NOT NULL UNIQUE,
  rate_multiplier numeric(6,3) NOT NULL DEFAULT 1.000 CHECK (rate_multiplier >= 0),
  is_billable_default boolean NOT NULL DEFAULT true,
  counts_against_agreement boolean NOT NULL DEFAULT true,  -- deducts from block/prepaid hours
  is_active       boolean NOT NULL DEFAULT true,
  legacy_cw_work_type_id integer UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog.product_category (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       citext NOT NULL UNIQUE,
  parent_id  bigint REFERENCES catalog.product_category (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog.product (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  identifier    citext NOT NULL UNIQUE,                -- SKU / part number
  description   text NOT NULL,
  category_id   bigint REFERENCES catalog.product_category (id),
  kind          text NOT NULL DEFAULT 'inventory'
                CHECK (kind IN ('inventory', 'non_inventory', 'service', 'agreement', 'other_charge')),
  unit_price    numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  unit_cost     numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  unit_of_measure text NOT NULL DEFAULT 'Each',
  is_taxable    boolean NOT NULL DEFAULT true,
  is_recurring  boolean NOT NULL DEFAULT false,        -- candidate for agreement additions / RMR
  is_active     boolean NOT NULL DEFAULT true,
  vendor_company_id bigint,                            -- FK added once crm.company exists (0004)
  manufacturer_part_number text,
  qb_item_full_name text,                              -- QB Desktop item list FullName
  legacy_cw_catalog_id integer UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_description_trgm_idx ON catalog.product USING gin (description gin_trgm_ops);
CREATE INDEX product_category_idx ON catalog.product (category_id);

SELECT sys.attach_standard_triggers('catalog.tax_code');
SELECT sys.attach_standard_triggers('catalog.billing_terms');
SELECT sys.attach_standard_triggers('catalog.work_role');
SELECT sys.attach_standard_triggers('catalog.work_type');
SELECT sys.attach_standard_triggers('catalog.product');

COMMENT ON COLUMN catalog.product.unit_price IS
  'Four decimal places: distributor pricing often needs sub-cent precision. Invoice lines round to cents.';
