import { withActor } from "@hoosier/db";
import {
  type Ticket,
  type TicketNote,
  idSchema,
  ticketCreateSchema,
  ticketListQuerySchema,
  ticketNoteCreateSchema,
  ticketUpdateSchema,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../errors.js";

interface TicketRow {
  id: string;
  summary: string;
  company_id: string;
  company: string;
  site_id: string | null;
  site: string | null;
  contact_id: string | null;
  contact: string | null;
  board_id: string;
  board: string;
  status_id: string;
  status: string;
  is_closed: boolean;
  priority_id: string;
  priority: string;
  owner_member_id: string | null;
  agreement_id: string | null;
  agreement: string | null;
  entered_at: Date;
  closed_at: Date | null;
  updated_at: Date;
}

const SELECT_TICKET = `
  SELECT t.id, t.summary, t.company_id, c.name AS company, t.site_id, st.name AS site, t.contact_id,
         NULLIF(trim(concat(ct.first_name, ' ', ct.last_name)), '') AS contact,
         t.board_id, b.name AS board, t.status_id, s.name AS status, s.is_closed,
         t.priority_id, p.name AS priority, t.owner_member_id,
         t.agreement_id, ag.name AS agreement,
         t.entered_at, t.closed_at, t.updated_at
    FROM service.ticket t
    JOIN crm.company c ON c.id = t.company_id
    LEFT JOIN crm.site st ON st.id = t.site_id
    LEFT JOIN crm.contact ct ON ct.id = t.contact_id
    JOIN service.board b ON b.id = t.board_id
    JOIN service.board_status s ON s.id = t.status_id
    JOIN service.priority p ON p.id = t.priority_id
    LEFT JOIN billing.agreement ag ON ag.id = t.agreement_id`;

const optId = (v: string | null) => (v === null ? null : Number(v));

function toTicket(r: TicketRow): Ticket {
  return {
    id: Number(r.id),
    summary: r.summary,
    companyId: Number(r.company_id),
    company: r.company,
    siteId: optId(r.site_id),
    site: r.site,
    contactId: optId(r.contact_id),
    contact: r.contact,
    boardId: Number(r.board_id),
    board: r.board,
    statusId: Number(r.status_id),
    status: r.status,
    isClosed: r.is_closed,
    priorityId: Number(r.priority_id),
    priority: r.priority,
    ownerMemberId: optId(r.owner_member_id),
    agreementId: optId(r.agreement_id),
    agreement: r.agreement,
    enteredAt: r.entered_at.toISOString(),
    closedAt: r.closed_at?.toISOString() ?? null,
    updatedAt: r.updated_at.toISOString(),
  };
}

async function loadTicket(db: pg.Pool | pg.PoolClient, id: number): Promise<TicketRow> {
  const { rows } = await db.query<TicketRow>(`${SELECT_TICKET} WHERE t.id = $1`, [id]);
  const row = rows[0];
  if (!row) throw new HttpError(404, "Not Found", `Ticket ${id} not found`);
  return row;
}

/** A status must belong to the ticket's board; otherwise the move is meaningless. */
async function statusOnBoard(
  db: pg.Pool | pg.PoolClient,
  statusId: number,
  boardId: number,
): Promise<{ is_closed: boolean }> {
  const { rows } = await db.query<{ is_closed: boolean }>(
    "SELECT is_closed FROM service.board_status WHERE id = $1 AND board_id = $2 AND is_active",
    [statusId, boardId],
  );
  const row = rows[0];
  if (!row)
    throw new HttpError(422, "Invalid status", "Status does not belong to the ticket's board");
  return row;
}

export const ticketRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { config: { perm: "service.ticket.read" } }, async (req) => {
    const q = ticketListQuerySchema.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (q.state === "open") where.push("t.closed_at IS NULL");
    if (q.state === "closed") where.push("t.closed_at IS NOT NULL");
    if (q.q) {
      if (/^\d+$/.test(q.q))
        add("(t.id = ? OR t.summary ILIKE '%' || ?::text || '%')", Number(q.q));
      else add("t.summary ILIKE '%' || ? || '%'", q.q);
    }
    if (q.companyId) add("t.company_id = ?", q.companyId);
    if (q.siteId) add("t.site_id = ?", q.siteId);
    if (q.contactId) add("t.contact_id = ?", q.contactId);
    if (q.boardId) add("t.board_id = ?", q.boardId);
    if (q.statusId) add("t.status_id = ?", q.statusId);
    if (q.ownerMemberId) add("t.owner_member_id = ?", q.ownerMemberId);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const total = await app.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM service.ticket t ${whereSql}`,
      params,
    );
    const rows = await app.pool.query<TicketRow>(
      `${SELECT_TICKET} ${whereSql} ORDER BY p.sort_order, t.entered_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.limit, q.offset],
    );
    return {
      items: rows.rows.map(toTicket),
      total: Number(total.rows[0]?.n ?? 0),
      limit: q.limit,
      offset: q.offset,
    };
  });

  app.get("/:id", { config: { perm: "service.ticket.read" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    return toTicket(await loadTicket(app.pool, id));
  });

  app.post("/", { config: { perm: "service.ticket.write" } }, async (req, reply) => {
    const body = ticketCreateSchema.parse(req.body);
    const created = await withActor(app.pool, req.memberId, async (client) => {
      const board = await client.query<{ default_priority_id: string | null }>(
        "SELECT default_priority_id FROM service.board WHERE id = $1 AND is_active",
        [body.boardId],
      );
      if (!board.rows[0]) throw new HttpError(422, "Invalid board", "Board not found or inactive");

      let statusId = body.statusId;
      if (statusId === undefined) {
        const d = await client.query<{ id: string }>(
          "SELECT id FROM service.board_status WHERE board_id = $1 AND is_default AND is_active",
          [body.boardId],
        );
        if (!d.rows[0])
          throw new HttpError(422, "No default status", "The board has no default status");
        statusId = Number(d.rows[0].id);
      } else {
        await statusOnBoard(client, statusId, body.boardId);
      }

      let priorityId = body.priorityId ?? optId(board.rows[0].default_priority_id) ?? undefined;
      if (priorityId === undefined) {
        const p = await client.query<{ id: string }>(
          "SELECT id FROM service.priority WHERE name = 'Normal'",
        );
        priorityId = Number(p.rows[0]?.id);
      }

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO service.ticket
           (summary, company_id, site_id, contact_id, board_id, status_id, priority_id,
            owner_member_id, entered_by_member_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          body.summary,
          body.companyId,
          body.siteId ?? null,
          body.contactId ?? null,
          body.boardId,
          statusId,
          priorityId,
          body.ownerMemberId ?? null,
          req.memberId,
        ],
      );
      const id = Number(rows[0]?.id);
      if (body.description) {
        await client.query(
          `INSERT INTO service.ticket_note (ticket_id, kind, body, author_member_id)
           VALUES ($1, 'description', $2, $3)`,
          [id, body.description, req.memberId],
        );
      }
      return loadTicket(client, id);
    });
    return reply
      .status(201)
      .header("location", `/api/v1/tickets/${created.id}`)
      .send(toTicket(created));
  });

  app.patch("/:id", { config: { perm: "service.ticket.write" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = ticketUpdateSchema.parse(req.body);
    const updated = await withActor(app.pool, req.memberId, async (client) => {
      const current = await loadTicket(client, id);
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, value: unknown) => {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      };
      if (body.companyId !== undefined && body.companyId !== Number(current.company_id)) {
        const c = await client.query("SELECT 1 FROM crm.company WHERE id = $1", [body.companyId]);
        if (!c.rowCount) throw new HttpError(422, "Invalid company", "Company not found");
        set("company_id", body.companyId);
        // A site or contact belongs to one company, so a move clears them unless the request names new ones.
        if (body.siteId === undefined) sets.push("site_id = NULL");
        if (body.contactId === undefined) sets.push("contact_id = NULL");
      }
      if (body.summary !== undefined) set("summary", body.summary);
      if (body.priorityId !== undefined) set("priority_id", body.priorityId);
      if (body.ownerMemberId !== undefined) set("owner_member_id", body.ownerMemberId);
      const targetCompany = body.companyId ?? Number(current.company_id);
      if (body.siteId !== undefined) {
        if (body.siteId !== null) {
          const ok = await client.query(
            "SELECT 1 FROM crm.site WHERE id = $1 AND company_id = $2",
            [body.siteId, targetCompany],
          );
          if (!ok.rowCount)
            throw new HttpError(422, "Invalid site", "The site is not at this ticket's company");
        }
        set("site_id", body.siteId);
      }
      if (body.contactId !== undefined) {
        if (body.contactId !== null) {
          const ok = await client.query(
            "SELECT 1 FROM crm.contact WHERE id = $1 AND company_id = $2",
            [body.contactId, targetCompany],
          );
          if (!ok.rowCount)
            throw new HttpError(
              422,
              "Invalid contact",
              "The contact is not at this ticket's company",
            );
        }
        set("contact_id", body.contactId);
      }
      if (body.agreementId !== undefined) {
        if (body.agreementId !== null) {
          // The agreement must belong to (or be billed to) the ticket's company.
          const ok = await client.query(
            "SELECT 1 FROM billing.agreement WHERE id = $1 AND (company_id = $2 OR bill_to_company_id = $2)",
            [body.agreementId, targetCompany],
          );
          if (!ok.rowCount)
            throw new HttpError(
              422,
              "Invalid agreement",
              "The agreement is not for this ticket's company",
            );
        }
        set("agreement_id", body.agreementId);
      } else if (body.companyId !== undefined && body.companyId !== Number(current.company_id)) {
        // Moving to another company drops an agreement that belonged to the old one.
        sets.push("agreement_id = NULL");
      }
      if (body.statusId !== undefined && body.statusId !== Number(current.status_id)) {
        const target = await statusOnBoard(client, body.statusId, Number(current.board_id));
        set("status_id", body.statusId);
        // Closing stamps closed_at/by; reopening clears them.
        if (target.is_closed && !current.is_closed) {
          sets.push("closed_at = now()");
          set("closed_by_member_id", req.memberId);
        } else if (!target.is_closed && current.is_closed) {
          sets.push("closed_at = NULL", "closed_by_member_id = NULL");
        }
      }
      if (sets.length > 0) {
        params.push(id);
        await client.query(
          `UPDATE service.ticket SET ${sets.join(", ")} WHERE id = $${params.length}`,
          params,
        );
      }
      return loadTicket(client, id);
    });
    return toTicket(updated);
  });

  app.get("/:id/notes", { config: { perm: "service.ticket.read" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    await loadTicket(app.pool, id);
    const { rows } = await app.pool.query<{
      id: string;
      ticket_id: string;
      kind: string;
      body: string;
      author_member_id: string | null;
      created_at: Date;
    }>(
      `SELECT id, ticket_id, kind, body, author_member_id, created_at
         FROM service.ticket_note WHERE ticket_id = $1 ORDER BY created_at, id`,
      [id],
    );
    const items: TicketNote[] = rows.map((r) => ({
      id: Number(r.id),
      ticketId: Number(r.ticket_id),
      kind: r.kind,
      body: r.body,
      authorMemberId: optId(r.author_member_id),
      createdAt: r.created_at.toISOString(),
    }));
    return { items };
  });

  app.post("/:id/notes", { config: { perm: "service.ticket.write" } }, async (req, reply) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = ticketNoteCreateSchema.parse(req.body);
    const note = await withActor(app.pool, req.memberId, async (client) => {
      await loadTicket(client, id);
      const { rows } = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO service.ticket_note (ticket_id, kind, body, author_member_id)
         VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
        [id, body.kind, body.body, req.memberId],
      );
      // First staff-authored customer-visible note counts as the first response.
      if (body.kind !== "internal") {
        await client.query(
          "UPDATE service.ticket SET first_response_at = now() WHERE id = $1 AND first_response_at IS NULL",
          [id],
        );
      }
      return rows[0] as { id: string; created_at: Date };
    });
    const out: TicketNote = {
      id: Number(note.id),
      ticketId: id,
      kind: body.kind,
      body: body.body,
      authorMemberId: req.memberId,
      createdAt: note.created_at.toISOString(),
    };
    return reply.status(201).send(out);
  });
};
