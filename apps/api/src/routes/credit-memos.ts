import { withActor } from "@hoosier/db";
import {
  type CreditMemo,
  creditMemoApplySchema,
  creditMemoCreateSchema,
  creditMemoListQuerySchema,
  creditMemoVoidSchema,
  dec,
  idSchema,
  invoiceTotals,
  lineTotal,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../errors.js";

type Q = Pick<pg.Pool, "query">;

interface MemoRow {
  id: string;
  company_id: string;
  company: string;
  source_invoice_id: string | null;
  source_invoice_number: string | null;
  memo_number: string;
  status: CreditMemo["status"];
  memo_date: string;
  reason: string;
  tax_code: string | null;
  tax_rate_pct: string;
  tax_exempt: boolean;
  subtotal: string;
  tax_total: string;
  total: string;
  voided_at: Date | null;
  void_reason: string | null;
  applied: string;
}

const SELECT = `
  SELECT m.id, m.company_id, c.name AS company, m.source_invoice_id, si.invoice_number AS source_invoice_number,
         m.memo_number, m.status, to_char(m.memo_date, 'YYYY-MM-DD') AS memo_date, m.reason,
         tc.name AS tax_code, m.tax_rate_pct, m.tax_exempt, m.subtotal, m.tax_total, m.total,
         m.voided_at, m.void_reason,
         COALESCE((SELECT sum(a.amount) FROM billing.credit_application a WHERE a.credit_memo_id = m.id), 0) AS applied
    FROM billing.credit_memo m
    JOIN crm.company c ON c.id = m.company_id
    LEFT JOIN billing.invoice si ON si.id = m.source_invoice_id
    LEFT JOIN catalog.tax_code tc ON tc.id = m.tax_code_id`;

/** Money arrives as JSON numbers; accept whole cents only so nothing is silently rounded. */
function cents(n: number, what: string): string {
  const d = dec(n);
  if (d.decimalPlaces() > 2)
    throw new HttpError(422, "Invalid amount", `${what} must be in whole cents`);
  return d.toFixed(2);
}

async function toMemos(q: Q, rows: MemoRow[], withLines: boolean): Promise<CreditMemo[]> {
  const ids = rows.map((r) => Number(r.id));
  const apps = new Map<number, CreditMemo["applications"]>();
  const lines = new Map<number, NonNullable<CreditMemo["lines"]>>();
  if (ids.length > 0) {
    const a = await q.query<{
      id: string;
      credit_memo_id: string;
      invoice_id: string;
      invoice_number: string | null;
      amount: string;
    }>(
      `SELECT a.id, a.credit_memo_id, a.invoice_id, i.invoice_number, a.amount
         FROM billing.credit_application a JOIN billing.invoice i ON i.id = a.invoice_id
        WHERE a.credit_memo_id = ANY($1::bigint[]) ORDER BY a.id`,
      [ids],
    );
    for (const r of a.rows) {
      const list = apps.get(Number(r.credit_memo_id)) ?? [];
      list.push({
        id: Number(r.id),
        invoiceId: Number(r.invoice_id),
        invoiceNumber: r.invoice_number === null ? null : Number(r.invoice_number),
        amount: r.amount,
      });
      apps.set(Number(r.credit_memo_id), list);
    }
    if (withLines) {
      const l = await q.query<{
        id: string;
        credit_memo_id: string;
        line_no: number;
        source_line_id: string | null;
        description: string;
        quantity: string;
        unit_price: string;
        amount: string;
        taxable: boolean;
      }>(
        "SELECT * FROM billing.credit_memo_line WHERE credit_memo_id = ANY($1::bigint[]) ORDER BY credit_memo_id, line_no",
        [ids],
      );
      for (const r of l.rows) {
        const list = lines.get(Number(r.credit_memo_id)) ?? [];
        list.push({
          id: Number(r.id),
          lineNo: r.line_no,
          sourceLineId: r.source_line_id === null ? null : Number(r.source_line_id),
          description: r.description,
          quantity: r.quantity,
          unitPrice: r.unit_price,
          amount: r.amount,
          taxable: r.taxable,
        });
        lines.set(Number(r.credit_memo_id), list);
      }
    }
  }
  return rows.map((r) => {
    const memo: CreditMemo = {
      id: Number(r.id),
      companyId: Number(r.company_id),
      company: r.company,
      sourceInvoiceId: r.source_invoice_id === null ? null : Number(r.source_invoice_id),
      sourceInvoiceNumber:
        r.source_invoice_number === null ? null : Number(r.source_invoice_number),
      memoNumber: Number(r.memo_number),
      status: r.status,
      memoDate: r.memo_date,
      reason: r.reason,
      taxCode: r.tax_code,
      taxRatePct: r.tax_rate_pct,
      taxExempt: r.tax_exempt,
      subtotal: r.subtotal,
      taxTotal: r.tax_total,
      total: r.total,
      voidedAt: r.voided_at?.toISOString() ?? null,
      voidReason: r.void_reason,
      // A void memo keeps its record but no longer counts against any invoice.
      appliedAmount: r.status === "void" ? "0.00" : dec(r.applied).toFixed(2),
      unappliedAmount: r.status === "void" ? "0.00" : dec(r.total).minus(r.applied).toFixed(2),
      applications: apps.get(Number(r.id)) ?? [],
    };
    if (withLines) memo.lines = lines.get(Number(r.id)) ?? [];
    return memo;
  });
}

async function load(q: Q, id: number): Promise<CreditMemo> {
  const { rows } = await q.query<MemoRow>(`${SELECT} WHERE m.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "Not Found", `Credit memo ${id} not found`);
  return (await toMemos(q, rows, true))[0] as CreditMemo;
}

/** Applies part of a credit memo to an invoice, with messages a person can act on. */
async function applyOne(
  client: pg.PoolClient,
  memo: { id: number; companyId: number },
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
  if (Number(i.company_id) !== memo.companyId)
    throw new HttpError(
      422,
      "Wrong customer",
      `${label} belongs to a different customer than this credit memo`,
    );
  if (i.status !== "posted" && i.status !== "partially_paid")
    throw new HttpError(
      422,
      "Not payable",
      `${label} is ${i.status.replace("_", " ")} and cannot take a credit`,
    );
  const balance = dec(i.total).minus(i.amount_paid);
  if (dec(amount).gt(balance))
    throw new HttpError(
      422,
      "More than the balance",
      `${label} has a balance of ${balance.toFixed(2)}`,
    );
  await client.query(
    "INSERT INTO billing.credit_application (credit_memo_id, invoice_id, amount, applied_by_member_id) VALUES ($1, $2, $3, current_setting('app.member_id', true)::bigint)",
    [memo.id, invoiceId, amount],
  );
}

const idParams = z.object({ id: idSchema });

/** Credit memos and their application to invoices. Mounted under /api/v1/credit-memos. */
export const creditMemoRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { config: { perm: "billing.credit.read" } }, async (req) => {
    const q = creditMemoListQuerySchema.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replaceAll("?", `$${params.length}`));
    };
    if (q.state === "posted") where.push("m.status = 'posted'");
    else if (q.state === "void") where.push("m.status = 'void'");
    else if (q.state === "unapplied")
      where.push(
        "m.status = 'posted' AND m.total > COALESCE((SELECT sum(a.amount) FROM billing.credit_application a WHERE a.credit_memo_id = m.id), 0)",
      );
    if (q.companyId) add("m.company_id = ?", q.companyId);
    if (q.invoiceId)
      add(
        "(m.source_invoice_id = ? OR m.id IN (SELECT credit_memo_id FROM billing.credit_application WHERE invoice_id = ?))",
        q.invoiceId,
      );
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { rows } = await app.pool.query<MemoRow>(
      `${SELECT} ${clause} ORDER BY m.memo_date DESC, m.id DESC LIMIT ${q.limit} OFFSET ${q.offset}`,
      params,
    );
    const total = await app.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM billing.credit_memo m ${clause}`,
      params,
    );
    return {
      items: await toMemos(app.pool, rows, false),
      total: Number(total.rows[0]?.n ?? 0),
      limit: q.limit,
      offset: q.offset,
    };
  });

  app.get("/:id", { config: { perm: "billing.credit.read" } }, async (req) => {
    const { id } = idParams.parse(req.params);
    return load(app.pool, id);
  });

  app.post("/", { config: { perm: "billing.credit.write" } }, async (req, reply) => {
    const body = creditMemoCreateSchema.parse(req.body);
    const apps = body.applications.map((a) => ({
      invoiceId: a.invoiceId,
      amount: cents(a.amount, "An applied amount"),
    }));
    if (new Set(apps.map((a) => a.invoiceId)).size !== apps.length)
      throw new HttpError(422, "Duplicate invoice", "List each invoice once");
    const lines = body.lines.map((l) => ({
      ...l,
      amount: lineTotal(l.quantity, l.unitPrice).toFixed(2),
    }));
    if (lines.some((l) => dec(l.amount).lte(0)))
      throw new HttpError(422, "Invalid line", "Every line must be for more than zero");

    const created = await withActor(app.pool, req.memberId as number, async (client) => {
      // Tax comes from the invoice being corrected, otherwise from the customer's own profile.
      let taxCodeId: number | null = null;
      let rate = "0";
      let exempt = false;
      if (body.sourceInvoiceId) {
        const src = await client.query<{
          company_id: string;
          status: string;
          total: string;
          tax_code_id: string | null;
          tax_rate_pct: string;
          tax_exempt: boolean;
          invoice_number: string | null;
        }>(
          "SELECT company_id, status, total, tax_code_id, tax_rate_pct, tax_exempt, invoice_number FROM billing.invoice WHERE id = $1 FOR UPDATE",
          [body.sourceInvoiceId],
        );
        const s = src.rows[0];
        if (!s) throw new HttpError(404, "Not Found", `Invoice ${body.sourceInvoiceId} not found`);
        if (Number(s.company_id) !== body.companyId)
          throw new HttpError(
            422,
            "Wrong customer",
            "That invoice belongs to a different customer",
          );
        if (s.status === "draft" || s.status === "void")
          throw new HttpError(422, "Not creditable", `A ${s.status} invoice cannot be credited`);
        taxCodeId = s.tax_code_id === null ? null : Number(s.tax_code_id);
        rate = s.tax_rate_pct;
        exempt = s.tax_exempt;
        const ids = lines.map((l) => l.sourceLineId).filter((x): x is number => x !== undefined);
        if (ids.length > 0) {
          const ok = await client.query(
            "SELECT id FROM billing.invoice_line WHERE invoice_id = $1 AND id = ANY($2::bigint[])",
            [body.sourceInvoiceId, ids],
          );
          if (ok.rowCount !== new Set(ids).size)
            throw new HttpError(422, "Invalid line", "A credited line is not on that invoice");
        }
      } else {
        if (lines.some((l) => l.sourceLineId !== undefined))
          throw new HttpError(
            422,
            "Invalid line",
            "Lines can only point at an invoice when one is chosen",
          );
        const prof = await client.query<{
          tax_code_id: string | null;
          rate_pct: string | null;
          tax_exempt_id: string | null;
        }>(
          `SELECT c.tax_code_id, tc.rate_pct, c.tax_exempt_id
             FROM crm.company c LEFT JOIN catalog.tax_code tc ON tc.id = c.tax_code_id WHERE c.id = $1`,
          [body.companyId],
        );
        const p = prof.rows[0];
        if (!p) throw new HttpError(422, "Invalid customer", "That customer does not exist");
        taxCodeId = p.tax_code_id === null ? null : Number(p.tax_code_id);
        rate = p.rate_pct ?? "0";
        exempt = p.tax_exempt_id !== null && p.tax_exempt_id.trim() !== "";
      }
      const t = invoiceTotals(
        lines.map((l) => ({ amount: l.amount, taxable: l.taxable })),
        rate,
        exempt,
      );

      if (body.sourceInvoiceId) {
        const [inv, already] = await Promise.all([
          client.query<{ total: string }>("SELECT total FROM billing.invoice WHERE id = $1", [
            body.sourceInvoiceId,
          ]),
          client.query<{ s: string }>(
            "SELECT COALESCE(sum(total), 0) AS s FROM billing.credit_memo WHERE source_invoice_id = $1 AND status = 'posted'",
            [body.sourceInvoiceId],
          ),
        ]);
        const room = dec(inv.rows[0]?.total ?? 0).minus(already.rows[0]?.s ?? 0);
        if (dec(t.total).gt(room))
          throw new HttpError(
            422,
            "More than the invoice",
            `Credits on that invoice can total at most ${dec(inv.rows[0]?.total ?? 0).toFixed(2)}; ${room.toFixed(2)} is left`,
          );
      }
      if (apps.reduce((s, a) => s.plus(a.amount), dec(0)).gt(t.total))
        throw new HttpError(
          422,
          "More than the credit",
          "The applied amounts add up to more than the credit memo",
        );

      const ins = await client.query<{ id: string }>(
        `INSERT INTO billing.credit_memo
           (company_id, source_invoice_id, memo_number, memo_date, reason, tax_code_id, tax_rate_pct, tax_exempt,
            subtotal, tax_total, total, issued_by_member_id)
         VALUES ($1,$2,billing.next_invoice_number(),$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          body.companyId,
          body.sourceInvoiceId ?? null,
          body.memoDate,
          body.reason,
          taxCodeId,
          rate,
          exempt,
          t.subtotal,
          t.tax,
          t.total,
          req.memberId,
        ],
      );
      const id = Number(ins.rows[0]?.id);
      let no = 0;
      for (const l of lines) {
        no += 1;
        await client.query(
          `INSERT INTO billing.credit_memo_line
             (credit_memo_id, line_no, source_line_id, description, quantity, unit_price, amount, taxable)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            no,
            l.sourceLineId ?? null,
            l.description,
            l.quantity,
            l.unitPrice,
            l.amount,
            l.taxable,
          ],
        );
      }
      for (const a of apps) {
        await applyOne(client, { id, companyId: body.companyId }, a.invoiceId, a.amount);
        await client.query("SELECT billing.refresh_invoice_paid($1)", [a.invoiceId]);
      }
      return load(client, id);
    });
    return reply.status(201).send(created);
  });

  app.post("/:id/apply", { config: { perm: "billing.credit.write" } }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = creditMemoApplySchema.parse(req.body);
    const amount = cents(body.amount, "The amount");
    return withActor(app.pool, req.memberId as number, async (client) => {
      const locked = await client.query<{ company_id: string; status: string }>(
        "SELECT company_id, status FROM billing.credit_memo WHERE id = $1 FOR UPDATE",
        [id],
      );
      const m = locked.rows[0];
      if (!m) throw new HttpError(404, "Not Found", `Credit memo ${id} not found`);
      if (m.status === "void")
        throw new HttpError(409, "Void", "A void credit memo cannot be applied");
      const cur = await load(client, id);
      if (dec(amount).gt(cur.unappliedAmount))
        throw new HttpError(
          422,
          "More than is left",
          `Only ${cur.unappliedAmount} of this credit memo is unapplied`,
        );
      await applyOne(client, { id, companyId: Number(m.company_id) }, body.invoiceId, amount);
      await client.query("SELECT billing.refresh_invoice_paid($1)", [body.invoiceId]);
      return load(client, id);
    });
  });

  app.delete(
    "/:id/applications/:applicationId",
    { config: { perm: "billing.credit.write" } },
    async (req) => {
      const p = z.object({ id: idSchema, applicationId: idSchema }).parse(req.params);
      return withActor(app.pool, req.memberId as number, async (client) => {
        const memo = await client.query<{ status: string }>(
          "SELECT status FROM billing.credit_memo WHERE id = $1 FOR UPDATE",
          [p.id],
        );
        if (!memo.rows[0]) throw new HttpError(404, "Not Found", `Credit memo ${p.id} not found`);
        if (memo.rows[0].status === "void")
          throw new HttpError(409, "Void", "A void credit memo cannot be changed");
        const del = await client.query<{ invoice_id: string }>(
          "DELETE FROM billing.credit_application WHERE id = $1 AND credit_memo_id = $2 RETURNING invoice_id",
          [p.applicationId, p.id],
        );
        if (!del.rows[0])
          throw new HttpError(
            404,
            "Not Found",
            `Application ${p.applicationId} not found on credit memo ${p.id}`,
          );
        await client.query("SELECT billing.refresh_invoice_paid($1)", [del.rows[0].invoice_id]);
        return load(client, p.id);
      });
    },
  );

  app.post("/:id/void", { config: { perm: "billing.credit.write" } }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = creditMemoVoidSchema.parse(req.body);
    return withActor(app.pool, req.memberId as number, async (client) => {
      const cur = await client.query<{ status: string }>(
        "SELECT status FROM billing.credit_memo WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (!cur.rows[0]) throw new HttpError(404, "Not Found", `Credit memo ${id} not found`);
      if (cur.rows[0].status === "void")
        throw new HttpError(409, "Already void", "This credit memo is already void");
      const touched = await client.query<{ invoice_id: string }>(
        "SELECT DISTINCT invoice_id FROM billing.credit_application WHERE credit_memo_id = $1",
        [id],
      );
      await client.query(
        `UPDATE billing.credit_memo
            SET status = 'void', voided_at = now(), voided_by_member_id = $2, void_reason = $3
          WHERE id = $1`,
        [id, req.memberId, body.reason],
      );
      for (const t of touched.rows)
        await client.query("SELECT billing.refresh_invoice_paid($1)", [t.invoice_id]);
      return load(client, id);
    });
  });
};
