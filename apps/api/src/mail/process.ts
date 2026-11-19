import { createHash } from "node:crypto";
import { withActor } from "@hoosier/db";
import type pg from "pg";
import { MAX_ATTACHMENT_BYTES, cleanContentType, cleanFileName } from "../routes/ticket-files.js";
import { cleanSubject, stripQuotedReply, ticketRefs } from "./text.js";
import type { MailMessage } from "./types.js";

export interface Mailbox {
  id: number;
  address: string;
  boardId: number;
  priorityId: number | null;
  fallbackCompanyId: number;
  reopenOnReply: boolean;
}

export type Outcome =
  | "created"
  | "created_unmatched"
  | "appended"
  | "ignored"
  | "error"
  | "duplicate";
export interface ProcessResult {
  outcome: Outcome;
  reason?: string;
  ticketId?: number;
}

const AUTOMATED_SENDERS = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|donotreply)$/i;

/** Why a message should be dropped without touching any ticket, or null if it should be processed. */
export function ignoreReason(msg: MailMessage, ownAddresses: Set<string>): string | null {
  const from = msg.fromAddress.trim().toLowerCase();
  if (!from || !from.includes("@")) return "no usable sender address";
  if (ownAddresses.has(from)) return "sent from one of our own mailboxes (loop protection)";
  const local = from.split("@")[0] ?? "";
  if (AUTOMATED_SENDERS.test(local)) return "automated sender";
  if (msg.autoSubmitted && msg.autoSubmitted.trim().toLowerCase() !== "no")
    return "auto-submitted message";
  if (msg.precedence && /^(bulk|junk|list|auto_reply)$/i.test(msg.precedence.trim()))
    return "bulk or automatic mail";
  return null;
}

type Db = pg.Pool | pg.PoolClient;

interface Sender {
  contacts: Array<{ contactId: number; companyId: number }>;
  memberId: number | null;
}

async function identifySender(db: Db, address: string): Promise<Sender> {
  const contacts = await db.query<{ contact_id: string; company_id: string }>(
    `SELECT DISTINCT c.id AS contact_id, c.company_id
       FROM crm.contact_channel ch JOIN crm.contact c ON c.id = ch.contact_id
      WHERE ch.kind = 'email' AND ch.value_normalized = $1
        AND c.deleted_at IS NULL AND NOT c.is_inactive`,
    [address],
  );
  const member = await db.query<{ id: string }>(
    "SELECT id FROM iam.member WHERE email = $1 AND is_active",
    [address],
  );
  return {
    contacts: contacts.rows.map((r) => ({
      contactId: Number(r.contact_id),
      companyId: Number(r.company_id),
    })),
    memberId: member.rows[0] ? Number(member.rows[0].id) : null,
  };
}

/** Existing tickets this message might belong to, in the order to try them. */
async function candidateTickets(db: Db, mailboxId: number, msg: MailMessage): Promise<number[]> {
  const ids = ticketRefs(msg.subject);
  const parents = [msg.inReplyTo, ...msg.references].filter((x): x is string => !!x);
  if (parents.length) {
    const { rows } = await db.query<{ ticket_id: string }>(
      `SELECT ticket_id FROM service.inbound_email
        WHERE mailbox_id = $1 AND message_id = ANY($2::text[]) AND ticket_id IS NOT NULL
        ORDER BY received_at DESC`,
      [mailboxId, parents],
    );
    for (const r of rows) if (!ids.includes(Number(r.ticket_id))) ids.push(Number(r.ticket_id));
  }
  return ids;
}

/**
 * Handles one message: ignore it, add it to a ticket, or open a new ticket. Safe to call again for the
 * same message (it is recognised by its Message-ID and reported as a duplicate).
 *
 * A message only joins an existing ticket when the sender is a known contact of that ticket's company
 * (or a staff member). Guessing a ticket number in a subject line is not enough to write into it.
 */
export async function processInboundMessage(
  pool: pg.Pool,
  mailbox: Mailbox,
  msg: MailMessage,
  ownAddresses: Set<string>,
): Promise<ProcessResult> {
  const from = msg.fromAddress.trim().toLowerCase();
  const messageId = msg.internetMessageId.trim();
  if (!messageId) return { outcome: "error", reason: "message has no Message-ID" };

  return withActor(pool, null, async (db) => {
    // Claim the message first. If the row already exists, someone processed it.
    const claim = await db.query<{ id: string }>(
      `INSERT INTO service.inbound_email
         (mailbox_id, message_id, in_reply_to, reference_ids, from_address, from_name, subject,
          received_at, outcome, body_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ignored',$9)
       ON CONFLICT (mailbox_id, message_id) DO NOTHING RETURNING id`,
      [
        mailbox.id,
        messageId,
        msg.inReplyTo,
        msg.references,
        from || "unknown",
        msg.fromName,
        msg.subject.slice(0, 1000),
        msg.receivedAt,
        msg.bodyText.slice(0, 200_000),
      ],
    );
    const logId = claim.rows[0]?.id;
    if (!logId) return { outcome: "duplicate" } as ProcessResult;

    const finish = async (
      r: ProcessResult & { noteId?: number; stored?: number; skipped?: number },
    ) => {
      await db.query(
        `UPDATE service.inbound_email
            SET outcome = $2, reason = $3, ticket_id = $4, note_id = $5,
                attachments_stored = $6, attachments_skipped = $7
          WHERE id = $1`,
        [
          logId,
          r.outcome,
          r.reason ?? null,
          r.ticketId ?? null,
          r.noteId ?? null,
          r.stored ?? 0,
          r.skipped ?? 0,
        ],
      );
      return r as ProcessResult;
    };

    const ignored = ignoreReason(msg, ownAddresses);
    if (ignored) return finish({ outcome: "ignored", reason: ignored });

    const sender = await identifySender(db, from);
    const reply = stripQuotedReply(msg.bodyText);
    const body = reply || "(no text)";

    // 1. A reply to an existing ticket.
    for (const ticketId of await candidateTickets(db, mailbox.id, msg)) {
      const t = await db.query<{ company_id: string; is_closed: boolean; board_id: string }>(
        `SELECT t.company_id, s.is_closed, t.board_id
           FROM service.ticket t JOIN service.board_status s ON s.id = t.status_id
          WHERE t.id = $1`,
        [ticketId],
      );
      const ticket = t.rows[0];
      if (!ticket) continue;
      const contact = sender.contacts.find((c) => c.companyId === Number(ticket.company_id));
      if (!contact && sender.memberId === null) continue; // not allowed to write into this ticket

      const note = await db.query<{ id: string }>(
        `INSERT INTO service.ticket_note (ticket_id, kind, body, author_member_id, author_contact_id)
         VALUES ($1,'discussion',$2,$3,$4) RETURNING id`,
        [ticketId, body, contact ? null : sender.memberId, contact?.contactId ?? null],
      );
      if (contact) {
        await db.query("UPDATE service.ticket SET customer_updated_at = now() WHERE id = $1", [
          ticketId,
        ]);
        if (ticket.is_closed && mailbox.reopenOnReply) {
          const reopen = await db.query<{ id: string }>(
            "SELECT id FROM service.board_status WHERE board_id = $1 AND is_default AND is_active",
            [ticket.board_id],
          );
          if (reopen.rows[0]) {
            await db.query(
              "UPDATE service.ticket SET status_id = $2, closed_at = NULL, closed_by_member_id = NULL WHERE id = $1",
              [ticketId, reopen.rows[0].id],
            );
          }
        }
      } else {
        await db.query(
          "UPDATE service.ticket SET first_response_at = now() WHERE id = $1 AND first_response_at IS NULL",
          [ticketId],
        );
      }
      const files = await storeAttachments(db, ticketId, msg, sender.memberId);
      return finish({
        outcome: "appended",
        ticketId,
        noteId: Number(note.rows[0]?.id),
        reason: contact ? "reply from a known contact" : "reply from staff",
        ...files,
      });
    }

    // 2. A new ticket. A sender who is a contact of exactly one company is matched; otherwise the
    //    ticket goes to the mailbox's fallback company for someone to sort out.
    const companies = [...new Set(sender.contacts.map((c) => c.companyId))];
    const matched = companies.length === 1 ? sender.contacts[0] : undefined;
    const companyId = matched?.companyId ?? mailbox.fallbackCompanyId;
    const contactId = matched?.contactId ?? null;

    const status = await db.query<{ id: string }>(
      "SELECT id FROM service.board_status WHERE board_id = $1 AND is_default AND is_active",
      [mailbox.boardId],
    );
    if (!status.rows[0]) throw new Error("The mailbox's board has no default status");
    const prio = await db.query<{ id: string }>(
      `SELECT COALESCE($2::bigint, (SELECT default_priority_id FROM service.board WHERE id = $1),
                       (SELECT id FROM service.priority WHERE name = 'Normal')) AS id`,
      [mailbox.boardId, mailbox.priorityId],
    );
    const ticket = await db.query<{ id: string }>(
      `INSERT INTO service.ticket
         (summary, company_id, contact_id, board_id, status_id, priority_id, source_id, customer_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,(SELECT id FROM service.ticket_source WHERE name = 'Email'), now())
       RETURNING id`,
      [
        cleanSubject(msg.subject),
        companyId,
        contactId,
        mailbox.boardId,
        status.rows[0].id,
        prio.rows[0]?.id,
      ],
    );
    const ticketId = Number(ticket.rows[0]?.id);
    const unmatchedNote = matched
      ? ""
      : `[Sender ${msg.fromName ? `${msg.fromName} ` : ""}<${from}> is ${
          companies.length > 1 ? "a contact at more than one company" : "not a known contact"
        }; this ticket is on the fallback company until someone moves it.]\n\n`;
    const note = await db.query<{ id: string }>(
      `INSERT INTO service.ticket_note (ticket_id, kind, body, author_contact_id)
       VALUES ($1,'description',$2,$3) RETURNING id`,
      [ticketId, `${unmatchedNote}${body}`, contactId],
    );
    const files = await storeAttachments(db, ticketId, msg, null);
    return finish({
      outcome: matched ? "created" : "created_unmatched",
      ticketId,
      noteId: Number(note.rows[0]?.id),
      reason: matched
        ? "sender matched to a contact"
        : companies.length > 1
          ? "sender belongs to several companies"
          : "sender is not a known contact",
      ...files,
    });
  });
}

async function storeAttachments(
  db: Db,
  ticketId: number,
  msg: MailMessage,
  uploaderMemberId: number | null,
): Promise<{ stored: number; skipped: number }> {
  let stored = 0;
  let skipped = msg.attachmentsUnavailable;
  for (const a of msg.attachments) {
    const name = cleanFileName(a.name);
    if (a.isInline || !name) continue; // signature images are neither stored nor counted as skipped
    if (a.bytes.length === 0 || a.bytes.length > MAX_ATTACHMENT_BYTES) {
      skipped++;
      continue;
    }
    const row = await db.query<{ id: string }>(
      `INSERT INTO service.ticket_attachment
         (ticket_id, file_name, content_type, size_bytes, sha256, uploaded_by_member_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        ticketId,
        name,
        cleanContentType(a.contentType),
        a.bytes.length,
        createHash("sha256").update(a.bytes).digest("hex"),
        uploaderMemberId,
      ],
    );
    await db.query(
      "INSERT INTO service.ticket_attachment_blob (attachment_id, data) VALUES ($1,$2)",
      [row.rows[0]?.id, a.bytes],
    );
    stored++;
  }
  return { stored, skipped };
}
