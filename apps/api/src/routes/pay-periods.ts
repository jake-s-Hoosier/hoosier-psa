import { withActor } from "@hoosier/db";
import {
  type PayPeriod,
  type PayrollRow,
  buildPayrollRow,
  idSchema,
  lastDayOfMonth,
  payPeriodGenerateSchema,
  payrollCsv,
  workweekFor,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../errors.js";

interface PeriodRow {
  id: string;
  start_date: string;
  end_date: string;
  pay_date: string | null;
  status: "open" | "locked" | "exported";
  locked_at: Date | null;
  exported_at: Date | null;
}

const SELECT_PERIOD = `
  SELECT id, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
         to_char(pay_date, 'YYYY-MM-DD') AS pay_date, status, locked_at, exported_at
    FROM timekeeping.pay_period`;

function toPeriod(r: PeriodRow): PayPeriod {
  return {
    id: Number(r.id),
    startDate: r.start_date,
    endDate: r.end_date,
    payDate: r.pay_date,
    status: r.status,
    lockedAt: r.locked_at?.toISOString() ?? null,
    exportedAt: r.exported_at?.toISOString() ?? null,
  };
}

async function loadPeriod(
  db: pg.Pool | pg.PoolClient,
  id: number,
  lock = false,
): Promise<PeriodRow> {
  const { rows } = await db.query<PeriodRow>(
    `${SELECT_PERIOD} WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, "Not Found", `Pay period ${id} not found`);
  return row;
}

/**
 * Payroll lines for a period. Worked hours come from submitted, approved and billed time (actual
 * hours, regardless of billable status); overtime needs the whole workweek, so days in the
 * neighbouring period are read too. Paid leave is read for the period itself.
 */
async function payrollRows(db: pg.Pool | pg.PoolClient, period: PeriodRow): Promise<PayrollRow[]> {
  const from = workweekFor(period.start_date).start;
  const to = workweekFor(period.end_date).end;
  const worked = await db.query<{
    member_id: string;
    identifier: string;
    name: string;
    d: string;
    h: string;
  }>(
    `SELECT te.member_id, m.identifier, m.first_name || ' ' || m.last_name AS name,
            to_char(te.work_date, 'YYYY-MM-DD') AS d, sum(te.actual_hours) AS h
       FROM timekeeping.time_entry te JOIN iam.member m ON m.id = te.member_id
      WHERE te.work_date BETWEEN $1 AND $2 AND te.status IN ('submitted', 'approved', 'billed')
      GROUP BY te.member_id, m.identifier, m.first_name, m.last_name, te.work_date`,
    [from, to],
  );
  const leave = await db.query<{
    member_id: string;
    identifier: string;
    name: string;
    d: string;
    hours: string;
    leave_type: string;
  }>(
    `SELECT l.member_id, m.identifier, m.first_name || ' ' || m.last_name AS name,
            to_char(l.leave_date, 'YYYY-MM-DD') AS d, l.hours, l.leave_type
       FROM timekeeping.leave_entry l JOIN iam.member m ON m.id = l.member_id
      WHERE l.leave_date BETWEEN $1 AND $2 AND l.status = 'approved' AND l.leave_type <> 'unpaid'`,
    [period.start_date, period.end_date],
  );

  const members = new Map<
    number,
    {
      identifier: string;
      name: string;
      worked: { date: string; hours: number }[];
      leave: { date: string; hours: number; type: "pto" | "holiday" | "sick" | "other" }[];
    }
  >();
  const entryFor = (id: string, identifier: string, name: string) => {
    const key = Number(id);
    let m = members.get(key);
    if (!m) {
      m = { identifier, name, worked: [], leave: [] };
      members.set(key, m);
    }
    return m;
  };
  for (const r of worked.rows)
    entryFor(r.member_id, r.identifier, r.name).worked.push({ date: r.d, hours: Number(r.h) });
  for (const r of leave.rows) {
    entryFor(r.member_id, r.identifier, r.name).leave.push({
      date: r.d,
      hours: Number(r.hours),
      type: r.leave_type as "pto" | "holiday" | "sick" | "other",
    });
  }

  const period_ = { start: period.start_date, end: period.end_date };
  return [...members.entries()]
    .map(([memberId, m]) => buildPayrollRow({ memberId, ...m }, period_))
    .filter(
      (r) =>
        r.workedInPeriod !== 0 ||
        r.regularHours !== 0 ||
        r.ptoHours + r.holidayHours + r.sickHours + r.otherLeaveHours !== 0,
    )
    .sort((a, b) => a.identifier.localeCompare(b.identifier));
}

export const payPeriodRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async () => {
    const { rows } = await app.pool.query<PeriodRow>(
      `${SELECT_PERIOD} ORDER BY start_date DESC LIMIT 100`,
    );
    return { items: rows.map(toPeriod) };
  });

  /** Creates the two semi-monthly periods for a month (1-15 and 16-end). Existing ones are kept. */
  app.post("/generate", async (req, reply) => {
    const { year, month } = payPeriodGenerateSchema.parse(req.body);
    const mm = String(month).padStart(2, "0");
    const last = lastDayOfMonth(year, month);
    const ranges = [
      [`${year}-${mm}-01`, `${year}-${mm}-15`],
      [`${year}-${mm}-16`, `${year}-${mm}-${String(last).padStart(2, "0")}`],
    ] as const;
    const items = await withActor(app.pool, req.memberId, async (client) => {
      const out: PeriodRow[] = [];
      for (const [start, end] of ranges) {
        const existing = await client.query<PeriodRow>(
          `${SELECT_PERIOD} WHERE start_date = $1 AND end_date = $2`,
          [start, end],
        );
        if (existing.rows[0]) {
          out.push(existing.rows[0]);
          continue;
        }
        const overlap = await client.query(
          "SELECT 1 FROM timekeeping.pay_period WHERE daterange(start_date, end_date, '[]') && daterange($1::date, $2::date, '[]')",
          [start, end],
        );
        if (overlap.rowCount) {
          throw new HttpError(
            409,
            "Overlapping period",
            `A different pay period already overlaps ${start} to ${end}`,
          );
        }
        const { rows } = await client.query<PeriodRow>(
          `INSERT INTO timekeeping.pay_period (start_date, end_date) VALUES ($1, $2)
           RETURNING id, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
                     to_char(pay_date, 'YYYY-MM-DD') AS pay_date, status, locked_at, exported_at`,
          [start, end],
        );
        out.push(rows[0] as PeriodRow);
      }
      return out;
    });
    return reply.status(201).send({ items: items.map(toPeriod) });
  });

  /** Review table: works for any status, so a period can be previewed before it is locked. */
  app.get("/:id/payroll", async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const period = await loadPeriod(app.pool, id);
    const open = await app.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM timekeeping.time_entry
        WHERE work_date BETWEEN $1 AND $2 AND status = 'open'`,
      [period.start_date, period.end_date],
    );
    const rows = await payrollRows(app.pool, period);
    return {
      period: toPeriod(period),
      unsubmittedEntries: Number(open.rows[0]?.n),
      items: rows,
      warnings: rows.flatMap((r) => r.warnings.map((w) => `${r.identifier}: ${w}`)),
    };
  });

  /**
   * Locks the period: every entry must be submitted or approved (no open entries, no running timer).
   * Entries are stamped with the period and become immutable (database guard).
   */
  app.post("/:id/lock", async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const locked = await withActor(app.pool, req.memberId, async (client) => {
      const period = await loadPeriod(client, id, true);
      if (period.status !== "open") {
        throw new HttpError(409, "Not open", `The pay period is already ${period.status}`);
      }
      const open = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM timekeeping.time_entry
          WHERE work_date BETWEEN $1 AND $2 AND status = 'open'`,
        [period.start_date, period.end_date],
      );
      if (Number(open.rows[0]?.n) > 0) {
        throw new HttpError(
          409,
          "Unsubmitted time",
          `${open.rows[0]?.n} time entries in this period are still open (not submitted)`,
        );
      }
      // Stamping billed entries needs the audited override; scoped to this single statement.
      await client.query("SELECT set_config('app.allow_locked_edit', 'on', true)");
      await client.query(
        `UPDATE timekeeping.time_entry SET pay_period_id = $1
          WHERE work_date BETWEEN $2 AND $3 AND status <> 'void'`,
        [id, period.start_date, period.end_date],
      );
      await client.query("SELECT set_config('app.allow_locked_edit', '', true)");
      await client.query(
        "UPDATE timekeeping.pay_period SET status = 'locked', locked_at = now() WHERE id = $1",
        [id],
      );
      return loadPeriod(client, id);
    });
    return toPeriod(locked);
  });

  /**
   * Produces the payroll file. The first export marks the period exported; later calls return the same
   * figures (time in a locked period cannot change). `format=csv` returns the file, default JSON.
   */
  app.post("/:id/export", async (req, reply) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const { format } = z
      .object({ format: z.enum(["json", "csv"]).default("json") })
      .parse(req.query);
    const { period, rows } = await withActor(app.pool, req.memberId, async (client) => {
      let p = await loadPeriod(client, id, true);
      if (p.status === "open") {
        throw new HttpError(409, "Not locked", "Lock the pay period before exporting payroll");
      }
      if (p.status === "locked") {
        await client.query(
          "UPDATE timekeeping.pay_period SET status = 'exported', exported_at = now() WHERE id = $1",
          [id],
        );
        p = await loadPeriod(client, id);
      }
      return { period: p, rows: await payrollRows(client, p) };
    });
    if (format === "csv") {
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="payroll-${period.start_date}-to-${period.end_date}.csv"`,
        )
        .send(payrollCsv(rows));
    }
    return { period: toPeriod(period), items: rows };
  });
};
