import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("timesheets and payroll API (integration)", () => {
  const dbName = `hoosier_pay_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let jane: number;
  let bob: number;
  let ticketId: number;
  let roleId: number;
  let typeId: number;
  const as = (id: number) => ({ "x-dev-member-id": String(id) });

  async function id(sql: string, params: unknown[] = []): Promise<number> {
    return Number((await pool.query<{ id: string }>(sql, params)).rows[0]?.id);
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
    jane = await id(
      "INSERT INTO iam.member (identifier, first_name, last_name, email) VALUES ('JSmith','Jane','Smith','j@example.com') RETURNING id",
    );
    bob = await id(
      "INSERT INTO iam.member (identifier, first_name, last_name, email) VALUES ('BJones','Bob','Jones','b@example.com') RETURNING id",
    );
    const company = await id(
      "INSERT INTO crm.company (identifier, name, status_id) VALUES ('ACME','Acme',(SELECT id FROM crm.company_status WHERE name='Active')) RETURNING id",
    );
    const board = await id("INSERT INTO service.board (name) VALUES ('Service') RETURNING id");
    const status = await id(
      "INSERT INTO service.board_status (board_id, name, is_default) VALUES ($1,'New',true) RETURNING id",
      [board],
    );
    const prio = await id("SELECT id FROM service.priority WHERE name='Normal'");
    ticketId = await id(
      "INSERT INTO service.ticket (summary, company_id, board_id, status_id, priority_id) VALUES ('t',$1,$2,$3,$4) RETURNING id",
      [company, board, status, prio],
    );
    roleId = await id(
      "INSERT INTO catalog.work_role (name, hourly_rate) VALUES ('Tech', 100) RETURNING id",
    );
    typeId = await id("INSERT INTO catalog.work_type (name) VALUES ('Regular') RETURNING id");
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

  const log = (member: number, workDate: string, hours: number) =>
    app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: as(member),
      payload: { ticketId, workRoleId: roleId, workTypeId: typeId, workDate, hours },
    });
  const post = (member: number, url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: as(member), payload: payload as object });

  let p1: number;
  let p2: number;

  it("generates the two semi-monthly periods for a month, idempotently", async () => {
    const first = await post(jane, "/api/v1/pay-periods/generate", { year: 2026, month: 11 });
    expect(first.statusCode).toBe(201);
    const items = first.json().items;
    expect(
      items.map((p: { startDate: string; endDate: string }) => [p.startDate, p.endDate]),
    ).toEqual([
      ["2026-11-01", "2026-11-15"],
      ["2026-11-16", "2026-11-30"],
    ]);
    p1 = items[0].id;
    p2 = items[1].id;
    const again = await post(jane, "/api/v1/pay-periods/generate", { year: 2026, month: 11 });
    expect(again.json().items.map((p: { id: number }) => p.id)).toEqual([p1, p2]);
    const feb = await post(jane, "/api/v1/pay-periods/generate", { year: 2028, month: 2 });
    expect(feb.json().items[1].endDate).toBe("2028-02-29");
  });

  it("rejects an invalid month", async () => {
    const res = await post(jane, "/api/v1/pay-periods/generate", { year: 2026, month: 13 });
    expect(res.statusCode).toBe(400);
  });

  it("computes payroll with mid-week overtime and paid leave", async () => {
    // Jane: 10h on Sun 15th .. Thu 19th (docs/04 worked example). Bob: 8h Mon 16th, plus PTO.
    for (const d of ["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]) {
      expect((await log(jane, d, 10)).statusCode).toBe(201);
    }
    expect((await log(bob, "2026-11-16", 8)).statusCode).toBe(201);
    await pool.query(
      `INSERT INTO timekeeping.leave_entry (member_id, leave_date, hours, leave_type)
       VALUES ($1,'2026-11-17',8,'pto'), ($1,'2026-11-26',8,'holiday'), ($1,'2026-11-18',8,'unpaid')`,
      [bob],
    );

    // Open (unsubmitted) time is not payable yet.
    const before = await app.inject({
      method: "GET",
      url: `/api/v1/pay-periods/${p2}/payroll`,
      headers: as(jane),
    });
    expect(before.json().unsubmittedEntries).toBeGreaterThan(0);
    expect(before.json().items.map((r: { identifier: string }) => r.identifier)).toEqual([
      "BJones",
    ]); // leave only

    for (const [m, from, to] of [
      [jane, "2026-11-01", "2026-11-30"],
      [bob, "2026-11-01", "2026-11-30"],
    ] as const) {
      const sub = await post(m, "/api/v1/timesheets/submit", { from, to });
      expect(sub.statusCode).toBe(200);
    }
    const approve = await post(jane, "/api/v1/timesheets/approve", {
      memberId: jane,
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect(approve.json().approved).toBe(5);

    const p2res = await app.inject({
      method: "GET",
      url: `/api/v1/pay-periods/${p2}/payroll`,
      headers: as(jane),
    });
    const rows = p2res.json().items;
    const j = rows.find((r: { identifier: string }) => r.identifier === "JSmith");
    const b = rows.find((r: { identifier: string }) => r.identifier === "BJones");
    expect(j).toMatchObject({
      regularHours: 30,
      overtimeHours: 10,
      regularHm: "30:00",
      overtimeHm: "10:00",
    });
    expect(b).toMatchObject({ regularHours: 8, ptoHours: 8, holidayHours: 8, sickHours: 0 });

    const p1res = await app.inject({
      method: "GET",
      url: `/api/v1/pay-periods/${p1}/payroll`,
      headers: as(jane),
    });
    expect(p1res.json().items[0]).toMatchObject({
      identifier: "JSmith",
      regularHours: 10,
      overtimeHours: 0,
    });
  });

  it("refuses to submit while a timer is running, and recall reopens submitted time", async () => {
    const start = await post(bob, "/api/v1/time-entries/timer/start", {
      ticketId,
      workRoleId: roleId,
      workTypeId: typeId,
    });
    expect(start.statusCode).toBe(201);
    const today = start.json().workDate;
    const blocked = await post(bob, "/api/v1/timesheets/submit", { from: today, to: today });
    expect(blocked.statusCode).toBe(409);
    await post(bob, "/api/v1/time-entries/timer/stop", {});
    await post(bob, "/api/v1/timesheets/submit", { from: today, to: today });
    const recalled = await post(bob, "/api/v1/timesheets/recall", { from: today, to: today });
    expect(recalled.json().recalled).toBe(1);
    // Tidy so later locking tests are unaffected: remove that entry.
    await pool.query(
      "UPDATE timekeeping.time_entry SET status = 'void' WHERE member_id = $1 AND work_date = $2",
      [bob, today],
    );
  });

  it("blocks locking while entries are open, then locks and freezes the period", async () => {
    await log(jane, "2026-11-03", 2); // open entry in period 1
    const blocked = await post(jane, `/api/v1/pay-periods/${p1}/lock`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().title).toBe("Unsubmitted time");

    await post(jane, "/api/v1/timesheets/submit", { from: "2026-11-01", to: "2026-11-15" });
    const lock = await post(jane, `/api/v1/pay-periods/${p1}/lock`);
    expect(lock.statusCode).toBe(200);
    expect(lock.json()).toMatchObject({ status: "locked" });
    expect(lock.json().lockedAt).not.toBeNull();

    const again = await post(jane, `/api/v1/pay-periods/${p1}/lock`);
    expect(again.statusCode).toBe(409);

    // New time in the locked period is refused; existing time cannot be recalled.
    expect((await log(jane, "2026-11-04", 1)).statusCode).toBe(409);
    const recall = await post(jane, "/api/v1/timesheets/recall", {
      from: "2026-11-01",
      to: "2026-11-15",
    });
    expect(recall.statusCode).toBe(422);
  });

  it("will not export an unlocked period; exports a locked one as JSON and CSV", async () => {
    const early = await post(jane, `/api/v1/pay-periods/${p2}/export`);
    expect(early.statusCode).toBe(409);

    const exported = await post(jane, `/api/v1/pay-periods/${p1}/export`);
    expect(exported.statusCode).toBe(200);
    expect(exported.json().period.status).toBe("exported");
    expect(exported.json().period.exportedAt).not.toBeNull();
    const jsmith = exported
      .json()
      .items.find((r: { identifier: string }) => r.identifier === "JSmith");
    expect(jsmith).toMatchObject({ regularHours: 12, overtimeHours: 0 }); // 10 (Sun 15th) + 2 (Nov 3)

    const csv = await post(jane, `/api/v1/pay-periods/${p1}/export?format=csv`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("payroll-2026-11-01-to-2026-11-15.csv");
    expect(csv.body.split("\r\n")[1]).toContain("JSmith,Jane Smith,12.00,12:00,0.00,0:00");
  });

  it("is read-only safe: nothing here runs in read-only mode", async () => {
    const ro = buildApp({
      pool,
      config: {
        AUTH_MODE: "dev",
        LOG_LEVEL: "silent",
        APP_ENV: "test",
        DB_WRITE_MODE: "read_only",
      },
    });
    for (const url of [
      `/api/v1/pay-periods/${p2}/lock`,
      `/api/v1/pay-periods/${p2}/export`,
      "/api/v1/timesheets/submit",
    ]) {
      const res = await ro.inject({
        method: "POST",
        url,
        headers: as(jane),
        payload: { from: "2026-11-01", to: "2026-11-30" },
      });
      expect(res.statusCode, url).toBe(403);
    }
    await ro.close();
  });
});
