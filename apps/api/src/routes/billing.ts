import { withActor } from "@hoosier/db";
import {
  type BillingRun,
  type BillingRunPreview,
  type Invoice,
  type InvoiceLine,
  type SkippedAgreement,
  addDaysIso,
  agreementInvoiceLines,
  billingRunCreateSchema,
  dueDate,
  idSchema,
  invoiceLineUpdateSchema,
  invoiceListQuerySchema,
  invoiceTotals,
  invoiceUpdateSchema,
  invoiceVoidSchema,
  lineTotal,
  periodStartingIn,
  sumMoney,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../errors.js";

const OPERATING_TZ = "America/Indiana/Indianapolis";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: OPERATING_TZ }).format(new Date());

type Q = pg.Pool | pg.PoolClient;

// ---- Reading ----

interface InvoiceRow {
  id: string;
  run_id: string | null;
  company_id: string;
  company: string;
  invoice_number: string | null;
  status: Invoice["status"];
  invoice_date: string;
  due_date: string;
  terms: string | null;
  po_number: string | null;
  notes: string | null;
  tax_code: string | null;
  tax_rate_pct: string;
  tax_exempt: boolean;
  subtotal: string;
  tax_total: string;
  total: string;
  amount_paid: string;
  posted_at: Date | null;
  voided_at: Date | null;
  void_reason: string | null;
  line_count: string;
  has_tax_code: boolean;
  has_terms: boolean;
  has_qb: boolean;
}

const SELECT_INVOICE = `
  SELECT i.id, i.run_id, i.company_id, c.name AS company, i.invoice_number, i.status,
         to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
         t.name AS terms, i.po_number, i.notes, tc.name AS tax_code, i.tax_rate_pct, i.tax_exempt,
         i.subtotal, i.tax_total, i.total, i.amount_paid, i.posted_at, i.voided_at, i.void_reason,
         (SELECT count(*) FROM billing.invoice_line l WHERE l.invoice_id = i.id) AS line_count,
         c.tax_code_id IS NOT NULL AS has_tax_code, c.billing_terms_id IS NOT NULL AS has_terms,
         c.qb_customer_list_id IS NOT NULL AS has_qb
    FROM billing.invoice i
    JOIN crm.company c ON c.id = i.company_id
    LEFT JOIN catalog.billing_terms t ON t.id = i.billing_terms_id
    LEFT JOIN catalog.tax_code tc ON tc.id = i.tax_code_id`;

function warningsFor(
  r: Pick<InvoiceRow, "status" | "has_tax_code" | "has_terms" | "has_qb" | "tax_exempt">,
): string[] {
  if (r.status !== "draft") return [];
  const w: string[] = [];
  if (!r.has_tax_code && !r.tax_exempt) w.push("The company has no tax code, so no tax is charged");
  if (!r.has_terms) w.push("The company has no billing terms, so the invoice is due on receipt");
  if (!r.has_qb) w.push("The company is not linked to a QuickBooks customer");
  return w;
}

function toInvoice(r: InvoiceRow): Invoice {
  return {
    id: Number(r.id),
    runId: r.run_id === null ? null : Number(r.run_id),
    companyId: Number(r.company_id),
    company: r.company,
    invoiceNumber: r.invoice_number === null ? null : Number(r.invoice_number),
    status: r.status,
    invoiceDate: r.invoice_date,
    dueDate: r.due_date,
    terms: r.terms,
    poNumber: r.po_number,
    notes: r.notes,
    taxCode: r.tax_code,
    taxRatePct: r.tax_rate_pct,
    taxExempt: r.tax_exempt,
    subtotal: r.subtotal,
    taxTotal: r.tax_total,
    total: r.total,
    amountPaid: r.amount_paid,
    postedAt: r.posted_at?.toISOString() ?? null,
    voidedAt: r.voided_at?.toISOString() ?? null,
    voidReason: r.void_reason,
    lineCount: Number(r.line_count),
    warnings: warningsFor(r),
  };
}

async function loadLines(q: Q, invoiceId: number): Promise<InvoiceLine[]> {
  const { rows } = await q.query<{
    id: string;
    line_no: number;
    kind: InvoiceLine["kind"];
    agreement_id: string | null;
    agreement: string | null;
    description: string;
    period_start: string | null;
    period_end: string | null;
    quantity: string;
    unit_price: string;
    amount: string;
    cost_amount: string;
    taxable: boolean;
  }>(
    `SELECT l.id, l.line_no, l.kind, l.agreement_id, a.name AS agreement, l.description,
            to_char(l.period_start, 'YYYY-MM-DD') AS period_start, to_char(l.period_end, 'YYYY-MM-DD') AS period_end,
            l.quantity, l.unit_price, l.amount, l.cost_amount, l.taxable
       FROM billing.invoice_line l LEFT JOIN billing.agreement a ON a.id = l.agreement_id
      WHERE l.invoice_id = $1 ORDER BY l.line_no`,
    [invoiceId],
  );
  return rows.map((l) => ({
    id: Number(l.id),
    lineNo: l.line_no,
    kind: l.kind,
    agreementId: l.agreement_id === null ? null : Number(l.agreement_id),
    agreement: l.agreement,
    description: l.description,
    periodStart: l.period_start,
    periodEnd: l.period_end,
    quantity: l.quantity,
    unitPrice: l.unit_price,
    amount: l.amount,
    costAmount: l.cost_amount,
    taxable: l.taxable,
  }));
}

async function loadInvoice(q: Q, id: number, withLines = true): Promise<Invoice> {
  const { rows } = await q.query<InvoiceRow>(`${SELECT_INVOICE} WHERE i.id = $1`, [id]);
  const row = rows[0];
  if (!row) throw new HttpError(404, "Not Found", `Invoice ${id} not found`);
  const inv = toInvoice(row);
  if (withLines) inv.lines = await loadLines(q, id);
  return inv;
}

// ---- Planning a run ----

interface PlannedLine {
  agreementId: number;
  additionId: number;
  productId: number | null;
  description: string;
  periodStart: string;
  periodEnd: string;
  quantity: string;
  unitPrice: string;
  unitCost: string;
  amount: string;
  costAmount: string;
  taxable: boolean;
}

interface PlannedInvoice {
  companyId: number;
  company: string;
  lines: PlannedLine[];
  taxCodeId: number | null;
  taxCode: string | null;
  taxRatePct: string;
  taxExempt: boolean;
  termsId: number | null;
  terms: string | null;
  dueDays: number | null;
  warnings: string[];
  totals: ReturnType<typeof invoiceTotals>;
}

/**
 * Works out what a run for a month would bill, without writing anything: which agreements are due
 * (a cycle starts in the month), which lines are in effect, what has already been billed (so a re-run
 * cannot double-bill), and the invoices grouped by who pays.
 */
async function planRun(
  q: Q,
  month: string,
): Promise<{ invoices: PlannedInvoice[]; skipped: SkippedAgreement[] }> {
  const monthEnd = `${addDaysIso(`${month}-01`, 40).slice(0, 8)}01`;
  const { rows: agreements } = await q.query<{
    id: string;
    name: string;
    company: string;
    bill_to_company_id: string;
    bill_cycle: "monthly" | "quarterly" | "semi_annual" | "annual";
    bill_start_date: string;
    start_date: string;
    end_date: string | null;
    auto_renew: boolean;
    cancelled_date: string | null;
  }>(
    `SELECT a.id, a.name, c.name AS company, a.bill_to_company_id, a.bill_cycle,
            to_char(a.bill_start_date, 'YYYY-MM-DD') AS bill_start_date,
            to_char(a.start_date, 'YYYY-MM-DD') AS start_date, to_char(a.end_date, 'YYYY-MM-DD') AS end_date,
            a.auto_renew, to_char(a.cancelled_date, 'YYYY-MM-DD') AS cancelled_date
       FROM billing.agreement a JOIN crm.company c ON c.id = a.company_id
      WHERE a.bill_start_date < $1::date
      ORDER BY c.name, a.name, a.id`,
    [monthEnd],
  );

  const skipped: SkippedAgreement[] = [];
  const skip = (a: (typeof agreements)[number], reason: string) =>
    skipped.push({ agreementId: Number(a.id), agreement: a.name, company: a.company, reason });
  const due: Array<{ a: (typeof agreements)[number]; period: { start: string; end: string } }> = [];
  for (const a of agreements) {
    const period = periodStartingIn(a.bill_start_date, a.bill_cycle, month);
    if (!period) continue; // not this agreement's month; nothing to report
    if (a.start_date > period.end) {
      skip(a, "Not started during this period");
    } else if (a.cancelled_date !== null && a.cancelled_date < period.start) {
      skip(a, "Cancelled before this period");
    } else if (a.end_date !== null && a.end_date < period.start && !a.auto_renew) {
      skip(a, "Expired before this period");
    } else {
      due.push({ a, period });
    }
  }
  if (due.length === 0) return { invoices: [], skipped };

  const ids = due.map((d) => Number(d.a.id));
  const { rows: additions } = await q.query<{
    id: string;
    agreement_id: string;
    product_id: string | null;
    description: string;
    quantity: string;
    unit_price: string;
    unit_cost: string;
    effective_from: string;
    effective_to: string | null;
    prorate: boolean;
    is_taxable: boolean | null;
    billed: boolean;
  }>(
    `SELECT ad.id, ad.agreement_id, ad.product_id, ad.description, ad.quantity, ad.unit_price, ad.unit_cost,
            to_char(ad.effective_from, 'YYYY-MM-DD') AS effective_from,
            to_char(ad.effective_to, 'YYYY-MM-DD') AS effective_to, ad.prorate,
            p.is_taxable,
            false AS billed
       FROM billing.agreement_addition ad LEFT JOIN catalog.product p ON p.id = ad.product_id
      WHERE ad.agreement_id = ANY($1::bigint[])
      ORDER BY ad.agreement_id, ad.description, ad.id`,
    [ids],
  );
  const { rows: already } = await q.query<{ agreement_addition_id: string; period_start: string }>(
    `SELECT agreement_addition_id, to_char(period_start, 'YYYY-MM-DD') AS period_start
       FROM billing.invoice_line
      WHERE kind = 'agreement' AND NOT is_void AND agreement_id = ANY($1::bigint[])`,
    [ids],
  );
  const billedKey = new Set(already.map((r) => `${r.agreement_addition_id}|${r.period_start}`));

  // Who pays: the bill-to company's profile decides tax and terms.
  const billTos = [...new Set(due.map((d) => Number(d.a.bill_to_company_id)))];
  const { rows: profiles } = await q.query<{
    id: string;
    name: string;
    tax_code_id: string | null;
    tax_code: string | null;
    rate_pct: string | null;
    tax_exempt_id: string | null;
    terms_id: string | null;
    terms: string | null;
    due_days: number | null;
    has_qb: boolean;
  }>(
    `SELECT c.id, c.name, c.tax_code_id, tc.name AS tax_code, tc.rate_pct, c.tax_exempt_id,
            c.billing_terms_id AS terms_id, bt.name AS terms, bt.due_days,
            c.qb_customer_list_id IS NOT NULL AS has_qb
       FROM crm.company c
       LEFT JOIN catalog.tax_code tc ON tc.id = c.tax_code_id
       LEFT JOIN catalog.billing_terms bt ON bt.id = c.billing_terms_id
      WHERE c.id = ANY($1::bigint[])`,
    [billTos],
  );
  const profile = new Map(profiles.map((p) => [Number(p.id), p]));

  const byPayer = new Map<number, PlannedLine[]>();
  for (const { a, period } of due) {
    const mine = additions
      .filter((x) => x.agreement_id === a.id && !billedKey.has(`${x.id}|${period.start}`))
      .map((x) => ({
        id: Number(x.id),
        description: x.description,
        quantity: x.quantity,
        unitPrice: x.unit_price,
        unitCost: x.unit_cost,
        effectiveFrom: x.effective_from,
        effectiveTo: x.effective_to,
        prorate: x.prorate,
      }));
    const built = agreementInvoiceLines(mine, a.bill_cycle, period);
    if (built.length === 0) {
      const had = additions.some((x) => x.agreement_id === a.id);
      skip(
        a,
        had &&
          additions.some((x) => x.agreement_id === a.id && billedKey.has(`${x.id}|${period.start}`))
          ? "Already billed for this period"
          : "No recurring lines in effect for this period",
      );
      continue;
    }
    const lines = built.map<PlannedLine>((l) => {
      const src = additions.find((x) => Number(x.id) === l.additionId);
      return {
        agreementId: Number(a.id),
        additionId: l.additionId,
        productId: src?.product_id ? Number(src.product_id) : null,
        description: `${a.name} — ${l.description}${l.prorated ? " (prorated)" : ""}`,
        periodStart: period.start,
        periodEnd: period.end,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        unitCost: l.unitCost,
        amount: l.amount,
        costAmount: l.costAmount,
        taxable: src?.is_taxable === true,
      };
    });
    const payer = Number(a.bill_to_company_id);
    byPayer.set(payer, [...(byPayer.get(payer) ?? []), ...lines]);
  }

  const invoices: PlannedInvoice[] = [];
  for (const [companyId, lines] of byPayer) {
    const p = profile.get(companyId);
    if (!p) continue;
    const exempt = p.tax_exempt_id !== null && p.tax_exempt_id.trim() !== "";
    const rate = p.rate_pct ?? "0";
    const totals = invoiceTotals(lines, rate, exempt);
    const warnings: string[] = [];
    if (p.tax_code_id === null && !exempt)
      warnings.push("The company has no tax code, so no tax is charged");
    if (p.terms_id === null)
      warnings.push("The company has no billing terms, so the invoice is due on receipt");
    if (!p.has_qb) warnings.push("The company is not linked to a QuickBooks customer");
    invoices.push({
      companyId,
      company: p.name,
      lines,
      taxCodeId: p.tax_code_id === null ? null : Number(p.tax_code_id),
      taxCode: p.tax_code,
      taxRatePct: rate,
      taxExempt: exempt,
      termsId: p.terms_id === null ? null : Number(p.terms_id),
      terms: p.terms,
      dueDays: p.due_days,
      warnings,
      totals,
    });
  }
  invoices.sort((x, y) => x.company.localeCompare(y.company));
  return { invoices, skipped };
}

const plannedToInvoice = (p: PlannedInvoice, invoiceDate: string): Invoice => ({
  id: 0,
  runId: null,
  companyId: p.companyId,
  company: p.company,
  invoiceNumber: null,
  status: "draft",
  invoiceDate,
  dueDate: dueDate(invoiceDate, p.dueDays),
  terms: p.terms,
  poNumber: null,
  notes: null,
  taxCode: p.taxCode,
  taxRatePct: p.taxRatePct,
  taxExempt: p.taxExempt,
  subtotal: p.totals.subtotal,
  taxTotal: p.totals.tax,
  total: p.totals.total,
  amountPaid: "0.00",
  postedAt: null,
  voidedAt: null,
  voidReason: null,
  lineCount: p.lines.length,
  warnings: p.warnings,
  lines: p.lines.map((l, i) => ({
    id: 0,
    lineNo: i + 1,
    kind: "agreement",
    agreementId: l.agreementId,
    agreement: null,
    description: l.description,
    periodStart: l.periodStart,
    periodEnd: l.periodEnd,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    amount: l.amount,
    costAmount: l.costAmount,
    taxable: l.taxable,
  })),
});

// ---- Drafts: totals ----

/** Recomputes a draft invoice's totals from its lines (tax is a snapshot on the invoice). */
async function recalc(client: pg.PoolClient, invoiceId: number): Promise<void> {
  const inv = await client.query<{ tax_rate_pct: string; tax_exempt: boolean }>(
    "SELECT tax_rate_pct, tax_exempt FROM billing.invoice WHERE id = $1",
    [invoiceId],
  );
  const lines = await client.query<{ amount: string; taxable: boolean }>(
    "SELECT amount, taxable FROM billing.invoice_line WHERE invoice_id = $1",
    [invoiceId],
  );
  const t = invoiceTotals(lines.rows, inv.rows[0]?.tax_rate_pct ?? "0", inv.rows[0]?.tax_exempt);
  await client.query(
    "UPDATE billing.invoice SET subtotal = $2, tax_total = $3, total = $4 WHERE id = $1",
    [invoiceId, t.subtotal, t.tax, t.total],
  );
}

async function draftInvoice(client: pg.PoolClient, id: number) {
  const { rows } = await client.query<{ status: string; run_id: string | null }>(
    "SELECT status, run_id FROM billing.invoice WHERE id = $1 FOR UPDATE",
    [id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, "Not Found", `Invoice ${id} not found`);
  if (row.status !== "draft")
    throw new HttpError(
      409,
      "Not a draft",
      "Only draft invoices can be changed; void and reissue instead",
    );
  return row;
}

// ---- Routes ----

export const billingRoutes: FastifyPluginAsync = async (app) => {
  async function runSummary(q: Q, id?: number): Promise<BillingRun[]> {
    const { rows } = await q.query<{
      id: string;
      kind: "agreement";
      period_month: string;
      invoice_date: string;
      status: BillingRun["status"];
      notes: string | null;
      created_at: Date;
      posted_at: Date | null;
      invoice_count: string;
      total: string;
    }>(
      `SELECT r.id, r.kind, to_char(r.period_month, 'YYYY-MM') AS period_month,
              to_char(r.invoice_date, 'YYYY-MM-DD') AS invoice_date, r.status, r.notes, r.created_at, r.posted_at,
              (SELECT count(*) FROM billing.invoice i WHERE i.run_id = r.id) AS invoice_count,
              COALESCE((SELECT sum(total) FROM billing.invoice i WHERE i.run_id = r.id AND i.status <> 'void'), 0) AS total
         FROM billing.billing_run r
        WHERE ($1::bigint IS NULL OR r.id = $1)
        ORDER BY r.period_month DESC, r.id DESC`,
      [id ?? null],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      periodMonth: r.period_month,
      invoiceDate: r.invoice_date,
      status: r.status,
      notes: r.notes,
      createdAt: r.created_at.toISOString(),
      postedAt: r.posted_at?.toISOString() ?? null,
      invoiceCount: Number(r.invoice_count),
      total: r.total,
    }));
  }

  app.get("/runs", { config: { perm: "billing.invoice.read" } }, async () => ({
    items: await runSummary(app.pool),
  }));

  app.get("/runs/:id", { config: { perm: "billing.invoice.read" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const run = (await runSummary(app.pool, id))[0];
    if (!run) throw new HttpError(404, "Not Found", `Billing run ${id} not found`);
    const { rows } = await app.pool.query<InvoiceRow>(
      `${SELECT_INVOICE} WHERE i.run_id = $1 ORDER BY c.name, i.id`,
      [id],
    );
    return { ...run, invoices: rows.map(toInvoice) };
  });

  /** Preview (nothing saved) or create a run: draft invoices for review. */
  app.post("/runs", { config: { perm: "billing.invoice.write" } }, async (req, reply) => {
    const body = billingRunCreateSchema.parse(req.body);
    const invoiceDate = body.invoiceDate ?? today();
    if (body.preview) {
      const plan = await planRun(app.pool, body.month);
      const preview: BillingRunPreview = {
        periodMonth: body.month,
        invoiceDate,
        invoices: plan.invoices.map((p) => plannedToInvoice(p, invoiceDate)),
        skipped: plan.skipped,
        total: sumMoney(plan.invoices.map((p) => p.totals.total)).toFixed(2),
      };
      return preview;
    }
    const runId = await withActor(app.pool, req.memberId as number, async (client) => {
      // Plan inside the transaction so the already-billed check and the inserts see the same state.
      const plan = await planRun(client, body.month);
      if (plan.invoices.length === 0) {
        throw new HttpError(
          422,
          "Nothing to bill",
          plan.skipped.length > 0
            ? `No agreement has anything left to bill for ${body.month} (${plan.skipped.length} skipped)`
            : `No agreement's cycle starts in ${body.month}`,
        );
      }
      const run = await client.query<{ id: string }>(
        `INSERT INTO billing.billing_run (kind, period_month, invoice_date, notes, created_by_member_id)
         VALUES ('agreement', $1::date, $2, $3, $4) RETURNING id`,
        [`${body.month}-01`, invoiceDate, body.notes ?? null, req.memberId],
      );
      const rid = Number(run.rows[0]?.id);
      for (const p of plan.invoices) {
        const inv = await client.query<{ id: string }>(
          `INSERT INTO billing.invoice
             (run_id, company_id, status, invoice_date, due_date, billing_terms_id, tax_code_id, tax_rate_pct,
              tax_exempt, subtotal, tax_total, total)
           VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [
            rid,
            p.companyId,
            invoiceDate,
            dueDate(invoiceDate, p.dueDays),
            p.termsId,
            p.taxCodeId,
            p.taxRatePct,
            p.taxExempt,
            p.totals.subtotal,
            p.totals.tax,
            p.totals.total,
          ],
        );
        const invoiceId = Number(inv.rows[0]?.id);
        let n = 0;
        for (const l of p.lines) {
          n += 1;
          await client.query(
            `INSERT INTO billing.invoice_line
               (invoice_id, line_no, kind, agreement_id, agreement_addition_id, product_id, period_start, period_end,
                description, quantity, unit_price, unit_cost, amount, cost_amount, taxable)
             VALUES ($1,$2,'agreement',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              invoiceId,
              n,
              l.agreementId,
              l.additionId,
              l.productId,
              l.periodStart,
              l.periodEnd,
              l.description,
              l.quantity,
              l.unitPrice,
              l.unitCost,
              l.amount,
              l.costAmount,
              l.taxable,
            ],
          );
        }
      }
      return rid;
    });
    const run = (await runSummary(app.pool, runId))[0] as BillingRun;
    return reply.status(201).send(run);
  });

  /** Throws away a draft run and its draft invoices; the periods can be billed again. */
  app.post("/runs/:id/discard", { config: { perm: "billing.invoice.write" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    await withActor(app.pool, req.memberId as number, async (client) => {
      const r = await client.query<{ status: string }>(
        "SELECT status FROM billing.billing_run WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (!r.rows[0]) throw new HttpError(404, "Not Found", `Billing run ${id} not found`);
      if (r.rows[0].status !== "draft")
        throw new HttpError(409, "Not a draft", "Only a draft run can be discarded");
      await client.query("DELETE FROM billing.invoice WHERE run_id = $1 AND status = 'draft'", [
        id,
      ]);
      await client.query("UPDATE billing.billing_run SET status = 'discarded' WHERE id = $1", [id]);
    });
    return (await runSummary(app.pool, id))[0];
  });

  /** Posting numbers the run's invoices in company order and freezes them. */
  app.post("/runs/:id/post", { config: { perm: "billing.invoice.post" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    await withActor(app.pool, req.memberId as number, async (client) => {
      const r = await client.query<{ status: string }>(
        "SELECT status FROM billing.billing_run WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (!r.rows[0]) throw new HttpError(404, "Not Found", `Billing run ${id} not found`);
      if (r.rows[0].status !== "draft")
        throw new HttpError(409, "Not a draft", "This run has already been posted or discarded");
      const drafts = await client.query<{
        id: string;
        company: string;
        lines: string;
        total: string;
      }>(
        `SELECT i.id, c.name AS company, i.total,
                (SELECT count(*) FROM billing.invoice_line l WHERE l.invoice_id = i.id) AS lines
           FROM billing.invoice i JOIN crm.company c ON c.id = i.company_id
          WHERE i.run_id = $1 AND i.status = 'draft' ORDER BY c.name, i.id FOR UPDATE OF i`,
        [id],
      );
      if (drafts.rows.length === 0)
        throw new HttpError(422, "Nothing to post", "This run has no draft invoices");
      for (const d of drafts.rows) {
        if (Number(d.lines) === 0)
          throw new HttpError(
            422,
            "Empty invoice",
            `The invoice for ${d.company} has no lines; delete it first`,
          );
        if (Number(d.total) < 0)
          throw new HttpError(
            422,
            "Negative invoice",
            `The invoice for ${d.company} has a negative total`,
          );
      }
      for (const d of drafts.rows) {
        await client.query(
          `UPDATE billing.invoice
              SET status = 'posted', invoice_number = billing.next_invoice_number(),
                  posted_at = now(), posted_by_member_id = $2
            WHERE id = $1`,
          [d.id, req.memberId],
        );
      }
      await client.query(
        "UPDATE billing.billing_run SET status = 'posted', posted_at = now(), posted_by_member_id = $2 WHERE id = $1",
        [id, req.memberId],
      );
    });
    const run = (await runSummary(app.pool, id))[0];
    return run;
  });

  app.get("/invoices", { config: { perm: "billing.invoice.read" } }, async (req) => {
    const q = invoiceListQuerySchema.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replaceAll("?", `$${params.length}`));
    };
    if (q.status === "open") where.push("i.status IN ('posted', 'partially_paid')");
    else if (q.status !== "all") add("i.status = ?", q.status);
    if (q.companyId) add("i.company_id = ?", q.companyId);
    if (q.runId) add("i.run_id = ?", q.runId);
    if (q.q) {
      params.push(`%${q.q}%`);
      const n = params.length;
      where.push(
        `(c.name ILIKE $${n} OR i.invoice_number::text = trim(both '%' from $${n}) OR i.po_number ILIKE $${n})`,
      );
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { rows } = await app.pool.query<InvoiceRow>(
      `${SELECT_INVOICE} ${clause}
        ORDER BY i.invoice_date DESC, i.invoice_number DESC NULLS FIRST, i.id DESC
        LIMIT ${q.limit} OFFSET ${q.offset}`,
      params,
    );
    const total = await app.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM billing.invoice i JOIN crm.company c ON c.id = i.company_id ${clause}`,
      params,
    );
    return {
      items: rows.map(toInvoice),
      total: Number(total.rows[0]?.n ?? 0),
      limit: q.limit,
      offset: q.offset,
    };
  });

  app.get("/invoices/:id", { config: { perm: "billing.invoice.read" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    return loadInvoice(app.pool, id);
  });

  app.patch("/invoices/:id", { config: { perm: "billing.invoice.write" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = invoiceUpdateSchema.parse(req.body);
    return withActor(app.pool, req.memberId as number, async (client) => {
      await draftInvoice(client, id);
      const cur = await client.query<{ invoice_date: string; due_days: number | null }>(
        `SELECT to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, t.due_days
           FROM billing.invoice i LEFT JOIN catalog.billing_terms t ON t.id = i.billing_terms_id WHERE i.id = $1`,
        [id],
      );
      const invoiceDate = body.invoiceDate ?? cur.rows[0]?.invoice_date ?? today();
      // Moving the invoice date moves the due date with it, unless a due date was given.
      const due =
        body.dueDate ??
        (body.invoiceDate ? dueDate(invoiceDate, cur.rows[0]?.due_days ?? null) : null);
      if (due !== null && due < invoiceDate)
        throw new HttpError(400, "Bad dates", "The due date cannot be before the invoice date");
      await client.query(
        `UPDATE billing.invoice
            SET invoice_date = $2, due_date = COALESCE($3::date, due_date),
                po_number = CASE WHEN $4 THEN $5 ELSE po_number END,
                notes = CASE WHEN $6 THEN $7 ELSE notes END
          WHERE id = $1`,
        [
          id,
          invoiceDate,
          due,
          body.poNumber !== undefined,
          body.poNumber ?? null,
          body.notes !== undefined,
          body.notes ?? null,
        ],
      );
      return loadInvoice(client, id);
    });
  });

  app.delete("/invoices/:id", { config: { perm: "billing.invoice.write" } }, async (req, reply) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    await withActor(app.pool, req.memberId as number, async (client) => {
      await draftInvoice(client, id);
      await client.query("DELETE FROM billing.invoice WHERE id = $1", [id]);
    });
    return reply.status(204).send();
  });

  /**
   * Editing a quantity or price on a draft line bills quantity x price: it replaces proration, which is
   * only worked out when the run builds the line.
   */
  app.patch(
    "/invoices/:id/lines/:lineId",
    { config: { perm: "billing.invoice.write" } },
    async (req) => {
      const p = z.object({ id: idSchema, lineId: idSchema }).parse(req.params);
      const body = invoiceLineUpdateSchema.parse(req.body);
      return withActor(app.pool, req.memberId as number, async (client) => {
        await draftInvoice(client, p.id);
        const cur = await client.query<{ quantity: string; unit_price: string }>(
          "SELECT quantity, unit_price FROM billing.invoice_line WHERE id = $1 AND invoice_id = $2 FOR UPDATE",
          [p.lineId, p.id],
        );
        if (!cur.rows[0])
          throw new HttpError(404, "Not Found", `Line ${p.lineId} not found on invoice ${p.id}`);
        const repriced = body.quantity !== undefined || body.unitPrice !== undefined;
        const qty = body.quantity ?? cur.rows[0].quantity;
        const price = body.unitPrice ?? cur.rows[0].unit_price;
        await client.query(
          `UPDATE billing.invoice_line
            SET description = COALESCE($3, description), quantity = $4, unit_price = $5,
                amount = CASE WHEN $6 THEN $7::numeric ELSE amount END,
                taxable = COALESCE($8, taxable)
          WHERE id = $1 AND invoice_id = $2`,
          [
            p.lineId,
            p.id,
            body.description ?? null,
            qty,
            price,
            repriced,
            lineTotal(qty, price).toFixed(2),
            body.taxable ?? null,
          ],
        );
        await recalc(client, p.id);
        return loadInvoice(client, p.id);
      });
    },
  );

  app.delete(
    "/invoices/:id/lines/:lineId",
    { config: { perm: "billing.invoice.write" } },
    async (req) => {
      const p = z.object({ id: idSchema, lineId: idSchema }).parse(req.params);
      return withActor(app.pool, req.memberId as number, async (client) => {
        await draftInvoice(client, p.id);
        const del = await client.query(
          "DELETE FROM billing.invoice_line WHERE id = $1 AND invoice_id = $2",
          [p.lineId, p.id],
        );
        if (del.rowCount === 0)
          throw new HttpError(404, "Not Found", `Line ${p.lineId} not found on invoice ${p.id}`);
        await recalc(client, p.id);
        return loadInvoice(client, p.id);
      });
    },
  );

  /** Voiding keeps the numbered invoice on record, frees its periods to be billed again, and needs a reason. */
  app.post("/invoices/:id/void", { config: { perm: "billing.invoice.post" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = invoiceVoidSchema.parse(req.body);
    return withActor(app.pool, req.memberId as number, async (client) => {
      const cur = await client.query<{ status: string; amount_paid: string }>(
        "SELECT status, amount_paid FROM billing.invoice WHERE id = $1 FOR UPDATE",
        [id],
      );
      const row = cur.rows[0];
      if (!row) throw new HttpError(404, "Not Found", `Invoice ${id} not found`);
      if (row.status === "draft")
        throw new HttpError(409, "Still a draft", "Delete a draft invoice instead of voiding it");
      if (row.status === "void")
        throw new HttpError(409, "Already void", "This invoice is already void");
      if (Number(row.amount_paid) > 0)
        throw new HttpError(
          409,
          "Has payments",
          "This invoice has payments; reverse them before voiding",
        );
      // The one audited override: line flags on a posted invoice, so its periods can be billed again.
      await client.query("SELECT set_config('app.allow_locked_edit', 'on', true)");
      await client.query("UPDATE billing.invoice_line SET is_void = true WHERE invoice_id = $1", [
        id,
      ]);
      await client.query("SELECT set_config('app.allow_locked_edit', 'off', true)");
      await client.query(
        `UPDATE billing.invoice
            SET status = 'void', voided_at = now(), voided_by_member_id = $2, void_reason = $3
          WHERE id = $1`,
        [id, req.memberId, body.reason],
      );
      return loadInvoice(client, id);
    });
  });
};
