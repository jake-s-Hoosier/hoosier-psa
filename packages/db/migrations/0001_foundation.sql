-- 0001_foundation
-- Extensions, schemas, shared trigger functions and the audit log.
-- See docs/adr/0002-dedicated-database.md and docs/03-domain-model.md.

CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive identifiers and emails
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fuzzy search on names
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraints (schedule overlaps, later)

-- sys is created by the migration runner (it holds schema_migrations).
CREATE SCHEMA IF NOT EXISTS iam;           -- staff members, roles, permissions
CREATE SCHEMA IF NOT EXISTS crm;           -- companies, sites, contacts
CREATE SCHEMA IF NOT EXISTS catalog;       -- products, rate cards, tax codes, terms
CREATE SCHEMA IF NOT EXISTS service;       -- boards, tickets, notes
CREATE SCHEMA IF NOT EXISTS timekeeping;   -- time entries, leave, pay periods

-- Keeps updated_at honest without relying on application code.
CREATE OR REPLACE FUNCTION sys.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Append-only audit trail. Rows are written by sys.audit_row() triggers.
-- The acting staff member is passed by the API per transaction:
--   SET LOCAL app.member_id = '42';
CREATE TABLE sys.audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  member_id   bigint,                       -- no FK: audit rows must outlive members
  table_name  text NOT NULL,                -- schema-qualified
  row_pk      text NOT NULL,
  action      text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  old_row     jsonb,
  new_row     jsonb,
  changed     text[]                         -- column names that changed (UPDATE only)
);
CREATE INDEX audit_log_table_row_idx ON sys.audit_log (table_name, row_pk, occurred_at DESC);
CREATE INDEX audit_log_member_idx ON sys.audit_log (member_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION sys.audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_member bigint := NULLIF(current_setting('app.member_id', true), '')::bigint;
  v_old jsonb;
  v_new jsonb;
  v_changed text[];
  v_pk text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    v_pk := v_new ->> 'id';
  ELSIF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_pk := v_new ->> 'id';
    SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
    FROM jsonb_each(v_new) n
    WHERE n.key <> 'updated_at' AND v_old -> n.key IS DISTINCT FROM n.value;
    IF v_changed IS NULL THEN
      RETURN NEW;  -- no-op update, nothing to record
    END IF;
  ELSE
    v_old := to_jsonb(OLD);
    v_pk := v_old ->> 'id';
  END IF;

  INSERT INTO sys.audit_log (member_id, table_name, row_pk, action, old_row, new_row, changed)
  VALUES (v_member, TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, v_pk, TG_OP, v_old, v_new, v_changed);

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Attach updated_at maintenance and auditing to a table that has id and updated_at.
CREATE OR REPLACE FUNCTION sys.attach_standard_triggers(p_table regclass, p_audit boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_name text := replace(p_table::text, '.', '_');
BEGIN
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION sys.set_updated_at()',
    v_name || '_set_updated_at', p_table);
  IF p_audit THEN
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION sys.audit_row()',
      v_name || '_audit', p_table);
  END IF;
END;
$$;

COMMENT ON TABLE sys.audit_log IS
  'Append-only change history for audited tables. Never updated or deleted by application code.';
