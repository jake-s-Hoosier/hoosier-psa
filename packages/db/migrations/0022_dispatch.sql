-- 0022_dispatch
-- The dispatch board: who is scheduled where, and when (docs/03). An entry puts one person on a ticket for a block of
-- time (project work is ticket work, so project visits are tickets too), or marks time that is not ticket work, such
-- as a meeting or time off. Overlaps are allowed but reported, because a dispatcher sometimes double-books on purpose;
-- the API returns the clashes and the board shows them. Nothing here talks to Outlook; calendar sync comes later.

CREATE SCHEMA dispatch;

CREATE TABLE dispatch.schedule_entry (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL DEFAULT 'ticket' CHECK (kind IN ('ticket', 'meeting', 'time_off')),
  ticket_id   bigint REFERENCES service.ticket (id),
  member_id   bigint NOT NULL REFERENCES iam.member (id),
  title       text CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 300),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'confirmed', 'completed', 'canceled')),
  notes       text,
  created_by_member_id bigint REFERENCES iam.member (id),
  legacy_cw_schedule_id bigint UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_entry_ends_after_start CHECK (ends_at > starts_at),
  CONSTRAINT schedule_entry_under_a_week CHECK (ends_at - starts_at <= interval '7 days'),
  CONSTRAINT schedule_entry_kind_shape CHECK (
    (kind = 'ticket' AND ticket_id IS NOT NULL) OR (kind <> 'ticket' AND ticket_id IS NULL AND title IS NOT NULL))
);
CREATE INDEX schedule_entry_member_time_idx ON dispatch.schedule_entry (member_id, starts_at);
CREATE INDEX schedule_entry_time_idx ON dispatch.schedule_entry (starts_at);
CREATE INDEX schedule_entry_ticket_idx ON dispatch.schedule_entry (ticket_id) WHERE ticket_id IS NOT NULL;
SELECT sys.attach_standard_triggers('dispatch.schedule_entry');
