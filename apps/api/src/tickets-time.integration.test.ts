import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("tickets and time API (integration)", () => {
  const dbName = `hoosier_tt_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let memberId: number;
  let otherMemberId: number;
  let companyId: number;
  let boardId: number;
  let openStatusId: number;
  let closedStatusId: number;
  let roleId: number;
  let typeId: number;
  const as = (id: number) => ({ "x-dev-member-id": String(id) });

  async function id(sql: string, params: unknown[] = []): Promise<number> {
    const r = await pool.query<{ id: string }>(sql, params);
    return Number(r.rows[0]?.id);
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    await migrateUp(pool);
    await ensureMarker(pool, "test");
    memberId = await id(
      `INSERT INTO iam.member (identifier, first_name, last_name, email, hourly_cost)
       VALUES ('tech1', 'Tech', 'One', 't1@example.com', 40) RETURNING id`,
    );
    otherMemberId = await id(
      `INSERT INTO iam.member (identifier, first_name, last_name, email)
       VALUES ('tech2', 'Tech', 'Two', 't2@example.com') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO iam.member_role (member_id, role_id)
       SELECT m.id, r.id FROM iam.member m, iam.role r
       WHERE (r.name = 'Administrator' AND m.id <> $1) OR (r.name = 'Technician' AND m.id = $1)`,
      [otherMemberId],
    );
    companyId = await id(
      `INSERT INTO crm.company (identifier, name, status_id)
       VALUES ('ACME', 'Acme', (SELECT id FROM crm.company_status WHERE name = 'Active')) RETURNING id`,
    );
    boardId = await id("INSERT INTO service.board (name) VALUES ('Service') RETURNING id");
    openStatusId = await id(
      "INSERT INTO service.board_status (board_id, name, is_default) VALUES ($1,'New',true) RETURNING id",
      [boardId],
    );
    closedStatusId = await id(
      "INSERT INTO service.board_status (board_id, name, is_closed) VALUES ($1,'Closed',true) RETURNING id",
      [boardId],
    );
    roleId = await id(
      "INSERT INTO catalog.work_role (name, hourly_rate) VALUES ('Technician', 100) RETURNING id",
    );
    typeId = await id(
      "INSERT INTO catalog.work_type (name, rate_multiplier) VALUES ('Overtime', 1.5) RETURNING id",
    );
    app = buildApp({
      pool,
      config: {
        AUTH_MODE: "dev",
        LOG_LEVEL: "silent",
        APP_ENV: "test",
        DB_WRITE_MODE: "read_write",
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  async function newTicket(summary = "Door will not latch") {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tickets",
      headers: as(memberId),
      payload: { summary, companyId, boardId, description: "Reported by front desk" },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it("serves lookups for forms: boards with statuses, priorities, roles and types", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/lookups", headers: as(memberId) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const board = body.boards.find((b: { id: number }) => b.id === boardId);
    expect(board.statuses.map((s: { name: string }) => s.name)).toEqual(["New", "Closed"]);
    expect(board.statuses[1].isClosed).toBe(true);
    expect(body.priorities.length).toBeGreaterThan(0);
    expect(body.workRoles.map((r: { id: number }) => r.id)).toContain(roleId);
    expect(body.workTypes.map((t: { id: number }) => t.id)).toContain(typeId);
  });

  it("creates a ticket with the board's default status and priority", async () => {
    const t = await newTicket();
    expect(t).toMatchObject({
      status: "New",
      priority: "Normal",
      isClosed: false,
      company: "Acme",
    });
    const notes = await app.inject({
      method: "GET",
      url: `/api/v1/tickets/${t.id}/notes`,
      headers: as(memberId),
    });
    expect(notes.json().items).toHaveLength(1);
    expect(notes.json().items[0].kind).toBe("description");
  });

  it("closes and reopens a ticket, stamping closed_at", async () => {
    const t = await newTicket("Close me");
    const closed = await app.inject({
      method: "PATCH",
      url: `/api/v1/tickets/${t.id}`,
      headers: as(memberId),
      payload: { statusId: closedStatusId },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().isClosed).toBe(true);
    expect(closed.json().closedAt).not.toBeNull();

    const open = await app.inject({
      method: "GET",
      url: "/api/v1/tickets?state=open&limit=200",
      headers: as(memberId),
    });
    expect(open.json().items.map((x: { id: number }) => x.id)).not.toContain(t.id);

    const reopened = await app.inject({
      method: "PATCH",
      url: `/api/v1/tickets/${t.id}`,
      headers: as(memberId),
      payload: { statusId: openStatusId },
    });
    expect(reopened.json().closedAt).toBeNull();
  });

  it("rejects a status from another board and an empty update", async () => {
    const otherBoard = await id(
      "INSERT INTO service.board (name) VALUES ('Projects') RETURNING id",
    );
    const foreign = await id(
      "INSERT INTO service.board_status (board_id, name) VALUES ($1,'Scheduled') RETURNING id",
      [otherBoard],
    );
    const t = await newTicket("Wrong board status");
    const bad = await app.inject({
      method: "PATCH",
      url: `/api/v1/tickets/${t.id}`,
      headers: as(memberId),
      payload: { statusId: foreign },
    });
    expect(bad.statusCode).toBe(422);
    const empty = await app.inject({
      method: "PATCH",
      url: `/api/v1/tickets/${t.id}`,
      headers: as(memberId),
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  it("sets first response on the first customer-visible note only", async () => {
    const t = await newTicket("Response timing");
    await app.inject({
      method: "POST",
      url: `/api/v1/tickets/${t.id}/notes`,
      headers: as(memberId),
      payload: { kind: "internal", body: "checking logs" },
    });
    const none = await pool.query("SELECT first_response_at FROM service.ticket WHERE id = $1", [
      t.id,
    ]);
    expect(none.rows[0].first_response_at).toBeNull();
    await app.inject({
      method: "POST",
      url: `/api/v1/tickets/${t.id}/notes`,
      headers: as(memberId),
      payload: { body: "We are on it" },
    });
    const set = await pool.query("SELECT first_response_at FROM service.ticket WHERE id = $1", [
      t.id,
    ]);
    expect(set.rows[0].first_response_at).not.toBeNull();
  });

  it("runs a timer, snapshots rates, applies rounding, and allows one timer per member", async () => {
    const t = await newTicket("Timed work");
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/timer/start",
      headers: as(memberId),
      payload: { ticketId: t.id, workRoleId: roleId, workTypeId: typeId },
    });
    expect(start.statusCode).toBe(201);
    expect(start.json()).toMatchObject({ isTimer: true, billRate: 150, memberId });

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/timer/start",
      headers: as(memberId),
      payload: { ticketId: t.id, workRoleId: roleId, workTypeId: typeId },
    });
    expect(second.statusCode).toBe(409);

    const stop = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/timer/stop",
      headers: as(memberId),
      payload: { notes: "Replaced strike plate" },
    });
    expect(stop.statusCode).toBe(200);
    expect(stop.json().isTimer).toBe(false);
    expect(stop.json().billedHours).toBe(0.25); // seconds of work round up to one 15 minute block
    expect(stop.json().notes).toBe("Replaced strike plate");

    const none = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/timer/stop",
      headers: as(memberId),
      payload: {},
    });
    expect(none.statusCode).toBe(409);
    const cost = await pool.query("SELECT cost_rate FROM timekeeping.time_entry WHERE id = $1", [
      start.json().id,
    ]);
    expect(Number(cost.rows[0].cost_rate)).toBe(40);
  });

  it("creates manual entries from hours or a range and validates input", async () => {
    const t = await newTicket("Manual time");
    const byHours = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: as(memberId),
      payload: {
        ticketId: t.id,
        workRoleId: roleId,
        workTypeId: typeId,
        workDate: "2026-11-02",
        hours: 1.1,
      },
    });
    expect(byHours.statusCode).toBe(201);
    expect(byHours.json()).toMatchObject({
      actualHours: 1.1,
      billedHours: 1.25,
      workDate: "2026-11-02",
    });

    const byRange = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: as(memberId),
      payload: {
        ticketId: t.id,
        workRoleId: roleId,
        workTypeId: typeId,
        workDate: "2026-11-02",
        startedAt: "2026-11-02T14:00:00Z",
        endedAt: "2026-11-02T15:30:00Z",
        billable: "do_not_bill",
      },
    });
    expect(byRange.json()).toMatchObject({ actualHours: 1.5, billedHours: 0 });

    for (const payload of [
      { workDate: "2026-11-02" }, // no hours or range
      {
        workDate: "2026-11-02",
        hours: 1,
        startedAt: "2026-11-02T14:00:00Z",
        endedAt: "2026-11-02T15:00:00Z",
      },
      {
        workDate: "2026-11-02",
        startedAt: "2026-11-02T15:00:00Z",
        endedAt: "2026-11-02T14:00:00Z",
      },
      { workDate: "11/02/2026", hours: 1 },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: as(memberId),
        payload: { ticketId: t.id, workRoleId: roleId, workTypeId: typeId, ...payload },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("prices by work type: custom rate, minimum hours, cap, and default billable setting", async () => {
    const onsite = await id(
      `INSERT INTO catalog.work_type (name, rate_type, custom_rate, hours_min)
       VALUES ('Onsite - Service', 'custom', 197, 1) RETURNING id`,
    );
    const dispatch = await id(
      `INSERT INTO catalog.work_type (name, rate_type, custom_rate, hours_max)
       VALUES ('Dispatch', 'custom', 99, 1) RETURNING id`,
    );
    const warranty = await id(
      "INSERT INTO catalog.work_type (name, bill_time) VALUES ('Warranty', 'no_charge') RETURNING id",
    );
    const t = await newTicket("Pricing");
    const entry = (workTypeId: number, hours: number) =>
      app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: as(memberId),
        payload: { ticketId: t.id, workRoleId: roleId, workTypeId, workDate: "2026-11-04", hours },
      });

    // The custom rate ignores the role rate (100); 25 minutes bills as the 1 hour minimum.
    const a = (await entry(onsite, 0.42)).json();
    expect(a).toMatchObject({
      billRate: 197,
      actualHours: 0.42,
      billedHours: 1,
      billable: "billable",
    });
    // Dispatch is capped at one billed hour.
    const b = (await entry(dispatch, 2.5)).json();
    expect(b).toMatchObject({ billRate: 99, billedHours: 1 });
    // A no-charge work type defaults the entry to no_charge and bills nothing.
    const c = (await entry(warranty, 1)).json();
    expect(c).toMatchObject({ billable: "no_charge", billedHours: 0 });
  });

  it("refuses new time in a locked pay period and blocks voiding time once its period locks", async () => {
    const t = await newTicket("Locked period");
    await pool.query(
      `INSERT INTO timekeeping.pay_period (start_date, end_date, status, locked_at)
       VALUES ('2026-09-16', '2026-09-30', 'locked', now())`,
    );
    const locked = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: as(memberId),
      payload: {
        ticketId: t.id,
        workRoleId: roleId,
        workTypeId: typeId,
        workDate: "2026-09-20",
        hours: 1,
      },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().title).toBe("Pay period locked");

    // Entry written while the period is open; locking the period then freezes it (DB guard).
    await pool.query(
      "INSERT INTO timekeeping.pay_period (start_date, end_date) VALUES ('2026-10-01', '2026-10-15')",
    );
    const entry = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: as(memberId),
      payload: {
        ticketId: t.id,
        workRoleId: roleId,
        workTypeId: typeId,
        workDate: "2026-10-05",
        hours: 2,
      },
    });
    expect(entry.statusCode).toBe(201);
    await pool.query(
      "UPDATE timekeeping.pay_period SET status = 'locked', locked_at = now() WHERE start_date = '2026-10-01'",
    );
    const voided = await app.inject({
      method: "DELETE",
      url: `/api/v1/time-entries/${entry.json().id}`,
      headers: as(memberId),
    });
    expect(voided.statusCode).toBe(422);
  });

  it("lets only the owner void an entry, and hides voided entries", async () => {
    const t = await newTicket("Void rules");
    const e = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: as(memberId),
      payload: {
        ticketId: t.id,
        workRoleId: roleId,
        workTypeId: typeId,
        workDate: "2026-11-03",
        hours: 1,
      },
    });
    const entryId = e.json().id;
    const other = await app.inject({
      method: "DELETE",
      url: `/api/v1/time-entries/${entryId}`,
      headers: as(otherMemberId),
    });
    expect(other.statusCode).toBe(403);
    const own = await app.inject({
      method: "DELETE",
      url: `/api/v1/time-entries/${entryId}`,
      headers: as(memberId),
    });
    expect(own.statusCode).toBe(204);
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/time-entries?ticketId=${t.id}`,
      headers: as(memberId),
    });
    expect(list.json().items).toHaveLength(0);
  });
});
