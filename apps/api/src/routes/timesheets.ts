import { withActor } from "@hoosier/db";
import { dateRangeSchema, timesheetApproveSchema } from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import { HttpError } from "../errors.js";

/**
 * Timesheet lifecycle for a date range (docs/04): open -> submitted -> approved.
 * Locked pay periods and billed entries are protected by database triggers, so a request that touches
 * them fails with 422 rather than changing history.
 */
export const timesheetRoutes: FastifyPluginAsync = async (app) => {
  app.post("/submit", { config: { perm: "timekeeping.time.write_own" } }, async (req) => {
    const body = dateRangeSchema.parse(req.body);
    const memberId = req.memberId as number;
    return withActor(app.pool, memberId, async (client) => {
      const running = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM timekeeping.time_entry
          WHERE member_id = $1 AND is_timer AND ended_at IS NULL AND work_date BETWEEN $2 AND $3`,
        [memberId, body.from, body.to],
      );
      if (Number(running.rows[0]?.n) > 0) {
        throw new HttpError(409, "Timer running", "Stop your running timer before submitting time");
      }
      const { rowCount } = await client.query(
        `UPDATE timekeeping.time_entry SET status = 'submitted'
          WHERE member_id = $1 AND status = 'open' AND work_date BETWEEN $2 AND $3`,
        [memberId, body.from, body.to],
      );
      return { submitted: rowCount ?? 0 };
    });
  });

  app.post("/recall", { config: { perm: "timekeeping.time.write_own" } }, async (req) => {
    const body = dateRangeSchema.parse(req.body);
    const memberId = req.memberId as number;
    return withActor(app.pool, memberId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE timekeeping.time_entry SET status = 'open'
          WHERE member_id = $1 AND status = 'submitted' AND work_date BETWEEN $2 AND $3`,
        [memberId, body.from, body.to],
      );
      return { recalled: rowCount ?? 0 };
    });
  });

  // Needs timekeeping.time.approve. Nobody approves their own time: someone else signs it off.
  app.post("/approve", { config: { perm: "timekeeping.time.approve" } }, async (req) => {
    const body = timesheetApproveSchema.parse(req.body);
    const approverId = req.memberId as number;
    if (body.memberId === approverId) {
      throw new HttpError(
        403,
        "Forbidden",
        "You cannot approve your own time; ask another approver",
      );
    }
    return withActor(app.pool, approverId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE timekeeping.time_entry
            SET status = 'approved', approved_by_member_id = $4, approved_at = now()
          WHERE member_id = $1 AND status = 'submitted' AND work_date BETWEEN $2 AND $3`,
        [body.memberId, body.from, body.to, approverId],
      );
      return { approved: rowCount ?? 0 };
    });
  });

  /** Per-member status counts for a range: the approval screen's starting point. */
  app.get("/summary", { config: { perm: "timekeeping.time.read_all" } }, async (req) => {
    const q = dateRangeSchema.parse(req.query);
    const { rows } = await app.pool.query<{
      member_id: string;
      identifier: string;
      status: string;
      entries: string;
      hours: string;
    }>(
      `SELECT te.member_id, m.identifier, te.status, count(*) AS entries, sum(te.actual_hours) AS hours
         FROM timekeeping.time_entry te JOIN iam.member m ON m.id = te.member_id
        WHERE te.work_date BETWEEN $1 AND $2 AND te.status <> 'void'
        GROUP BY te.member_id, m.identifier, te.status ORDER BY m.identifier, te.status`,
      [q.from, q.to],
    );
    return {
      items: rows.map((r) => ({
        memberId: Number(r.member_id),
        identifier: r.identifier,
        status: r.status,
        entries: Number(r.entries),
        hours: Number(r.hours),
      })),
    };
  });
};
