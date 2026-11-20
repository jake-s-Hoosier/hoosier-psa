import { withActor } from "@hoosier/db";
import {
  type PurchaseOrder,
  type PurchaseOrderLine,
  type Receipt,
  dec,
  idSchema,
  purchaseOrderCreateSchema,
  purchaseOrderLineSchema,
  purchaseOrderLineUpdateSchema,
  purchaseOrderUpdateSchema,
  receiptCreateSchema,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../errors.js";

type Q = Pick<pg.Pool, "query">;
const optNum = (v: string | null) => (v === null ? null : Number(v));
const params = z.object({ id: idSchema });

interface PoRow {
  id: string;
  po_number: string;
  vendor_company_id: string;
  vendor: string;
  status: PurchaseOrder["status"];
  project_id: string | null;
  project: string | null;
  sales_order_id: string | null;
  sales_order: string | null;
  ticket_id: string | null;
  vendor_reference: string | null;
  ship_to: string | null;
  expected_date: string | null;
  ordered_at: Date | null;
  shipping_cost: string;
  notes: string | null;
  lines_total: string;
  received_value: string;
  open_value: string;
  created_at: Date;
}

/** Quantity received per line is always computed from receipts, never stored, so it cannot drift. */
const SELECT_PO = `
  SELECT po.id, po.po_number, po.vendor_company_id, v.name AS vendor, po.status, po.project_id, pr.name AS project,
         po.sales_order_id, so.name AS sales_order, po.ticket_id, po.vendor_reference, po.ship_to,
         to_char(po.expected_date, 'YYYY-MM-DD') AS expected_date, po.ordered_at, po.shipping_cost, po.notes,
         po.created_at,
         round(COALESCE(x.lines_total, 0), 2) AS lines_total,
         round(COALESCE(x.received_value, 0), 2) AS received_value,
         round(CASE WHEN po.status IN ('ordered', 'partial') THEN COALESCE(x.open_value, 0) ELSE 0 END, 2) AS open_value
    FROM procurement.purchase_order po
    JOIN crm.company v ON v.id = po.vendor_company_id
    LEFT JOIN project.project pr ON pr.id = po.project_id
    LEFT JOIN sales.sales_order so ON so.id = po.sales_order_id
    LEFT JOIN LATERAL (
      SELECT sum(round(l.quantity * l.unit_cost, 2)) AS lines_total,
             sum(round(LEAST(l.quantity, r.qty) * l.unit_cost, 2)) AS received_value,
             sum(round(GREATEST(l.quantity - r.qty, 0) * l.unit_cost, 2)) AS open_value
        FROM procurement.purchase_order_line l
        CROSS JOIN LATERAL (SELECT COALESCE(sum(rl.quantity), 0) AS qty
                              FROM procurement.receipt_line rl WHERE rl.po_line_id = l.id) r
       WHERE l.po_id = po.id) x ON true`;

const toPo = (r: PoRow): PurchaseOrder => ({
  id: Number(r.id),
  poNumber: r.po_number,
  vendorCompanyId: Number(r.vendor_company_id),
  vendor: r.vendor,
  status: r.status,
  projectId: optNum(r.project_id),
  project: r.project,
  salesOrderId: optNum(r.sales_order_id),
  salesOrder: r.sales_order,
  ticketId: optNum(r.ticket_id),
  vendorReference: r.vendor_reference,
  shipTo: r.ship_to,
  expectedDate: r.expected_date,
  orderedAt: r.ordered_at?.toISOString() ?? null,
  shippingCost: r.shipping_cost,
  notes: r.notes,
  linesTotal: r.lines_total,
  total: dec(r.lines_total).plus(r.shipping_cost).toDecimalPlaces(2).toFixed(2),
  receivedValue: r.received_value,
  openValue: r.open_value,
  createdAt: r.created_at.toISOString(),
});

async function loadPo(q: Q, id: number, lock = false): Promise<PurchaseOrder> {
  if (lock)
    await q.query("SELECT 1 FROM procurement.purchase_order WHERE id = $1 FOR UPDATE", [id]);
  const { rows } = await q.query<PoRow>(`${SELECT_PO} WHERE po.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "Not Found", `Purchase order ${id} not found`);
  return toPo(rows[0]);
}

interface LineRow {
  id: string;
  po_id: string;
  product_id: string | null;
  description: string;
  quantity: string;
  unit_cost: string;
  sort_order: number;
  line_total: string;
  received: string;
}
const LINE_SELECT = `
  SELECT l.id, l.po_id, l.product_id, l.description, l.quantity, l.unit_cost, l.sort_order,
         round(l.quantity * l.unit_cost, 2) AS line_total,
         COALESCE((SELECT sum(rl.quantity) FROM procurement.receipt_line rl WHERE rl.po_line_id = l.id), 0) AS received
    FROM procurement.purchase_order_line l`;
const toLine = (r: LineRow): PurchaseOrderLine => ({
  id: Number(r.id),
  poId: Number(r.po_id),
  productId: optNum(r.product_id),
  description: r.description,
  quantity: r.quantity,
  unitCost: r.unit_cost,
  lineTotal: r.line_total,
  quantityReceived: r.received,
  quantityOutstanding: dec(r.quantity).minus(r.received).toFixed(3),
  sortOrder: r.sort_order,
});
const loadLines = async (q: Q, poId: number) =>
  (
    await q.query<LineRow>(`${LINE_SELECT} WHERE l.po_id = $1 ORDER BY l.sort_order, l.id`, [poId])
  ).rows.map(toLine);

async function loadReceipts(q: Q, poId: number): Promise<Receipt[]> {
  const { rows } = await q.query<{
    id: string;
    po_id: string;
    received_on: string;
    reference: string | null;
    notes: string | null;
    received_by: string | null;
    lines: Array<{
      id: number;
      poLineId: number;
      description: string;
      quantity: string;
      serialNumbers: string | null;
    }>;
  }>(
    `SELECT r.id, r.po_id, to_char(r.received_on, 'YYYY-MM-DD') AS received_on, r.reference, r.notes,
            trim(concat(m.first_name, ' ', m.last_name)) AS received_by,
            COALESCE((SELECT json_agg(json_build_object('id', rl.id, 'poLineId', rl.po_line_id,
                                                        'description', l.description, 'quantity', rl.quantity::text,
                                                        'serialNumbers', rl.serial_numbers) ORDER BY rl.id)
                        FROM procurement.receipt_line rl
                        JOIN procurement.purchase_order_line l ON l.id = rl.po_line_id
                       WHERE rl.receipt_id = r.id), '[]'::json) AS lines
       FROM procurement.receipt r LEFT JOIN iam.member m ON m.id = r.received_by_member_id
      WHERE r.po_id = $1 ORDER BY r.received_on DESC, r.id DESC`,
    [poId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    poId: Number(r.po_id),
    receivedOn: r.received_on,
    reference: r.reference,
    notes: r.notes,
    receivedBy: r.received_by,
    lines: r.lines,
  }));
}

const needDraft = (po: PurchaseOrder) => {
  if (po.status !== "draft")
    throw new HttpError(
      409,
      "Already placed",
      "Lines can only change while the order is a draft; cancel it or close it short instead",
    );
};

/** Set ordered, partial or received from what has actually been received. */
async function refreshStatus(q: Q, poId: number): Promise<void> {
  await q.query(
    `UPDATE procurement.purchase_order po SET status = CASE
        WHEN NOT EXISTS (SELECT 1 FROM procurement.receipt_line rl
                           JOIN procurement.purchase_order_line l ON l.id = rl.po_line_id WHERE l.po_id = po.id)
          THEN 'ordered'
        WHEN EXISTS (SELECT 1 FROM procurement.purchase_order_line l
                      WHERE l.po_id = po.id
                        AND l.quantity > COALESCE((SELECT sum(rl.quantity) FROM procurement.receipt_line rl
                                                    WHERE rl.po_line_id = l.id), 0))
          THEN 'partial'
        ELSE 'received' END
      WHERE po.id = $1 AND po.status IN ('ordered', 'partial', 'received')`,
    [poId],
  );
}

async function checkLinks(
  q: Q,
  links: { projectId?: number | null; salesOrderId?: number | null; ticketId?: number | null },
) {
  const check = async (table: string, id: number | null | undefined, label: string) => {
    if (id == null) return;
    const ok = await q.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    if (!ok.rowCount) throw new HttpError(422, `Invalid ${label}`, `The ${label} was not found`);
  };
  await check("project.project", links.projectId, "project");
  await check("sales.sales_order", links.salesOrderId, "sales order");
  await check("service.ticket", links.ticketId, "ticket");
}

/** Purchase orders and receiving. Mounted under /api/v1/procurement. */
export const procurementRoutes: FastifyPluginAsync = async (app) => {
  app.get("/orders", { config: { perm: "procurement.read" } }, async (req) => {
    const qs = z
      .object({
        vendorId: idSchema.optional(),
        projectId: idSchema.optional(),
        ticketId: idSchema.optional(),
        salesOrderId: idSchema.optional(),
        status: z
          .enum(["draft", "ordered", "partial", "received", "closed", "canceled", "open", "all"])
          .default("all"),
      })
      .parse(req.query);
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (col: string, v: unknown) => {
      values.push(v);
      where.push(`${col} = $${values.length}`);
    };
    if (qs.vendorId) add("po.vendor_company_id", qs.vendorId);
    if (qs.projectId) add("po.project_id", qs.projectId);
    if (qs.ticketId) add("po.ticket_id", qs.ticketId);
    if (qs.salesOrderId) add("po.sales_order_id", qs.salesOrderId);
    if (qs.status === "open") where.push("po.status IN ('draft','ordered','partial')");
    else if (qs.status !== "all") add("po.status", qs.status);
    const { rows } = await app.pool.query<PoRow>(
      `${SELECT_PO} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY po.id DESC LIMIT 300`,
      values,
    );
    return { items: rows.map(toPo) };
  });

  app.get("/orders/:id", { config: { perm: "procurement.read" } }, async (req) => {
    const { id } = params.parse(req.params);
    const [order, lines, receipts] = await Promise.all([
      loadPo(app.pool, id),
      loadLines(app.pool, id),
      loadReceipts(app.pool, id),
    ]);
    return { order, lines, receipts };
  });

  app.post("/orders", { config: { perm: "procurement.write" } }, async (req, reply) => {
    const body = purchaseOrderCreateSchema.parse(req.body);
    const created = await withActor(app.pool, req.memberId as number, async (client) => {
      const v = await client.query<{ is_vendor: boolean }>(
        "SELECT is_vendor FROM crm.company WHERE id = $1",
        [body.vendorCompanyId],
      );
      if (!v.rows[0]) throw new HttpError(422, "Invalid vendor", "Vendor not found");
      if (!v.rows[0].is_vendor)
        throw new HttpError(
          422,
          "Not a vendor",
          "Mark this company as a vendor on its company record before ordering from it",
        );
      await checkLinks(client, body);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO procurement.purchase_order
           (vendor_company_id, project_id, sales_order_id, ticket_id, vendor_reference, ship_to, expected_date,
            shipping_cost, notes, created_by_member_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          body.vendorCompanyId,
          body.projectId ?? null,
          body.salesOrderId ?? null,
          body.ticketId ?? null,
          body.vendorReference ?? null,
          body.shipTo ?? null,
          body.expectedDate ?? null,
          body.shippingCost,
          body.notes ?? null,
          req.memberId,
        ],
      );
      return loadPo(client, Number(rows[0]?.id));
    });
    return reply
      .status(201)
      .header("location", `/api/v1/procurement/orders/${created.id}`)
      .send(created);
  });

  app.patch("/orders/:id", { config: { perm: "procurement.write" } }, async (req) => {
    const { id } = params.parse(req.params);
    const body = purchaseOrderUpdateSchema.parse(req.body);
    return withActor(app.pool, req.memberId as number, async (client) => {
      const cur = await loadPo(client, id, true);
      if (cur.status === "canceled" || cur.status === "closed" || cur.status === "received")
        throw new HttpError(
          409,
          "Finished",
          `This order is ${cur.status}; it can no longer change`,
        );
      await checkLinks(client, body);
      const cols: Record<string, string> = {
        projectId: "project_id",
        salesOrderId: "sales_order_id",
        ticketId: "ticket_id",
        vendorReference: "vendor_reference",
        shipTo: "ship_to",
        expectedDate: "expected_date",
        shippingCost: "shipping_cost",
        notes: "notes",
      };
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [k, col] of Object.entries(cols)) {
        const v = (body as Record<string, unknown>)[k];
        if (v === undefined) continue;
        values.push(v);
        sets.push(`${col} = $${values.length}`);
      }
      values.push(id);
      await client.query(
        `UPDATE procurement.purchase_order SET ${sets.join(", ")} WHERE id = $${values.length}`,
        values,
      );
      return loadPo(client, id);
    });
  });

  // ---- Lines (draft only) ----
  app.post("/orders/:id/lines", { config: { perm: "procurement.write" } }, async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = purchaseOrderLineSchema.parse(req.body);
    const line = await withActor(app.pool, req.memberId as number, async (client) => {
      needDraft(await loadPo(client, id, true));
      let description = body.description;
      let unitCost = body.unitCost;
      if (body.productId) {
        const p = await client.query<{ description: string; unit_cost: string }>(
          "SELECT description, unit_cost FROM catalog.product WHERE id = $1",
          [body.productId],
        );
        if (!p.rows[0]) throw new HttpError(422, "Invalid product", "Product not found");
        description ??= p.rows[0].description;
        unitCost ??= Number(p.rows[0].unit_cost);
      }
      if (!description)
        throw new HttpError(422, "Description needed", "Pick a product or describe the line");
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO procurement.purchase_order_line (po_id, product_id, description, quantity, unit_cost, sort_order)
         VALUES ($1,$2,$3,$4,$5,
                 COALESCE((SELECT max(sort_order) + 1 FROM procurement.purchase_order_line WHERE po_id = $1), 0))
         RETURNING id`,
        [id, body.productId ?? null, description, body.quantity, unitCost ?? 0],
      );
      const { rows: out } = await client.query<LineRow>(`${LINE_SELECT} WHERE l.id = $1`, [
        rows[0]?.id,
      ]);
      return toLine(out[0] as LineRow);
    });
    return reply.status(201).send(line);
  });

  const lineOwner = async (q: Q, lineId: number) => {
    const { rows } = await q.query<{ po_id: string }>(
      "SELECT po_id FROM procurement.purchase_order_line WHERE id = $1",
      [lineId],
    );
    if (!rows[0]) throw new HttpError(404, "Not Found", `Line ${lineId} not found`);
    return Number(rows[0].po_id);
  };

  app.patch("/lines/:id", { config: { perm: "procurement.write" } }, async (req) => {
    const { id } = params.parse(req.params);
    const body = purchaseOrderLineUpdateSchema.parse(req.body);
    return withActor(app.pool, req.memberId as number, async (client) => {
      needDraft(await loadPo(client, await lineOwner(client, id), true));
      const cols: Record<string, string> = {
        description: "description",
        quantity: "quantity",
        unitCost: "unit_cost",
      };
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [k, col] of Object.entries(cols)) {
        const v = (body as Record<string, unknown>)[k];
        if (v === undefined) continue;
        values.push(v);
        sets.push(`${col} = $${values.length}`);
      }
      values.push(id);
      await client.query(
        `UPDATE procurement.purchase_order_line SET ${sets.join(", ")} WHERE id = $${values.length}`,
        values,
      );
      const { rows } = await client.query<LineRow>(`${LINE_SELECT} WHERE l.id = $1`, [id]);
      return toLine(rows[0] as LineRow);
    });
  });

  app.delete("/lines/:id", { config: { perm: "procurement.write" } }, async (req, reply) => {
    const { id } = params.parse(req.params);
    await withActor(app.pool, req.memberId as number, async (client) => {
      needDraft(await loadPo(client, await lineOwner(client, id), true));
      await client.query("DELETE FROM procurement.purchase_order_line WHERE id = $1", [id]);
    });
    return reply.status(204).send();
  });

  // ---- Lifecycle ----
  app.post("/orders/:id/place", { config: { perm: "procurement.write" } }, async (req) => {
    const { id } = params.parse(req.params);
    return withActor(app.pool, req.memberId as number, async (client) => {
      needDraft(await loadPo(client, id, true));
      const n = await client.query(
        "SELECT 1 FROM procurement.purchase_order_line WHERE po_id = $1 LIMIT 1",
        [id],
      );
      if (!n.rowCount)
        throw new HttpError(422, "No lines", "Add at least one line before placing the order");
      await client.query(
        "UPDATE procurement.purchase_order SET status = 'ordered', ordered_at = now() WHERE id = $1",
        [id],
      );
      return loadPo(client, id);
    });
  });

  app.post("/orders/:id/cancel", { config: { perm: "procurement.write" } }, async (req) => {
    const { id } = params.parse(req.params);
    return withActor(app.pool, req.memberId as number, async (client) => {
      const cur = await loadPo(client, id, true);
      if (!["draft", "ordered"].includes(cur.status))
        throw new HttpError(
          409,
          "Cannot cancel",
          cur.status === "partial"
            ? "Some of this order has arrived; close it short instead"
            : `This order is ${cur.status}`,
        );
      await client.query(
        "UPDATE procurement.purchase_order SET status = 'canceled' WHERE id = $1",
        [id],
      );
      return loadPo(client, id);
    });
  });

  /** The vendor will not ship the rest: finish the order with what arrived. */
  app.post("/orders/:id/close", { config: { perm: "procurement.write" } }, async (req) => {
    const { id } = params.parse(req.params);
    return withActor(app.pool, req.memberId as number, async (client) => {
      const cur = await loadPo(client, id, true);
      if (cur.status !== "partial")
        throw new HttpError(
          409,
          "Cannot close",
          "Only a partly received order can be closed short",
        );
      await client.query("UPDATE procurement.purchase_order SET status = 'closed' WHERE id = $1", [
        id,
      ]);
      return loadPo(client, id);
    });
  });

  // ---- Receiving ----
  app.post(
    "/orders/:id/receipts",
    { config: { perm: "procurement.receive" } },
    async (req, reply) => {
      const { id } = params.parse(req.params);
      const body = receiptCreateSchema.parse(req.body);
      const out = await withActor(app.pool, req.memberId as number, async (client) => {
        const po = await loadPo(client, id, true);
        if (po.status !== "ordered" && po.status !== "partial")
          throw new HttpError(
            409,
            "Not receivable",
            po.status === "draft"
              ? "Place the order before receiving against it"
              : `This order is ${po.status}`,
          );
        const lines = await loadLines(client, id);
        const byId = new Map(lines.map((l) => [l.id, l]));
        const asked = new Map<number, ReturnType<typeof dec>>();
        for (const l of body.lines) {
          if (!byId.has(l.poLineId))
            throw new HttpError(
              422,
              "Wrong order",
              `Line ${l.poLineId} is not on this purchase order`,
            );
          asked.set(l.poLineId, (asked.get(l.poLineId) ?? dec(0)).plus(l.quantity));
        }
        for (const [lineId, qty] of asked) {
          const line = byId.get(lineId) as PurchaseOrderLine;
          if (qty.greaterThan(line.quantityOutstanding))
            throw new HttpError(
              422,
              "Too many received",
              `${line.description}: ${line.quantityOutstanding} still expected, ${qty.toString()} entered`,
            );
        }
        const r = await client.query<{ id: string }>(
          `INSERT INTO procurement.receipt (po_id, received_on, reference, notes, received_by_member_id)
         VALUES ($1, COALESCE($2::date, current_date), $3, $4, $5) RETURNING id`,
          [id, body.receivedOn ?? null, body.reference ?? null, body.notes ?? null, req.memberId],
        );
        for (const l of body.lines)
          await client.query(
            `INSERT INTO procurement.receipt_line (receipt_id, po_line_id, quantity, serial_numbers)
           VALUES ($1,$2,$3,$4)`,
            [r.rows[0]?.id, l.poLineId, l.quantity, l.serialNumbers ?? null],
          );
        await refreshStatus(client, id);
        return { order: await loadPo(client, id), receipts: await loadReceipts(client, id) };
      });
      return reply.status(201).send(out);
    },
  );

  /** Undo a receipt entered by mistake. */
  app.delete("/receipts/:id", { config: { perm: "procurement.write" } }, async (req, reply) => {
    const { id } = params.parse(req.params);
    await withActor(app.pool, req.memberId as number, async (client) => {
      const r = await client.query<{ po_id: string }>(
        "SELECT po_id FROM procurement.receipt WHERE id = $1",
        [id],
      );
      if (!r.rows[0]) throw new HttpError(404, "Not Found", `Receipt ${id} not found`);
      const poId = Number(r.rows[0].po_id);
      const po = await loadPo(client, poId, true);
      if (po.status === "closed" || po.status === "canceled")
        throw new HttpError(409, "Finished", `This order is ${po.status}; its receipts are final`);
      await client.query("DELETE FROM procurement.receipt WHERE id = $1", [id]);
      await refreshStatus(client, poId);
    });
    return reply.status(204).send();
  });
};
