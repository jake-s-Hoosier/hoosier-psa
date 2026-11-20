import { withActor } from "@hoosier/db";
import {
  type Agreement,
  type AgreementAddition,
  type AgreementDetail,
  type AgreementType,
  addDaysIso,
  additionChangeSchema,
  additionCreateSchema,
  additionEditSchema,
  additionEndSchema,
  agreementCancelSchema,
  agreementCreateSchema,
  agreementListQuerySchema,
  agreementTypeInputSchema,
  agreementUpdateSchema,
  idSchema,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../errors.js";

const OPERATING_TZ = "America/Indiana/Indianapolis";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: OPERATING_TZ }).format(new Date());

interface AgreementRow {
  id: string;
  name: string;
  company_id: string;
  company: string;
  bill_to_company_id: string;
  bill_to_company: string;
  type_id: string;
  type: string;
  status: Agreement["status"];
  start_date: string;
  end_date: string | null;
  auto_renew: boolean;
  renewal_notice_days: number;
  cancelled_date: string | null;
  cancel_reason: string | null;
  bill_cycle: Agreement["billCycle"];
  bill_start_date: string;
  coverage: Agreement["coverage"];
  block_hours: string | null;
  po_number: string | null;
  notes: string | null;
  rmr: string;
  monthly_cost: string;
}

/**
 * Status is computed in SQL with the same rules as agreementStatus() in shared, so a list can be
 * filtered and paged by it; a test keeps the two in step. :today is parameter $1.
 */
const STATUS_SQL = `CASE
    WHEN a.cancelled_date IS NOT NULL AND a.cancelled_date < $1::date THEN 'cancelled'
    WHEN a.start_date > $1::date THEN 'pending'
    WHEN a.end_date IS NOT NULL AND a.end_date < $1::date AND NOT a.auto_renew THEN 'expired'
    ELSE 'active' END`;

const SELECT_AGREEMENT = `
  SELECT a.id, a.name, a.company_id, c.name AS company, a.bill_to_company_id, bc.name AS bill_to_company,
         a.type_id, t.name::text AS type, ${STATUS_SQL} AS status,
         to_char(a.start_date, 'YYYY-MM-DD') AS start_date, to_char(a.end_date, 'YYYY-MM-DD') AS end_date,
         a.auto_renew, a.renewal_notice_days,
         to_char(a.cancelled_date, 'YYYY-MM-DD') AS cancelled_date, a.cancel_reason,
         a.bill_cycle, to_char(a.bill_start_date, 'YYYY-MM-DD') AS bill_start_date,
         a.coverage, a.block_hours, a.po_number, a.notes,
         COALESCE((SELECT sum(round(x.quantity * x.unit_price, 2)) FROM billing.agreement_addition x
                    WHERE x.agreement_id = a.id AND x.effective_from <= $1::date
                      AND (x.effective_to IS NULL OR x.effective_to >= $1::date)), 0)::text AS rmr,
         COALESCE((SELECT sum(round(x.quantity * x.unit_cost, 2)) FROM billing.agreement_addition x
                    WHERE x.agreement_id = a.id AND x.effective_from <= $1::date
                      AND (x.effective_to IS NULL OR x.effective_to >= $1::date)), 0)::text AS monthly_cost
    FROM billing.agreement a
    JOIN crm.company c ON c.id = a.company_id
    JOIN crm.company bc ON bc.id = a.bill_to_company_id
    JOIN billing.agreement_type t ON t.id = a.type_id`;

function toAgreement(r: AgreementRow): Agreement {
  return {
    id: Number(r.id),
    name: r.name,
    companyId: Number(r.company_id),
    company: r.company,
    billToCompanyId: Number(r.bill_to_company_id),
    billToCompany: r.bill_to_company,
    typeId: Number(r.type_id),
    type: r.type,
    status: r.status,
    startDate: r.start_date,
    endDate: r.end_date,
    autoRenew: r.auto_renew,
    renewalNoticeDays: r.renewal_notice_days,
    cancelledDate: r.cancelled_date,
    cancelReason: r.cancel_reason,
    billCycle: r.bill_cycle,
    billStartDate: r.bill_start_date,
    coverage: r.coverage,
    blockHours: r.block_hours === null ? null : Number(r.block_hours),
    poNumber: r.po_number,
    notes: r.notes,
    rmr: Number(r.rmr).toFixed(2),
    monthlyCost: Number(r.monthly_cost).toFixed(2),
  };
}

interface AdditionRow {
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
  vendor_company_id: string | null;
  vendor: string | null;
}

const SELECT_ADDITION = `
  SELECT x.id, x.agreement_id, x.product_id, x.description, x.quantity, x.unit_price, x.unit_cost,
         to_char(x.effective_from, 'YYYY-MM-DD') AS effective_from,
         to_char(x.effective_to, 'YYYY-MM-DD') AS effective_to,
         x.prorate, x.vendor_company_id, v.name AS vendor
    FROM billing.agreement_addition x
    LEFT JOIN crm.company v ON v.id = x.vendor_company_id`;

const toAddition = (r: AdditionRow): AgreementAddition => ({
  id: Number(r.id),
  agreementId: Number(r.agreement_id),
  productId: r.product_id === null ? null : Number(r.product_id),
  description: r.description,
  quantity: Number(r.quantity),
  unitPrice: Number(r.unit_price),
  unitCost: Number(r.unit_cost),
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  prorate: r.prorate,
  vendorCompanyId: r.vendor_company_id === null ? null : Number(r.vendor_company_id),
  vendor: r.vendor,
});

type Db = pg.Pool | pg.PoolClient;

async function loadAgreement(db: Db, id: number): Promise<Agreement> {
  const { rows } = await db.query<AgreementRow>(`${SELECT_AGREEMENT} WHERE a.id = $2`, [
    today(),
    id,
  ]);
  if (!rows[0]) throw new HttpError(404, "Not Found", `Agreement ${id} not found`);
  return toAgreement(rows[0]);
}

async function loadAdditions(db: Db, agreementId: number): Promise<AgreementAddition[]> {
  const { rows } = await db.query<AdditionRow>(
    `${SELECT_ADDITION} WHERE x.agreement_id = $1 ORDER BY x.effective_from DESC, x.id DESC`,
    [agreementId],
  );
  return rows.map(toAddition);
}

async function mustExistCompany(db: Db, id: number, what: string): Promise<void> {
  const { rowCount } = await db.query(
    "SELECT 1 FROM crm.company WHERE id = $1 AND deleted_at IS NULL",
    [id],
  );
  if (!rowCount) throw new HttpError(422, `Invalid ${what}`, `Company ${id} not found`);
}

async function loadAddition(db: Db, agreementId: number, id: number): Promise<AgreementAddition> {
  const { rows } = await db.query<AdditionRow>(
    `${SELECT_ADDITION} WHERE x.id = $1 AND x.agreement_id = $2`,
    [id, agreementId],
  );
  if (!rows[0]) throw new HttpError(404, "Not Found", `Addition ${id} not found on this agreement`);
  return toAddition(rows[0]);
}

export const agreementRoutes: FastifyPluginAsync = async (app) => {
  // ---- agreement types ----
  app.get("/types", { config: { perm: "billing.agreement.read" } }, async () => {
    const { rows } = await app.pool.query<{
      id: string;
      name: string;
      bill_cycle: AgreementType["billCycle"];
      coverage: AgreementType["coverage"];
      auto_renew: boolean;
      is_active: boolean;
    }>(
      "SELECT id, name::text, bill_cycle, coverage, auto_renew, is_active FROM billing.agreement_type ORDER BY name",
    );
    return {
      items: rows.map(
        (r): AgreementType => ({
          id: Number(r.id),
          name: r.name,
          billCycle: r.bill_cycle,
          coverage: r.coverage,
          autoRenew: r.auto_renew,
          isActive: r.is_active,
        }),
      ),
    };
  });

  app.post("/types", { config: { perm: "billing.agreement.write" } }, async (req, reply) => {
    const body = agreementTypeInputSchema.parse(req.body);
    if (!body.name) throw new HttpError(400, "Bad Request", "A name is required");
    const id = await withActor(app.pool, req.memberId, async (client) => {
      try {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO billing.agreement_type (name, bill_cycle, coverage, auto_renew)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [body.name, body.billCycle ?? "monthly", body.coverage ?? "none", body.autoRenew ?? true],
        );
        return Number(rows[0]?.id);
      } catch (e) {
        if ((e as { code?: string }).code === "23505")
          throw new HttpError(409, "Duplicate", "An agreement type with that name already exists");
        throw e;
      }
    });
    return reply.status(201).send({ id });
  });

  app.patch("/types/:id", { config: { perm: "billing.agreement.write" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = agreementTypeInputSchema.parse(req.body);
    await withActor(app.pool, req.memberId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE billing.agreement_type SET
            name = COALESCE($2, name), bill_cycle = COALESCE($3, bill_cycle),
            coverage = COALESCE($4, coverage), auto_renew = COALESCE($5, auto_renew),
            is_active = COALESCE($6, is_active)
          WHERE id = $1`,
        [
          id,
          body.name ?? null,
          body.billCycle ?? null,
          body.coverage ?? null,
          body.autoRenew ?? null,
          body.isActive ?? null,
        ],
      );
      if (!rowCount) throw new HttpError(404, "Not Found", `Agreement type ${id} not found`);
    });
    return { id };
  });

  // ---- agreements ----
  app.get("/", { config: { perm: "billing.agreement.read" } }, async (req) => {
    const q = agreementListQuerySchema.parse(req.query);
    const params: unknown[] = [today()];
    const where: string[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replaceAll("?", `$${params.length}`));
    };
    if (q.status !== "all") add(`${STATUS_SQL} = ?`, q.status);
    if (q.companyId) add("(a.company_id = ? OR a.bill_to_company_id = ?)", q.companyId);
    if (q.typeId) add("a.type_id = ?", q.typeId);
    if (q.q) add("(a.name ILIKE '%' || ? || '%' OR c.name ILIKE '%' || ? || '%')", q.q);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = await app.pool.query<{ n: string }>(
      `SELECT count(*) FILTER (WHERE $1::date IS NOT NULL) AS n
         FROM billing.agreement a JOIN crm.company c ON c.id = a.company_id ${whereSql}`,
      params,
    );
    const rows = await app.pool.query<AgreementRow>(
      `${SELECT_AGREEMENT} ${whereSql} ORDER BY c.name, a.name
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.limit, q.offset],
    );
    return {
      items: rows.rows.map(toAgreement),
      total: Number(total.rows[0]?.n ?? 0),
      limit: q.limit,
      offset: q.offset,
    };
  });

  app.get("/:id", { config: { perm: "billing.agreement.read" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const agreement = await loadAgreement(app.pool, id);
    const additions = await loadAdditions(app.pool, id);
    const expense = await app.pool.query<{ hours: string; cost: string; tickets: string }>(
      `SELECT COALESCE(sum(te.actual_hours), 0) AS hours,
              COALESCE(sum(te.actual_hours * te.cost_rate), 0) AS cost,
              (SELECT count(*) FROM service.ticket WHERE agreement_id = $1) AS tickets
         FROM timekeeping.time_entry te
         JOIN service.ticket t ON t.id = te.ticket_id
        WHERE t.agreement_id = $1 AND te.status <> 'void'`,
      [id],
    );
    const e = expense.rows[0];
    const detail: AgreementDetail = {
      ...agreement,
      additions,
      serviceHours: Number(e?.hours ?? 0),
      serviceCost: Number(Number(e?.cost ?? 0).toFixed(2)),
      ticketCount: Number(e?.tickets ?? 0),
    };
    return detail;
  });

  app.post("/", { config: { perm: "billing.agreement.write" } }, async (req, reply) => {
    const body = agreementCreateSchema.parse(req.body);
    const id = await withActor(app.pool, req.memberId, async (client) => {
      await mustExistCompany(client, body.companyId, "company");
      const billTo = body.billToCompanyId ?? body.companyId;
      if (billTo !== body.companyId) await mustExistCompany(client, billTo, "bill-to company");
      const type = await client.query<{
        bill_cycle: string;
        coverage: string;
        auto_renew: boolean;
      }>("SELECT bill_cycle, coverage, auto_renew FROM billing.agreement_type WHERE id = $1", [
        body.typeId,
      ]);
      const t = type.rows[0];
      if (!t) throw new HttpError(422, "Invalid agreement type", `Type ${body.typeId} not found`);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO billing.agreement
           (company_id, bill_to_company_id, type_id, name, start_date, end_date, auto_renew,
            renewal_notice_days, bill_cycle, bill_start_date, coverage, block_hours, po_number, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [
          body.companyId,
          billTo,
          body.typeId,
          body.name,
          body.startDate,
          body.endDate ?? null,
          body.autoRenew ?? t.auto_renew,
          body.renewalNoticeDays ?? 60,
          body.billCycle ?? t.bill_cycle,
          body.billStartDate ?? body.startDate,
          body.coverage ?? t.coverage,
          body.blockHours ?? null,
          body.poNumber ?? null,
          body.notes ?? null,
        ],
      );
      return Number(rows[0]?.id);
    });
    return reply
      .status(201)
      .header("location", `/api/v1/agreements/${id}`)
      .send(await loadAgreement(app.pool, id));
  });

  app.patch("/:id", { config: { perm: "billing.agreement.write" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = agreementUpdateSchema.parse(req.body);
    await withActor(app.pool, req.memberId, async (client) => {
      const cur = await client.query<{ start_date: string; end_date: string | null }>(
        `SELECT to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date
           FROM billing.agreement WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const c = cur.rows[0];
      if (!c) throw new HttpError(404, "Not Found", `Agreement ${id} not found`);
      const start = body.startDate ?? c.start_date;
      const end = body.endDate === undefined ? c.end_date : body.endDate;
      if (end !== null && end < start)
        throw new HttpError(422, "Invalid dates", "The end date cannot be before the start date");
      if (body.billToCompanyId !== undefined)
        await mustExistCompany(client, body.billToCompanyId, "bill-to company");
      if (body.typeId !== undefined) {
        const t = await client.query("SELECT 1 FROM billing.agreement_type WHERE id = $1", [
          body.typeId,
        ]);
        if (!t.rowCount)
          throw new HttpError(422, "Invalid agreement type", `Type ${body.typeId} not found`);
      }
      const cols: Record<string, unknown> = {
        bill_to_company_id: body.billToCompanyId,
        type_id: body.typeId,
        name: body.name,
        start_date: body.startDate,
        end_date: body.endDate,
        auto_renew: body.autoRenew,
        renewal_notice_days: body.renewalNoticeDays,
        bill_cycle: body.billCycle,
        bill_start_date: body.billStartDate,
        coverage: body.coverage,
        block_hours: body.blockHours,
        po_number: body.poNumber,
        notes: body.notes,
      };
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [col, v] of Object.entries(cols)) {
        if (v === undefined) continue;
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
      await client.query(`UPDATE billing.agreement SET ${sets.join(", ")} WHERE id = $1`, params);
    });
    return loadAgreement(app.pool, id);
  });

  /** The cancellation date is the last day of coverage: lines end on it, history stays. */
  app.post("/:id/cancel", { config: { perm: "billing.agreement.write" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = agreementCancelSchema.parse(req.body);
    await withActor(app.pool, req.memberId, async (client) => {
      const cur = await client.query<{ start_date: string; cancelled_date: string | null }>(
        `SELECT to_char(start_date, 'YYYY-MM-DD') AS start_date,
                to_char(cancelled_date, 'YYYY-MM-DD') AS cancelled_date
           FROM billing.agreement WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const c = cur.rows[0];
      if (!c) throw new HttpError(404, "Not Found", `Agreement ${id} not found`);
      if (c.cancelled_date !== null)
        throw new HttpError(409, "Already cancelled", `Cancelled on ${c.cancelled_date}`);
      if (body.date < c.start_date)
        throw new HttpError(422, "Invalid date", "Cannot cancel before the agreement starts");
      // Lines that would start after the last day of coverage: drop those that never took effect,
      // refuse when one already did (it cannot be ended before it began).
      const late = await client.query<{ id: string; effective_from: string }>(
        `SELECT id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from
           FROM billing.agreement_addition WHERE agreement_id = $1 AND effective_from > $2`,
        [id, body.date],
      );
      if (late.rows.some((r) => r.effective_from <= today())) {
        throw new HttpError(
          422,
          "Line already in effect",
          "A recurring line started after that date; choose a later cancellation date",
        );
      }
      for (const r of late.rows)
        await client.query("DELETE FROM billing.agreement_addition WHERE id = $1", [r.id]);
      await client.query(
        "UPDATE billing.agreement SET cancelled_date = $2, cancel_reason = $3 WHERE id = $1",
        [id, body.date, body.reason],
      );
      await client.query(
        `UPDATE billing.agreement_addition SET effective_to = $2
          WHERE agreement_id = $1 AND (effective_to IS NULL OR effective_to > $2)`,
        [id, body.date],
      );
    });
    return loadAgreement(app.pool, id);
  });

  // ---- additions ----
  app.post(
    "/:id/additions",
    { config: { perm: "billing.agreement.write" } },
    async (req, reply) => {
      const { id } = z.object({ id: idSchema }).parse(req.params);
      const body = additionCreateSchema.parse(req.body);
      const additionId = await withActor(app.pool, req.memberId, async (client) => {
        const a = await client.query("SELECT 1 FROM billing.agreement WHERE id = $1", [id]);
        if (!a.rowCount) throw new HttpError(404, "Not Found", `Agreement ${id} not found`);
        if (body.productId !== undefined) {
          const p = await client.query("SELECT 1 FROM catalog.product WHERE id = $1", [
            body.productId,
          ]);
          if (!p.rowCount)
            throw new HttpError(422, "Invalid product", `Product ${body.productId} not found`);
        }
        if (body.vendorCompanyId !== undefined)
          await mustExistCompany(client, body.vendorCompanyId, "vendor");
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO billing.agreement_addition
           (agreement_id, product_id, description, quantity, unit_price, unit_cost, effective_from,
            effective_to, prorate, vendor_company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [
            id,
            body.productId ?? null,
            body.description,
            body.quantity,
            body.unitPrice,
            body.unitCost,
            body.effectiveFrom,
            body.effectiveTo ?? null,
            body.prorate,
            body.vendorCompanyId ?? null,
          ],
        );
        return Number(rows[0]?.id);
      });
      return reply.status(201).send(await loadAddition(app.pool, id, additionId));
    },
  );

  /** Description, proration flag and vendor only; price and quantity change through /change. */
  app.patch(
    "/:id/additions/:additionId",
    { config: { perm: "billing.agreement.write" } },
    async (req) => {
      const { id, additionId } = z.object({ id: idSchema, additionId: idSchema }).parse(req.params);
      const body = additionEditSchema.parse(req.body);
      await withActor(app.pool, req.memberId, async (client) => {
        await loadAddition(client, id, additionId);
        if (body.vendorCompanyId) await mustExistCompany(client, body.vendorCompanyId, "vendor");
        await client.query(
          `UPDATE billing.agreement_addition SET
              description = COALESCE($2, description), prorate = COALESCE($3, prorate),
              vendor_company_id = CASE WHEN $4 THEN $5 ELSE vendor_company_id END
            WHERE id = $1`,
          [
            additionId,
            body.description ?? null,
            body.prorate ?? null,
            body.vendorCompanyId !== undefined,
            body.vendorCompanyId ?? null,
          ],
        );
      });
      return loadAddition(app.pool, id, additionId);
    },
  );

  /** Closes the line on the given date. Ending it before it starts is refused. */
  app.post(
    "/:id/additions/:additionId/end",
    { config: { perm: "billing.agreement.write" } },
    async (req) => {
      const { id, additionId } = z.object({ id: idSchema, additionId: idSchema }).parse(req.params);
      const body = additionEndSchema.parse(req.body);
      await withActor(app.pool, req.memberId, async (client) => {
        const cur = await loadAddition(client, id, additionId);
        if (body.date < cur.effectiveFrom)
          throw new HttpError(422, "Invalid date", "A line cannot end before it starts");
        await client.query(
          "UPDATE billing.agreement_addition SET effective_to = $2 WHERE id = $1",
          [additionId, body.date],
        );
      });
      return loadAddition(app.pool, id, additionId);
    },
  );

  /** A price or quantity change: close the line the day before, open a new one from the date. */
  app.post(
    "/:id/additions/:additionId/change",
    { config: { perm: "billing.agreement.write" } },
    async (req, reply) => {
      const { id, additionId } = z.object({ id: idSchema, additionId: idSchema }).parse(req.params);
      const body = additionChangeSchema.parse(req.body);
      const newId = await withActor(app.pool, req.memberId, async (client) => {
        const cur = await loadAddition(client, id, additionId);
        if (body.effectiveFrom <= cur.effectiveFrom)
          throw new HttpError(
            422,
            "Invalid date",
            "The change must start after the current line starts",
          );
        if (cur.effectiveTo !== null && cur.effectiveTo < body.effectiveFrom)
          throw new HttpError(409, "Line already ended", "That line ended before the change date");
        await client.query(
          "UPDATE billing.agreement_addition SET effective_to = $2 WHERE id = $1",
          [additionId, addDaysIso(body.effectiveFrom, -1)],
        );
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO billing.agreement_addition
             (agreement_id, product_id, description, quantity, unit_price, unit_cost, effective_from,
              effective_to, prorate, vendor_company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [
            id,
            cur.productId,
            cur.description,
            body.quantity ?? cur.quantity,
            body.unitPrice ?? cur.unitPrice,
            body.unitCost ?? cur.unitCost,
            body.effectiveFrom,
            cur.effectiveTo,
            cur.prorate,
            cur.vendorCompanyId,
          ],
        );
        return Number(rows[0]?.id);
      });
      return reply.status(201).send(await loadAddition(app.pool, id, newId));
    },
  );
};
