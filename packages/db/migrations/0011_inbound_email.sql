-- 0011_inbound_email
-- Inbound email to tickets through Microsoft 365 (docs/adr/0012-microsoft-365-mail.md).
--
-- service.mailbox: one row per shared mailbox the PSA reads. A mailbox starts INACTIVE and only
-- looks at mail received after poll_from, so switching it on never replays history.
-- service.inbound_email: one row per message seen (a log, not audited: it carries message bodies).
-- The unique (mailbox_id, message_id) is what makes processing safe to repeat.

INSERT INTO service.ticket_source (name) VALUES ('Email') ON CONFLICT (name) DO NOTHING;

CREATE TABLE service.mailbox (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address             citext NOT NULL UNIQUE,
  board_id            bigint NOT NULL REFERENCES service.board (id),
  priority_id         bigint REFERENCES service.priority (id),     -- null = the board's default
  fallback_company_id bigint NOT NULL REFERENCES crm.company (id), -- tickets from unknown senders land here for triage
  reopen_on_reply     boolean NOT NULL DEFAULT true,               -- a customer reply reopens a closed ticket
  is_active           boolean NOT NULL DEFAULT false,
  poll_from           timestamptz NOT NULL DEFAULT now(),
  last_received_at    timestamptz,                                  -- newest message handled; the next poll starts here
  last_polled_at      timestamptz,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
SELECT sys.attach_standard_triggers('service.mailbox');

CREATE TABLE service.inbound_email (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mailbox_id          bigint NOT NULL REFERENCES service.mailbox (id),
  message_id          text NOT NULL,                                -- RFC 5322 Message-ID
  in_reply_to         text,
  reference_ids       text[] NOT NULL DEFAULT '{}',
  from_address        citext NOT NULL,
  from_name           text,
  subject             text NOT NULL DEFAULT '',
  received_at         timestamptz NOT NULL,
  outcome             text NOT NULL CHECK (outcome IN ('created', 'created_unmatched', 'appended', 'ignored', 'error')),
  reason              text,                                         -- why ignored or failed, or how it was matched
  ticket_id           bigint REFERENCES service.ticket (id) ON DELETE SET NULL,
  note_id             bigint REFERENCES service.ticket_note (id) ON DELETE SET NULL,
  attachments_stored  integer NOT NULL DEFAULT 0,
  attachments_skipped integer NOT NULL DEFAULT 0,
  body_text           text,
  processed_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, message_id)
);
CREATE INDEX inbound_email_message_id_idx ON service.inbound_email (message_id);
CREATE INDEX inbound_email_ticket_idx ON service.inbound_email (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX inbound_email_outcome_idx ON service.inbound_email (outcome, received_at DESC);
