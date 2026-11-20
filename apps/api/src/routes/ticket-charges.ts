import { withActor } from "@hoosier/db";
import {
  type TicketCharge,
  idSchema,
  lineTotal,
  ticketChargeCreateSchema,
  ticketChargeUpdateSchema,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../errors.js";

type Q = Pick<pg.Pool, "query">;

interface ChargeRow {
  id: string;
  ticket_id: string;
  kind: TicketCharge["kind"];
  product_id: string | null;
  product: string | null;
  description: string;
  quantity: string;
  unit_price: string;
  unit_cost: string;
  taxable: boolean;
  billable: TicketCharge["billable"];
  incurred_on: string;
  invoice_id: string | null;
  invoice_number: string | null;
  added_by_member_id: string | null;
}

const SELECT = `
  SELECT c.id, c.ticket_id, c.kind, c.product_id, p.identifier::text AS product, c.description,
         c.quantity, c.unit_price, c.unit_cost, c.taxable, c.billable,
         to_char(c.incurred_on, 'YYYY-MM-DD') AS incurred_on, c.invoice_id,
         i.invoice_number, c.added_by_member_id
    FROM service.ticket_charge c
    LEFT JOIN catalog.product p ON p.id = c.product_id
    LEFT JOIN billing.invoice i ON i.id = c.invoice_id`;

const num = (v: string | null) => (v === null ? null : Number(v));
const toCharge = (r: ChargeRow): TicketCharge => ({
  id: Number(r.id),
  ticketId: Number(r.ticket_id),
  kind: r.kind,
  productId: num(r.product_id),
  product: r.product,
  description: r.description,
  quantity: r.quantity,
  unitPrice: r.unit_price,
  unitCost: r.unit_cost,
  amount: lineTotal(r.quantity, r.unit_price).toFixed(2),
  taxable: r.taxable,
  billable: r.billable,
  incurredOn: r.incurred_on,
  invoiceId: num(r.invoice_id),
  invoiceNumber: num(r.invoice_number),
  addedByMemberId: num(r.added_by_member_id),
});

const params = z.object({ id: idSchema });
const chargeParams = z.object({ id: idSchema, chargeId: idSchema });

async function load(q: Q, ticketId: number, chargeId: number): Promise<TicketCharge> {
  const { rows } = await q.query<ChargeRow>(`${SELECT} WHERE c.id = $1 AND c.ticket_id = $2`, [
    chargeId,
    ticketId,
  ]);
  if (!rows[0])
    throw new HttpError(404, "Not Found", `Charge ${chargeId} not found on ticket ${ticketId}`);
  return toCharge(rows[0]);
}

/** Materials and expenses on a ticket. Mounted under /api/v1/tickets. */
export const ticketChargeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/:id/charges", { config: { perm: "service.ticket.read" } }, async (req) => {
    const { id } = params.parse(req.params);
    const { rows } = await app.pool.query<ChargeRow>(
      `${SELECT} WHERE c.ticket_id = $1 ORDER BY c.incurred_on, c.id`,
      [id],
    );
    return { items: rows.map(toCharge) };
  });

  app.post("/:id/charges", { config: { perm: "service.ticket.write" } }, async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = ticketChargeCreateSchema.parse(req.body);
    const created = await withActor(app.pool, req.memberId as number, async (client) => {
      const t = await client.query("SELECT 1 FROM service.ticket WHERE id = $1", [id]);
      if (!t.rowCount) throw new HttpError(404, "Not Found", `Ticket ${id} not found`);
      let product:
        | { description: string; unit_price: string; unit_cost: string; is_taxable: boolean }
        | undefined;
      if (body.productId !== undefined) {
        const { rows } = await client.query<NonNullable<typeof product>>(
          "SELECT description, unit_price, unit_cost, is_taxable FROM catalog.product WHERE id = $1 AND is_active",
          [body.productId],
        );
        product = rows[0];
        if (!product)
          throw new HttpError(422, "Invalid product", "That product does not exist or is inactive");
      }
      const description = body.description ?? product?.description;
      if (!description)
        throw new HttpError(422, "Description needed", "Give a description or choose a product");
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO service.ticket_charge
           (ticket_id, kind, product_id, description, quantity, unit_price, unit_cost, taxable,
            billable, incurred_on, added_by_member_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::date, current_date),$11) RETURNING id`,
        [
          id,
          body.kind,
          body.productId ?? null,
          description,
          body.quantity,
          body.unitPrice ?? product?.unit_price ?? 0,
          body.unitCost ?? product?.unit_cost ?? 0,
          // An expense is not taxed unless said so; a product follows its catalog flag.
          body.taxable ?? (body.kind === "product" ? (product?.is_taxable ?? true) : false),
          body.billable,
          body.incurredOn ?? null,
          req.memberId,
        ],
      );
      return load(client, id, Number(rows[0]?.id));
    });
    return reply.status(201).send(created);
  });

  app.patch("/:id/charges/:chargeId", { config: { perm: "service.ticket.write" } }, async (req) => {
    const p = chargeParams.parse(req.params);
    const body = ticketChargeUpdateSchema.parse(req.body);
    return withActor(app.pool, req.memberId as number, async (client) => {
      const cur = await load(client, p.id, p.chargeId);
      if (cur.invoiceId !== null)
        throw new HttpError(
          409,
          "On an invoice",
          "This charge is on an invoice; remove it from the invoice first",
        );
      const cols: Record<string, string> = {
        description: "description",
        quantity: "quantity",
        unitPrice: "unit_price",
        unitCost: "unit_cost",
        taxable: "taxable",
        billable: "billable",
        incurredOn: "incurred_on",
      };
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [key, col] of Object.entries(cols)) {
        const v = (body as Record<string, unknown>)[key];
        if (v === undefined) continue;
        values.push(v);
        sets.push(`${col} = $${values.length}`);
      }
      values.push(p.chargeId);
      await client.query(
        `UPDATE service.ticket_charge SET ${sets.join(", ")} WHERE id = $${values.length}`,
        values,
      );
      return load(client, p.id, p.chargeId);
    });
  });

  app.delete(
    "/:id/charges/:chargeId",
    { config: { perm: "service.ticket.write" } },
    async (req, reply) => {
      const p = chargeParams.parse(req.params);
      await withActor(app.pool, req.memberId as number, async (client) => {
        const cur = await load(client, p.id, p.chargeId);
        if (cur.invoiceId !== null)
          throw new HttpError(
            409,
            "On an invoice",
            "This charge is on an invoice; remove it from the invoice first",
          );
        await client.query("DELETE FROM service.ticket_charge WHERE id = $1", [p.chargeId]);
      });
      return reply.status(204).send();
    },
  );
};
