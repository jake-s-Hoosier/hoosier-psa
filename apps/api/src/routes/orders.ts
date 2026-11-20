import { withActor } from "@hoosier/db";
import {
  type BillingMilestone,
  type SalesOrder,
  type SalesOrderLine,
  dec,
  idSchema,
  milestoneCreateSchema,
  milestoneUpdateSchema,
  orderConvertSchema,
  orderLineSchema,
  orderLineUpdateSchema,
  salesOrderCreateSchema,
  salesOrderUpdateSchema,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../errors.js";

type Q = Pick<pg.Pool, "query">;
const optNum = (v: string | null) => (v === null ? null : Number(v));
const params = z.object({ id: idSchema });

interface OrderRow {
  id: string;
  opportunity_id: string | null;
  opportunity: string | null;
  company_id: string;
  company: string;
  site_id: string | null;
  site: string | null;
  name: string;
  status: SalesOrder["status"];
  billing_method: SalesOrder["billingMethod"];
  billing_amount: string | null;
  po_number: string | null;
  po_amount: string | null;
  notes: string | null;
  project_id: string | null;
  approved_at: Date | null;
  lines_total: string;
  labor_hours: string;
  created_at: Date;
}

const SELECT_ORDER = `
  SELECT o.id, o.opportunity_id, op.name AS opportunity, o.company_id, c.name AS company, o.site_id,
         st.name AS site, o.name, o.status, o.billing_method, o.billing_amount, o.po_number, o.po_amount,
         o.notes, o.project_id, o.approved_at, o.created_at,
         COALESCE((SELECT sum(round(l.quantity * l.unit_price, 2)) FROM sales.sales_order_line l
                    WHERE l.order_id = o.id), 0) AS lines_total,
         COALESCE((SELECT sum(l.quantity) FROM sales.sales_order_line l
                    WHERE l.order_id = o.id AND l.kind = 'labor'), 0) AS labor_hours
    FROM sales.sales_order o
    JOIN crm.company c ON c.id = o.company_id
    LEFT JOIN crm.site st ON st.id = o.site_id
    LEFT JOIN sales.opportunity op ON op.id = o.opportunity_id`;

const toOrder = (r: OrderRow): SalesOrder => ({
  id: Number(r.id),
  opportunityId: optNum(r.opportunity_id),
  opportunity: r.opportunity,
  companyId: Number(r.company_id),
  company: r.company,
  siteId: optNum(r.site_id),
  site: r.site,
  name: r.name,
  status: r.status,
  billingMethod: r.billing_method,
  billingAmount: r.billing_amount,
  poNumber: r.po_number,
  poAmount: r.po_amount,
  notes: r.notes,
  projectId: optNum(r.project_id),
  approvedAt: r.approved_at?.toISOString() ?? null,
  linesTotal: r.lines_total,
  laborHours: r.labor_hours,
  createdAt: r.created_at.toISOString(),
});

async function loadOrder(q: Q, id: number, lock = false): Promise<SalesOrder> {
  if (lock) await q.query("SELECT 1 FROM sales.sales_order WHERE id = $1 FOR UPDATE", [id]);
  const { rows } = await q.query<OrderRow>(`${SELECT_ORDER} WHERE o.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "Not Found", `Sales order ${id} not found`);
  return toOrder(rows[0]);
}

const editable = (o: SalesOrder) => {
  if (o.status === "converted")
    throw new HttpError(
      409,
      "Already converted",
      "This order is now a project; change the project instead",
    );
  if (o.status === "canceled")
    throw new HttpError(
      409,
      "Canceled",
      "This order is canceled; reopen it as a draft to change it",
    );
};

interface LineRow {
  id: string;
  order_id: string;
  kind: SalesOrderLine["kind"];
  description: string;
  quantity: string;
  unit_price: string;
  unit_cost: string;
  sort_order: number;
  line_total: string;
}
const LINE_SELECT = `SELECT id, order_id, kind, description, quantity, unit_price, unit_cost, sort_order,
  round(quantity * unit_price, 2) AS line_total FROM sales.sales_order_line`;
const toLine = (r: LineRow): SalesOrderLine => ({
  id: Number(r.id),
  orderId: Number(r.order_id),
  kind: r.kind,
  description: r.description,
  quantity: r.quantity,
  unitPrice: r.unit_price,
  unitCost: r.unit_cost,
  sortOrder: r.sort_order,
  lineTotal: r.line_total,
});

interface MsRow {
  id: string;
  order_id: string | null;
  project_id: string | null;
  name: string;
  kind: BillingMilestone["kind"];
  percent: string | null;
  amount: string | null;
  fee: string | null;
  sort_order: number;
  billed: boolean;
}
/** Milestones of an order (before conversion) or of a project, with their dollar amounts and whether billed. */
export async function listMilestones(
  q: Q,
  owner: { orderId: number } | { projectId: number },
): Promise<BillingMilestone[]> {
  const byOrder = "orderId" in owner;
  const { rows } = await q.query<MsRow>(
    `SELECT m.id, m.order_id, m.project_id, m.name, m.kind, m.percent, m.amount, m.sort_order,
            CASE WHEN $2 THEN (SELECT o.billing_amount FROM sales.sales_order o
                                WHERE o.id = m.order_id AND o.billing_method = 'fixed_fee')
                 ELSE (SELECT p.billing_amount FROM project.project p
                        WHERE p.id = m.project_id AND p.billing_method = 'fixed_fee') END AS fee,
            EXISTS (SELECT 1 FROM billing.billing_run r JOIN billing.invoice i ON i.run_id = r.id
                     WHERE r.milestone_id = m.id AND i.status <> 'void') AS billed
       FROM sales.billing_milestone m
      WHERE ${byOrder ? "m.order_id" : "m.project_id"} = $1
      ORDER BY m.sort_order, m.id`,
    [byOrder ? owner.orderId : owner.projectId, byOrder],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    orderId: optNum(r.order_id),
    projectId: optNum(r.project_id),
    name: r.name,
    kind: r.kind,
    percent: r.percent,
    amount: r.amount,
    resolvedAmount:
      r.amount ??
      (r.percent !== null && r.fee !== null
        ? dec(r.fee).times(r.percent).dividedBy(100).toDecimalPlaces(2).toFixed(2)
        : null),
    sortOrder: r.sort_order,
    billed: r.billed,
  }));
}

/** Milestones are payments against a fixed fee; together they cannot be more than the fee. */
async function checkMilestoneTotal(
  q: Q,
  owner: { orderId: number } | { projectId: number },
  fee: string | null,
  method: string,
): Promise<void> {
  const list = await listMilestones(q, owner);
  if (list.length === 0) return;
  if (method !== "fixed_fee" || fee === null)
    throw new HttpError(422, "Not a fixed fee", "Milestones are payments against a fixed fee");
  const total = list.reduce((a, m) => a.plus(m.resolvedAmount ?? 0), dec(0));
  if (total.greaterThan(fee))
    throw new HttpError(
      422,
      "Milestones exceed the fee",
      `Milestones add up to ${total.toFixed(2)}, more than the fixed fee of ${dec(fee).toFixed(2)}`,
    );
}

/** Used by the project routes: milestones, plus the guard when a project's fee or method changes. */
export { checkMilestoneTotal };

/** Sales orders and billing milestones. Mounted under /api/v1/sales. */
export const salesOrderRoutes: FastifyPluginAsync = async (app) => {
  app.get("/orders", { config: { perm: "sales.order.read" } }, async (req) => {
    const qs = z
      .object({
        companyId: idSchema.optional(),
        opportunityId: idSchema.optional(),
        status: z
          .enum(["draft", "approved", "converted", "canceled", "open", "all"])
          .default("all"),
      })
      .parse(req.query);
    const where: string[] = [];
    const values: unknown[] = [];
    if (qs.companyId) {
      values.push(qs.companyId);
      where.push(`o.company_id = $${values.length}`);
    }
    if (qs.opportunityId) {
      values.push(qs.opportunityId);
      where.push(`o.opportunity_id = $${values.length}`);
    }
    if (qs.status === "open") where.push("o.status IN ('draft','approved')");
    else if (qs.status !== "all") {
      values.push(qs.status);
      where.push(`o.status = $${values.length}`);
    }
    const { rows } = await app.pool.query<OrderRow>(
      `${SELECT_ORDER} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY o.id DESC LIMIT 200`,
      values,
    );
    return { items: rows.map(toOrder) };
  });

  app.get("/orders/:id", { config: { perm: "sales.order.read" } }, async (req) => {
    const { id } = params.parse(req.params);
    return loadOrder(app.pool, id);
  });

  app.post("/orders", { config: { perm: "sales.order.write" } }, async (req, reply) => {
    const body = salesOrderCreateSchema.parse(req.body);
    const created = await withActor(app.pool, req.memberId as number, async (client) => {
      let companyId = body.companyId;
      let siteId = body.siteId ?? null;
      let name = body.name;
      if (body.opportunityId) {
        const o = await client.query<{
          company_id: string;
          site_id: string | null;
          name: string;
          is_lost: boolean;
        }>(
          `SELECT o.company_id, o.site_id, o.name, s.is_lost FROM sales.opportunity o
             JOIN sales.stage s ON s.id = o.stage_id WHERE o.id = $1`,
          [body.opportunityId],
        );
        if (!o.rows[0]) throw new HttpError(422, "Invalid opportunity", "Opportunity not found");
        if (o.rows[0].is_lost)
          throw new HttpError(
            422,
            "Opportunity lost",
            "Reopen the lost opportunity before ordering",
          );
        companyId = Number(o.rows[0].company_id);
        siteId = body.siteId ?? optNum(o.rows[0].site_id);
        name = body.name ?? o.rows[0].name;
      }
      if (siteId !== null) {
        const ok = await client.query("SELECT 1 FROM crm.site WHERE id = $1 AND company_id = $2", [
          siteId,
          companyId,
        ]);
        if (!ok.rowCount)
          throw new HttpError(422, "Invalid site", "The site is not at this order's company");
      }
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO sales.sales_order
           (opportunity_id, company_id, site_id, name, billing_method, billing_amount, po_number, po_amount,
            notes, created_by_member_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          body.opportunityId ?? null,
          companyId,
          siteId,
          name,
          body.billingMethod,
          body.billingMethod === "actual_rates" ? null : (body.billingAmount ?? null),
          body.poNumber ?? null,
          body.poAmount ?? null,
          body.notes ?? null,
          req.memberId,
        ],
      );
      return loadOrder(client, Number(rows[0]?.id));
    });
    return reply.status(201).header("location", `/api/v1/sales/orders/${created.id}`).send(created);
  });

  app.patch("/orders/:id", { config: { perm: "sales.order.write" } }, async (req) => {
    const { id } = params.parse(req.params);
    const body = salesOrderUpdateSchema.parse(req.body);
    return withActor(app.pool, req.memberId as number, async (client) => {
      const cur = await loadOrder(client, id, true);
      if (cur.status === "converted") editable(cur);
      if (cur.status === "canceled" && body.status === undefined) editable(cur);
      const method = body.billingMethod ?? cur.billingMethod;
      let amount =
        body.billingAmount !== undefined ? body.billingAmount : optNumStr(cur.billingAmount);
      if (method === "actual_rates") amount = null;
      else if (!(Number(amount) > 0))
        throw new HttpError(
          422,
          "Amount needed",
          "Enter the fee, cap or rate for this billing method",
        );
      if (body.siteId) {
        const ok = await client.query("SELECT 1 FROM crm.site WHERE id = $1 AND company_id = $2", [
          body.siteId,
          cur.companyId,
        ]);
        if (!ok.rowCount)
          throw new HttpError(422, "Invalid site", "The site is not at this order's company");
      }
      const cols: Record<string, string> = {
        name: "name",
        siteId: "site_id",
        poNumber: "po_number",
        poAmount: "po_amount",
        notes: "notes",
        status: "status",
      };
      const sets = ["billing_method = $1", "billing_amount = $2"];
      const values: unknown[] = [method, amount];
      for (const [key, col] of Object.entries(cols)) {
        const v = (body as Record<string, unknown>)[key];
        if (v === undefined) continue;
        values.push(v);
        sets.push(`${col} = $${values.length}`);
      }
      if (body.status === "approved") sets.push("approved_at = COALESCE(approved_at, now())");
      else if (body.status) sets.push("approved_at = NULL");
      values.push(id);
      await client.query(
        `UPDATE sales.sales_order SET ${sets.join(", ")} WHERE id = $${values.length}`,
        values,
      );
      await checkMilestoneTotal(
        client,
        { orderId: id },
        amount === null ? null : String(amount),
        method,
      );
      return loadOrder(client, id);
    });
  });

  // ---- Lines (the budget and bill of materials) ----

  app.get("/orders/:id/lines", { config: { perm: "sales.order.read" } }, async (req) => {
    const { id } = params.parse(req.params);
    await loadOrder(app.pool, id);
    const { rows } = await app.pool.query<LineRow>(
      `${LINE_SELECT} WHERE order_id = $1 ORDER BY sort_order, id`,
      [id],
    );
    return { items: rows.map(toLine) };
  });

  app.post("/orders/:id/lines", { config: { perm: "sales.order.write" } }, async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = orderLineSchema.parse(req.body);
    const created = await withActor(app.pool, req.memberId as number, async (client) => {
      editable(await loadOrder(client, id, true));
      const next = await client.query<{ n: number }>(
        "SELECT COALESCE(max(sort_order), 0) + 10 AS n FROM sales.sales_order_line WHERE order_id = $1",
        [id],
      );
      const { rows } = await client.query<LineRow>(
        `INSERT INTO sales.sales_order_line (order_id, kind, description, quantity, unit_price, unit_cost, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, order_id, kind, description, quantity, unit_price, unit_cost, sort_order,
                   round(quantity * unit_price, 2) AS line_total`,
        [
          id,
          body.kind,
          body.description,
          body.quantity,
          body.unitPrice,
          body.unitCost,
          body.sortOrder ?? next.rows[0]?.n,
        ],
      );
      return toLine(rows[0] as LineRow);
    });
    return reply.status(201).send(created);
  });

  app.patch("/orders/:id/lines/:lineId", { config: { perm: "sales.order.write" } }, async (req) => {
    const p = z.object({ id: idSchema, lineId: idSchema }).parse(req.params);
    const body = orderLineUpdateSchema.parse(req.body);
    return withActor(app.pool, req.memberId as number, async (client) => {
      editable(await loadOrder(client, p.id, true));
      const cols: Record<string, string> = {
        kind: "kind",
        description: "description",
        quantity: "quantity",
        unitPrice: "unit_price",
        unitCost: "unit_cost",
        sortOrder: "sort_order",
      };
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [key, col] of Object.entries(cols)) {
        const v = (body as Record<string, unknown>)[key];
        if (v === undefined) continue;
        values.push(v);
        sets.push(`${col} = $${values.length}`);
      }
      values.push(p.lineId, p.id);
      const { rows } = await client.query<LineRow>(
        `UPDATE sales.sales_order_line SET ${sets.join(", ")}
          WHERE id = $${values.length - 1} AND order_id = $${values.length}
          RETURNING id, order_id, kind, description, quantity, unit_price, unit_cost, sort_order,
                    round(quantity * unit_price, 2) AS line_total`,
        values,
      );
      if (!rows[0]) throw new HttpError(404, "Not Found", "Line not found");
      return toLine(rows[0]);
    });
  });

  app.delete(
    "/orders/:id/lines/:lineId",
    { config: { perm: "sales.order.write" } },
    async (req, reply) => {
      const p = z.object({ id: idSchema, lineId: idSchema }).parse(req.params);
      await withActor(app.pool, req.memberId as number, async (client) => {
        editable(await loadOrder(client, p.id, true));
        const r = await client.query(
          "DELETE FROM sales.sales_order_line WHERE id = $1 AND order_id = $2",
          [p.lineId, p.id],
        );
        if (!r.rowCount) throw new HttpError(404, "Not Found", "Line not found");
      });
      return reply.status(204).send();
    },
  );

  // ---- Billing milestones ----

  app.get("/orders/:id/milestones", { config: { perm: "sales.order.read" } }, async (req) => {
    const { id } = params.parse(req.params);
    await loadOrder(app.pool, id);
    return { items: await listMilestones(app.pool, { orderId: id }) };
  });

  app.post(
    "/orders/:id/milestones",
    { config: { perm: "sales.order.write" } },
    async (req, reply) => {
      const { id } = params.parse(req.params);
      const body = milestoneCreateSchema.parse(req.body);
      const created = await withActor(app.pool, req.memberId as number, async (client) => {
        const o = await loadOrder(client, id, true);
        editable(o);
        const next = await client.query<{ n: number }>(
          "SELECT COALESCE(max(sort_order), 0) + 10 AS n FROM sales.billing_milestone WHERE order_id = $1",
          [id],
        );
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sales.billing_milestone (order_id, name, kind, percent, amount, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [
            id,
            body.name,
            body.kind,
            body.percent ?? null,
            body.amount ?? null,
            body.sortOrder ?? next.rows[0]?.n,
          ],
        );
        await checkMilestoneTotal(client, { orderId: id }, o.billingAmount, o.billingMethod);
        const all = await listMilestones(client, { orderId: id });
        return all.find((m) => m.id === Number(rows[0]?.id)) as BillingMilestone;
      });
      return reply.status(201).send(created);
    },
  );

  app.patch("/milestones/:id", { config: { perm: "sales.order.write" } }, async (req) => {
    const { id } = params.parse(req.params);
    const body = milestoneUpdateSchema.parse(req.body);
    return withActor(app.pool, req.memberId as number, async (client) => {
      const owner = await milestoneOwner(client, id, req.permissions.has("project.write"));
      const cur = (await listMilestones(client, owner.scope)).find(
        (m) => m.id === id,
      ) as BillingMilestone;
      if (
        cur.billed &&
        (body.percent !== undefined || body.amount !== undefined || body.kind !== undefined)
      )
        throw new HttpError(409, "Already billed", "A billed milestone's amount cannot be changed");
      const percent = body.percent !== undefined ? body.percent : optNumStr(cur.percent);
      const amount = body.amount !== undefined ? body.amount : optNumStr(cur.amount);
      if ((percent === null) === (amount === null))
        throw new HttpError(
          422,
          "Amount or percentage",
          "Enter an amount or a percentage, not both",
        );
      const cols: Record<string, unknown> = {
        name: body.name,
        kind: body.kind,
        sort_order: body.sortOrder,
      };
      const sets = ["percent = $1", "amount = $2"];
      const values: unknown[] = [percent, amount];
      for (const [col, v] of Object.entries(cols)) {
        if (v === undefined) continue;
        values.push(v);
        sets.push(`${col} = $${values.length}`);
      }
      values.push(id);
      await client.query(
        `UPDATE sales.billing_milestone SET ${sets.join(", ")} WHERE id = $${values.length}`,
        values,
      );
      await checkMilestoneTotal(client, owner.scope, owner.fee, owner.method);
      return (await listMilestones(client, owner.scope)).find(
        (m) => m.id === id,
      ) as BillingMilestone;
    });
  });

  app.delete("/milestones/:id", { config: { perm: "sales.order.write" } }, async (req, reply) => {
    const { id } = params.parse(req.params);
    await withActor(app.pool, req.memberId as number, async (client) => {
      const owner = await milestoneOwner(client, id, req.permissions.has("project.write"));
      const cur = (await listMilestones(client, owner.scope)).find((m) => m.id === id);
      if (cur?.billed)
        throw new HttpError(409, "Already billed", "A billed milestone cannot be removed");
      await client.query("DELETE FROM sales.billing_milestone WHERE id = $1", [id]);
    });
    return reply.status(204).send();
  });

  // ---- Convert to a project ----

  app.post("/orders/:id/convert", { config: { perm: "sales.order.write" } }, async (req, reply) => {
    if (!req.permissions.has("project.write"))
      throw new HttpError(
        403,
        "Forbidden",
        "Converting an order creates a project, which needs the project.write permission",
      );
    const { id } = params.parse(req.params);
    const body = orderConvertSchema.parse(req.body ?? {});
    const out = await withActor(app.pool, req.memberId as number, async (client) => {
      const o = await loadOrder(client, id, true);
      if (o.status === "converted")
        throw new HttpError(409, "Already converted", `This order is project ${o.projectId}`);
      if (o.status !== "approved")
        throw new HttpError(
          422,
          "Approve the order first",
          "Only an approved order can become a project",
        );
      const total = o.laborHours;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO project.project
           (company_id, site_id, name, status, manager_member_id, billing_method, billing_amount, po_number,
            po_amount, estimated_start, estimated_end, budget_hours, notes)
         VALUES ($1,$2,$3,'open',$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          o.companyId,
          o.siteId,
          body.projectName ?? o.name,
          body.managerMemberId ?? null,
          o.billingMethod,
          o.billingAmount,
          o.poNumber,
          o.poAmount,
          body.estimatedStart ?? null,
          body.estimatedEnd ?? null,
          Number(total) > 0 ? total : null,
          o.notes,
        ],
      );
      const projectId = Number(rows[0]?.id);
      let order = 0;
      for (const phase of body.phases) {
        order += 10;
        await client.query(
          "INSERT INTO project.phase (project_id, name, sort_order) VALUES ($1,$2,$3)",
          [projectId, phase, order],
        );
      }
      await client.query("UPDATE sales.billing_milestone SET project_id = $1 WHERE order_id = $2", [
        projectId,
        id,
      ]);
      await client.query(
        `INSERT INTO sales.external_ref
           (entity_type, entity_id, provider, kind, external_id, version, status, title, url, amount, payload,
            synced_at, created_by_member_id)
         SELECT 'project', $1, provider, kind, external_id, version, status, title, url, amount, payload,
                synced_at, $4
           FROM sales.external_ref
          WHERE (entity_type = 'sales_order' AND entity_id = $2)
             OR (entity_type = 'opportunity' AND entity_id = $3::bigint)
         ON CONFLICT DO NOTHING`,
        [projectId, id, o.opportunityId ?? 0, req.memberId],
      );
      await client.query(
        "UPDATE sales.sales_order SET status = 'converted', project_id = $1 WHERE id = $2",
        [projectId, id],
      );
      if (o.opportunityId) {
        await client.query(
          `UPDATE sales.opportunity SET stage_id = (SELECT id FROM sales.stage WHERE is_won AND is_active ORDER BY sort_order LIMIT 1)
            WHERE id = $1 AND stage_id NOT IN (SELECT id FROM sales.stage WHERE is_won)`,
          [o.opportunityId],
        );
      }
      return { order: await loadOrder(client, id), projectId };
    });
    return reply.status(201).send(out);
  });
};

const optNumStr = (v: string | null): number | null => (v === null ? null : Number(v));

/** Which order or project a milestone belongs to, with its fee, so changes can be checked against it. */
async function milestoneOwner(
  q: Q,
  id: number,
  canProject: boolean,
): Promise<{
  scope: { orderId: number } | { projectId: number };
  fee: string | null;
  method: string;
}> {
  const { rows } = await q.query<{ order_id: string | null; project_id: string | null }>(
    "SELECT order_id, project_id FROM sales.billing_milestone WHERE id = $1 FOR UPDATE",
    [id],
  );
  if (!rows[0]) throw new HttpError(404, "Not Found", "Milestone not found");
  if (rows[0].project_id !== null) {
    if (!canProject)
      throw new HttpError(
        403,
        "Forbidden",
        "This milestone belongs to a project; changing it needs project.write",
      );
    const p = await q.query<{ billing_amount: string | null; billing_method: string }>(
      "SELECT billing_amount, billing_method FROM project.project WHERE id = $1",
      [rows[0].project_id],
    );
    return {
      scope: { projectId: Number(rows[0].project_id) },
      fee: p.rows[0]?.billing_amount ?? null,
      method: p.rows[0]?.billing_method ?? "",
    };
  }
  const o = await loadOrder(q, Number(rows[0].order_id));
  editable(o);
  return { scope: { orderId: o.id }, fee: o.billingAmount, method: o.billingMethod };
}
