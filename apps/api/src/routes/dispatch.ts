import { withActor } from "@hoosier/db";
import {
  type DispatchBoard,
  type ScheduleEntry,
  type UnassignedTicket,
  dispatchBoardQuerySchema,
  idSchema,
  scheduleEntryCreateSchema,
  scheduleEntryUpdateSchema,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../errors.js";

type Q = Pick<pg.Pool, "query">;
const optNum = (v: string | null) => (v === null ? null : Number(v));
const params = z.object({ id: idSchema });
const MAX_RANGE_DAYS = 45;

interface EntryRow {
  id: string;
  kind: ScheduleEntry["kind"];
  ticket_id: string | null;
  ticket_summary: string | null;
  company_id: string | null;
  company: string | null;
  site_id: string | null;
  site: string | null;
  project_id: string | null;
  member_id: string;
  member: string;
  title: string | null;
  starts_at: Date;
  ends_at: Date;
  status: ScheduleEntry["status"];
  notes: string | null;
}

const SELECT_ENTRY = `
  SELECT e.id, e.kind, e.ticket_id, t.summary AS ticket_summary, t.company_id, c.name AS company,
         t.site_id, s.name AS site, t.project_id, e.member_id,
         trim(concat(m.first_name, ' ', m.last_name)) AS member, e.title, e.starts_at, e.ends_at,
         e.status, e.notes
    FROM dispatch.schedule_entry e
    JOIN iam.member m ON m.id = e.member_id
    LEFT JOIN service.ticket t ON t.id = e.ticket_id
    LEFT JOIN crm.company c ON c.id = t.company_id
    LEFT JOIN crm.site s ON s.id = t.site_id`;

const toEntry = (r: EntryRow): ScheduleEntry => ({
  id: Number(r.id),
  kind: r.kind,
  ticketId: optNum(r.ticket_id),
  ticketSummary: r.ticket_summary,
  companyId: optNum(r.company_id),
  company: r.company,
  siteId: optNum(r.site_id),
  site: r.site,
  projectId: optNum(r.project_id),
  memberId: Number(r.member_id),
  member: r.member,
  title: r.title,
  startsAt: r.starts_at.toISOString(),
  endsAt: r.ends_at.toISOString(),
  status: r.status,
  notes: r.notes,
});

async function loadEntry(q: Q, id: number): Promise<ScheduleEntry> {
  const { rows } = await q.query<EntryRow>(`${SELECT_ENTRY} WHERE e.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "Not Found", `Schedule entry ${id} not found`);
  return toEntry(rows[0]);
}

/** Other live entries for the same person that overlap this block of time. */
async function conflictsFor(q: Q, entry: ScheduleEntry): Promise<ScheduleEntry[]> {
  const { rows } = await q.query<EntryRow>(
    `${SELECT_ENTRY}
      WHERE e.member_id = $1 AND e.id <> $2 AND e.status <> 'canceled'
        AND e.starts_at < $4 AND e.ends_at > $3
      ORDER BY e.starts_at`,
    [entry.memberId, entry.id, entry.startsAt, entry.endsAt],
  );
  return rows.map(toEntry);
}

async function checkMember(q: Q, memberId: number): Promise<void> {
  const m = await q.query("SELECT 1 FROM iam.member WHERE id = $1 AND is_active", [memberId]);
  if (!m.rowCount)
    throw new HttpError(422, "Invalid person", "That person is not an active member");
}

/** Everyone scheduled on a ticket is one of its resources. */
async function addResource(q: Q, ticketId: number, memberId: number): Promise<void> {
  await q.query(
    "INSERT INTO service.ticket_resource (ticket_id, member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [ticketId, memberId],
  );
}

/** Dispatch: the schedule board, the queue of tickets nobody has scheduled, and the visits themselves. */
export const dispatchRoutes: FastifyPluginAsync = async (app) => {
  app.get("/board", { config: { perm: "dispatch.read" } }, async (req) => {
    const qs = dispatchBoardQuerySchema.parse(req.query);
    const from = new Date(qs.from);
    const to = new Date(qs.to);
    if (to <= from) throw new HttpError(422, "Invalid range", "The end must be after the start");
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000)
      throw new HttpError(422, "Range too long", `Show at most ${MAX_RANGE_DAYS} days at a time`);

    const [entries, members, unassigned] = await Promise.all([
      app.pool.query<EntryRow>(
        `${SELECT_ENTRY} WHERE e.starts_at < $2 AND e.ends_at > $1 AND e.status <> 'canceled'
          ORDER BY e.starts_at, e.id`,
        [qs.from, qs.to],
      ),
      app.pool.query<{ id: string; name: string }>(
        `SELECT m.id, trim(concat(m.first_name, ' ', m.last_name)) AS name
           FROM iam.member m
          WHERE m.is_active AND (m.is_field_tech OR EXISTS (
                  SELECT 1 FROM dispatch.schedule_entry e
                   WHERE e.member_id = m.id AND e.starts_at < $2 AND e.ends_at > $1 AND e.status <> 'canceled'))
          ORDER BY m.last_name, m.first_name`,
        [qs.from, qs.to],
      ),
      app.pool.query<{
        id: string;
        summary: string;
        company_id: string;
        company: string;
        site: string | null;
        priority: string;
        color: string | null;
        status: string;
        required_by: Date | null;
        entered_at: Date;
        project_id: string | null;
      }>(
        `SELECT t.id, t.summary, t.company_id, c.name AS company, s.name AS site, p.name::text AS priority,
                p.color, bs.name::text AS status, t.required_by, t.entered_at, t.project_id
           FROM service.ticket t
           JOIN crm.company c ON c.id = t.company_id
           JOIN service.priority p ON p.id = t.priority_id
           JOIN service.board_status bs ON bs.id = t.status_id
           LEFT JOIN crm.site s ON s.id = t.site_id
          WHERE t.closed_at IS NULL AND NOT bs.is_closed
            AND NOT EXISTS (
                  SELECT 1 FROM dispatch.schedule_entry e
                   WHERE e.ticket_id = t.id AND e.status <> 'canceled' AND e.ends_at > now())
          ORDER BY p.sort_order, t.required_by NULLS LAST, t.entered_at
          LIMIT 100`,
      ),
    ]);

    const board: DispatchBoard = {
      from: qs.from,
      to: qs.to,
      members: members.rows.map((m) => ({ id: Number(m.id), name: m.name })),
      entries: entries.rows.map(toEntry),
      unassigned: unassigned.rows.map(
        (u): UnassignedTicket => ({
          id: Number(u.id),
          summary: u.summary,
          companyId: Number(u.company_id),
          company: u.company,
          site: u.site,
          priority: u.priority,
          priorityColor: u.color,
          status: u.status,
          requiredBy: u.required_by?.toISOString() ?? null,
          enteredAt: u.entered_at.toISOString(),
          projectId: optNum(u.project_id),
        }),
      ),
    };
    return board;
  });

  app.get("/entries", { config: { perm: "dispatch.read" } }, async (req) => {
    const qs = z.object({ ticketId: idSchema }).parse(req.query);
    const { rows } = await app.pool.query<EntryRow>(
      `${SELECT_ENTRY} WHERE e.ticket_id = $1 ORDER BY e.starts_at DESC LIMIT 100`,
      [qs.ticketId],
    );
    return { items: rows.map(toEntry) };
  });

  app.post("/entries", { config: { perm: "dispatch.write" } }, async (req, reply) => {
    const body = scheduleEntryCreateSchema.parse(req.body);
    const out = await withActor(app.pool, req.memberId as number, async (client) => {
      await checkMember(client, body.memberId);
      if (body.ticketId) {
        const t = await client.query<{ closed: boolean }>(
          `SELECT (t.closed_at IS NOT NULL OR bs.is_closed) AS closed FROM service.ticket t
             JOIN service.board_status bs ON bs.id = t.status_id WHERE t.id = $1`,
          [body.ticketId],
        );
        if (!t.rows[0]) throw new HttpError(422, "Invalid ticket", "Ticket not found");
        if (t.rows[0].closed)
          throw new HttpError(422, "Ticket closed", "A closed ticket cannot be scheduled");
      }
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO dispatch.schedule_entry
           (kind, ticket_id, member_id, title, starts_at, ends_at, notes, created_by_member_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          body.kind,
          body.ticketId ?? null,
          body.memberId,
          body.title ?? null,
          body.startsAt,
          body.endsAt,
          body.notes ?? null,
          req.memberId,
        ],
      );
      if (body.ticketId) await addResource(client, body.ticketId, body.memberId);
      const entry = await loadEntry(client, Number(rows[0]?.id));
      return { entry, conflicts: await conflictsFor(client, entry) };
    });
    return reply.status(201).send(out);
  });

  app.patch("/entries/:id", { config: { perm: "dispatch.write" } }, async (req) => {
    const { id } = params.parse(req.params);
    const body = scheduleEntryUpdateSchema.parse(req.body);
    return withActor(app.pool, req.memberId as number, async (client) => {
      await client.query("SELECT 1 FROM dispatch.schedule_entry WHERE id = $1 FOR UPDATE", [id]);
      const cur = await loadEntry(client, id);
      if (body.title !== undefined && cur.kind === "ticket")
        throw new HttpError(422, "Not editable", "A ticket visit takes its title from the ticket");
      if (body.memberId !== undefined) await checkMember(client, body.memberId);
      const startsAt = body.startsAt ?? cur.startsAt;
      const endsAt = body.endsAt ?? cur.endsAt;
      if (new Date(endsAt) <= new Date(startsAt))
        throw new HttpError(422, "Invalid time", "The end must be after the start");
      const cols: Record<string, string> = {
        memberId: "member_id",
        title: "title",
        startsAt: "starts_at",
        endsAt: "ends_at",
        status: "status",
        notes: "notes",
      };
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [key, col] of Object.entries(cols)) {
        const v = (body as Record<string, unknown>)[key];
        if (v === undefined) continue;
        values.push(v);
        sets.push(`${col} = $${values.length}`);
      }
      values.push(id);
      await client.query(
        `UPDATE dispatch.schedule_entry SET ${sets.join(", ")} WHERE id = $${values.length}`,
        values,
      );
      const entry = await loadEntry(client, id);
      if (entry.ticketId && body.memberId !== undefined)
        await addResource(client, entry.ticketId, entry.memberId);
      return {
        entry,
        conflicts: entry.status === "canceled" ? [] : await conflictsFor(client, entry),
      };
    });
  });

  app.delete("/entries/:id", { config: { perm: "dispatch.write" } }, async (req, reply) => {
    const { id } = params.parse(req.params);
    await withActor(app.pool, req.memberId as number, async (client) => {
      const r = await client.query("DELETE FROM dispatch.schedule_entry WHERE id = $1", [id]);
      if (!r.rowCount) throw new HttpError(404, "Not Found", `Schedule entry ${id} not found`);
    });
    return reply.status(204).send();
  });
};
