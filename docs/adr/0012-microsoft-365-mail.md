# 0012. Inbound email through Microsoft 365 (Graph), read-only, polled

Status: Accepted
Date: 2026-11-19

## Context
Customers email support and expect a ticket. Hoosier Security's mail is Microsoft 365. The PSA must turn
mail into tickets and replies into notes, without losing or duplicating anything, and without disturbing
ConnectWise, which keeps handling the same mailbox until cutover.

## Decision
- **Microsoft Graph, application permission `Mail.Read` only**, using client credentials (an app registration
  in the Hoosier Security tenant). The tenant restricts the app to the support mailbox(es) with an
  **application access policy**; without one, `Mail.Read` reaches every mailbox. The PSA never moves, marks,
  deletes or sends mail in this milestone, so it cannot interfere with ConnectWise's use of the mailbox.
- **Polling, not webhooks.** The API asks for messages received since the last one it handled (minus a
  five-minute overlap) every 60 seconds. No inbound public endpoint, no subscription renewals, and a missed
  cycle costs nothing because the next one catches up. Webhooks can replace the trigger later; the processing stays.
- **Idempotent by Message-ID.** `service.inbound_email` has a unique `(mailbox_id, message_id)`. The row is
  claimed first inside the same transaction that creates the ticket, so a repeat, an overlap re-read or a
  crash cannot make a second ticket. A failed message is logged as an error row and not retried forever.
- **Mailboxes live in the database** (`service.mailbox`): address, board, priority, a fallback company, and an
  on/off switch. A new mailbox starts off, and switching on a never-polled mailbox starts from that moment,
  so enabling it never replays history. A database copied to UAT therefore needs the mailbox checked before it is switched on.
- **Matching.**
  - A reply joins an existing ticket when the subject carries `[#12345]` or `Ticket #12345`, or when
    `In-Reply-To`/`References` names a message already logged against a ticket. **Joining requires the sender
    to be a known contact of that ticket's company or a staff member**; guessing a ticket number is not enough.
  - A new ticket is opened for a sender who is a contact at exactly one company (matched by email address,
    case-insensitively). Unknown senders, and people who are contacts at several companies, go to the mailbox's
    fallback company, with a line at the top of the description saying why, for staff to move with "Move to another company".
  - No matching by email domain: shared and public domains (gmail.com) would attach tickets to the wrong customer.
- **Not turned into tickets:** mail from our own mailboxes (loops), `Auto-Submitted` other than `no`,
  `Precedence: bulk/junk/list`, and no-reply/mailer-daemon senders. They are logged as ignored with the reason.
- **Text only.** Graph returns the body as text; HTML is converted if that is all there is. Quoted earlier
  conversation is cut from reply notes; the full original text stays in `inbound_email.body_text`.
  Attachments become ticket attachments (25 MB each); inline images are dropped.
- **Gating.** `MAIL_POLL_ENABLED` is off by default and needs the three `GRAPH_*` settings and a writable
  database. It is refused in the shadow environment, and in production it also needs `INTEGRATIONS_ENABLED`
  (so it follows the go-live approval). UAT may poll a dedicated test mailbox.

## Consequences
- During the parallel run, production polling stays off. UAT is tested with a separate test mailbox that
  only the PSA reads. At cutover, ConnectWise stops reading the mailbox and the PSA switches on.
- Outbound mail (acknowledgements, "ticket updated" notices, invoices) is a separate decision: it needs
  `Mail.Send`, a sender address, templates and loop protection. It is not built. When it is, subjects will carry `[#ticket]` so replies thread.
- Mail stays in the inbox after processing. A later step can move processed mail to a folder once ConnectWise is gone.
- Message bodies sit in the database. `inbound_email` is not audited, for the same reason as attachment bytes.
- Graph throttling (HTTP 429) surfaces as a mailbox error and the next cycle retries.

## Alternatives considered
- **IMAP with an app password.** Basic auth is retired for Exchange Online, and app passwords reach the
  whole mailbox with no policy to narrow them.
- **Graph change notifications (webhooks).** Lower latency, but needs a public endpoint, validation handshakes and
  subscription renewals; polling every minute is fast enough for tickets.
- **Delegated permissions with a service account.** Ties the integration to a licensed user and a password or MFA.
- **Matching by domain.** Rejected above.
