import { withActor } from "@hoosier/db";
import {
  type BillingRun,
  type BillingRunPreview,
  type Invoice,
  type InvoiceLine,
  type ProjectBillingMode,
  type SkippedItem,
  addDaysIso,
  agreementInvoiceLines,
  billingRunCreateSchema,
  dec,
  dueDate,
  idSchema,
  invoiceLineUpdateSchema,
  invoiceListQuerySchema,
  invoiceTotals,
  invoiceUpdateSchema,
  invoiceVoidSchema,
  lineTotal,
  periodStartingIn,
  qbInvoiceAdd,
  sumMoney,
  ticketInvoiceLines,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { renderInvoicePdf } from "../invoice-pdf.js";
import { sellerFromEnv } from "../seller.js";

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
    ticket_id: string | null;
    description: string;
    period_start: string | null;
    period_end: string | null;
    quantity: string;
    unit_price: string;
    amount: string;
    cost_amount: string;
    taxable: boolean;
  }>(
    `SELECT l.id, l.line_no, l.kind, l.agreement_id, a.name AS agreement, l.ticket_id, l.description,
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
    ticketId: l.ticket_id === null ? null : Number(l.ticket_id),
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
  kind: "agreement" | "time" | "product" | "expense" | "fee";
  agreementId: number | null;
  additionId: number | null;
  ticketId: number | null;
  /** Project lines carry the project (and a separately billed phase) they bill. */
  projectId?: number | null;
  phaseId?: number | null;
  /** A line that bills part of a project scope's fixed fee (deposit, progress, final). */
  projectFee?: boolean;
  /** The single line that bills a fixed-fee ticket's fee. */
  ticketFee: boolean;
  /** Time entries this line bills; they are linked to it while it is a draft. */
  entryIds: number[];
  /** Ticket charges (materials, expenses) this line bills; linked to it while it is a draft. */
  chargeIds: number[];
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
 * Groups planned lines into invoices by who pays. The payer's profile decides tax (an exempt id means
 * none), terms and the warnings a reviewer should look at.
 */
async function buildInvoices(q: Q, byPayer: Map<number, PlannedLine[]>): Promise<PlannedInvoice[]> {
  const billTos = [...byPayer.keys()];
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
  return invoices;
}

/**
 * Works out what a run for a month would bill, without writing anything: which agreements are due
 * (a cycle starts in the month), which lines are in effect, what has already been billed (so a re-run
 * cannot double-bill), and the invoices grouped by who pays.
 */
async function planAgreementRun(
  q: Q,
  month: string,
): Promise<{ invoices: PlannedInvoice[]; skipped: SkippedItem[] }> {
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

  const skipped: SkippedItem[] = [];
  const skip = (a: (typeof agreements)[number], reason: string) =>
    skipped.push({
      kind: "agreement",
      id: Number(a.id),
      label: a.name,
      company: a.company,
      reason,
    });
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
        kind: "agreement",
        agreementId: Number(a.id),
        additionId: l.additionId,
        ticketId: null,
        ticketFee: false,
        entryIds: [],
        chargeIds: [],
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

  return { invoices: await buildInvoices(q, byPayer), skipped };
}

/**
 * Works out what a ticket run would bill: approved, unbilled service-ticket time worked through the date
 * (a fixed-fee ticket takes all its approved time, so none is left behind), by each ticket's billing
 * method, grouped by who pays. Nothing is written.
 */
async function planTicketRun(
  q: Q,
  through: string,
): Promise<{ invoices: PlannedInvoice[]; skipped: SkippedItem[] }> {
  const { rows: entries } = await q.query<{
    id: string;
    ticket_id: string;
    work_date: string;
    actual_hours: string;
    billed_hours: string;
    bill_rate: string;
    cost_rate: string;
    billable: boolean;
  }>(
    `SELECT e.id, e.ticket_id, to_char(e.work_date, 'YYYY-MM-DD') AS work_date, e.actual_hours,
            e.billed_hours, e.bill_rate, e.cost_rate, (e.billable = 'billable') AS billable
       FROM timekeeping.time_entry e JOIN service.ticket t ON t.id = e.ticket_id
      WHERE e.status = 'approved' AND e.invoice_id IS NULL AND e.charge_type = 'service_ticket'
        AND t.project_id IS NULL
        AND (e.work_date <= $1::date OR t.billing_method = 'fixed_fee')
      ORDER BY e.ticket_id, e.work_date, e.id`,
    [through],
  );
  // Materials and expenses ride on the same run, by the date they were incurred.
  const { rows: charges } = await q.query<{
    id: string;
    ticket_id: string;
    kind: "product" | "expense";
    product_id: string | null;
    description: string;
    quantity: string;
    unit_price: string;
    unit_cost: string;
    taxable: boolean;
    incurred_on: string;
  }>(
    `SELECT c.id, c.ticket_id, c.kind, c.product_id, c.description, c.quantity, c.unit_price, c.unit_cost,
            c.taxable, to_char(c.incurred_on, 'YYYY-MM-DD') AS incurred_on
       FROM service.ticket_charge c JOIN service.ticket t ON t.id = c.ticket_id
      WHERE c.invoice_id IS NULL AND c.billable = 'billable' AND c.incurred_on <= $1::date
        AND t.project_id IS NULL
      ORDER BY c.ticket_id, c.incurred_on, c.id`,
    [through],
  );
  if (entries.length === 0 && charges.length === 0) return { invoices: [], skipped: [] };
  const ticketIds = [
    ...new Set([
      ...entries.map((e) => Number(e.ticket_id)),
      ...charges.map((c) => Number(c.ticket_id)),
    ]),
  ];
  const { rows: tickets } = await q.query<{
    id: string;
    summary: string;
    billing_method: "actual_rates" | "fixed_fee" | "not_to_exceed" | "override_rate";
    billing_amount: string | null;
    is_closed: boolean;
    company: string;
    payer: string;
    fee_billed: boolean;
    billed_so_far: string;
    unapproved: string;
  }>(
    `SELECT t.id, t.summary, t.billing_method, t.billing_amount, bs.is_closed, c.name AS company,
            COALESCE(c.bill_to_company_id, c.id) AS payer,
            EXISTS (SELECT 1 FROM billing.invoice_line l
                     WHERE l.ticket_id = t.id AND l.ticket_fee AND NOT l.is_void) AS fee_billed,
            COALESCE((SELECT sum(l.amount) FROM billing.invoice_line l
                       WHERE l.ticket_id = t.id AND l.kind = 'time' AND NOT l.is_void), 0) AS billed_so_far,
            (SELECT count(*) FROM timekeeping.time_entry e
              WHERE e.ticket_id = t.id AND e.status IN ('open', 'submitted')) AS unapproved
       FROM service.ticket t
       JOIN service.board_status bs ON bs.id = t.status_id
       JOIN crm.company c ON c.id = t.company_id
      WHERE t.id = ANY($1::bigint[])
      ORDER BY c.name, t.id`,
    [ticketIds],
  );
  const skipped: SkippedItem[] = [];
  const byPayer = new Map<number, PlannedLine[]>();
  const usd = (n: string | number) => dec(n).toFixed(2);
  for (const t of tickets) {
    const mine = entries
      .filter((e) => e.ticket_id === t.id)
      .map((e) => ({
        id: Number(e.id),
        workDate: e.work_date,
        actualHours: e.actual_hours,
        billedHours: e.billed_hours,
        billRate: e.bill_rate,
        costRate: e.cost_rate,
        billable: e.billable,
      }));
    const label = `#${t.id} ${t.summary}`;
    const myCharges = charges.filter((c) => c.ticket_id === t.id);
    const result =
      mine.length === 0
        ? { lines: [], skip: null }
        : ticketInvoiceLines(
            {
              method: t.billing_method,
              amount: t.billing_amount,
              closed: t.is_closed,
              feeBilled: t.fee_billed,
              billedSoFar: t.billed_so_far,
              unapprovedEntries: Number(t.unapproved),
            },
            mine,
          );
    // Held labor is reported even when the ticket's materials are billed now.
    if (mine.length > 0 && (result.skip !== null || result.lines.length === 0)) {
      skipped.push({
        kind: "ticket",
        id: Number(t.id),
        label,
        company: t.company,
        reason: result.skip ?? "Nothing to bill",
      });
    }
    if (result.lines.length === 0 && myCharges.length === 0) continue;
    const lines = result.lines.map<PlannedLine>((l) => {
      const qty = dec(l.quantity);
      const what =
        l.kind === "fixed_fee"
          ? "fixed fee"
          : l.kind === "capped"
            ? `labor (not to exceed $${usd(t.billing_amount ?? 0)}; ${l.hours} h logged)`
            : "labor";
      return {
        kind: "time",
        agreementId: null,
        additionId: null,
        ticketId: Number(t.id),
        ticketFee: l.kind === "fixed_fee",
        entryIds: l.entryIds,
        chargeIds: [],
        productId: null,
        description: `Ticket # ${t.id}  ${t.summary} — ${what}`,
        periodStart: l.periodStart,
        periodEnd: l.periodEnd,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        unitCost: qty.gt(0) ? dec(l.costAmount).div(qty).toFixed(4) : "0.0000",
        amount: l.amount,
        costAmount: l.costAmount,
        // Labor is not taxed by default; the reviewer can mark a line taxable on the draft.
        taxable: false,
      };
    });
    for (const c of myCharges) {
      lines.push({
        kind: c.kind,
        agreementId: null,
        additionId: null,
        ticketId: Number(t.id),
        ticketFee: false,
        entryIds: [],
        chargeIds: [Number(c.id)],
        productId: c.product_id === null ? null : Number(c.product_id),
        description: `Ticket # ${t.id}  ${c.description}`,
        periodStart: c.incurred_on,
        periodEnd: c.incurred_on,
        quantity: dec(c.quantity).toFixed(4),
        unitPrice: c.unit_price,
        unitCost: c.unit_cost,
        amount: lineTotal(c.quantity, c.unit_price).toFixed(2),
        costAmount: lineTotal(c.quantity, c.unit_cost).toFixed(2),
        taxable: c.taxable,
      });
    }
    const payer = Number(t.payer);
    byPayer.set(payer, [...(byPayer.get(payer) ?? []), ...lines]);
  }
  return { invoices: await buildInvoices(q, byPayer), skipped };
}

interface ProjectRunInput {
  projectId: number;
  phaseId: number | null;
  mode: ProjectBillingMode;
  through: string | null;
  amount?: number;
  percent?: number;
  description?: string;
}

/** The tickets a billing scope covers: a separately billed phase, or the project less those phases. */
const SCOPE_TICKETS = `t.project_id = $1 AND (
  CASE WHEN $2::bigint IS NULL
       THEN (t.phase_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM project.phase h WHERE h.id = t.phase_id AND h.bill_separately))
       ELSE t.phase_id = $2 END)`;

/**
 * Works out one project billing event (docs/05): time and materials through a date, a deposit or progress
 * payment against a fixed fee, or the final invoice that bills the rest of the fee and closes out the scope's
 * time. Nothing is written. With `lock`, the project row is held so two people cannot bill the same fee at once.
 */
async function planProjectRun(
  q: Q,
  input: ProjectRunInput,
  lock: boolean,
): Promise<{ invoices: PlannedInvoice[]; skipped: SkippedItem[]; poNumber: string | null }> {
  const { rows: pj } = await q.query<{
    id: string;
    company_id: string;
    name: string;
    status: string;
    billing_method: "actual_rates" | "fixed_fee" | "not_to_exceed" | "override_rate";
    billing_amount: string | null;
    po_number: string | null;
    payer: string;
  }>(
    `SELECT p.id, p.company_id, p.name, p.status, p.billing_method, p.billing_amount, p.po_number,
            COALESCE(c.bill_to_company_id, c.id) AS payer
       FROM project.project p JOIN crm.company c ON c.id = p.company_id
      WHERE p.id = $1 ${lock ? "FOR UPDATE OF p" : ""}`,
    [input.projectId],
  );
  const project = pj[0];
  if (!project) throw new HttpError(404, "Not Found", `Project ${input.projectId} not found`);
  if (project.status === "canceled")
    throw new HttpError(409, "Project canceled", "A canceled project cannot be billed");

  let scopeName = project.name;
  let method = project.billing_method;
  let amount = project.billing_amount;
  if (input.phaseId !== null) {
    const { rows } = await q.query<{
      name: string;
      bill_separately: boolean;
      billing_method: typeof method | null;
      billing_amount: string | null;
    }>(
      "SELECT name::text AS name, bill_separately, billing_method, billing_amount FROM project.phase WHERE id = $1 AND project_id = $2",
      [input.phaseId, input.projectId],
    );
    const ph = rows[0];
    if (!ph) throw new HttpError(404, "Not Found", `Phase ${input.phaseId} is not in this project`);
    if (!ph.bill_separately)
      throw new HttpError(
        422,
        "Not billed separately",
        "That phase is billed with its project; bill the project instead",
      );
    scopeName = `${project.name}: ${ph.name}`;
    // A separately billed phase with no terms of its own bills time and materials.
    method = ph.billing_method ?? "actual_rates";
    amount = ph.billing_method ? ph.billing_amount : null;
  }

  const fixed = method === "fixed_fee";
  const usd = (n: string | number) => dec(n).toFixed(2);
  const scope = [input.projectId, input.phaseId];
  const lines: PlannedLine[] = [];
  const skipped: SkippedItem[] = [];
  const base = {
    agreementId: null,
    additionId: null,
    ticketId: null,
    ticketFee: false,
    entryIds: [] as number[],
    chargeIds: [] as number[],
    productId: null,
    projectId: input.projectId,
    phaseId: input.phaseId,
  };
  const today0 = today();

  if (input.mode === "time_materials" && fixed)
    throw new HttpError(
      422,
      "Fixed-fee project",
      "This scope is billed at a fixed fee: bill a deposit, a progress payment or the final invoice",
    );
  if (input.mode !== "time_materials" && !fixed)
    throw new HttpError(
      422,
      "Not a fixed-fee project",
      "Deposits, progress payments and final invoices are for fixed-fee scopes; bill time and materials",
    );

  // Approved, unbilled time and unbilled charges in the scope.
  const entryQuery = (cutoff: boolean) =>
    q.query<{
      id: string;
      work_date: string;
      actual_hours: string;
      billed_hours: string;
      bill_rate: string;
      cost_rate: string;
      billable: boolean;
    }>(
      `SELECT e.id, to_char(e.work_date, 'YYYY-MM-DD') AS work_date, e.actual_hours, e.billed_hours,
              e.bill_rate, e.cost_rate, (e.billable = 'billable') AS billable
         FROM timekeeping.time_entry e JOIN service.ticket t ON t.id = e.ticket_id
        WHERE e.status = 'approved' AND e.invoice_id IS NULL AND e.charge_type = 'service_ticket'
          AND ${SCOPE_TICKETS} ${cutoff ? "AND e.work_date <= $3::date" : ""}
        ORDER BY e.work_date, e.id`,
      cutoff ? [...scope, input.through] : scope,
    );
  const chargeQuery = (cutoff: boolean) =>
    q.query<{
      id: string;
      ticket_id: string;
      kind: "product" | "expense";
      product_id: string | null;
      description: string;
      quantity: string;
      unit_price: string;
      unit_cost: string;
      taxable: boolean;
      incurred_on: string;
    }>(
      `SELECT c.id, c.ticket_id, c.kind, c.product_id, c.description, c.quantity, c.unit_price, c.unit_cost,
              c.taxable, to_char(c.incurred_on, 'YYYY-MM-DD') AS incurred_on
         FROM service.ticket_charge c JOIN service.ticket t ON t.id = c.ticket_id
        WHERE c.invoice_id IS NULL AND c.billable = 'billable'
          AND ${SCOPE_TICKETS} ${cutoff ? "AND c.incurred_on <= $3::date" : ""}
        ORDER BY c.ticket_id, c.incurred_on, c.id`,
      cutoff ? [...scope, input.through] : scope,
    );
  const toLine = (c: Awaited<ReturnType<typeof chargeQuery>>["rows"][number]): PlannedLine => ({
    ...base,
    kind: c.kind,
    ticketId: Number(c.ticket_id),
    chargeIds: [Number(c.id)],
    productId: c.product_id === null ? null : Number(c.product_id),
    description: `Ticket # ${c.ticket_id}  ${c.description}`,
    periodStart: c.incurred_on,
    periodEnd: c.incurred_on,
    quantity: dec(c.quantity).toFixed(4),
    unitPrice: c.unit_price,
    unitCost: c.unit_cost,
    amount: lineTotal(c.quantity, c.unit_price).toFixed(2),
    costAmount: lineTotal(c.quantity, c.unit_cost).toFixed(2),
    taxable: c.taxable,
  });

  if (fixed) {
    const { rows: billed } = await q.query<{ fee_billed: string; final_billed: boolean }>(
      `SELECT COALESCE((SELECT sum(l.amount) FROM billing.invoice_line l
                         WHERE l.project_id = $1 AND l.phase_id IS NOT DISTINCT FROM $2
                           AND l.project_fee AND NOT l.is_void), 0) AS fee_billed,
              EXISTS (SELECT 1 FROM billing.invoice i JOIN billing.billing_run r ON r.id = i.run_id
                       WHERE r.project_id = $1 AND r.phase_id IS NOT DISTINCT FROM $2
                         AND r.project_mode = 'final' AND i.status <> 'void') AS final_billed`,
      scope,
    );
    const fee = dec(amount ?? 0);
    const remaining = fee.minus(billed[0]?.fee_billed ?? 0);
    if (billed[0]?.final_billed)
      throw new HttpError(
        409,
        "Already closed out",
        "The final invoice for this scope has been created; void it to bill again",
      );

    if (input.mode === "deposit" || input.mode === "progress") {
      const cents =
        input.amount !== undefined ? dec(input.amount) : fee.times(input.percent ?? 0).div(100);
      const bill = cents.toDecimalPlaces(2);
      if (bill.lte(0)) throw new HttpError(422, "Nothing to bill", "Enter an amount above zero");
      if (bill.gt(remaining))
        throw new HttpError(
          422,
          "More than the fee",
          `$${bill.toFixed(2)} is more than the $${remaining.toFixed(2)} of the $${fee.toFixed(2)} fixed fee that has not been billed`,
        );
      const label = input.mode === "deposit" ? "Down payment" : "Progress billing";
      const pct =
        input.percent !== undefined ? ` (${dec(input.percent).toFixed(0)}% of fixed fee)` : "";
      lines.push({
        ...base,
        kind: "fee",
        projectFee: true,
        description: input.description ?? `${label} — ${scopeName}${pct}`,
        periodStart: today0,
        periodEnd: today0,
        quantity: "1.0000",
        unitPrice: bill.toFixed(4),
        unitCost: "0.0000",
        amount: bill.toFixed(2),
        costAmount: "0.00",
        taxable: false,
      });
    } else {
      // Final: what is left of the fee, plus every unbilled charge; the scope's time is closed out with it.
      if (
        input.phaseId === null &&
        project.status !== "ready_to_invoice" &&
        project.status !== "closed"
      )
        throw new HttpError(
          422,
          "Not ready to invoice",
          "Set the project to Ready to invoice (or close it) before the final invoice",
        );
      const open = await q.query<{ n: string }>(
        `SELECT count(*) AS n FROM service.ticket t JOIN service.board_status s ON s.id = t.status_id
          WHERE ${SCOPE_TICKETS} AND NOT s.is_closed`,
        scope,
      );
      if (input.phaseId !== null && Number(open.rows[0]?.n) > 0)
        throw new HttpError(
          422,
          "Open tickets",
          `${open.rows[0]?.n} ticket(s) in this phase are still open; close them before the final invoice`,
        );
      const unapproved = await q.query<{ n: string }>(
        `SELECT count(*) AS n FROM timekeeping.time_entry e JOIN service.ticket t ON t.id = e.ticket_id
          WHERE e.status IN ('open', 'submitted') AND ${SCOPE_TICKETS}`,
        scope,
      );
      if (Number(unapproved.rows[0]?.n) > 0)
        throw new HttpError(
          422,
          "Time not approved",
          `${unapproved.rows[0]?.n} time entries on this scope are not approved yet; approve them first`,
        );
      const entries = (await entryQuery(false)).rows;
      const charges = (await chargeQuery(false)).rows;
      const cost = entries.reduce((a, e) => a.plus(dec(e.actual_hours).times(e.cost_rate)), dec(0));
      const dates = entries.map((e) => e.work_date).sort();
      if (remaining.gt(0) || entries.length > 0) {
        const billedBefore = fee.minus(remaining);
        lines.push({
          ...base,
          kind: "fee",
          projectFee: true,
          entryIds: entries.map((e) => Number(e.id)),
          description: billedBefore.gt(0)
            ? `Final billing — ${scopeName} (fixed fee $${fee.toFixed(2)}, $${billedBefore.toFixed(2)} billed to date)`
            : `${scopeName} — fixed fee`,
          periodStart: dates[0] ?? today0,
          periodEnd: dates[dates.length - 1] ?? today0,
          quantity: "1.0000",
          unitPrice: remaining.toFixed(4),
          unitCost: cost.toFixed(4),
          amount: remaining.toFixed(2),
          costAmount: cost.toFixed(2),
          taxable: false,
        });
      }
      for (const c of charges) lines.push(toLine(c));
    }
  } else {
    const entries = (await entryQuery(true)).rows;
    const charges = (await chargeQuery(true)).rows;
    if (entries.length > 0) {
      const { rows: so } = await q.query<{ billed: string }>(
        `SELECT COALESCE(sum(l.amount), 0) AS billed FROM billing.invoice_line l
          WHERE l.project_id = $1 AND l.phase_id IS NOT DISTINCT FROM $2
            AND l.kind = 'time' AND NOT l.is_void`,
        scope,
      );
      const result = ticketInvoiceLines(
        {
          method,
          amount,
          closed: true,
          feeBilled: false,
          billedSoFar: so[0]?.billed ?? "0",
          unapprovedEntries: 0,
        },
        entries.map((e) => ({
          id: Number(e.id),
          workDate: e.work_date,
          actualHours: e.actual_hours,
          billedHours: e.billed_hours,
          billRate: e.bill_rate,
          costRate: e.cost_rate,
          billable: e.billable,
        })),
      );
      if (result.skip !== null || result.lines.length === 0)
        skipped.push({
          kind: "project",
          id: input.projectId,
          label: scopeName,
          company: "",
          reason: result.skip ?? "Nothing to bill",
        });
      for (const l of result.lines) {
        const qty = dec(l.quantity);
        const what =
          l.kind === "capped"
            ? `labor (not to exceed $${usd(amount ?? 0)}; ${l.hours} h logged)`
            : "labor";
        lines.push({
          ...base,
          kind: "time",
          entryIds: l.entryIds,
          description: `${scopeName} — ${what}`,
          periodStart: l.periodStart,
          periodEnd: l.periodEnd,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          unitCost: qty.gt(0) ? dec(l.costAmount).div(qty).toFixed(4) : "0.0000",
          amount: l.amount,
          costAmount: l.costAmount,
          taxable: false,
        });
      }
    }
    for (const c of charges) lines.push(toLine(c));
  }

  if (lines.length === 0) return { invoices: [], skipped, poNumber: project.po_number };
  const byPayer = new Map<number, PlannedLine[]>([[Number(project.payer), lines]]);
  return { invoices: await buildInvoices(q, byPayer), skipped, poNumber: project.po_number };
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
    kind: l.kind,
    agreementId: l.agreementId,
    agreement: null,
    ticketId: l.ticketId,
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

/** Runs a step with the audited override on: time in a locked pay period is otherwise immutable. */
async function withOverride<T>(client: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query("SELECT set_config('app.allow_locked_edit', 'on', true)");
  try {
    return await fn();
  } finally {
    await client.query("SELECT set_config('app.allow_locked_edit', 'off', true)");
  }
}

/**
 * Lets go of time that was on draft or voided invoices so it can be billed again (billed time goes back to
 * approved). The scope is one invoice, one line, or every draft invoice of a run.
 */
async function releaseEntries(
  client: pg.PoolClient,
  scope: { invoiceId: number } | { lineId: number } | { runDrafts: number },
): Promise<void> {
  const [where, id] =
    "invoiceId" in scope
      ? ["invoice_id = $1", scope.invoiceId]
      : "lineId" in scope
        ? ["invoice_line_id = $1", scope.lineId]
        : [
            "invoice_id IN (SELECT id FROM billing.invoice WHERE run_id = $1 AND status = 'draft')",
            scope.runDrafts,
          ];
  await withOverride(client, async () => {
    await client.query(
      `UPDATE timekeeping.time_entry
          SET invoice_id = NULL, invoice_line_id = NULL,
              status = CASE WHEN status = 'billed' THEN 'approved' ELSE status END
        WHERE ${where}`,
      [id],
    );
    // Materials and expenses on the same lines go back to unbilled.
    await client.query(
      `UPDATE service.ticket_charge SET invoice_id = NULL, invoice_line_id = NULL WHERE ${where}`,
      [id],
    );
  });
}

// ---- Routes ----

export const billingRoutes: FastifyPluginAsync = async (app) => {
  async function runSummary(q: Q, id?: number): Promise<BillingRun[]> {
    const { rows } = await q.query<{
      id: string;
      kind: BillingRun["kind"];
      project_id: string | null;
      project: string | null;
      phase_id: string | null;
      project_mode: BillingRun["projectMode"];
      period_month: string;
      through_date: string | null;
      invoice_date: string;
      status: BillingRun["status"];
      notes: string | null;
      created_at: Date;
      posted_at: Date | null;
      invoice_count: string;
      total: string;
    }>(
      `SELECT r.id, r.kind, r.project_id, pj.name AS project, r.phase_id, r.project_mode,
              to_char(r.period_month, 'YYYY-MM') AS period_month,
              to_char(r.through_date, 'YYYY-MM-DD') AS through_date,
              to_char(r.invoice_date, 'YYYY-MM-DD') AS invoice_date, r.status, r.notes, r.created_at, r.posted_at,
              (SELECT count(*) FROM billing.invoice i WHERE i.run_id = r.id) AS invoice_count,
              COALESCE((SELECT sum(total) FROM billing.invoice i WHERE i.run_id = r.id AND i.status <> 'void'), 0) AS total
         FROM billing.billing_run r
         LEFT JOIN project.project pj ON pj.id = r.project_id
        WHERE ($1::bigint IS NULL OR r.id = $1)
        ORDER BY r.period_month DESC, r.id DESC`,
      [id ?? null],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      projectId: r.project_id === null ? null : Number(r.project_id),
      project: r.project,
      phaseId: r.phase_id === null ? null : Number(r.phase_id),
      projectMode: r.project_mode,
      periodMonth: r.period_month,
      throughDate: r.through_date,
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
    const month =
      body.kind === "ticket"
        ? (body.throughDate as string).slice(0, 7)
        : body.kind === "project"
          ? invoiceDate.slice(0, 7)
          : (body.month as string);
    const projectInput: ProjectRunInput | null =
      body.kind === "project"
        ? {
            projectId: body.projectId as number,
            phaseId: body.phaseId ?? null,
            mode: body.mode as ProjectBillingMode,
            through: body.throughDate ?? null,
            amount: body.amount,
            percent: body.percent,
            description: body.description,
          }
        : null;
    const planFor = async (
      q: Q,
      lock = false,
    ): Promise<{
      invoices: PlannedInvoice[];
      skipped: SkippedItem[];
      poNumber?: string | null;
    }> =>
      projectInput
        ? planProjectRun(q, projectInput, lock)
        : body.kind === "ticket"
          ? planTicketRun(q, body.throughDate as string)
          : planAgreementRun(q, month);
    if (body.preview) {
      const plan = await planFor(app.pool);
      const preview: BillingRunPreview = {
        kind: body.kind,
        periodMonth: month,
        throughDate: body.throughDate ?? null,
        invoiceDate,
        invoices: plan.invoices.map((p) => plannedToInvoice(p, invoiceDate)),
        skipped: plan.skipped,
        total: sumMoney(plan.invoices.map((p) => p.totals.total)).toFixed(2),
      };
      return preview;
    }
    const runId = await withActor(app.pool, req.memberId as number, async (client) => {
      // Plan inside the transaction so the already-billed check and the inserts see the same state.
      const plan = await planFor(client, true);
      if (plan.invoices.length === 0) {
        throw new HttpError(
          422,
          "Nothing to bill",
          body.kind === "project"
            ? `No approved, unbilled time or charges to bill${plan.skipped[0] ? `: ${plan.skipped[0].reason}` : ""}`
            : body.kind === "ticket"
              ? `No approved, unbilled ticket time or charges to bill through ${body.throughDate}${plan.skipped.length > 0 ? ` (${plan.skipped.length} tickets skipped)` : ""}`
              : plan.skipped.length > 0
                ? `No agreement has anything left to bill for ${month} (${plan.skipped.length} skipped)`
                : `No agreement's cycle starts in ${month}`,
        );
      }
      const run = await client.query<{ id: string }>(
        `INSERT INTO billing.billing_run
           (kind, period_month, through_date, invoice_date, notes, created_by_member_id,
            project_id, phase_id, project_mode)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          body.kind,
          `${month}-01`,
          body.throughDate ?? null,
          invoiceDate,
          body.notes ?? null,
          req.memberId,
          projectInput?.projectId ?? null,
          projectInput?.phaseId ?? null,
          projectInput?.mode ?? null,
        ],
      );
      const rid = Number(run.rows[0]?.id);
      for (const p of plan.invoices) {
        const inv = await client.query<{ id: string }>(
          `INSERT INTO billing.invoice
             (run_id, company_id, status, invoice_date, due_date, billing_terms_id, tax_code_id, tax_rate_pct,
              tax_exempt, subtotal, tax_total, total, po_number)
           VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
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
            plan.poNumber ?? null,
          ],
        );
        const invoiceId = Number(inv.rows[0]?.id);
        let n = 0;
        for (const l of p.lines) {
          n += 1;
          const ins = await client.query<{ id: string }>(
            `INSERT INTO billing.invoice_line
               (invoice_id, line_no, kind, agreement_id, agreement_addition_id, product_id, period_start, period_end,
                description, quantity, unit_price, unit_cost, amount, cost_amount, taxable, ticket_id, ticket_fee,
                project_id, phase_id, project_fee)
             VALUES ($1,$2,$15,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$16,$17,$18,$19,$20) RETURNING id`,
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
              l.kind,
              l.ticketId,
              l.ticketFee,
              l.projectId ?? null,
              l.phaseId ?? null,
              l.projectFee ?? false,
            ],
          );
          // Time goes onto the draft line now, so a second run cannot bill it again.
          if (l.entryIds.length > 0) {
            await withOverride(client, async () => {
              const link = await client.query(
                `UPDATE timekeeping.time_entry SET invoice_id = $1, invoice_line_id = $2
                  WHERE id = ANY($3::bigint[]) AND status = 'approved' AND invoice_id IS NULL`,
                [invoiceId, ins.rows[0]?.id, l.entryIds],
              );
              if (link.rowCount !== l.entryIds.length)
                throw new HttpError(
                  409,
                  "Time changed",
                  "Some time was billed by someone else; try again",
                );
            });
          }
          if (l.chargeIds.length > 0) {
            await withOverride(client, async () => {
              const link = await client.query(
                `UPDATE service.ticket_charge SET invoice_id = $1, invoice_line_id = $2
                  WHERE id = ANY($3::bigint[]) AND billable = 'billable' AND invoice_id IS NULL`,
                [invoiceId, ins.rows[0]?.id, l.chargeIds],
              );
              if (link.rowCount !== l.chargeIds.length)
                throw new HttpError(
                  409,
                  "Charges changed",
                  "A charge changed while billing; try again",
                );
            });
          }
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
      await releaseEntries(client, { runDrafts: id });
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
      // The time on these invoices is now billed and frozen.
      await withOverride(client, () =>
        client.query(
          `UPDATE timekeeping.time_entry SET status = 'billed'
            WHERE invoice_id IN (SELECT id FROM billing.invoice WHERE run_id = $1)`,
          [id],
        ),
      );
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

  /**
   * The invoice as a PDF the customer could be sent. Read-only; drafts and voids are watermarked so one cannot be
   * mistaken for a live invoice. Nothing is emailed from here.
   */
  app.get("/invoices/:id/pdf", { config: { perm: "billing.invoice.read" } }, async (req, reply) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const inv = await loadInvoice(app.pool, id);
    const site = await app.pool.query<{
      address_line1: string | null;
      address_line2: string | null;
      city: string | null;
      state: string | null;
      postal_code: string | null;
    }>(
      `SELECT address_line1, address_line2, city, state, postal_code
         FROM crm.site WHERE company_id = $1 AND deleted_at IS NULL
        ORDER BY is_billing DESC, is_default_service DESC, id LIMIT 1`,
      [inv.companyId],
    );
    const a = site.rows[0];
    const cityLine = [a?.city, [a?.state, a?.postal_code].filter(Boolean).join(" ")]
      .filter(Boolean)
      .join(", ");
    const pays = await app.pool.query<{
      received_on: string;
      method: string;
      reference: string | null;
      amount: string;
    }>(
      `SELECT to_char(p.received_on, 'YYYY-MM-DD') AS received_on, p.method, p.reference, a.amount
         FROM payments.payment_application a JOIN payments.payment p ON p.id = a.payment_id
        WHERE a.invoice_id = $1 AND p.status = 'posted' ORDER BY p.received_on, a.id`,
      [id],
    );
    const credits = await app.pool.query<{
      memo_date: string;
      memo_number: string;
      amount: string;
    }>(
      `SELECT to_char(m.memo_date, 'YYYY-MM-DD') AS memo_date, m.memo_number, c.amount
         FROM billing.credit_application c JOIN billing.credit_memo m ON m.id = c.credit_memo_id
        WHERE c.invoice_id = $1 AND m.status = 'posted' ORDER BY m.memo_date, c.id`,
      [id],
    );
    const received = [
      ...pays.rows.map((p) => ({
        date: p.received_on,
        label: `${p.method}${p.reference ? ` ${p.reference}` : ""}`,
        amount: p.amount,
      })),
      ...credits.rows.map((c) => ({
        date: c.memo_date,
        label: `credit memo ${c.memo_number}`,
        amount: c.amount,
      })),
    ].sort((x, y) => x.date.localeCompare(y.date));
    const pdf = await renderInvoicePdf({
      seller: sellerFromEnv(),
      status: inv.status,
      invoiceNumber: inv.invoiceNumber,
      invoiceId: inv.id,
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate,
      terms: inv.terms,
      poNumber: inv.poNumber,
      notes: inv.notes,
      billTo: {
        name: inv.company,
        lines: [a?.address_line1, a?.address_line2, cityLine].filter((l): l is string =>
          Boolean(l),
        ),
      },
      taxLabel: inv.taxExempt ? "Tax (exempt)" : `Tax${inv.taxCode ? ` · ${inv.taxCode}` : ""}`,
      lines: (inv.lines ?? []).map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
        detail:
          l.periodStart && l.periodEnd
            ? `${l.periodStart} to ${l.periodEnd}${l.taxable ? " · taxable" : ""}`
            : undefined,
      })),
      subtotal: inv.subtotal,
      taxTotal: inv.taxTotal,
      total: inv.total,
      payments: received,
      amountPaid: inv.amountPaid,
    });
    const name = inv.invoiceNumber === null ? `draft-${inv.id}` : String(inv.invoiceNumber);
    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `inline; filename="invoice-${name}.pdf"`)
      .send(pdf);
  });

  /**
   * The QuickBooks request this invoice would produce. Read-only: nothing is queued or sent. Lets billing compare
   * the output with what ConnectWise pushed, and shows missing QuickBooks links before cutover.
   */
  app.get("/invoices/:id/qbxml", { config: { perm: "billing.invoice.read" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const inv = await loadInvoice(app.pool, id);
    const extra = await app.pool.query<{
      list_id: string | null;
      terms: string | null;
      tax_item: string | null;
    }>(
      `SELECT c.qb_customer_list_id AS list_id, bt.qb_terms AS terms, tc.qb_tax_code AS tax_item
         FROM billing.invoice i
         JOIN crm.company c ON c.id = i.company_id
         LEFT JOIN catalog.billing_terms bt ON bt.id = i.billing_terms_id
         LEFT JOIN catalog.tax_code tc ON tc.id = i.tax_code_id
        WHERE i.id = $1`,
      [id],
    );
    const items = await app.pool.query<{ id: string; item: string | null }>(
      `SELECT l.id, p.qb_item_full_name AS item
         FROM billing.invoice_line l LEFT JOIN catalog.product p ON p.id = l.product_id
        WHERE l.invoice_id = $1 AND NOT l.is_void`,
      [id],
    );
    const itemOf = new Map(items.rows.map((r) => [Number(r.id), r.item]));
    const x = extra.rows[0];
    const result = qbInvoiceAdd({
      requestId: `invoice-${id}`,
      refNumber: inv.invoiceNumber === null ? "DRAFT" : String(inv.invoiceNumber),
      txnDate: inv.invoiceDate,
      dueDate: inv.dueDate,
      customerListId: x?.list_id ?? null,
      termsName: x?.terms ?? null,
      salesTaxItem: x?.tax_item ?? null,
      taxExempt: inv.taxExempt,
      taxTotal: inv.taxTotal,
      poNumber: inv.poNumber,
      memo: inv.notes,
      lines: (inv.lines ?? [])
        .filter((l) => itemOf.has(l.id))
        .map((l) => ({
          kind: l.kind,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          amount: l.amount,
          taxable: l.taxable,
          itemFullName: itemOf.get(l.id) ?? null,
          serviceDate: l.periodEnd,
        })),
    });
    if (inv.invoiceNumber === null)
      result.notes.push("A draft has no number yet; DRAFT stands in for the reference number");
    return result;
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
      await releaseEntries(client, { invoiceId: id });
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
        await releaseEntries(client, { lineId: p.lineId });
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
      await withOverride(client, () =>
        client.query("UPDATE billing.invoice_line SET is_void = true WHERE invoice_id = $1", [id]),
      );
      // Time on the invoice goes back to approved, ready to be billed again.
      await releaseEntries(client, { invoiceId: id });
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
