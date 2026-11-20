import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("time entries: non-ticket time, editing, names (integration)", () => {
  const dbName = `hoosier_te_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let tech: number;
  let boss: number;
  let companyId: number;
  let ticketId: number;
  let roleId: number;
  let typeId: number;
  const as = (id: number) => ({ "x-dev-member-id": String(id) });
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Indiana/Indianapolis" });

  async function id(sql: string, params: unknown[] = []): Promise<number> {
    return Number((await pool.query<{ id: string }>(sql, params)).rows[0]?.id);
  }
  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    who = tech,
  ) => app.inject({ method, url, headers: as(who), payload: payload as object | undefined });

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    await migrateUp(pool);
    await ensureMarker(pool, "test");
    tech = await id(
      "INSERT INTO iam.member (identifier, first_name, last_name, email, hourly_cost) VALUES ('t','Tess','Tech','t@e.com',30) RETURNING id",
    );
    boss = await id(
      "INSERT INTO iam.member (identifier, first_name, last_name, email) VALUES ('b','Bo','Boss','b@e.com') RETURNING id",
    );
    await pool.query(
      "INSERT INTO iam.member_role (member_id, role_id) SELECT $1, id FROM iam.role WHERE name = 'Technician'",
      [tech],
    );
    await pool.query(
      "INSERT INTO iam.member_role (member_id, role_id) SELECT $1, id FROM iam.role WHERE name = 'Administrator'",
      [boss],
    );
    companyId = await id(
      "INSERT INTO crm.company (identifier, name, status_id) VALUES ('ACME','Acme',(SELECT id FROM crm.company_status WHERE name='Active')) RETURNING id",
    );
    const board = await id("INSERT INTO service.board (name) VALUES ('Service') RETURNING id");
    await pool.query(
      "INSERT INTO service.board_status (board_id, name, is_default) VALUES ($1,'New',true)",
      [board],
    );
    roleId = await id(
      "INSERT INTO catalog.work_role (name, hourly_rate) VALUES ('Tech', 100) RETURNING id",
    );
    typeId = await id(
      "INSERT INTO catalog.work_type (name, rate_multiplier) VALUES ('Regular', 1) RETURNING id",
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
    const t = await call(
      "POST",
      "/api/v1/tickets",
      { summary: "Door stuck", companyId, boardId: board },
      boss,
    );
    ticketId = t.json().id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  const entry = (extra: object = {}) =>
    call("POST", "/api/v1/time-entries", {
      ticketId,
      workRoleId: roleId,
      workTypeId: typeId,
      workDate: day,
      hours: 1.5,
      ...extra,
    });

  it("returns the company and ticket summary with each entry", async () => {
    const res = await entry();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ company: "Acme", ticketSummary: "Door stuck", ticketId });
  });

  it("records non-ticket time against a company, never billable", async () => {
    const res = await call("POST", "/api/v1/time-entries", {
      companyId,
      workRoleId: roleId,
      workTypeId: typeId,
      workDate: day,
      hours: 2,
      billable: "billable",
      notes: "Shop inventory",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      ticketId: null,
      ticketSummary: null,
      billable: "do_not_bill",
      billedHours: 0,
      actualHours: 2,
    });
    const stored = await pool.query(
      "SELECT charge_type FROM timekeeping.time_entry WHERE id = $1",
      [res.json().id],
    );
    expect(stored.rows[0].charge_type).toBe("non_ticket");
  });

  it("needs a ticket or a company", async () => {
    const res = await call("POST", "/api/v1/time-entries", {
      workRoleId: roleId,
      workTypeId: typeId,
      workDate: day,
      hours: 1,
    });
    expect(res.statusCode).toBe(400);
  });

  it("edits an open entry and reprices it", async () => {
    const e = (await entry({ hours: 1 })).json();
    const res = await call("PATCH", `/api/v1/time-entries/${e.id}`, {
      hours: 2.25,
      notes: "Replaced strike plate",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ actualHours: 2.25, notes: "Replaced strike plate" });
    expect(res.json().billedHours).toBeGreaterThanOrEqual(2.25);
    expect((await call("PATCH", `/api/v1/time-entries/${e.id}`, {})).statusCode).toBe(400);
  });

  it("will not edit submitted time until it is recalled, nor someone else's", async () => {
    const e = (await entry({ workDate: day, hours: 0.5 })).json();
    expect(
      (await call("PATCH", `/api/v1/time-entries/${e.id}`, { hours: 1 }, boss)).statusCode,
    ).toBe(200); // write_all
    await call("POST", "/api/v1/timesheets/submit", { from: day, to: day });
    const blocked = await call("PATCH", `/api/v1/time-entries/${e.id}`, { hours: 3 });
    expect(blocked.statusCode).toBe(409);
    await call("POST", "/api/v1/timesheets/recall", { from: day, to: day });
    expect((await call("PATCH", `/api/v1/time-entries/${e.id}`, { hours: 3 })).statusCode).toBe(
      200,
    );
    const other = (
      await call(
        "POST",
        "/api/v1/time-entries",
        { ticketId, workRoleId: roleId, workTypeId: typeId, workDate: day, hours: 1 },
        boss,
      )
    ).json();
    await pool.query("UPDATE iam.member_role SET member_id = member_id"); // no-op: keep roles as set up
    const noPerm = await call("PATCH", `/api/v1/time-entries/${other.id}`, { hours: 2 });
    expect(noPerm.statusCode).toBe(403);
  });

  it("filters time by company for the company page", async () => {
    const res = await call("GET", `/api/v1/time-entries?companyId=${companyId}`);
    expect(res.json().items.length).toBeGreaterThan(0);
    expect(res.json().items.every((i: { company: string }) => i.company === "Acme")).toBe(true);
  });
});
