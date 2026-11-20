import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("project invoicing (integration)", () => {
  const dbName = `hoosier_proj_bill_test_${process.pid}`;
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

  const company = async () => {
    seq += 1;
    return one(
      `INSERT INTO crm.company (identifier, name, status_id)
       VALUES ('C${seq}-${process.pid}','Co ${seq}',${status}) RETURNING id`,
    );
  };
  const makeProject = async (companyId: number, extra: object = {}) => {
    const r = await call("POST", "/api/v1/projects", {
      companyId,
      name: `Job ${++seq}`,
      billingMethod: "fixed_fee",
      billingAmount: 10000,
      poNumber: "PO-77",
      ...extra,
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as number;
  };
  const setStatus = async (projectId: number, s: string) =>
    expect((await call("PATCH", `/api/v1/projects/${projectId}`, { status: s })).statusCode).toBe(
      200,
    );
  const projectTicket = async (companyId: number, projectId: number, phaseId?: number) => {
    const t = await call("POST", "/api/v1/tickets", {
      summary: "Install",
      companyId,
      boardId: board,
      projectId,
      phaseId,
    });
    expect(t.statusCode).toBe(201);
    return t.json().id as number;
  };
  const closeTicket = (id: number) =>
    pool.query("UPDATE service.ticket SET status_id = $2 WHERE id = $1", [id, closedStatus]);
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
  const run = (projectId: number, mode: string, extra: object = {}) =>
    call("POST", "/api/v1/billing/runs", {
      kind: "project",
      projectId,
      mode,
      invoiceDate: "2027-03-01",
      ...extra,
    });
  type Inv = {
    id: number;
    poNumber: string | null;
    subtotal: string;
    total: string;
    lines: Array<{ kind: string; amount: string; description: string; quantity: string }>;
  };
  const invoicesOf = async (runId: number) => {
    const summaries = (await call("GET", `/api/v1/billing/runs/${runId}`)).json().invoices ?? [];
    const out: Inv[] = [];
    for (const i of summaries as Array<{ id: number }>)
      out.push((await call("GET", `/api/v1/billing/invoices/${i.id}`)).json() as Inv);
    return out;
  };
  const post = async (runId: number) =>
    expect((await call("POST", `/api/v1/billing/runs/${runId}/post`)).statusCode).toBe(200);

  it("bills time and materials at actual rates, and ticket runs leave project work alone", async () => {
    const co = await company();
    const p = await makeProject(co, { billingMethod: "actual_rates", billingAmount: undefined });
    const t = await projectTicket(co, p);
    const e1 = await logTime(t, 2, "2027-03-02");
    const e2 = await logTime(t, 3, "2027-03-03");
    await logTime(t, 1, "2027-03-20"); // after the cut-off
    const ch = await call("POST", `/api/v1/tickets/${t}/charges`, {
      kind: "expense",
      description: "Lift rental",
      quantity: 1,
      unitPrice: 50,
    });
    expect(ch.statusCode).toBe(201);

    const ticketRun = await call("POST", "/api/v1/billing/runs", {
      kind: "ticket",
      throughDate: "2027-03-31",
      invoiceDate: "2027-03-31",
      preview: true,
    });
    const inTicketRun = (ticketRun.json().invoices ?? []).some(
      (i: { companyId: number }) => i.companyId === co,
    );
    expect(inTicketRun).toBe(false);

    const wrongMode = await run(p, "deposit", { amount: 100 });
    expect(wrongMode.statusCode).toBe(422);
    const noDate = await run(p, "time_materials");
    expect(noDate.statusCode).toBe(400);

    const res = await run(p, "time_materials", { throughDate: "2027-03-10" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      kind: "project",
      projectId: p,
      projectMode: "time_materials",
    });
    const [inv] = await invoicesOf(res.json().id);
    expect(inv?.poNumber).toBe("PO-77");
    // 5 h at $100 labor plus the $50 expense
    expect(inv?.subtotal).toBe("550.00");
    expect(inv?.lines.map((l) => l.kind).sort()).toEqual(["expense", "time"]);
    expect((await entry(e1)).invoice).toBe(inv?.id);
    expect((await entry(e2)).invoice).toBe(inv?.id);

    // nothing to double-bill
    const again = await run(p, "time_materials", { throughDate: "2027-03-10" });
    expect(again.statusCode).toBe(422);

    await post(res.json().id);
    expect((await entry(e1)).status).toBe("billed");
    // the straggler bills in a later run
    const later = await run(p, "time_materials", { throughDate: "2027-03-31" });
    expect(later.statusCode).toBe(201);
    expect((await invoicesOf(later.json().id))[0]?.subtotal).toBe("100.00");
  });

  it("caps not-to-exceed project labor across runs and applies an override rate", async () => {
    const co = await company();
    const capped = await makeProject(co, { billingMethod: "not_to_exceed", billingAmount: 450 });
    const t = await projectTicket(co, capped);
    await logTime(t, 3, "2027-04-01");
    await logTime(t, 3, "2027-04-02");
    const first = await run(capped, "time_materials", { throughDate: "2027-04-30" });
    expect(first.statusCode).toBe(201);
    expect((await invoicesOf(first.json().id))[0]?.subtotal).toBe("450.00");
    await post(first.json().id);
    await logTime(t, 2, "2027-04-03");
    const second = await run(capped, "time_materials", { throughDate: "2027-04-30" });
    expect(second.statusCode).toBe(422); // cap already billed

    const flat = await makeProject(co, { billingMethod: "override_rate", billingAmount: 80 });
    const t2 = await projectTicket(co, flat);
    await logTime(t2, 2, "2027-04-05");
    const r = await run(flat, "time_materials", { throughDate: "2027-04-30" });
    expect((await invoicesOf(r.json().id))[0]?.subtotal).toBe("160.00");
  });

  it("bills a fixed fee as deposit, progress and final, and never more than the fee", async () => {
    const co = await company();
    const p = await makeProject(co); // $10,000
    const t = await projectTicket(co, p);
    const e1 = await logTime(t, 4, "2027-05-03");

    const tm = await run(p, "time_materials", { throughDate: "2027-05-31" });
    expect(tm.statusCode).toBe(422);

    const dep = await run(p, "deposit", { percent: 25 });
    expect(dep.statusCode).toBe(201);
    const [depInv] = await invoicesOf(dep.json().id);
    expect(depInv?.subtotal).toBe("2500.00");
    expect(depInv?.lines[0]).toMatchObject({ kind: "fee", amount: "2500.00" });
    expect(depInv?.lines[0]?.description).toContain("Down payment");
    expect((await entry(e1)).invoice).toBeNull(); // a deposit does not take time
    await post(dep.json().id);

    const prog = await run(p, "progress", {
      amount: 4000,
      description: "Milestone 2: rough-in complete",
    });
    expect(prog.statusCode).toBe(201);
    expect((await invoicesOf(prog.json().id))[0]?.lines[0]?.description).toBe(
      "Milestone 2: rough-in complete",
    );

    // 10,000 - 2,500 - 4,000 (draft counts) = 3,500 left
    const tooMuch = await run(p, "progress", { amount: 3600 });
    expect(tooMuch.statusCode).toBe(422);
    expect(tooMuch.json().detail).toContain("3500.00");

    const early = await run(p, "final");
    expect(early.statusCode).toBe(422); // not ready to invoice
    await setStatus(p, "ready_to_invoice");
    await logTime(t, 1, "2027-05-04", false);
    const unapproved = await run(p, "final");
    expect(unapproved.statusCode).toBe(422);
    await pool.query(
      "UPDATE timekeeping.time_entry SET status = 'approved' WHERE status = 'submitted' OR status = 'open'",
    );
    await post(prog.json().id);

    const ch = await call("POST", `/api/v1/tickets/${t}/charges`, {
      kind: "expense",
      description: "Permit",
      quantity: 1,
      unitPrice: 200,
    });
    expect(ch.statusCode).toBe(201);
    const fin = await run(p, "final");
    expect(fin.statusCode).toBe(201);
    const [finInv] = await invoicesOf(fin.json().id);
    expect(finInv?.subtotal).toBe("3700.00"); // 3,500 fee + 200 permit
    const fee = finInv?.lines.find((l) => l.kind === "fee");
    expect(fee?.amount).toBe("3500.00");
    expect(fee?.description).toContain("6500.00 billed to date");
    expect((await entry(e1)).invoice).toBe(finInv?.id); // time closed out with the final

    const dup = await run(p, "final");
    expect(dup.statusCode).toBe(409);
    await post(fin.json().id);
    expect((await entry(e1)).status).toBe("billed");

    // voiding the final frees the fee and the time
    const voided = await call("POST", `/api/v1/billing/invoices/${finInv?.id}/void`, {
      reason: "Customer dispute",
    });
    expect(voided.statusCode).toBe(200);
    expect((await entry(e1)).status).toBe("approved");
    const redo = await run(p, "final");
    expect(redo.statusCode).toBe(201);
  });

  it("closes out a fully billed fee with a zero line that carries the time", async () => {
    const co = await company();
    const p = await makeProject(co, { billingAmount: 1000 });
    const t = await projectTicket(co, p);
    const e = await logTime(t, 2, "2027-06-01");
    const all = await run(p, "progress", { percent: 100 });
    expect(all.statusCode).toBe(201);
    await post(all.json().id);
    await setStatus(p, "ready_to_invoice");
    const fin = await run(p, "final");
    expect(fin.statusCode).toBe(201);
    const [inv] = await invoicesOf(fin.json().id);
    expect(inv?.total).toBe("0.00");
    expect(inv?.lines[0]?.description).toContain("billed to date");
    expect((await entry(e)).invoice).toBe(inv?.id);
    // with nothing left at all, there is nothing to bill
    const p2 = await makeProject(co, { billingAmount: 500, status: "ready_to_invoice" });
    const a = await run(p2, "progress", { percent: 100 });
    await post(a.json().id);
    expect((await run(p2, "final")).statusCode).toBe(422);
  });

  it("bills a separately billed phase on its own and leaves it out of the project", async () => {
    const co = await company();
    const p = await makeProject(co, { billingAmount: 6000 });
    const ph = (
      await call("POST", `/api/v1/projects/${p}/phases`, {
        name: "Phase 2",
        billSeparately: true,
        billingMethod: "fixed_fee",
        billingAmount: 2000,
      })
    ).json();
    const plain = (await call("POST", `/api/v1/projects/${p}/phases`, { name: "Phase 1" })).json();
    const tPhase = await projectTicket(co, p, ph.id);
    const tPlain = await projectTicket(co, p, plain.id);
    const e1 = await logTime(tPhase, 1, "2027-07-01");
    const e2 = await logTime(tPlain, 1, "2027-07-02");

    const notSep = await run(p, "deposit", { amount: 100, phaseId: plain.id });
    expect(notSep.statusCode).toBe(422);
    const dep = await run(p, "deposit", { percent: 50, phaseId: ph.id });
    expect(dep.statusCode).toBe(201);
    expect((await invoicesOf(dep.json().id))[0]?.subtotal).toBe("1000.00");
    expect(dep.json()).toMatchObject({ phaseId: ph.id });
    // the project's own fee is untouched by the phase deposit
    const proj = await run(p, "deposit", { percent: 100 });
    expect(proj.statusCode).toBe(201);
    expect((await invoicesOf(proj.json().id))[0]?.subtotal).toBe("6000.00");

    await post(dep.json().id);
    await post(proj.json().id);
    await setStatus(p, "ready_to_invoice");
    const finProject = await run(p, "final");
    expect(finProject.statusCode).toBe(201);
    // the project final takes Phase 1's time only
    expect((await entry(e2)).invoice).not.toBeNull();
    expect((await entry(e1)).invoice).toBeNull();
    // the phase needs its own tickets closed first
    const early = await run(p, "final", { phaseId: ph.id });
    expect(early.statusCode).toBe(422);
    await closeTicket(tPhase);
    const finPhase = await run(p, "final", { phaseId: ph.id });
    expect(finPhase.statusCode).toBe(201);
    expect(
      (await invoicesOf(finPhase.json().id))[0]?.lines.find((l) => l.kind === "fee")?.amount,
    ).toBe("1000.00");
    expect((await entry(e1)).invoice).not.toBeNull();
  });

  it("reports where each scope stands", async () => {
    const co = await company();
    const p = await makeProject(co, { billingAmount: 5000 });
    const t = await projectTicket(co, p);
    await logTime(t, 2, "2027-08-01");
    await logTime(t, 1, "2027-08-02", false);
    const dep = await run(p, "deposit", { amount: 1000 });
    expect(dep.statusCode).toBe(201);
    const b = await call("GET", `/api/v1/projects/${p}/billing`);
    expect(b.statusCode).toBe(200);
    expect(b.json().scopes[0]).toMatchObject({
      billingMethod: "fixed_fee",
      feeBilled: "1000.00",
      feeRemaining: "4000.00",
      finalBilled: false,
      invoicedToDate: "1000.00",
      unbilledHours: "2.00",
      unbilledLabor: "200.00",
      unapprovedEntries: 1,
      openTickets: 1,
    });
  });

  it("the database refuses fee lines beyond the fixed fee, whatever the code does", async () => {
    const co = await company();
    const p = await makeProject(co, { billingAmount: 300 });
    const inv = await one(
      `INSERT INTO billing.invoice (company_id, status, invoice_date, due_date, subtotal, tax_total, total)
       VALUES ($1,'draft','2027-09-01','2027-10-01',0,0,0) RETURNING id`,
      [co],
    );
    const line = (amount: number, n: number) =>
      pool.query(
        `INSERT INTO billing.invoice_line (invoice_id, line_no, kind, description, amount, project_id, project_fee)
         VALUES ($1,$2,'fee','fee',$3,$4,true)`,
        [inv, n, amount, p],
      );
    await line(200, 1);
    await expect(line(150, 2)).rejects.toThrow(/exceed the fixed fee/);
    await line(100, 3);
    const t = await makeProject(co, { billingMethod: "actual_rates", billingAmount: undefined });
    await expect(
      pool.query(
        `INSERT INTO billing.invoice_line (invoice_id, line_no, kind, description, amount, project_id, project_fee)
         VALUES ($1,4,'fee','fee',1,$2,true)`,
        [inv, t],
      ),
    ).rejects.toThrow(/not billed at a fixed fee/);
  });

  it("discarding a draft run releases the time and frees the fee", async () => {
    const co = await company();
    const p = await makeProject(co, { billingAmount: 800 });
    const t = await projectTicket(co, p);
    const e = await logTime(t, 1, "2027-10-01");
    await setStatus(p, "ready_to_invoice");
    const fin = await run(p, "final");
    expect(fin.statusCode).toBe(201);
    expect((await entry(e)).invoice).not.toBeNull();
    const d = await call("POST", `/api/v1/billing/runs/${fin.json().id}/discard`);
    expect(d.statusCode).toBe(200);
    expect((await entry(e)).invoice).toBeNull();
    expect((await run(p, "final")).statusCode).toBe(201);
  });
});
