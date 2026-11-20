import { withActor } from "@hoosier/db";
import {
  type Payment,
  dec,
  idSchema,
  paymentApplySchema,
  paymentCreateSchema,
  paymentListQuerySchema,
  paymentUpdateSchema,
  paymentVoidSchema,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../errors.js";

type Q = Pick<pg.Pool, "query">;

interface PaymentRow {
  id: string;
  company_id: string;
  company: string;
  received_on: string;
  method: Payment["method"];
  reference: string | null;
  amount: string;
  fee_amount: string;
  status: Payment["status"];
  notes: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  applied: string;
}

const SELECT = `
  SELECT p.id, p.company_id, c.name AS company, to_char(p.received_on, 'YYYY-MM-DD') AS received_on,
         p.method, p.reference, p.amount, p.fee_amount, p.status, p.notes, p.voided_at, p.void_reason,
         COALESCE((SELECT sum(a.amount) FROM payments.payment_application a WHERE a.payment_id = p.id), 0) AS applied
    FROM payments.payment p JOIN crm.company c ON c.id = p.company_id`;

/** Money arrives as JSON numbers; accept whole cents only so nothing is silently rounded. */
function cents(n: number, what: string): string {
  const d = dec(n);
  if (d.decimalPlaces() > 2)
    throw new HttpError(422, "Invalid amount", `${what} must be in whole cents`);
  return d.toFixed(2);
}

async function applicationsOf(q: Q, ids: number[]) {
  if (ids.length === 0) return new Map<number, Payment["applications"]>();
  const { rows } = await q.query<{
    id: string;
    payment_id: string;
    invoice_id: string;
    invoice_number: string | null;
    amount: string;
  }>(
    `SELECT a.id, a.payment_id, a.invoice_id, i.invoice_number, a.amount
       FROM payments.payment_application a JOIN billing.invoice i ON i.id = a.invoice_id
      WHERE a.payment_id = ANY($1::bigint[]) ORDER BY a.id`,
    [ids],
  );
  const by = new Map<number, Payment["applications"]>();
  for (const r of rows) {
    const list = by.get(Number(r.payment_id)) ?? [];
    list.push({
      id: Number(r.id),
      invoiceId: Number(r.invoice_id),
      invoiceNumber: r.invoice_number === null ? null : Number(r.invoice_number),
      amount: r.amount,
    });
    by.set(Number(r.payment_id), list);
  }
  return by;
}

async function toPayments(q: Q, rows: PaymentRow[]): Promise<Payment[]> {
  const apps = await applicationsOf(
    q,
    rows.map((r) => Number(r.id)),
  );
  return rows.map((r) => ({
    id: Number(r.id),
    companyId: Number(r.company_id),
    company: r.company,
    receivedOn: r.received_on,
    method: r.method,
    reference: r.reference,
    amount: r.amount,
    feeAmount: r.fee_amount,
    status: r.status,
    notes: r.notes,
    voidedAt: r.voided_at?.toISOString() ?? null,
    voidReason: r.void_reason,
    // A void payment keeps its record but no longer counts against any invoice.
    appliedAmount: r.status === "void" ? "0.00" : dec(r.applied).toFixed(2),
    unappliedAmount: r.status === "void" ? "0.00" : dec(r.amount).minus(r.applied).toFixed(2),
    applications: apps.get(Number(r.id)) ?? [],
  }));
}

async function load(q: Q, id: number): Promise<Payment> {
  const { rows } = await q.query<PaymentRow>(`${SELECT} WHERE p.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "Not Found", `Payment ${id} not found`);
  return (await toPayments(q, rows))[0] as Payment;
}

/** An invoice's paid amount and status follow its live payments and credit memos (one SQL function does both). */
async function recompute(client: pg.PoolClient, invoiceId: number): Promise<void> {
  await client.query("SELECT billing.refresh_invoice_paid($1)", [invoiceId]);
}

/** Applies part of a payment to an invoice, with messages a person can act on. */
async function applyOne(
  client: pg.PoolClient,
  payment: { id: number; companyId: number },
  invoiceId: number,
  amount: string,
): Promise<void> {
  const inv = await client.query<{
    company_id: string;
    status: string;
    total: string;
    amount_paid: string;
    invoice_number: string | null;
  }>(
    "SELECT company_id, status, total, amount_paid, invoice_number FROM billing.invoice WHERE id = $1 FOR UPDATE",
    [invoiceId],
  );
  const i = inv.rows[0];
  if (!i) throw new HttpError(404, "Not Found", `Invoice ${invoiceId} not found`);
  const label = i.invoice_number ? `Invoice ${i.invoice_number}` : `Invoice ${invoiceId}`;
  if (Number(i.company_id) !== payment.companyId)
    throw new HttpError(
      422,
      "Wrong customer",
      `${label} belongs to a different customer than this payment`,
    );
  if (i.status !== "posted" && i.status !== "partially_paid")
    throw new HttpError(
      422,
      "Not payable",
      `${label} is ${i.status.replace("_", " ")} and cannot take a payment`,
    );
  const balance = dec(i.total).minus(i.amount_paid);
  if (dec(amount).gt(balance))
    throw new HttpError(
      422,
      "More than the balance",
      `${label} has a balance of ${balance.toFixed(2)}`,
    );
  await client.query(
    "INSERT INTO payments.payment_application (payment_id, invoice_id, amount) VALUES ($1, $2, $3)",
    [payment.id, invoiceId, amount],
  );
}

const idParams = z.object({ id: idSchema });

/** Payments received and their application to invoices. Mounted under /api/v1/payments. */
export const paymentRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { config: { perm: "billing.payment.read" } }, async (req) => {
    const q = paymentListQuerySchema.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replaceAll("?", `$${params.length}`));
    };
    if (q.state === "posted") where.push("p.status = 'posted'");
    else if (q.state === "void") where.push("p.status = 'void'");
    else if (q.state === "unapplied")
      where.push(
        `p.status = 'posted' AND p.amount > COALESCE((SELECT sum(a.amount) FROM payments.payment_application a WHERE a.payment_id = p.id), 0)`,
      );
    if (q.companyId) add("p.company_id = ?", q.companyId);
    if (q.invoiceId)
      add(
        "p.id IN (SELECT payment_id FROM payments.payment_application WHERE invoice_id = ?)",
        q.invoiceId,
      );
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { rows } = await app.pool.query<PaymentRow>(
      `${SELECT} ${clause} ORDER BY p.received_on DESC, p.id DESC LIMIT ${q.limit} OFFSET ${q.offset}`,
      params,
    );
    const total = await app.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM payments.payment p ${clause}`,
      params,
    );
    return {
      items: await toPayments(app.pool, rows),
      total: Number(total.rows[0]?.n ?? 0),
      limit: q.limit,
      offset: q.offset,
    };
  });

  app.get("/:id", { config: { perm: "billing.payment.read" } }, async (req) => {
    const { id } = idParams.parse(req.params);
    return load(app.pool, id);
  });

  app.post("/", { config: { perm: "billing.payment.write" } }, async (req, reply) => {
    const body = paymentCreateSchema.parse(req.body);
    const amount = cents(body.amount, "The amount");
    const apps = body.applications.map((a) => ({
      invoiceId: a.invoiceId,
      amount: cents(a.amount, "An applied amount"),
    }));
    if (new Set(apps.map((a) => a.invoiceId)).size !== apps.length)
      throw new HttpError(422, "Duplicate invoice", "List each invoice once");
    if (apps.reduce((s, a) => s.plus(a.amount), dec(0)).gt(amount))
      throw new HttpError(
        422,
        "More than received",
        "The applied amounts add up to more than the payment",
      );
    const created = await withActor(app.pool, req.memberId as number, async (client) => {
      const co = await client.query("SELECT 1 FROM crm.company WHERE id = $1", [body.companyId]);
      if (!co.rowCount)
        throw new HttpError(422, "Invalid customer", "That customer does not exist");
      const ins = await client.query<{ id: string }>(
        `INSERT INTO payments.payment
           (company_id, received_on, method, reference, amount, fee_amount, notes, recorded_by_member_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          body.companyId,
          body.receivedOn,
          body.method,
          body.reference ?? null,
          amount,
          body.feeAmount === undefined ? "0.00" : cents(body.feeAmount, "The fee"),
          body.notes ?? null,
          req.memberId,
        ],
      );
      const id = Number(ins.rows[0]?.id);
      for (const a of apps) {
        await applyOne(client, { id, companyId: body.companyId }, a.invoiceId, a.amount);
        await recompute(client, a.invoiceId);
      }
      return load(client, id);
    });
    return reply.status(201).send(created);
  });

  app.patch("/:id", { config: { perm: "billing.payment.write" } }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = paymentUpdateSchema.parse(req.body);
    return withActor(app.pool, req.memberId as number, async (client) => {
      const cur = await load(client, id);
      if (cur.status === "void")
        throw new HttpError(409, "Void", "A void payment cannot be changed");
      if (body.feeAmount !== undefined && dec(body.feeAmount).gte(cur.amount))
        throw new HttpError(422, "Invalid fee", "The fee must be less than the amount");
      const sets: string[] = [];
      const values: unknown[] = [];
      const set = (col: string, v: unknown) => {
        values.push(v);
        sets.push(`${col} = $${values.length}`);
      };
      if (body.reference !== undefined) set("reference", body.reference);
      if (body.notes !== undefined) set("notes", body.notes);
      if (body.feeAmount !== undefined) set("fee_amount", cents(body.feeAmount, "The fee"));
      values.push(id);
      await client.query(
        `UPDATE payments.payment SET ${sets.join(", ")} WHERE id = $${values.length}`,
        values,
      );
      return load(client, id);
    });
  });

  app.post("/:id/apply", { config: { perm: "billing.payment.write" } }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = paymentApplySchema.parse(req.body);
    const amount = cents(body.amount, "The amount");
    return withActor(app.pool, req.memberId as number, async (client) => {
      const locked = await client.query<{ company_id: string; status: string }>(
        "SELECT company_id, status FROM payments.payment WHERE id = $1 FOR UPDATE",
        [id],
      );
      const p = locked.rows[0];
      if (!p) throw new HttpError(404, "Not Found", `Payment ${id} not found`);
      if (p.status === "void") throw new HttpError(409, "Void", "A void payment cannot be applied");
      const cur = await load(client, id);
      if (dec(amount).gt(cur.unappliedAmount))
        throw new HttpError(
          422,
          "More than is left",
          `Only ${cur.unappliedAmount} of this payment is unapplied`,
        );
      await applyOne(client, { id, companyId: Number(p.company_id) }, body.invoiceId, amount);
      await recompute(client, body.invoiceId);
      return load(client, id);
    });
  });

  app.delete(
    "/:id/applications/:applicationId",
    { config: { perm: "billing.payment.write" } },
    async (req) => {
      const p = z.object({ id: idSchema, applicationId: idSchema }).parse(req.params);
      return withActor(app.pool, req.memberId as number, async (client) => {
        const pay = await client.query<{ status: string }>(
          "SELECT status FROM payments.payment WHERE id = $1 FOR UPDATE",
          [p.id],
        );
        if (!pay.rows[0]) throw new HttpError(404, "Not Found", `Payment ${p.id} not found`);
        if (pay.rows[0].status === "void")
          throw new HttpError(409, "Void", "A void payment cannot be changed");
        const del = await client.query<{ invoice_id: string }>(
          "DELETE FROM payments.payment_application WHERE id = $1 AND payment_id = $2 RETURNING invoice_id",
          [p.applicationId, p.id],
        );
        if (!del.rows[0])
          throw new HttpError(
            404,
            "Not Found",
            `Application ${p.applicationId} not found on payment ${p.id}`,
          );
        await recompute(client, Number(del.rows[0].invoice_id));
        return load(client, p.id);
      });
    },
  );

  app.post("/:id/void", { config: { perm: "billing.payment.write" } }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = paymentVoidSchema.parse(req.body);
    return withActor(app.pool, req.memberId as number, async (client) => {
      const cur = await client.query<{ status: string }>(
        "SELECT status FROM payments.payment WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (!cur.rows[0]) throw new HttpError(404, "Not Found", `Payment ${id} not found`);
      if (cur.rows[0].status === "void")
        throw new HttpError(409, "Already void", "This payment is already void");
      const touched = await client.query<{ invoice_id: string }>(
        "SELECT DISTINCT invoice_id FROM payments.payment_application WHERE payment_id = $1",
        [id],
      );
      await client.query(
        `UPDATE payments.payment
            SET status = 'void', voided_at = now(), voided_by_member_id = $2, void_reason = $3
          WHERE id = $1`,
        [id, req.memberId, body.reason],
      );
      for (const t of touched.rows) await recompute(client, Number(t.invoice_id));
      return load(client, id);
    });
  });
};
