import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("ticket time invoicing (integration)", () => {
  const dbName = `hoosier_tkt_bill_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let boss: number;
  let board: number;
  let openStatus: number;
  let closedStatus: number;
  let roleId: number;
  let typeId: number;
  let seq = 0;
  const one = async (sql: string, params: unknown[] = []) =>
    Number((await pool.query<{ id: string }>(sql, params)).rows[0]?.id);
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { "x-dev-member-id": String(boss) },
      payload: payload as object | undefined,
    });
  const status = "(SELECT id FROM crm.company_status WHERE name='Active')";

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
    board = await one("INSERT INTO service.board (name) VALUES ('Service') RETURNING id");
    openStatus = await one(
      "INSERT INTO service.board_status (board_id, name, is_default) VALUES ($1,'New',true) RETURNING id",
      [board],
    );
    closedStatus = await one(
      "INSERT INTO service.board_status (board_id, name, is_closed) VALUES ($1,'Closed',true) RETURNING id",
      [board],
    );
    roleId = await one(
      "INSERT INTO catalog.work_role (name, hourly_rate) VALUES ('Tech', 100) RETURNING id",
    );
    typeId = await one(
      "INSERT INTO catalog.work_type (name, rate_multiplier, counts_against_agreement) VALUES ('Remote', 1, false) RETURNING id",
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

  const company = async (extra = "") => {
    seq += 1;
    return one(
      `INSERT INTO crm.company (identifier, name, status_id ${extra ? ", bill_to_company_id" : ""})
       VALUES ('C${seq}-${process.pid}','Co ${seq}',${status} ${extra ? `, ${extra}` : ""}) RETURNING id`,
    );
  };
  const ticket = async (companyId: number, billing: object = {}) => {
    const t = await call("POST", "/api/v1/tickets", {
      summary: "Fix it",
      companyId,
      boardId: board,
    });
    expect(t.statusCode).toBe(201);
    if (Object.keys(billing).length > 0) {
      const p = await call("PATCH", `/api/v1/tickets/${t.json().id}`, billing);
      expect(p.statusCode).toBe(200);
    }
    return t.json().id as number;
  };
  /** Logs time through the API, then approves it the way timesheet approval would. */
  const logTime = async (ticketId: number, hours: number, workDate: string, approve = true) => {
    const res = await call("POST", "/api/v1/time-entries", {
      ticketId,
      workRoleId: roleId,
      workTypeId: typeId,
      workDate,
      hours,
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as number;
    if (approve)
      await pool.query("UPDATE timekeeping.time_entry SET status = 'approved' WHERE id = $1", [id]);
    return id;
  };
  const entry = async (id: number) =>
    (
      await pool.query(
        "SELECT status, invoice_id::int AS invoice, invoice_line_id::int AS line FROM timekeeping.time_entry WHERE id = $1",
        [id],
      )
    ).rows[0];
  const ticketRun = (throughDate: string, extra: object = {}) =>
    call("POST", "/api/v1/billing/runs", {
      kind: "ticket",
      throughDate,
      invoiceDate: "2027-02-01",
      ...extra,
    });
  type Inv = {
    id: number;
    companyId: number;
    subtotal: string;
    total: string;
    lines: Array<{
      id: number;
      quantity: string;
      amount: string;
      description: string;
      ticketId: number;
    }>;
  };
  /** The run's invoices with their lines (the run detail lists invoices without lines). */
  const invoicesOf = async (runId: number): Promise<Inv[]> => {
    const heads = (await call("GET", `/api/v1/billing/runs/${runId}`)).json().invoices as Inv[];
    return Promise.all(
      heads.map(async (h) => (await call("GET", `/api/v1/billing/invoices/${h.id}`)).json() as Inv),
    );
  };

  it("bills approved time at actual rates, grouped by rate, and never twice", async () => {
    const co = await company();
    const t = await ticket(co);
    const a = await logTime(t, 2, "2027-01-04");
    const b = await logTime(t, 1.5, "2027-01-05");
    const pending = await logTime(t, 4, "2027-01-06", false);

    const prev = await call("POST", "/api/v1/billing/runs", {
      kind: "ticket",
      throughDate: "2027-01-31",
      invoiceDate: "2027-02-01",
      preview: true,
    });
    expect(prev.statusCode).toBe(200);
    expect(prev.json().kind).toBe("ticket");
    expect((await entry(a)).invoice).toBeNull(); // a preview saves nothing

    const res = await ticketRun("2027-01-31");
    expect(res.statusCode).toBe(201);
    const run = res.json();
    expect(run.kind).toBe("ticket");
    expect(run.throughDate).toBe("2027-01-31");
    const [inv] = (await invoicesOf(run.id)).filter((i) => i.companyId === co);
    expect(inv?.subtotal).toBe("350.00");
    expect(inv?.lines).toHaveLength(1);
    expect(Number(inv?.lines[0]?.quantity)).toBe(3.5);
    expect(inv?.lines[0]?.ticketId).toBe(t);

    expect((await entry(a)).invoice).toBe(inv?.id);
    expect((await entry(pending)).invoice).toBeNull();

    // The same time is not offered again.
    const again = await ticketRun("2027-01-31");
    expect(again.statusCode).toBe(422);
    expect(b).toBeGreaterThan(0);
  });

  it("leaves out time after the through date", async () => {
    const co = await company();
    const t = await ticket(co);
    const early = await logTime(t, 1, "2027-03-01");
    const late = await logTime(t, 1, "2027-03-20");
    const res = await ticketRun("2027-03-10");
    expect(res.statusCode).toBe(201);
    expect((await entry(early)).invoice).not.toBeNull();
    expect((await entry(late)).invoice).toBeNull();
  });

  it("bills an override rate, and a not-to-exceed cap that runs out", async () => {
    const co = await company();
    const over = await ticket(co, { billingMethod: "override_rate", billingAmount: 80 });
    await logTime(over, 2, "2027-04-01");
    const nte = await ticket(co, { billingMethod: "not_to_exceed", billingAmount: 250 });
    await logTime(nte, 3, "2027-04-02"); // 300 at 100/h, capped to 250
    const res = await ticketRun("2027-04-30");
    expect(res.statusCode).toBe(201);
    const [inv] = (await invoicesOf(res.json().id)).filter((i) => i.companyId === co);
    const amounts = Object.fromEntries(inv?.lines.map((l) => [l.ticketId, l.amount]) ?? []);
    expect(amounts[over]).toBe("160.00");
    expect(amounts[nte]).toBe("250.00");

    // More time on the capped ticket bills nothing: the cap is used up.
    await logTime(nte, 1, "2027-04-20");
    const next = await ticketRun("2027-04-30");
    expect(next.statusCode).toBe(422);
  });

  it("holds a fixed-fee ticket until it is closed and all its time is approved", async () => {
    const co = await company();
    const t = await ticket(co, { billingMethod: "fixed_fee", billingAmount: 500 });
    const e1 = await logTime(t, 2, "2027-05-02");
    const open = await ticketRun("2027-05-31");
    expect(open.statusCode).toBe(422); // not closed

    await call("PATCH", `/api/v1/tickets/${t}`, { statusId: closedStatus });
    const unapproved = await logTime(t, 1, "2027-05-03", false);
    const held = await ticketRun("2027-05-31");
    expect(held.statusCode).toBe(422); // time not approved yet

    await pool.query("UPDATE timekeeping.time_entry SET status = 'approved' WHERE id = $1", [
      unapproved,
    ]);
    const ok = await ticketRun("2027-05-31");
    expect(ok.statusCode).toBe(201);
    const [inv] = (await invoicesOf(ok.json().id)).filter((i) => i.companyId === co);
    expect(inv?.subtotal).toBe("500.00");
    expect((await entry(e1)).invoice).toBe(inv?.id);
    expect(openStatus).toBeGreaterThan(0);
  });

  it("bills the parent company when the customer has a bill-to company", async () => {
    const parent = await company();
    const child = await company(`${parent}`);
    const t = await ticket(child);
    await logTime(t, 1, "2027-06-01");
    const res = await ticketRun("2027-06-30");
    expect(res.statusCode).toBe(201);
    const invs = await invoicesOf(res.json().id);
    expect(invs.some((i) => i.companyId === parent)).toBe(true);
    expect(invs.some((i) => i.companyId === child)).toBe(false);
  });

  it("freezes time when the run is posted, and releases it on void", async () => {
    const co = await company();
    const t = await ticket(co);
    const e = await logTime(t, 2, "2027-07-01");
    const res = await ticketRun("2027-07-31");
    expect(res.statusCode).toBe(201);
    const runId = res.json().id as number;
    const [inv] = (await invoicesOf(runId)).filter((i) => i.companyId === co);

    expect((await entry(e)).status).toBe("approved"); // draft: linked, not yet billed
    const posted = await call("POST", `/api/v1/billing/runs/${runId}/post`);
    expect(posted.statusCode).toBe(200);
    expect((await entry(e)).status).toBe("billed");

    const edit = await call("PATCH", `/api/v1/time-entries/${e}`, { hours: 3 });
    expect(edit.statusCode).toBeGreaterThanOrEqual(400);

    const voided = await call("POST", `/api/v1/billing/invoices/${inv?.id}/void`, {
      reason: "Wrong customer",
    });
    expect(voided.statusCode).toBe(200);
    expect(await entry(e)).toMatchObject({ status: "approved", invoice: null, line: null });

    const rebill = await ticketRun("2027-07-31");
    expect(rebill.statusCode).toBe(201);
  });

  it("releases time when a draft line, invoice or run is thrown away", async () => {
    const co = await company();
    const t1 = await ticket(co);
    const t2 = await ticket(co);
    const e1 = await logTime(t1, 1, "2027-08-02");
    const e2 = await logTime(t2, 1, "2027-08-03");
    const res = await ticketRun("2027-08-31");
    expect(res.statusCode).toBe(201);
    const runId = res.json().id as number;
    const [inv] = (await invoicesOf(runId)).filter((i) => i.companyId === co);
    const first = inv?.lines.find((l) => l.ticketId === t1);

    const del = await call("DELETE", `/api/v1/billing/invoices/${inv?.id}/lines/${first?.id}`);
    expect(del.statusCode).toBe(200);
    expect((await entry(e1)).invoice).toBeNull();
    expect((await entry(e2)).invoice).toBe(inv?.id);

    const discard = await call("POST", `/api/v1/billing/runs/${runId}/discard`);
    expect(discard.statusCode).toBe(200);
    expect((await entry(e2)).invoice).toBeNull();

    const again = await ticketRun("2027-08-31");
    expect(again.statusCode).toBe(201);
  });

  it("links time that sits in a locked pay period", async () => {
    const co = await company();
    const t = await ticket(co);
    const e = await logTime(t, 1, "2027-09-01");
    await pool.query(
      "INSERT INTO timekeeping.pay_period (start_date, end_date, status, locked_at) VALUES ('2027-08-30','2027-09-12','locked', now())",
    );
    const res = await ticketRun("2027-09-30");
    expect(res.statusCode).toBe(201);
    expect((await entry(e)).invoice).not.toBeNull();
  });
});
