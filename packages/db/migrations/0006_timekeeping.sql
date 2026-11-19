-- 0006_timekeeping
-- Detailed time capture. Design goals (docs/04-time-and-payroll.md):
--   * every entry snapshots the bill rate and cost rate in force when it was written
--   * live timers are first-class (a row with ended_at NULL)
--   * entries move through a lifecycle and are locked once billed or paid
--   * payroll-relevant facts (workweek, pay period, overtime) are derivable from the data

CREATE TABLE timekeeping.pay_period (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  pay_date    date,                                      -- confirmed against Justworks calendar before use
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'exported')),
  locked_at   timestamptz,
  exported_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_period_dates CHECK (end_date >= start_date),
  CONSTRAINT pay_period_no_overlap EXCLUDE USING gist (daterange(start_date, end_date, '[]') WITH &&)
);

CREATE TABLE timekeeping.time_entry (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id      bigint NOT NULL REFERENCES iam.member (id),
  company_id     bigint NOT NULL REFERENCES crm.company (id),
  charge_type    text NOT NULL CHECK (charge_type IN ('service_ticket', 'project_ticket', 'agreement', 'non_ticket')),
  ticket_id      bigint REFERENCES service.ticket (id),
  project_ticket_id bigint,                              -- FK added in the projects migration
  agreement_id   bigint,                                 -- FK added in the agreements migration
  work_role_id   bigint NOT NULL REFERENCES catalog.work_role (id),
  work_type_id   bigint NOT NULL REFERENCES catalog.work_type (id),
  work_date      date NOT NULL,                          -- local date in the member's time zone
  started_at     timestamptz,
  ended_at       timestamptz,                            -- NULL while a timer is running
  is_timer       boolean NOT NULL DEFAULT false,
  actual_hours   numeric(7,2) NOT NULL DEFAULT 0 CHECK (actual_hours >= 0 AND actual_hours <= 24),
  billed_hours   numeric(7,2) NOT NULL DEFAULT 0 CHECK (billed_hours >= 0),   -- after rounding rules
  billable       text NOT NULL DEFAULT 'billable' CHECK (billable IN ('billable', 'do_not_bill', 'no_charge')),
  bill_rate      numeric(10,2) NOT NULL DEFAULT 0 CHECK (bill_rate >= 0),     -- snapshot
  cost_rate      numeric(10,2) NOT NULL DEFAULT 0 CHECK (cost_rate >= 0),     -- snapshot
  notes          text,                                   -- customer-visible work description
  internal_notes text,
  status         text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'submitted', 'approved', 'billed', 'void')),
  approved_by_member_id bigint REFERENCES iam.member (id),
  approved_at    timestamptz,
  invoice_id     bigint,                                 -- FK added in the billing migration
  pay_period_id  bigint REFERENCES timekeeping.pay_period (id),
  legacy_cw_time_entry_id integer UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT time_entry_end_after_start CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at > started_at),
  CONSTRAINT time_entry_timer_open CHECK (NOT is_timer OR ended_at IS NULL OR started_at IS NOT NULL),
  CONSTRAINT time_entry_charge_target CHECK (
    (charge_type = 'service_ticket' AND ticket_id IS NOT NULL)
    OR (charge_type = 'project_ticket' AND project_ticket_id IS NOT NULL)
    OR (charge_type = 'agreement' AND agreement_id IS NOT NULL)
    OR (charge_type = 'non_ticket')
  ),
  CONSTRAINT time_entry_billed_has_invoice CHECK (status <> 'billed' OR invoice_id IS NOT NULL)
);
-- One running timer per person.
CREATE UNIQUE INDEX time_entry_one_running_timer_uq ON timekeeping.time_entry (member_id)
  WHERE is_timer AND ended_at IS NULL;
CREATE INDEX time_entry_member_date_idx ON timekeeping.time_entry (member_id, work_date);
CREATE INDEX time_entry_ticket_idx ON timekeeping.time_entry (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX time_entry_company_date_idx ON timekeeping.time_entry (company_id, work_date);
CREATE INDEX time_entry_unbilled_idx ON timekeeping.time_entry (company_id)
  WHERE status IN ('approved') AND billable = 'billable';

ALTER TABLE service.ticket_note
  ADD CONSTRAINT ticket_note_time_entry_fk FOREIGN KEY (time_entry_id) REFERENCES timekeeping.time_entry (id) ON DELETE SET NULL;

-- Paid leave and holidays. Kept apart from time_entry because it is never billed and has no company.
CREATE TABLE timekeeping.leave_entry (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id   bigint NOT NULL REFERENCES iam.member (id),
  leave_date  date NOT NULL,
  hours       numeric(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  leave_type  text NOT NULL CHECK (leave_type IN ('pto', 'holiday', 'sick', 'unpaid', 'other')),
  notes       text,
  status      text NOT NULL DEFAULT 'approved' CHECK (status IN ('requested', 'approved', 'denied')),
  external_ref text,                                      -- Justworks time-off request id, if synced
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, leave_date, leave_type)
);

SELECT sys.attach_standard_triggers('timekeeping.pay_period');
SELECT sys.attach_standard_triggers('timekeeping.time_entry');
SELECT sys.attach_standard_triggers('timekeeping.leave_entry');

-- Billed, voided or period-locked entries are immutable except to move between those states by
-- privileged code paths that set app.allow_locked_edit = 'on' for the transaction.
CREATE OR REPLACE FUNCTION timekeeping.guard_locked_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_period_status text;
BEGIN
  IF current_setting('app.allow_locked_edit', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD.status = 'billed' THEN
      RAISE EXCEPTION 'time entry % is billed and cannot be changed', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.pay_period_id IS NOT NULL THEN
      SELECT status INTO v_period_status FROM timekeeping.pay_period WHERE id = OLD.pay_period_id;
      IF v_period_status IN ('locked', 'exported') THEN
        RAISE EXCEPTION 'time entry % belongs to a % pay period', OLD.id, v_period_status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER time_entry_guard_locked
  BEFORE UPDATE OR DELETE ON timekeeping.time_entry
  FOR EACH ROW EXECUTE FUNCTION timekeeping.guard_locked_entry();

COMMENT ON TABLE timekeeping.time_entry IS
  'One block of work. bill_rate and cost_rate are snapshots; never recompute them from current rate cards.';
