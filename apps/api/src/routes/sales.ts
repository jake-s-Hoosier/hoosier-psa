import { withActor } from "@hoosier/db";
import {
  type Activity,
  type ExternalRef,
  type Opportunity,
  type SalesStage,
  activityCreateSchema,
  activityUpdateSchema,
  externalEntityTypes,
  externalRefCreateSchema,
  idSchema,
  opportunityCreateSchema,
  opportunityListQuerySchema,
  opportunityUpdateSchema,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../errors.js";

type Q = Pick<pg.Pool, "query">;
const optNum = (v: string | null) => (v === null ? null : Number(v));
const name = (a: string) => `NULLIF(trim(concat(${a}.first_name, ' ', ${a}.last_name)), '')`;

interface OppRow {
  id: string;
  company_id: string;
  company: string;
  site_id: string | null;
  site: string | null;
  contact_id: string | null;
  contact: string | null;
  name: string;
  stage_id: string;
  stage: string;
  probability: number;
  is_won: boolean;
  is_lost: boolean;
  owner_member_id: string | null;
  owner: string | null;
  expected_amount: string | null;
  weighted: string;
  expected_close: string | null;
  source: string | null;
  notes: string | null;
  lost_reason: string | null;
  closed_at: Date | null;
  open_tasks: string;
  created_at: Date;
}

const SELECT_OPP = `
  SELECT o.id, o.company_id, c.name AS company, o.site_id, st.name AS site, o.contact_id,
         ${name("ct")} AS contact, o.name, o.stage_id, s.name::text AS stage, s.probability, s.is_won, s.is_lost,
         o.owner_member_id, ${name("m")} AS owner, o.expected_amount,
         round(COALESCE(o.expected_amount, 0) * s.probability / 100, 2) AS weighted,
         to_char(o.expected_close, 'YYYY-MM-DD') AS expected_close, o.source, o.notes, o.lost_reason,
         o.closed_at, o.created_at,
         (SELECT count(*) FROM sales.activity a
           WHERE a.opportunity_id = o.id AND a.kind = 'task' AND a.completed_at IS NULL) AS open_tasks
    FROM sales.opportunity o
    JOIN crm.company c ON c.id = o.company_id
    JOIN sales.stage s ON s.id = o.stage_id
    LEFT JOIN crm.site st ON st.id = o.site_id
    LEFT JOIN crm.contact ct ON ct.id = o.contact_id
    LEFT JOIN iam.member m ON m.id = o.owner_member_id`;

const toOpp = (r: OppRow): Opportunity => ({
  id: Number(r.id),
  companyId: Number(r.company_id),
  company: r.company,
  siteId: optNum(r.site_id),
  site: r.site,
  contactId: optNum(r.contact_id),
  contact: r.contact,
  name: r.name,
  stageId: Number(r.stage_id),
  stage: r.stage,
  probability: r.probability,
  isWon: r.is_won,
  isLost: r.is_lost,
  ownerMemberId: optNum(r.owner_member_id),
  owner: r.owner,
  expectedAmount: r.expected_amount,
  weightedAmount: r.weighted,
  expectedClose: r.expected_close,
  source: r.source,
  notes: r.notes,
  lostReason: r.lost_reason,
  closedAt: r.closed_at?.toISOString() ?? null,
  openTasks: Number(r.open_tasks),
  createdAt: r.created_at.toISOString(),
});

async function loadOpp(q: Q, id: number): Promise<Opportunity> {
  const { rows } = await q.query<OppRow>(`${SELECT_OPP} WHERE o.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "Not Found", `Opportunity ${id} not found`);
  return toOpp(rows[0]);
}

interface ActRow {
  id: string;
  opportunity_id: string;
  kind: Activity["kind"];
  subject: string;
  body: string | null;
  due_date: string | null;
  completed_at: Date | null;
  assigned_member_id: string | null;
  assigned_to: string | null;
  created_at: Date;
}
const SELECT_ACT = `
  SELECT a.id, a.opportunity_id, a.kind, a.subject, a.body, to_char(a.due_date, 'YYYY-MM-DD') AS due_date,
         a.completed_at, a.assigned_member_id, ${name("m")} AS assigned_to, a.created_at
    FROM sales.activity a LEFT JOIN iam.member m ON m.id = a.assigned_member_id`;
const toAct = (r: ActRow): Activity => ({
  id: Number(r.id),
  opportunityId: Number(r.opportunity_id),
  kind: r.kind,
  subject: r.subject,
  body: r.body,
  dueDate: r.due_date,
  completedAt: r.completed_at?.toISOString() ?? null,
  assignedMemberId: optNum(r.assigned_member_id),
  assignedTo: r.assigned_to,
  createdAt: r.created_at.toISOString(),
});

interface RefRow {
  id: string;
  entity_type: ExternalRef["entityType"];
  entity_id: string;
  provider: ExternalRef["provider"];
  kind: ExternalRef["kind"];
  external_id: string;
  version: string | null;
  status: string | null;
  title: string | null;
  url: string | null;
  amount: string | null;
  synced_at: Date | null;
  created_at: Date;
}
const toRef = (r: RefRow): ExternalRef => ({
  id: Number(r.id),
  entityType: r.entity_type,
  entityId: Number(r.entity_id),
  provider: r.provider,
  kind: r.kind,
  externalId: r.external_id,
  version: r.version,
  status: r.status,
  title: r.title,
  url: r.url,
  amount: r.amount,
  syncedAt: r.synced_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});
const REF_COLS =
  "id, entity_type, entity_id, provider, kind, external_id, version, status, title, url, amount, synced_at, created_at";

const params = z.object({ id: idSchema });

/** Sales: stages, opportunities and their activities. Mounted under /api/v1/sales. */
export const salesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/stages", { config: { perm: "sales.opportunity.read" } }, async () => {
    const { rows } = await app.pool.query<{
      id: string;
      name: string;
      sort_order: number;
      probability: number;
      is_won: boolean;
      is_lost: boolean;
    }>(
      "SELECT id, name::text AS name, sort_order, probability, is_won, is_lost FROM sales.stage WHERE is_active ORDER BY sort_order",
    );
    const items: SalesStage[] = rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      sortOrder: r.sort_order,
      probability: r.probability,
      isWon: r.is_won,
      isLost: r.is_lost,
    }));
    return { items };
  });

  /** Open pipeline by stage: count, value and probability-weighted value. */
  app.get("/pipeline", { config: { perm: "sales.opportunity.read" } }, async () => {
    const { rows } = await app.pool.query<{
      stage_id: string;
      stage: string;
      n: string;
      amount: string;
      weighted: string;
    }>(
      `SELECT s.id AS stage_id, s.name::text AS stage, count(o.id) AS n,
              COALESCE(sum(o.expected_amount), 0) AS amount,
              COALESCE(sum(round(o.expected_amount * s.probability / 100, 2)), 0) AS weighted
         FROM sales.stage s LEFT JOIN sales.opportunity o ON o.stage_id = s.id
        WHERE s.is_active AND NOT s.is_won AND NOT s.is_lost
        GROUP BY s.id, s.name, s.sort_order ORDER BY s.sort_order`,
    );
    return {
      items: rows.map((r) => ({
        stageId: Number(r.stage_id),
        stage: r.stage,
        count: Number(r.n),
        amount: r.amount,
        weightedAmount: r.weighted,
      })),
    };
  });

  app.get("/opportunities", { config: { perm: "sales.opportunity.read" } }, async (req) => {
    const qs = opportunityListQuerySchema.parse(req.query);
    const where: string[] = [];
    const values: unknown[] = [];
    if (qs.q) {
      values.push(`%${qs.q}%`);
      where.push(`(o.name ILIKE $${values.length} OR c.name ILIKE $${values.length})`);
    }
    if (qs.companyId) {
      values.push(qs.companyId);
      where.push(`o.company_id = $${values.length}`);
    }
    if (qs.ownerMemberId) {
      values.push(qs.ownerMemberId);
      where.push(`o.owner_member_id = $${values.length}`);
    }
    if (qs.stageId) {
      values.push(qs.stageId);
      where.push(`o.stage_id = $${values.length}`);
    }
    if (qs.state === "open") where.push("NOT s.is_won AND NOT s.is_lost");
    else if (qs.state === "won") where.push("s.is_won");
    else if (qs.state === "lost") where.push("s.is_lost");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = await app.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM sales.opportunity o JOIN crm.company c ON c.id = o.company_id
        JOIN sales.stage s ON s.id = o.stage_id ${clause}`,
      values,
    );
    values.push(qs.limit, qs.offset);
    const { rows } = await app.pool.query<OppRow>(
      `${SELECT_OPP} ${clause} ORDER BY s.sort_order, o.expected_close NULLS LAST, o.id DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { items: rows.map(toOpp), total: Number(total.rows[0]?.n ?? 0) };
  });

  app.get("/opportunities/:id", { config: { perm: "sales.opportunity.read" } }, async (req) => {
    const { id } = params.parse(req.params);
    return loadOpp(app.pool, id);
  });

  app.post(
    "/opportunities",
    { config: { perm: "sales.opportunity.write" } },
    async (req, reply) => {
      const body = opportunityCreateSchema.parse(req.body);
      const created = await withActor(app.pool, req.memberId as number, async (client) => {
        const c = await client.query("SELECT 1 FROM crm.company WHERE id = $1", [body.companyId]);
        if (!c.rowCount) throw new HttpError(422, "Invalid company", "Company not found");
        await checkLinks(client, body.companyId, body.siteId ?? null, body.contactId ?? null);
        let stageId = body.stageId;
        if (stageId === undefined) {
          const s = await client.query<{ id: string }>(
            "SELECT id FROM sales.stage WHERE is_active AND NOT is_won AND NOT is_lost ORDER BY sort_order LIMIT 1",
          );
          stageId = Number(s.rows[0]?.id);
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sales.opportunity
             (company_id, site_id, contact_id, name, stage_id, owner_member_id, expected_amount,
              expected_close, source, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [
            body.companyId,
            body.siteId ?? null,
            body.contactId ?? null,
            body.name,
            stageId,
            body.ownerMemberId ?? req.memberId,
            body.expectedAmount ?? null,
            body.expectedClose ?? null,
            body.source ?? null,
            body.notes ?? null,
          ],
        );
        return loadOpp(client, Number(rows[0]?.id));
      });
      return reply
        .status(201)
        .header("location", `/api/v1/sales/opportunities/${created.id}`)
        .send(created);
    },
  );

  app.patch("/opportunities/:id", { config: { perm: "sales.opportunity.write" } }, async (req) => {
    const { id } = params.parse(req.params);
    const body = opportunityUpdateSchema.parse(req.body);
    return withActor(app.pool, req.memberId as number, async (client) => {
      const cur = await loadOpp(client, id);
      if (body.siteId !== undefined || body.contactId !== undefined)
        await checkLinks(
          client,
          cur.companyId,
          body.siteId === undefined ? null : body.siteId,
          body.contactId === undefined ? null : body.contactId,
        );
      if (body.stageId !== undefined) {
        const s = await client.query("SELECT 1 FROM sales.stage WHERE id = $1 AND is_active", [
          body.stageId,
        ]);
        if (!s.rowCount) throw new HttpError(422, "Invalid stage", "That stage does not exist");
      }
      const cols: Record<string, string> = {
        name: "name",
        siteId: "site_id",
        contactId: "contact_id",
        stageId: "stage_id",
        ownerMemberId: "owner_member_id",
        expectedAmount: "expected_amount",
        expectedClose: "expected_close",
        source: "source",
        notes: "notes",
        lostReason: "lost_reason",
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
        `UPDATE sales.opportunity SET ${sets.join(", ")} WHERE id = $${values.length}`,
        values,
      );
      return loadOpp(client, id);
    });
  });

  // ---- Activities and tasks ----

  app.get(
    "/opportunities/:id/activities",
    { config: { perm: "sales.opportunity.read" } },
    async (req) => {
      const { id } = params.parse(req.params);
      await loadOpp(app.pool, id);
      const { rows } = await app.pool.query<ActRow>(
        `${SELECT_ACT} WHERE a.opportunity_id = $1
          ORDER BY (a.kind = 'task' AND a.completed_at IS NULL) DESC, a.due_date NULLS LAST, a.created_at DESC`,
        [id],
      );
      return { items: rows.map(toAct) };
    },
  );

  app.post(
    "/opportunities/:id/activities",
    { config: { perm: "sales.opportunity.write" } },
    async (req, reply) => {
      const { id } = params.parse(req.params);
      const body = activityCreateSchema.parse(req.body);
      if (body.dueDate && body.kind !== "task")
        throw new HttpError(422, "Not a task", "Only tasks have a due date");
      const created = await withActor(app.pool, req.memberId as number, async (client) => {
        await loadOpp(client, id);
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sales.activity (opportunity_id, kind, subject, body, due_date, assigned_member_id, created_by_member_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            id,
            body.kind,
            body.subject,
            body.body ?? null,
            body.dueDate ?? null,
            body.assignedMemberId ?? (body.kind === "task" ? req.memberId : null),
            req.memberId,
          ],
        );
        const r = await client.query<ActRow>(`${SELECT_ACT} WHERE a.id = $1`, [rows[0]?.id]);
        return toAct(r.rows[0] as ActRow);
      });
      return reply.status(201).send(created);
    },
  );

  app.patch(
    "/opportunities/:id/activities/:activityId",
    { config: { perm: "sales.opportunity.write" } },
    async (req) => {
      const p = z.object({ id: idSchema, activityId: idSchema }).parse(req.params);
      const body = activityUpdateSchema.parse(req.body);
      return withActor(app.pool, req.memberId as number, async (client) => {
        const cur = await client.query<{ kind: string }>(
          "SELECT kind FROM sales.activity WHERE id = $1 AND opportunity_id = $2",
          [p.activityId, p.id],
        );
        if (!cur.rows[0]) throw new HttpError(404, "Not Found", "Activity not found");
        if ((body.dueDate || body.completed !== undefined) && cur.rows[0].kind !== "task")
          throw new HttpError(422, "Not a task", "Only tasks have a due date or can be completed");
        const sets: string[] = [];
        const values: unknown[] = [];
        const add = (col: string, v: unknown) => {
          values.push(v);
          sets.push(`${col} = $${values.length}`);
        };
        if (body.subject !== undefined) add("subject", body.subject);
        if (body.body !== undefined) add("body", body.body);
        if (body.dueDate !== undefined) add("due_date", body.dueDate);
        if (body.assignedMemberId !== undefined) add("assigned_member_id", body.assignedMemberId);
        if (body.completed === true) sets.push("completed_at = COALESCE(completed_at, now())");
        if (body.completed === false) sets.push("completed_at = NULL");
        values.push(p.activityId);
        await client.query(
          `UPDATE sales.activity SET ${sets.join(", ")} WHERE id = $${values.length}`,
          values,
        );
        const r = await client.query<ActRow>(`${SELECT_ACT} WHERE a.id = $1`, [p.activityId]);
        return toAct(r.rows[0] as ActRow);
      });
    },
  );

  app.delete(
    "/opportunities/:id/activities/:activityId",
    { config: { perm: "sales.opportunity.write" } },
    async (req, reply) => {
      const p = z.object({ id: idSchema, activityId: idSchema }).parse(req.params);
      await withActor(app.pool, req.memberId as number, async (client) => {
        const r = await client.query(
          "DELETE FROM sales.activity WHERE id = $1 AND opportunity_id = $2",
          [p.activityId, p.id],
        );
        if (!r.rowCount) throw new HttpError(404, "Not Found", "Activity not found");
      });
      return reply.status(204).send();
    },
  );

  // ---- Links to quotes, estimates and designs in other systems ----

  const refQuery = z.object({ entityType: z.enum(externalEntityTypes), entityId: idSchema });

  app.get("/external-refs", { config: { perm: "sales.opportunity.read" } }, async (req) => {
    const qs = refQuery.parse(req.query);
    const { rows } = await app.pool.query<RefRow>(
      `SELECT ${REF_COLS} FROM sales.external_ref WHERE entity_type = $1 AND entity_id = $2
        ORDER BY kind, provider, created_at`,
      [qs.entityType, qs.entityId],
    );
    return { items: rows.map(toRef) };
  });

  app.post(
    "/external-refs",
    { config: { perm: "sales.opportunity.write" } },
    async (req, reply) => {
      const qs = refQuery.parse(req.query);
      const body = externalRefCreateSchema.parse(req.body);
      const created = await withActor(app.pool, req.memberId as number, async (client) => {
        const table = {
          opportunity: "sales.opportunity",
          sales_order: "sales.sales_order",
          project: "project.project",
        }[qs.entityType];
        const exists = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [qs.entityId]);
        if (!exists.rowCount)
          throw new HttpError(404, "Not Found", `${qs.entityType} ${qs.entityId} not found`);
        const dup = await client.query(
          `SELECT 1 FROM sales.external_ref
            WHERE entity_type = $1 AND entity_id = $2 AND provider = $3 AND kind = $4 AND external_id = $5`,
          [qs.entityType, qs.entityId, body.provider, body.kind, body.externalId],
        );
        if (dup.rowCount)
          throw new HttpError(409, "Already linked", "That record is already linked here");
        const { rows } = await client.query<RefRow>(
          `INSERT INTO sales.external_ref
             (entity_type, entity_id, provider, kind, external_id, version, status, title, url, amount,
              created_by_member_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${REF_COLS}`,
          [
            qs.entityType,
            qs.entityId,
            body.provider,
            body.kind,
            body.externalId,
            body.version ?? null,
            body.status ?? null,
            body.title ?? null,
            body.url ?? null,
            body.amount ?? null,
            req.memberId,
          ],
        );
        return toRef(rows[0] as RefRow);
      });
      return reply.status(201).send(created);
    },
  );

  app.delete(
    "/external-refs/:id",
    { config: { perm: "sales.opportunity.write" } },
    async (req, reply) => {
      const { id } = params.parse(req.params);
      await withActor(app.pool, req.memberId as number, async (client) => {
        const r = await client.query("DELETE FROM sales.external_ref WHERE id = $1", [id]);
        if (!r.rowCount) throw new HttpError(404, "Not Found", "Link not found");
      });
      return reply.status(204).send();
    },
  );
};

async function checkLinks(
  q: Q,
  companyId: number,
  siteId: number | null,
  contactId: number | null,
): Promise<void> {
  if (siteId !== null) {
    const ok = await q.query("SELECT 1 FROM crm.site WHERE id = $1 AND company_id = $2", [
      siteId,
      companyId,
    ]);
    if (!ok.rowCount) throw new HttpError(422, "Invalid site", "The site is not at this company");
  }
  if (contactId !== null) {
    const ok = await q.query("SELECT 1 FROM crm.contact WHERE id = $1 AND company_id = $2", [
      contactId,
      companyId,
    ]);
    if (!ok.rowCount)
      throw new HttpError(422, "Invalid contact", "The contact is not at this company");
  }
}
