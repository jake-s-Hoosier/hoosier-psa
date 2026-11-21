import type pg from "pg";
import {
  type BillCycle,
  clean,
  cycleMonths,
  mapBillCycle,
  num,
  perMonth,
  sane,
} from "./mappings.js";
import type { ImportReport } from "./report.js";

type Id = number;

/**
 * Agreement types, agreements and their additions. Ids are preserved for agreements and additions (ADR 0003);
 * types are matched on their ConnectWise id. CW prices additions per bill cycle; the PSA prices per month, so
 * prices and costs are divided by the cycle's months. Re-runs may change prices, so the history guard on
 * additions is lifted for the duration of this step only (it stays on for the application).
 */
export async function importAgreements(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
  ctx: { companies: Map<number, Id> },
): Promise<void> {
  const types = await importTypes(src, db, report);
  const agreements = await importAgreementRows(src, db, report, ctx, types);
  await importAdditions(src, db, report, agreements);
}

async function importTypes(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
): Promise<Map<number, Id>> {
  const { rows } = await src.query<{ type_id: number; type_name: string | null }>(
    `SELECT DISTINCT type_id, type_name FROM production.agreements WHERE type_id IS NOT NULL ORDER BY type_id`,
  );
  const out = new Map<number, Id>();
  const c = report.count("agreement types");
  for (const t of rows) {
    c.read += 1;
    const name = clean(t.type_name) ?? `CW type ${t.type_id}`;
    const cycle = mapBillCycle(name).cycle;
    // A starter type with the same name is adopted, not duplicated.
    await db.query(
      `UPDATE billing.agreement_type SET legacy_cw_agreement_type_id = $2
        WHERE name = $1 AND legacy_cw_agreement_type_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM billing.agreement_type WHERE legacy_cw_agreement_type_id = $2)`,
      [name, t.type_id],
    );
    const r = await db.query<{ id: string }>(
      `INSERT INTO billing.agreement_type (name, bill_cycle, legacy_cw_agreement_type_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (legacy_cw_agreement_type_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name, cycle, t.type_id],
    );
    out.set(t.type_id, Number(r.rows[0]?.id));
    c.written += 1;
  }
  return out;
}

interface ImportedAgreement {
  cycle: BillCycle;
  cancelledDate: string | null;
  endDate: string | null;
  startDate: string;
}

async function importAgreementRows(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
  ctx: { companies: Map<number, Id> },
  types: Map<number, Id>,
): Promise<Map<number, ImportedAgreement>> {
  const { rows } = await src.query<{
    id: number;
    name: string | null;
    company_id: number | null;
    type_id: number | null;
    type_name: string | null;
    start_date: string | null;
    end_date: string | null;
    cancelled_flag: boolean | null;
    cancel_reason: string | null;
    bill_cycle_name: string | null;
    bill_start_date: string | null;
    bill_to_company_id: number | null;
    application_unlimited_flag: boolean | null;
    application_limit: string | null;
    last_updated: string | null;
  }>(
    `SELECT id, name, company_id, type_id, type_name, start_date::text, end_date::text, cancelled_flag,
            cancel_reason, bill_cycle_name, bill_start_date::text, bill_to_company_id,
            application_unlimited_flag, application_limit, last_updated::date::text AS last_updated
       FROM production.agreements ORDER BY id`,
  );
  const out = new Map<number, ImportedAgreement>();
  const c = report.count("agreements");
  for (const a of rows) {
    c.read += 1;
    const companyId = a.company_id === null ? undefined : ctx.companies.get(a.company_id);
    const typeId = a.type_id === null ? undefined : types.get(a.type_id);
    if (!companyId || !typeId) {
      c.skipped += 1;
      report.except("agreements", a.id, "skipped: company or type not imported");
      continue;
    }
    const startRaw = sane(a.start_date) ?? sane(a.bill_start_date);
    if (!startRaw) {
      c.skipped += 1;
      report.except("agreements", a.id, "skipped: no usable start date");
      continue;
    }
    if (!sane(a.start_date)) report.tally("agreements", "no start date; bill start date used");
    let endDate = sane(a.end_date);
    if (endDate && endDate < startRaw) {
      endDate = null;
      report.tally("agreements", "end date before start date; end date dropped");
    }
    const { cycle, note } = mapBillCycle(a.bill_cycle_name);
    if (note) report.tally("agreements", note);
    const billStart = sane(a.bill_start_date) ?? startRaw;
    if (!sane(a.bill_start_date)) report.tally("agreements", "no bill start date; start date used");
    const billTo =
      a.bill_to_company_id === null ? undefined : ctx.companies.get(a.bill_to_company_id);
    if (a.bill_to_company_id !== null && !billTo) {
      report.tally("agreements", "bill-to company not imported; the customer is billed instead");
    }
    let cancelledDate: string | null = null;
    if (a.cancelled_flag === true) {
      // CW keeps no cancel date on the agreement: its end date, else the day it was last changed.
      cancelledDate = endDate ?? sane(a.last_updated) ?? startRaw;
      if (cancelledDate < startRaw) cancelledDate = startRaw;
      report.tally("agreements", "cancelled; CW has no cancel date, end date or last update used");
    }
    if (a.application_unlimited_flag === true || Number(a.application_limit ?? 0) > 0) {
      report.tally("agreements", "coverage (block hours / unlimited) not imported; set by hand");
    }
    const name = clean(a.name) ?? `${clean(a.type_name) ?? "Agreement"} ${a.id}`;
    await db.query(
      `INSERT INTO billing.agreement
         (id, company_id, bill_to_company_id, type_id, name, start_date, end_date, cancelled_date,
          cancel_reason, bill_cycle, bill_start_date, legacy_cw_agreement_id)
       OVERRIDING SYSTEM VALUE
       VALUES ($1::int,$2,$3,$4,$5,$6::date,$7::date,$8::date,$9,$10,$11::date,$1::int)
       ON CONFLICT (id) DO UPDATE
         SET company_id = EXCLUDED.company_id, bill_to_company_id = EXCLUDED.bill_to_company_id,
             type_id = EXCLUDED.type_id, name = EXCLUDED.name, start_date = EXCLUDED.start_date,
             end_date = EXCLUDED.end_date, cancelled_date = EXCLUDED.cancelled_date,
             cancel_reason = EXCLUDED.cancel_reason, bill_cycle = EXCLUDED.bill_cycle,
             bill_start_date = EXCLUDED.bill_start_date`,
      [
        a.id,
        companyId,
        billTo ?? companyId,
        typeId,
        name.slice(0, 500),
        startRaw,
        endDate,
        cancelledDate,
        clean(a.cancel_reason),
        cycle,
        billStart,
      ],
    );
    out.set(a.id, { cycle, cancelledDate, endDate, startDate: startRaw });
    c.written += 1;
  }
  return out;
}

async function importAdditions(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
  agreements: Map<number, ImportedAgreement>,
): Promise<void> {
  const { rows } = await src.query<{
    id: number;
    agreement_id: number | null;
    product_identifier: string | null;
    description: string | null;
    invoice_description: string | null;
    quantity: string | null;
    unit_price: string | null;
    unit_cost: string | null;
    bill_customer: string | null;
    prorate: boolean | null;
    effective_date: string | null;
    date_entered: string | null;
    cancelled_date: string | null;
    agreement_status: string | null;
    last_updated: string | null;
  }>(
    `SELECT id, agreement_id, product_identifier, description, invoice_description, quantity, unit_price,
            unit_cost, bill_customer, prorate_current_period_flag AS prorate,
            effective_date::date::text AS effective_date, date_entered::date::text AS date_entered,
            cancelled_date::date::text AS cancelled_date, agreement_status,
            last_updated::date::text AS last_updated
       FROM production.agreement_additions ORDER BY id`,
  );
  // The history guard blocks price edits in place; a re-import legitimately refreshes them.
  await db.query("SELECT set_config('app.allow_locked_edit', 'on', true)");
  const c = report.count("agreement additions");
  try {
    for (const d of rows) {
      c.read += 1;
      const ag = d.agreement_id === null ? undefined : agreements.get(d.agreement_id);
      if (!ag) {
        c.skipped += 1;
        report.except("agreement additions", d.id, "skipped: agreement not imported");
        continue;
      }
      const qty = num(d.quantity);
      const price = num(d.unit_price);
      if (d.bill_customer === "DoNotBill") {
        c.skipped += 1;
        report.except(
          "agreement additions",
          d.id,
          "skipped: marked Do Not Bill in CW (not recurring revenue)",
        );
        continue;
      }
      if (qty === null || qty <= 0 || price === null || price < 0) {
        c.skipped += 1;
        report.except(
          "agreement additions",
          d.id,
          "skipped: quantity or price missing, zero or negative",
        );
        continue;
      }
      let cost = num(d.unit_cost) ?? 0;
      if (cost < 0) {
        cost = 0;
        report.tally("agreement additions", "negative cost; set to zero");
      }
      const from = sane(d.effective_date) ?? sane(d.date_entered) ?? ag.startDate;
      if (!sane(d.effective_date))
        report.tally("agreement additions", "no effective date; entered or agreement start used");
      // Ends: its own cancel date, else when its agreement was cancelled, else (inactive/expired) the day it last changed.
      let to = sane(d.cancelled_date) ?? ag.cancelledDate;
      if (!to && (d.agreement_status === "Inactive" || d.agreement_status === "Expired")) {
        to = ag.endDate ?? sane(d.last_updated) ?? from;
        report.tally(
          "agreement additions",
          `${d.agreement_status} in CW; ended on the agreement end or last update date`,
        );
      }
      if (to && to < from) to = from;
      const description =
        clean(d.description) ??
        clean(d.invoice_description) ??
        clean(d.product_identifier) ??
        "Recurring charge";
      await db.query(
        `INSERT INTO billing.agreement_addition
           (id, agreement_id, description, quantity, unit_price, unit_cost, effective_from, effective_to,
            prorate, legacy_cw_addition_id)
         OVERRIDING SYSTEM VALUE
         VALUES ($1::int,$2::int,$3,$4,$5,$6,$7::date,$8::date,$9,$1::int)
         ON CONFLICT (id) DO UPDATE
           SET agreement_id = EXCLUDED.agreement_id, description = EXCLUDED.description,
               quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, unit_cost = EXCLUDED.unit_cost,
               effective_from = EXCLUDED.effective_from, effective_to = EXCLUDED.effective_to,
               prorate = EXCLUDED.prorate`,
        [
          d.id,
          d.agreement_id,
          description.slice(0, 500),
          qty,
          perMonth(price, ag.cycle),
          perMonth(cost, ag.cycle),
          from,
          to,
          d.prorate === true,
        ],
      );
      if (cycleMonths(ag.cycle) > 1)
        report.tally(
          "agreement additions",
          "priced per bill cycle in CW; divided to a monthly price",
        );
      c.written += 1;
    }
  } finally {
    await db.query("SELECT set_config('app.allow_locked_edit', 'off', true)");
  }
  report.except(
    "agreement additions",
    "*",
    "catalog product and cost vendor are not in the mirror; link them by hand",
  );
}
