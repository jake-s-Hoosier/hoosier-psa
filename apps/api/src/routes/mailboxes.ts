import { withActor } from "@hoosier/db";
import { idSchema } from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HttpError } from "../errors.js";

interface MailboxRow {
  id: string;
  address: string;
  board_id: string;
  board: string;
  priority_id: string | null;
  fallback_company_id: string;
  fallback_company: string;
  reopen_on_reply: boolean;
  is_active: boolean;
  poll_from: Date;
  last_received_at: Date | null;
  last_polled_at: Date | null;
  last_error: string | null;
}

const SELECT = `
  SELECT m.id, m.address::text AS address, m.board_id, b.name::text AS board, m.priority_id,
         m.fallback_company_id, c.name AS fallback_company, m.reopen_on_reply, m.is_active,
         m.poll_from, m.last_received_at, m.last_polled_at, m.last_error
    FROM service.mailbox m
    JOIN service.board b ON b.id = m.board_id
    JOIN crm.company c ON c.id = m.fallback_company_id`;

const toView = (r: MailboxRow) => ({
  id: Number(r.id),
  address: r.address,
  boardId: Number(r.board_id),
  board: r.board,
  priorityId: r.priority_id === null ? null : Number(r.priority_id),
  fallbackCompanyId: Number(r.fallback_company_id),
  fallbackCompany: r.fallback_company,
  reopenOnReply: r.reopen_on_reply,
  isActive: r.is_active,
  pollFrom: r.poll_from.toISOString(),
  lastReceivedAt: r.last_received_at?.toISOString() ?? null,
  lastPolledAt: r.last_polled_at?.toISOString() ?? null,
  lastError: r.last_error,
});

const address = z.string().trim().toLowerCase().email().max(254);
const createSchema = z.object({
  address,
  boardId: idSchema,
  priorityId: idSchema.nullish(),
  fallbackCompanyId: idSchema,
  reopenOnReply: z.boolean().default(true),
});
const updateSchema = z
  .object({
    boardId: idSchema,
    priorityId: idSchema.nullable(),
    fallbackCompanyId: idSchema,
    reopenOnReply: z.boolean(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

/** Inbound mailboxes and the log of what happened to each message. Needs service.mailbox.manage. */
export const mailboxRoutes: FastifyPluginAsync = async (app) => {
  const perm = { config: { perm: "service.mailbox.manage" as const } };

  app.get("/", perm, async () => {
    const { rows } = await app.pool.query<MailboxRow>(`${SELECT} ORDER BY m.address`);
    return { items: rows.map(toView) };
  });

  app.post("/", perm, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const created = await withActor(app.pool, req.memberId, async (client) => {
      const dup = await client.query("SELECT 1 FROM service.mailbox WHERE address = $1", [
        body.address,
      ]);
      if (dup.rowCount)
        throw new HttpError(409, "Duplicate mailbox", `${body.address} is already set up`);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO service.mailbox (address, board_id, priority_id, fallback_company_id, reopen_on_reply)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [
          body.address,
          body.boardId,
          body.priorityId ?? null,
          body.fallbackCompanyId,
          body.reopenOnReply,
        ],
      );
      return (await client.query<MailboxRow>(`${SELECT} WHERE m.id = $1`, [rows[0]?.id])).rows[0];
    });
    // Created inactive on purpose: someone turns it on once the board and fallback company are checked.
    return reply.status(201).send(toView(created as MailboxRow));
  });

  app.patch("/:id", perm, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateSchema.parse(req.body);
    return withActor(app.pool, req.memberId, async (client) => {
      const cur = await client.query<{ is_active: boolean; last_received_at: Date | null }>(
        "SELECT is_active, last_received_at FROM service.mailbox WHERE id = $1",
        [id],
      );
      if (!cur.rows[0]) throw new HttpError(404, "Not Found", `Mailbox ${id} not found`);
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (body.boardId !== undefined) set("board_id", body.boardId);
      if (body.priorityId !== undefined) set("priority_id", body.priorityId);
      if (body.fallbackCompanyId !== undefined) set("fallback_company_id", body.fallbackCompanyId);
      if (body.reopenOnReply !== undefined) set("reopen_on_reply", body.reopenOnReply);
      if (body.isActive !== undefined) {
        set("is_active", body.isActive);
        // Turning a never-polled mailbox on starts from now, so old mail is not turned into tickets.
        if (body.isActive && !cur.rows[0].is_active && cur.rows[0].last_received_at === null)
          sets.push("poll_from = now()");
      }
      params.push(id);
      await client.query(
        `UPDATE service.mailbox SET ${sets.join(", ")} WHERE id = $${params.length}`,
        params,
      );
      return toView(
        (await client.query<MailboxRow>(`${SELECT} WHERE m.id = $1`, [id])).rows[0] as MailboxRow,
      );
    });
  });

  app.get("/messages", perm, async (req) => {
    const q = z
      .object({
        outcome: z
          .enum(["created", "created_unmatched", "appended", "ignored", "error"])
          .optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const { rows } = await app.pool.query<{
      id: string;
      mailbox: string;
      from_address: string;
      from_name: string | null;
      subject: string;
      received_at: Date;
      outcome: string;
      reason: string | null;
      ticket_id: string | null;
      attachments_stored: number;
      attachments_skipped: number;
    }>(
      `SELECT e.id, m.address::text AS mailbox, e.from_address::text AS from_address, e.from_name, e.subject,
              e.received_at, e.outcome, e.reason, e.ticket_id, e.attachments_stored, e.attachments_skipped
         FROM service.inbound_email e JOIN service.mailbox m ON m.id = e.mailbox_id
        WHERE ($1::text IS NULL OR e.outcome = $1)
        ORDER BY e.received_at DESC, e.id DESC LIMIT $2`,
      [q.outcome ?? null, q.limit],
    );
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        mailbox: r.mailbox,
        fromAddress: r.from_address,
        fromName: r.from_name,
        subject: r.subject,
        receivedAt: r.received_at.toISOString(),
        outcome: r.outcome,
        reason: r.reason,
        ticketId: r.ticket_id === null ? null : Number(r.ticket_id),
        attachmentsStored: r.attachments_stored,
        attachmentsSkipped: r.attachments_skipped,
      })),
    };
  });
};
