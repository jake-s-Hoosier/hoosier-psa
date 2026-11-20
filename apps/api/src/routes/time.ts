import { withActor } from "@hoosier/db";
import {
  DEFAULT_BILLING_ROUNDING,
  type RoundingRule,
  type TimeEntry,
  type WorkTypePricing,
  billedHours,
  idSchema,
  roundingRuleFor,
  timeEntryCreateSchema,
  timeEntryListQuerySchema,
  timerStartSchema,
  timerStopSchema,
  workTypeBillRate,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../errors.js";

interface TimeRow {
  id: string;
  member_id: string;
  company_id: string;
  ticket_id: string | null;
  work_role_id: string;
  work_type_id: string;
  work_date: string; // selected as text to avoid timezone shifts
  started_at: Date | null;
  ended_at: Date | null;
  is_timer: boolean;
  actual_hours: string;
  billed_hours: string;
  billable: string;
  bill_rate: string;
  status: string;
  notes: string | null;
}

const SELECT_TIME = `
  SELECT id, member_id, company_id, ticket_id, work_role_id, work_type_id,
         to_char(work_date, 'YYYY-MM-DD') AS work_date, started_at, ended_at, is_timer,
         actual_hours, billed_hours, billable, bill_rate, status, notes
    FROM timekeeping.time_entry`;

function toEntry(r: TimeRow): TimeEntry {
  return {
    id: Number(r.id),
    memberId: Number(r.member_id),
    companyId: Number(r.company_id),
    ticketId: r.ticket_id === null ? null : Number(r.ticket_id),
    workRoleId: Number(r.work_role_id),
    workTypeId: Number(r.work_type_id),
    workDate: r.work_date,
    startedAt: r.started_at?.toISOString() ?? null,
    endedAt: r.ended_at?.toISOString() ?? null,
    isTimer: r.is_timer,
    actualHours: Number(r.actual_hours),
    billedHours: Number(r.billed_hours),
    billable: r.billable,
    billRate: Number(r.bill_rate),
    status: r.status,
    notes: r.notes,
  };
}

/** Local date in the company's operating time zone (docs/04). */
const OPERATING_TZ = "America/Indiana/Indianapolis";
function localDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: OPERATING_TZ }).format(d);
}

/** Unrounded hours; callers round for storage but bill from the exact duration. */
function exactHoursBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / 3_600_000;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

interface PricingContext {
  billRate: number;
  costRate: number;
  rule: RoundingRule;
  billTime: "billable" | "do_not_bill" | "no_charge";
}

/**
 * Rates are snapshotted at write time (docs/04): the work type decides how the role rate is used
 * (multiplier, custom rate or adjustment); cost comes from the member. The work type also supplies
 * the minimum/maximum billable hours and its default billable setting.
 */
async function pricingFor(
  client: pg.PoolClient,
  memberId: number,
  workRoleId: number,
  workTypeId: number,
): Promise<PricingContext> {
  const role = await client.query<{ hourly_rate: string }>(
    "SELECT hourly_rate FROM catalog.work_role WHERE id = $1",
    [workRoleId],
  );
  const type = await client.query<{
    rate_type: WorkTypePricing["rateType"];
    rate_multiplier: string;
    custom_rate: string | null;
    rate_adjustment: string | null;
    hours_min: string;
    hours_max: string;
    round_billing_hours_to: string | null;
    bill_time: PricingContext["billTime"];
  }>(
    `SELECT rate_type, rate_multiplier, custom_rate, rate_adjustment, hours_min, hours_max,
            round_billing_hours_to, bill_time
       FROM catalog.work_type WHERE id = $1`,
    [workTypeId],
  );
  const r = role.rows[0];
  const t = type.rows[0];
  if (!r) throw new HttpError(422, "Invalid work role", `Work role ${workRoleId} not found`);
  if (!t) throw new HttpError(422, "Invalid work type", `Work type ${workTypeId} not found`);
  const pricing: WorkTypePricing = {
    rateType: t.rate_type,
    rateMultiplier: Number(t.rate_multiplier),
    customRate: t.custom_rate === null ? null : Number(t.custom_rate),
    rateAdjustment: t.rate_adjustment === null ? null : Number(t.rate_adjustment),
    hoursMin: Number(t.hours_min),
    hoursMax: Number(t.hours_max),
    roundBillingHoursTo:
      t.round_billing_hours_to === null ? null : Number(t.round_billing_hours_to),
  };
  const member = await client.query<{ hourly_cost: string | null }>(
    "SELECT hourly_cost FROM iam.member WHERE id = $1",
    [memberId],
  );
  return {
    billRate: workTypeBillRate(Number(r.hourly_rate), pricing),
    costRate: Number(member.rows[0]?.hourly_cost ?? 0),
    rule: roundingRuleFor(pricing, DEFAULT_BILLING_ROUNDING),
    billTime: t.bill_time,
  };
}

async function ticketCompany(client: pg.PoolClient, ticketId: number): Promise<number> {
  const { rows } = await client.query<{ company_id: string }>(
    "SELECT company_id FROM service.ticket WHERE id = $1",
    [ticketId],
  );
  if (!rows[0]) throw new HttpError(422, "Invalid ticket", `Ticket ${ticketId} not found`);
  return Number(rows[0].company_id);
}

async function periodIdFor(client: pg.PoolClient, workDate: string): Promise<number | null> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM timekeeping.pay_period WHERE $1::date BETWEEN start_date AND end_date",
    [workDate],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** Refuses to create time in a pay period that has been locked or exported. */
async function assertPeriodOpen(client: pg.PoolClient, periodId: number | null): Promise<void> {
  if (periodId === null) return;
  const { rows } = await client.query<{ status: string }>(
    "SELECT status FROM timekeeping.pay_period WHERE id = $1",
    [periodId],
  );
  if (rows[0] && rows[0].status !== "open") {
    throw new HttpError(
      409,
      "Pay period locked",
      `The pay period for that date is ${rows[0].status}`,
    );
  }
}

export const timeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { config: { perm: "timekeeping.time.read_own" } }, async (req) => {
    const q = timeEntryListQuerySchema.parse(req.query);
    const where: string[] = ["status <> 'void'"];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    // Own time by default; seeing anyone else's needs read_all.
    const canSeeAll = req.permissions.has("timekeeping.time.read_all");
    if (!canSeeAll && q.memberId && q.memberId !== req.memberId) {
      throw new HttpError(403, "Forbidden", "You can only view your own time entries");
    }
    if (!canSeeAll) add("member_id = ?", req.memberId);
    else if (q.memberId) add("member_id = ?", q.memberId);
    if (q.ticketId) add("ticket_id = ?", q.ticketId);
    if (q.companyId) add("company_id = ?", q.companyId);
    if (q.from) add("work_date >= ?::date", q.from);
    if (q.to) add("work_date <= ?::date", q.to);
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = await app.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM timekeeping.time_entry ${whereSql}`,
      params,
    );
    const rows = await app.pool.query<TimeRow>(
      `${SELECT_TIME} ${whereSql} ORDER BY work_date DESC, started_at DESC NULLS LAST, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.limit, q.offset],
    );
    return {
      items: rows.rows.map(toEntry),
      total: Number(total.rows[0]?.n ?? 0),
      limit: q.limit,
      offset: q.offset,
    };
  });

  app.get("/timer", { config: { perm: "timekeeping.time.write_own" } }, async (req) => {
    const { rows } = await app.pool.query<TimeRow>(
      `${SELECT_TIME} WHERE member_id = $1 AND is_timer AND ended_at IS NULL`,
      [req.memberId],
    );
    return { timer: rows[0] ? toEntry(rows[0]) : null };
  });

  app.post(
    "/timer/start",
    { config: { perm: "timekeeping.time.write_own" } },
    async (req, reply) => {
      const body = timerStartSchema.parse(req.body);
      const memberId = req.memberId as number;
      const entry = await withActor(app.pool, memberId, async (client) => {
        const companyId = await ticketCompany(client, body.ticketId);
        const pricing = await pricingFor(client, memberId, body.workRoleId, body.workTypeId);
        const now = new Date();
        const workDate = localDate(now);
        await assertPeriodOpen(client, await periodIdFor(client, workDate));
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO timekeeping.time_entry
           (member_id, company_id, charge_type, ticket_id, work_role_id, work_type_id, work_date,
            started_at, is_timer, bill_rate, cost_rate, notes, pay_period_id, billable)
         VALUES ($1,$2,'service_ticket',$3,$4,$5,$6,$7,true,$8,$9,$10,$11,$12) RETURNING id`,
          [
            memberId,
            companyId,
            body.ticketId,
            body.workRoleId,
            body.workTypeId,
            workDate,
            now,
            pricing.billRate,
            pricing.costRate,
            body.notes ?? null,
            await periodIdFor(client, workDate),
            pricing.billTime,
          ],
        );
        const full = await client.query<TimeRow>(`${SELECT_TIME} WHERE id = $1`, [rows[0]?.id]);
        return full.rows[0] as TimeRow;
      });
      return reply.status(201).send(toEntry(entry));
    },
  );

  app.post("/timer/stop", { config: { perm: "timekeeping.time.write_own" } }, async (req) => {
    const body = timerStopSchema.parse(req.body ?? {});
    const memberId = req.memberId as number;
    const entry = await withActor(app.pool, memberId, async (client) => {
      const { rows } = await client.query<TimeRow>(
        `${SELECT_TIME} WHERE member_id = $1 AND is_timer AND ended_at IS NULL FOR UPDATE`,
        [memberId],
      );
      const running = rows[0];
      if (!running?.started_at)
        throw new HttpError(409, "No running timer", "There is no timer to stop");
      const ended = new Date();
      // A timer that crossed local midnight is capped at 24h by the table; split handling is a later task.
      const exact = Math.min(exactHoursBetween(running.started_at, ended), 24);
      const actual = round2(exact);
      const pricing = await pricingFor(
        client,
        memberId,
        Number(running.work_role_id),
        Number(running.work_type_id),
      );
      const billed = running.billable === "billable" ? billedHours(exact, pricing.rule) : 0;
      await client.query(
        `UPDATE timekeeping.time_entry
            SET ended_at = $2, is_timer = false, actual_hours = $3, billed_hours = $4,
                notes = COALESCE($5, notes)
          WHERE id = $1`,
        [running.id, ended, actual, billed, body.notes ?? null],
      );
      const full = await client.query<TimeRow>(`${SELECT_TIME} WHERE id = $1`, [running.id]);
      return full.rows[0] as TimeRow;
    });
    return toEntry(entry);
  });

  app.post("/", { config: { perm: "timekeeping.time.write_own" } }, async (req, reply) => {
    const body = timeEntryCreateSchema.parse(req.body);
    const memberId = req.memberId as number;
    const entry = await withActor(app.pool, memberId, async (client) => {
      const companyId = await ticketCompany(client, body.ticketId);
      const pricing = await pricingFor(client, memberId, body.workRoleId, body.workTypeId);
      const billable = body.billable ?? pricing.billTime;
      const periodId = await periodIdFor(client, body.workDate);
      await assertPeriodOpen(client, periodId);
      const started = body.startedAt ? new Date(body.startedAt) : null;
      const ended = body.endedAt ? new Date(body.endedAt) : null;
      const exact = body.hours ?? exactHoursBetween(started as Date, ended as Date);
      if (exact > 24)
        throw new HttpError(422, "Invalid duration", "A single entry cannot exceed 24 hours");
      const actual = round2(exact);
      const billed = billable === "billable" ? billedHours(exact, pricing.rule) : 0;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO timekeeping.time_entry
           (member_id, company_id, charge_type, ticket_id, work_role_id, work_type_id, work_date,
            started_at, ended_at, actual_hours, billed_hours, billable, bill_rate, cost_rate,
            notes, internal_notes, pay_period_id)
         VALUES ($1,$2,'service_ticket',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id`,
        [
          memberId,
          companyId,
          body.ticketId,
          body.workRoleId,
          body.workTypeId,
          body.workDate,
          started,
          ended,
          actual,
          billed,
          billable,
          pricing.billRate,
          pricing.costRate,
          body.notes ?? null,
          body.internalNotes ?? null,
          periodId,
        ],
      );
      const full = await client.query<TimeRow>(`${SELECT_TIME} WHERE id = $1`, [rows[0]?.id]);
      return full.rows[0] as TimeRow;
    });
    return reply
      .status(201)
      .header("location", `/api/v1/time-entries/${entry.id}`)
      .send(toEntry(entry));
  });

  /** Voiding keeps the row for the audit trail; hard deletes of time are not offered. */
  app.delete("/:id", { config: { perm: "timekeeping.time.write_own" } }, async (req, reply) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const memberId = req.memberId as number;
    await withActor(app.pool, memberId, async (client) => {
      const { rows } = await client.query<{ member_id: string; status: string }>(
        "SELECT member_id, status FROM timekeeping.time_entry WHERE id = $1 FOR UPDATE",
        [id],
      );
      const row = rows[0];
      if (!row || row.status === "void")
        throw new HttpError(404, "Not Found", `Time entry ${id} not found`);
      // Anyone with write_own removes their own; removing someone else's needs write_all.
      if (
        Number(row.member_id) !== memberId &&
        !req.permissions.has("timekeeping.time.write_all")
      ) {
        throw new HttpError(403, "Forbidden", "You can only remove your own time entries");
      }
      await client.query(
        "UPDATE timekeeping.time_entry SET status = 'void', is_timer = false WHERE id = $1",
        [id],
      );
    });
    return reply.status(204).send();
  });
};
