-- 0010_audit_join_tables_and_attachments
--
-- 1. Audit trail for tables whose primary key is not a single "id" column (role grants, role
--    membership, ticket resources). sys.audit_row() now builds row_pk from the column names given as
--    trigger arguments when the row has no "id". Behaviour for tables with an id is unchanged.
-- 2. Ticket attachments: metadata in service.ticket_attachment (audited), file bytes in a separate
--    table that is deliberately NOT audited so file contents are never copied into sys.audit_log.

CREATE OR REPLACE FUNCTION sys.audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_member bigint := NULLIF(current_setting('app.member_id', true), '')::bigint;
  v_old jsonb;
  v_new jsonb;
  v_changed text[];
  v_pk text;
  v_row jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    v_row := v_new;
  ELSIF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_row := v_new;
    SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
    FROM jsonb_each(v_new) n
    WHERE n.key <> 'updated_at' AND v_old -> n.key IS DISTINCT FROM n.value;
    IF v_changed IS NULL THEN
      RETURN NEW;  -- no-op update, nothing to record
    END IF;
  ELSE
    v_old := to_jsonb(OLD);
    v_row := v_old;
  END IF;

  v_pk := v_row ->> 'id';
  IF v_pk IS NULL AND TG_NARGS > 0 THEN
    -- composite key: join the named columns, e.g. 'role_id/permission_key' values
    SELECT string_agg(v_row ->> a, '/' ORDER BY ord) INTO v_pk
    FROM unnest(TG_ARGV) WITH ORDINALITY AS t(a, ord);
  END IF;

  INSERT INTO sys.audit_log (member_id, table_name, row_pk, action, old_row, new_row, changed)
  VALUES (v_member, TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, v_pk, TG_OP, v_old, v_new, v_changed);

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER iam_role_permission_audit AFTER INSERT OR UPDATE OR DELETE ON iam.role_permission
  FOR EACH ROW EXECUTE FUNCTION sys.audit_row('role_id', 'permission_key');
CREATE TRIGGER iam_member_role_audit AFTER INSERT OR UPDATE OR DELETE ON iam.member_role
  FOR EACH ROW EXECUTE FUNCTION sys.audit_row('member_id', 'role_id');
CREATE TRIGGER service_ticket_resource_audit AFTER INSERT OR UPDATE OR DELETE ON service.ticket_resource
  FOR EACH ROW EXECUTE FUNCTION sys.audit_row('ticket_id', 'member_id');

CREATE TABLE service.ticket_attachment (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id     bigint NOT NULL REFERENCES service.ticket (id) ON DELETE CASCADE,
  file_name     text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  content_type  text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by_member_id bigint REFERENCES iam.member (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,                              -- removed from view; bytes kept until a purge
  deleted_by_member_id bigint REFERENCES iam.member (id),
  legacy_cw_document_id integer UNIQUE                    -- ConnectWise document id, import traceability
);
CREATE INDEX ticket_attachment_ticket_idx ON service.ticket_attachment (ticket_id)
  WHERE deleted_at IS NULL;
SELECT sys.attach_standard_triggers('service.ticket_attachment');

CREATE TABLE service.ticket_attachment_blob (
  attachment_id bigint PRIMARY KEY REFERENCES service.ticket_attachment (id) ON DELETE CASCADE,
  data          bytea NOT NULL
);
COMMENT ON TABLE service.ticket_attachment_blob IS
  'File bytes. No audit trigger on purpose: the audit log stores row values and must not hold file contents.';
