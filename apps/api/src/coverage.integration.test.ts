import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("agreement coverage on ticket time (integration)", () => {
  const dbName = `hoosier_cov_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let boss: number;
  let acme: number;
  let board: number;
  let roleId: number;
  let remoteType: number;
  let onsiteType: number;
  const day = new Date().toISOString().slice(0, 10);
  const iso = (offsetDays: number) =>
    new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  const one = async (sql: string, params: unknown[] = []) =>
    Number((await pool.query<{ id: string }>(sql, params)).rows[0]?.id);
  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { "x-dev-member-id": String(boss) },
      payload: payload as object | undefined,
    });

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    await migrateUp(pool);
    await ensureMarker(pool, "test");
    boss = await one(
      "INSERT INTO iam.member (identifier, first_name, last_name, email) VALUES ('b','Bo','Boss','b@e.com') RETURNING id",
    );
    await pool.query(
      "INSERT INTO iam.member_role (member_id, role_id) SELECT $1, id FROM iam.role WHERE name = 'Administrator'",
      [boss],
    );
    acme = await one(
      "INSERT INTO crm.company (identifier, name, status_id) VALUES ('ACME','Acme',(SELECT id FROM crm.company_status WHERE name='Active')) RETURNING id",
    );
    board = await one("INSERT INTO service.board (name) VALUES ('Service') RETURNING id");
    await pool.query(
      "INSERT INTO service.board_status (board_id, name, is_default) VALUES ($1,'New',true)",
      [board],
    );
    roleId = await one(
      "INSERT INTO catalog.work_role (name, hourly_rate) VALUES ('Tech', 100) RETURNING id",
    );
    remoteType = await one(
      "INSERT INTO catalog.work_type (name, rate_multiplier, counts_against_agreement) VALUES ('Remote', 1, true) RETURNING id",
    );
    onsiteType = await one(
      "INSERT INTO catalog.work_type (name, rate_multiplier, counts_against_agreement) VALUES ('On-site', 1, false) RETURNING id",
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

  const agreement = async (extra: object) => {
    const t = await call("POST", "/api/v1/agreements/types", {
      name: `T${Math.random()}`,
      billCycle: "monthly",
      coverage: "covered",
      autoRenew: true,
    });
    const res = await call("POST", "/api/v1/agreements", {
      companyId: acme,
      typeId: t.json().id,
      name: "A",
      startDate: iso(-60),
      ...extra,
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  };
  const ticket = async (agreementId?: number) => {
    const t = await call("POST", "/api/v1/tickets", {
      summary: "T",
      companyId: acme,
      boardId: board,
    });
    if (agreementId !== undefined)
      await call("PATCH", `/api/v1/tickets/${t.json().id}`, { agreementId });
    return t.json().id as number;
  };
  const row = async (id: number) =>
    (
      await pool.query(
        'SELECT billable, agreement_id::int AS "agreementId", billed_hours::float AS "billedHours" FROM timekeeping.time_entry WHERE id = $1',
        [id],
      )
    ).rows[0];
  const time = (ticketId: number, workTypeId: number, hours: number, extra: object = {}) =>
    call("POST", "/api/v1/time-entries", {
      ticketId,
      workRoleId: roleId,
      workTypeId,
      workDate: day,
      hours,
      ...extra,
    });

  it("bills normally with no agreement", async () => {
    const e = (await time(await ticket(), remoteType, 2)).json();
    expect(e).toMatchObject({ billable: "billable", agreementId: null, billedHours: 2 });
  });

  it("covers flagged work types on a covered agreement and bills the rest", async () => {
    const a = await agreement({ coverage: "covered" });
    const t = await ticket(a.id);
    const covered = (await time(t, remoteType, 2)).json();
    expect(covered).toMatchObject({ billable: "no_charge", agreementId: a.id, billedHours: 0 });
    const billed = (await time(t, onsiteType, 1)).json();
    expect(billed).toMatchObject({ billable: "billable", agreementId: null, billedHours: 1 });
    const detail = (await call("GET", `/api/v1/agreements/${a.id}`)).json();
    expect(detail.coveredHours).toBe(2);
  });

  it("lets an explicit billing choice stand", async () => {
    const a = await agreement({ coverage: "covered" });
    const e = (await time(await ticket(a.id), remoteType, 1, { billable: "billable" })).json();
    expect(e).toMatchObject({ billable: "billable", agreementId: null });
  });

  it("does not cover when the agreement has none or is not in force", async () => {
    const none = await agreement({ coverage: "none" });
    expect((await time(await ticket(none.id), remoteType, 1)).json().billable).toBe("billable");
    const ended = await agreement({ startDate: iso(-90), endDate: iso(-30), autoRenew: false });
    const t = await ticket();
    await pool.query("UPDATE service.ticket SET agreement_id = $2 WHERE id = $1", [t, ended.id]);
    expect((await time(t, remoteType, 1)).json().billable).toBe("billable");
  });

  it("draws block hours down and bills overage in full", async () => {
    const a = await agreement({ coverage: "block_hours", blockHours: 5 });
    const t = await ticket(a.id);
    expect((await time(t, remoteType, 3)).json().billable).toBe("no_charge");
    expect((await time(t, remoteType, 2)).json().billable).toBe("no_charge");
    const over = (await time(t, remoteType, 0.5)).json();
    expect(over).toMatchObject({ billable: "billable", agreementId: null });
    expect((await call("GET", `/api/v1/agreements/${a.id}`)).json().coveredHours).toBe(5);
  });

  it("re-decides an edited entry against the balance", async () => {
    const a = await agreement({ coverage: "block_hours", blockHours: 4 });
    const t = await ticket(a.id);
    const e = (await time(t, remoteType, 2)).json();
    expect(e.billable).toBe("no_charge");
    const grown = await call("PATCH", `/api/v1/time-entries/${e.id}`, { hours: 6 });
    expect(grown.json()).toMatchObject({ billable: "billable", agreementId: null });
    const shrunk = await call("PATCH", `/api/v1/time-entries/${e.id}`, { hours: 3 });
    expect(shrunk.json()).toMatchObject({ billable: "no_charge", agreementId: a.id });
  });

  it("covers a stopped timer", async () => {
    const a = await agreement({ coverage: "covered" });
    const t = await ticket(a.id);
    const started = await call("POST", "/api/v1/time-entries/timer/start", {
      ticketId: t,
      workRoleId: roleId,
      workTypeId: remoteType,
    });
    expect(started.statusCode).toBe(201);
    const stopped = await call("POST", "/api/v1/time-entries/timer/stop", {});
    expect(stopped.json()).toMatchObject({ billable: "no_charge", agreementId: a.id });
  });

  it("recomputes open time when the ticket's agreement changes", async () => {
    const a = await agreement({ coverage: "covered" });
    const t = await ticket();
    const e = (await time(t, remoteType, 2)).json();
    expect(e.billable).toBe("billable");
    await call("PATCH", `/api/v1/tickets/${t}`, { agreementId: a.id });
    let now = await row(e.id);
    expect(now).toMatchObject({ billable: "no_charge", agreementId: a.id, billedHours: 0 });
    await call("PATCH", `/api/v1/tickets/${t}`, { agreementId: null });
    now = await row(e.id);
    expect(now).toMatchObject({ billable: "billable", agreementId: null, billedHours: 2 });
  });

  it("leaves submitted time alone when the agreement changes", async () => {
    const a = await agreement({ coverage: "covered" });
    const t = await ticket();
    const e = (await time(t, remoteType, 2)).json();
    await pool.query("UPDATE timekeeping.time_entry SET status = 'submitted' WHERE id = $1", [
      e.id,
    ]);
    await call("PATCH", `/api/v1/tickets/${t}`, { agreementId: a.id });
    const row = await pool.query(
      "SELECT billable, agreement_id FROM timekeeping.time_entry WHERE id = $1",
      [e.id],
    );
    expect(row.rows[0]).toMatchObject({ billable: "billable", agreement_id: null });
  });
});
