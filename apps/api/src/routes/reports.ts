import {
  type AgreementServiceReport,
  type AgreementServiceRow,
  type MarginFigures,
  type ProjectMarginReport,
  type ProjectMarginRow,
  type RmrFlag,
  type RmrGroup,
  type RmrReport,
  agreementServiceQuerySchema,
  dec,
  marginPct,
  projectMarginQuerySchema,
  rmrReportQuerySchema,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";

const OPERATING_TZ = "America/Indiana/Indianapolis";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: OPERATING_TZ }).format(new Date());
const money = (v: string | number | null | undefined) =>
  dec(v ?? 0)
    .toDecimalPlaces(2)
    .toFixed(2);

const figures = (revenue: string, cost: string): MarginFigures => ({
  revenue: money(revenue),
  cost: money(cost),
  margin: dec(revenue).minus(cost).toDecimalPlaces(2).toFixed(2),
  marginPct: marginPct(revenue, cost),
});

const addMonths = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Agreements in force on a date: started, not cancelled before it, and not past an end date without auto-renew.
 * The same rule as `agreementStatus` in shared/agreements.ts.
 */
const ACTIVE_AGREEMENT = `
  a.start_date <= $1::date
  AND (a.cancelled_date IS NULL OR a.cancelled_date >= $1::date)
  AND (a.end_date IS NULL OR a.end_date >= $1::date OR a.auto_renew)`;

/** Revenue, margin and cost reports. Read-only. Mounted under /api/v1/reports. */
export const reportRoutes: FastifyPluginAsync = async (app) => {
  // ---- Recurring revenue and margin ----
  app.get("/rmr", { config: { perm: "reports.read" } }, async (req) => {
    const qs = rmrReportQuerySchema.parse(req.query);
    const asOf = qs.asOf ?? today();
    const { rows } = await app.pool.query<{
      agreement_id: string;
      agreement: string;
      company_id: string;
      company: string;
      type_id: string;
      type: string;
      addition_id: string;
      description: string;
      vendor_id: string | null;
      vendor: string | null;
      revenue: string;
      cost: string;
    }>(
      `SELECT a.id AS agreement_id, a.name AS agreement, a.company_id, c.name AS company,
              a.type_id, ty.name::text AS type, x.id AS addition_id, x.description,
              x.vendor_company_id AS vendor_id, v.name AS vendor,
              round(x.quantity * x.unit_price, 2) AS revenue, round(x.quantity * x.unit_cost, 2) AS cost
         FROM billing.agreement a
         JOIN billing.agreement_type ty ON ty.id = a.type_id
         JOIN crm.company c ON c.id = a.company_id
         JOIN billing.agreement_addition x ON x.agreement_id = a.id
              AND x.effective_from <= $1::date AND (x.effective_to IS NULL OR x.effective_to >= $1::date)
         LEFT JOIN crm.company v ON v.id = x.vendor_company_id
        WHERE ${ACTIVE_AGREEMENT}
        ORDER BY a.id, x.id`,
      [asOf],
    );
    const active = await app.pool.query<{
      id: string;
      name: string;
      company_id: string;
      company: string;
    }>(
      `SELECT a.id, a.name, a.company_id, c.name AS company
         FROM billing.agreement a JOIN crm.company c ON c.id = a.company_id
        WHERE ${ACTIVE_AGREEMENT}
          AND NOT EXISTS (SELECT 1 FROM billing.agreement_addition x
                           WHERE x.agreement_id = a.id AND x.effective_from <= $1::date
                             AND (x.effective_to IS NULL OR x.effective_to >= $1::date))
        ORDER BY a.id`,
      [asOf],
    );
    const agreementCount = await app.pool.query<{ n: string; customers: string }>(
      `SELECT count(*) AS n, count(DISTINCT a.company_id) AS customers
         FROM billing.agreement a WHERE ${ACTIVE_AGREEMENT}`,
      [asOf],
    );

    const groupOf = (r: (typeof rows)[number]): { key: string; name: string } => {
      switch (qs.groupBy) {
        case "type":
          return { key: `t${r.type_id}`, name: r.type };
        case "vendor":
          return r.vendor_id
            ? { key: `v${r.vendor_id}`, name: r.vendor as string }
            : { key: "none", name: "No vendor recorded" };
        case "customer":
          return { key: `c${r.company_id}`, name: r.company };
        case "agreement":
          return { key: `a${r.agreement_id}`, name: `${r.agreement} (${r.company})` };
      }
    };

    const groups = new Map<
      string,
      { name: string; rev: string; cost: string; agreements: Set<string>; additions: number }
    >();
    const flags: RmrFlag[] = [];
    let totalRev = dec(0);
    let totalCost = dec(0);
    for (const r of rows) {
      totalRev = totalRev.plus(r.revenue);
      totalCost = totalCost.plus(r.cost);
      const g = groupOf(r);
      const cur = groups.get(g.key) ?? {
        name: g.name,
        rev: "0",
        cost: "0",
        agreements: new Set(),
        additions: 0,
      };
      cur.rev = dec(cur.rev).plus(r.revenue).toString();
      cur.cost = dec(cur.cost).plus(r.cost).toString();
      cur.agreements.add(r.agreement_id);
      cur.additions += 1;
      groups.set(g.key, cur);

      const pct = marginPct(r.revenue, r.cost);
      const rev = dec(r.revenue);
      const cost = dec(r.cost);
      let kind: RmrFlag["kind"] | null = null;
      if (rev.greaterThan(0) && cost.isZero()) kind = "no_cost";
      else if (cost.greaterThan(rev)) kind = "negative_margin";
      else if (pct !== null && pct < qs.floorPct) kind = "below_floor";
      if (kind)
        flags.push({
          kind,
          agreementId: Number(r.agreement_id),
          agreement: r.agreement,
          companyId: Number(r.company_id),
          company: r.company,
          description: r.description,
          vendor: r.vendor,
          revenue: money(r.revenue),
          cost: money(r.cost),
          marginPct: pct,
        });
    }
    for (const a of active.rows)
      flags.push({
        kind: "no_active_additions",
        agreementId: Number(a.id),
        agreement: a.name,
        companyId: Number(a.company_id),
        company: a.company,
        description: null,
        vendor: null,
        revenue: "0.00",
        cost: "0.00",
        marginPct: null,
      });

    const order: Record<RmrFlag["kind"], number> = {
      negative_margin: 0,
      no_cost: 1,
      below_floor: 2,
      no_active_additions: 3,
    };
    flags.sort(
      (a, b) =>
        order[a.kind] - order[b.kind] ||
        (a.marginPct ?? 0) - (b.marginPct ?? 0) ||
        a.agreementId - b.agreementId,
    );
    const MAX_FLAGS = 500;

    const out: RmrReport = {
      asOf,
      groupBy: qs.groupBy,
      floorPct: qs.floorPct,
      totals: {
        ...figures(totalRev.toString(), totalCost.toString()),
        agreements: Number(agreementCount.rows[0]?.n ?? 0),
        customers: Number(agreementCount.rows[0]?.customers ?? 0),
        additions: rows.length,
      },
      groups: [...groups.entries()]
        .map(
          ([key, g]): RmrGroup => ({
            key,
            name: g.name,
            ...figures(g.rev, g.cost),
            agreements: g.agreements.size,
            additions: g.additions,
          }),
        )
        .sort((a, b) => Number(b.revenue) - Number(a.revenue) || a.name.localeCompare(b.name)),
      flags: flags.slice(0, MAX_FLAGS),
      flagsTruncated: flags.length > MAX_FLAGS,
    };
    return out;
  });

  // ---- What each agreement really earns once service labor is counted ----
  app.get("/agreement-service", { config: { perm: "reports.read" } }, async (req) => {
    const qs = agreementServiceQuerySchema.parse(req.query);
    const to = qs.asOf ?? today();
    const from = addMonths(to, -qs.months);
    const { rows } = await app.pool.query<{
      id: string;
      name: string;
      company_id: string;
      company: string;
      type: string;
      billed: string;
      cost: string;
      hours: string;
      absorbed: string;
    }>(
      `WITH billed AS (
         SELECT l.agreement_id, sum(l.amount) AS billed, sum(l.cost_amount) AS cost
           FROM billing.invoice_line l JOIN billing.invoice i ON i.id = l.invoice_id
          WHERE l.kind = 'agreement' AND NOT l.is_void AND i.status NOT IN ('draft', 'void')
            AND l.period_start > $1::date AND l.period_start <= $2::date
          GROUP BY l.agreement_id),
       labor AS (
         SELECT COALESCE(e.agreement_id, t.agreement_id) AS agreement_id,
                sum(e.actual_hours) AS hours,
                COALESCE(sum(e.actual_hours * e.cost_rate) FILTER (WHERE e.status <> 'billed'), 0) AS absorbed
           FROM timekeeping.time_entry e LEFT JOIN service.ticket t ON t.id = e.ticket_id
          WHERE e.status <> 'void' AND e.work_date > $1::date AND e.work_date <= $2::date
            AND COALESCE(e.agreement_id, t.agreement_id) IS NOT NULL
          GROUP BY 1)
       SELECT a.id, a.name, a.company_id, c.name AS company, ty.name::text AS type,
              COALESCE(b.billed, 0) AS billed, COALESCE(b.cost, 0) AS cost,
              COALESCE(l.hours, 0) AS hours, COALESCE(l.absorbed, 0) AS absorbed
         FROM billing.agreement a
         JOIN billing.agreement_type ty ON ty.id = a.type_id
         JOIN crm.company c ON c.id = a.company_id
         LEFT JOIN billed b ON b.agreement_id = a.id
         LEFT JOIN labor l ON l.agreement_id = a.id
        WHERE b.agreement_id IS NOT NULL OR l.agreement_id IS NOT NULL
        ORDER BY a.id`,
      [from, to],
    );
    const mapped = rows.map((r): AgreementServiceRow => {
      const margin = dec(r.billed).minus(r.cost).minus(r.absorbed);
      return {
        agreementId: Number(r.id),
        agreement: r.name,
        companyId: Number(r.company_id),
        company: r.company,
        type: r.type,
        billed: money(r.billed),
        recurringCost: money(r.cost),
        hours: dec(r.hours).toDecimalPlaces(2).toFixed(2),
        absorbedLaborCost: money(r.absorbed),
        margin: margin.toDecimalPlaces(2).toFixed(2),
        marginPct: marginPct(r.billed, dec(r.cost).plus(r.absorbed).toString()),
      };
    });
    // Worst first: the agreements that lose the most money after labor.
    mapped.sort((a, b) => Number(a.margin) - Number(b.margin) || a.agreementId - b.agreementId);
    const sum = (f: (r: AgreementServiceRow) => string) =>
      mapped.reduce((s, r) => s.plus(f(r)), dec(0));
    const billed = sum((r) => r.billed);
    const cost = sum((r) => r.recurringCost);
    const absorbed = sum((r) => r.absorbedLaborCost);
    const out: AgreementServiceReport = {
      from,
      to,
      months: qs.months,
      rows: mapped,
      totals: {
        billed: money(billed.toString()),
        recurringCost: money(cost.toString()),
        absorbedLaborCost: money(absorbed.toString()),
        margin: billed.minus(cost).minus(absorbed).toDecimalPlaces(2).toFixed(2),
        marginPct: marginPct(billed.toString(), cost.plus(absorbed).toString()),
      },
    };
    return out;
  });

  // ---- Project margin ----
  app.get("/projects", { config: { perm: "reports.read" } }, async (req) => {
    const qs = projectMarginQuerySchema.parse(req.query);
    const where =
      qs.status === "active"
        ? "p.status NOT IN ('closed', 'canceled')"
        : qs.status === "closed"
          ? "p.status IN ('closed', 'canceled')"
          : "TRUE";
    const { rows } = await app.pool.query<{
      id: string;
      name: string;
      company_id: string;
      company: string;
      status: ProjectMarginRow["status"];
      billing_method: ProjectMarginRow["billingMethod"];
      billing_amount: string | null;
      budget_hours: string | null;
      invoiced: string;
      fee_billed: string;
      hours: string;
      labor_cost: string;
      material_cost: string;
      unbilled_labor: string;
      unbilled_materials: string;
    }>(
      `SELECT p.id, p.name, p.company_id, c.name AS company, p.status, p.billing_method, p.billing_amount,
              p.budget_hours,
              COALESCE((SELECT sum(l.amount) FROM billing.invoice_line l JOIN billing.invoice i ON i.id = l.invoice_id
                         WHERE l.project_id = p.id AND NOT l.is_void AND i.status NOT IN ('draft', 'void')), 0) AS invoiced,
              COALESCE((SELECT sum(l.amount) FROM billing.invoice_line l JOIN billing.invoice i ON i.id = l.invoice_id
                         WHERE l.project_id = p.id AND l.project_fee AND NOT l.is_void
                           AND i.status NOT IN ('draft', 'void')), 0) AS fee_billed,
              COALESCE((SELECT sum(e.actual_hours) FROM timekeeping.time_entry e JOIN service.ticket t ON t.id = e.ticket_id
                         WHERE t.project_id = p.id AND e.status <> 'void'), 0) AS hours,
              COALESCE((SELECT sum(e.actual_hours * e.cost_rate) FROM timekeeping.time_entry e
                         JOIN service.ticket t ON t.id = e.ticket_id
                         WHERE t.project_id = p.id AND e.status <> 'void'), 0) AS labor_cost,
              COALESCE((SELECT sum(ch.quantity * ch.unit_cost) FROM service.ticket_charge ch
                         JOIN service.ticket t ON t.id = ch.ticket_id WHERE t.project_id = p.id), 0) AS material_cost,
              COALESCE((SELECT sum(e.actual_hours * e.bill_rate) FROM timekeeping.time_entry e
                         JOIN service.ticket t ON t.id = e.ticket_id
                         WHERE t.project_id = p.id AND e.status NOT IN ('void', 'billed')
                           AND e.billable = 'billable'), 0) AS unbilled_labor,
              COALESCE((SELECT sum(ch.quantity * ch.unit_price) FROM service.ticket_charge ch
                         JOIN service.ticket t ON t.id = ch.ticket_id
                         WHERE t.project_id = p.id AND ch.invoice_id IS NULL AND ch.billable = 'billable'), 0) AS unbilled_materials
         FROM project.project p JOIN crm.company c ON c.id = p.company_id
        WHERE ${where}
        ORDER BY p.id DESC`,
    );
    const mapped = rows.map((r): ProjectMarginRow => {
      const cost = dec(r.labor_cost).plus(r.material_cost);
      const fixed =
        r.billing_method === "fixed_fee" &&
        r.billing_amount !== null &&
        Number(r.billing_amount) > 0;
      return {
        projectId: Number(r.id),
        project: r.name,
        companyId: Number(r.company_id),
        company: r.company,
        status: r.status,
        billingMethod: r.billing_method,
        fee: r.billing_amount,
        invoiced: money(r.invoiced),
        feeBilledPct: fixed
          ? dec(r.fee_billed)
              .div(r.billing_amount as string)
              .times(100)
              .toDecimalPlaces(1)
              .toNumber()
          : null,
        budgetHours: r.budget_hours,
        hours: dec(r.hours).toDecimalPlaces(2).toFixed(2),
        laborCost: money(r.labor_cost),
        materialCost: money(r.material_cost),
        cost: cost.toDecimalPlaces(2).toFixed(2),
        margin: dec(r.invoiced).minus(cost).toDecimalPlaces(2).toFixed(2),
        marginPct: marginPct(r.invoiced, cost.toString()),
        unbilledValue: dec(r.unbilled_labor)
          .plus(r.unbilled_materials)
          .toDecimalPlaces(2)
          .toFixed(2),
      };
    });
    const sum = (f: (r: ProjectMarginRow) => string) =>
      mapped.reduce((s, r) => s.plus(f(r)), dec(0));
    const invoiced = sum((r) => r.invoiced);
    const cost = sum((r) => r.cost);
    const out: ProjectMarginReport = {
      rows: mapped,
      totals: {
        invoiced: money(invoiced.toString()),
        cost: money(cost.toString()),
        margin: invoiced.minus(cost).toDecimalPlaces(2).toFixed(2),
        marginPct: marginPct(invoiced.toString(), cost.toString()),
        unbilledValue: money(sum((r) => r.unbilledValue).toString()),
      },
    };
    return out;
  });
};
