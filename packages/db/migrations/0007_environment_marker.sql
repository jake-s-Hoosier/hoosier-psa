-- 0007_environment_marker
-- Every database declares which environment it is, and production declares whether go-live has been
-- approved. Application startup compares this marker with its own configuration and refuses to run
-- on a mismatch, and refuses to write to a production database that has not been approved.
-- See docs/12-environments-and-safe-rollout.md and docs/adr/0009-environment-markers-and-write-guards.md.

CREATE TABLE sys.environment (
  singleton           boolean PRIMARY KEY DEFAULT true CHECK (singleton),   -- exactly one row, ever
  name                text NOT NULL CHECK (name IN ('development', 'test', 'uat', 'shadow', 'production')),
  go_live_approved_at timestamptz,
  go_live_approved_by text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT environment_approval_pair CHECK ((go_live_approved_at IS NULL) = (go_live_approved_by IS NULL)),
  CONSTRAINT environment_approval_only_production CHECK (go_live_approved_at IS NULL OR name = 'production')
);

CREATE OR REPLACE FUNCTION sys.guard_environment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sys.environment cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.name <> OLD.name THEN
    RAISE EXCEPTION 'a database cannot change environment (% -> %)', OLD.name, NEW.name
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.go_live_approved_at IS NOT NULL AND
     (NEW.go_live_approved_at IS DISTINCT FROM OLD.go_live_approved_at
      OR NEW.go_live_approved_by IS DISTINCT FROM OLD.go_live_approved_by) THEN
    RAISE EXCEPTION 'go-live approval is permanent and cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER environment_guard
  BEFORE UPDATE OR DELETE ON sys.environment
  FOR EACH ROW EXECUTE FUNCTION sys.guard_environment();

COMMENT ON TABLE sys.environment IS
  'Single-row marker: which environment this database is, and (production only) when go-live was approved.';
