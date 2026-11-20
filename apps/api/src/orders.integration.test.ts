import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("sales orders (integration)", () => {
  const dbName = `hoosier_order_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let boss: number;
  let manager: number;
  let tech: number;
  let seq = 0;
  let rep = 0;
  const salesRep = async () => rep;
  let boardId: number;
  const one = async (sql: string, params: unknown[] = []) =>
    Number((await pool.query<{ id: string }>(sql, params)).rows[0]?.id);
  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    who = boss,
  ) =>
    app.inject({
      method,
      url,
      headers: { "x-dev-member-id": String(who) },
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
    const member = async (id: string, role: string) => {
      const m = await one(
        "INSERT INTO iam.member (identifier, first_name, last_name, email) VALUES ($1,$2,'X',$3) RETURNING id",
        [id, id, `${id}@e.com`],
      );
      await pool.query(
        "INSERT INTO iam.member_role (member_id, role_id) SELECT $1, id FROM iam.role WHERE name = $2",
        [m, role],
      );
      return m;
    };
    boardId = await one("INSERT INTO service.board (name) VALUES ('Service') RETURNING id");
    await pool.query(
      "INSERT INTO service.board_status (board_id, name, is_default) VALUES ($1,'New',true)",
      [boardId],
    );
    boss = await member("boss", "Administrator");
    manager = await member("mgr", "Manager");
    tech = await member("tech", "Technician");
    rep = await member("rep", "Sales");
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
       VALUES ('O${seq}-${process.pid}','Order Co ${seq}',(SELECT id FROM crm.company_status WHERE name='Active')) RETURNING id`,
    );
  };
  const opp = async (companyId: number) =>
    (
      await call("POST", "/api/v1/sales/opportunities", {
        companyId,
        name: "Camera refresh",
        expectedAmount: 40000,
      })
    ).json() as { id: number };
  const order = async (extra: object = {}) => {
    const c = await company();
    const o = await opp(c);
    const r = await call("POST", "/api/v1/sales/orders", {
      opportunityId: o.id,
      billingMethod: "fixed_fee",
      billingAmount: 40000,
      ...extra,
    });
    expect(r.statusCode).toBe(201);
    return {
      c,
      o,
      order: r.json() as { id: number; status: string; companyId: number; name: string },
    };
  };

  it("creates an order from an opportunity, taking its customer and name", async () => {
    const { o, c, order: ord } = await order();
    expect(ord).toMatchObject({ companyId: c, name: "Camera refresh", status: "draft" });
    expect(o.id).toBeGreaterThan(0);
    const bad = await call("POST", "/api/v1/sales/orders", {
      opportunityId: o.id,
      billingMethod: "fixed_fee",
    });
    expect(bad.statusCode).toBe(400);
    const nothing = await call("POST", "/api/v1/sales/orders", { billingMethod: "actual_rates" });
    expect(nothing.statusCode).toBe(400);
  });

  it("keeps lines as a budget: totals and labor hours, nothing billed", async () => {
    const { order: ord } = await order();
    const base = `/api/v1/sales/orders/${ord.id}`;
    await call("POST", `${base}/lines`, {
      kind: "labor",
      description: "Install",
      quantity: 40,
      unitPrice: 125,
      unitCost: 60,
    });
    await call("POST", `${base}/lines`, {
      kind: "material",
      description: "Cameras",
      quantity: 10,
      unitPrice: 800,
      unitCost: 500,
    });
    const got = (await call("GET", base)).json();
    expect(got).toMatchObject({ linesTotal: "13000.00", laborHours: "40.000" });
    const lines = (await call("GET", `${base}/lines`)).json().items;
    expect(lines.map((l: { lineTotal: string }) => l.lineTotal)).toEqual(["5000.00", "8000.00"]);
    const upd = await call("PATCH", `${base}/lines/${lines[1].id}`, { quantity: 12 });
    expect(upd.json().lineTotal).toBe("9600.00");
    expect((await call("DELETE", `${base}/lines/${lines[1].id}`)).statusCode).toBe(204);
  });

  it("any billing method: actual rates drops the amount; others need one", async () => {
    const { order: ord } = await order();
    const tm = await call("PATCH", `/api/v1/sales/orders/${ord.id}`, {
      billingMethod: "actual_rates",
    });
    expect(tm.json()).toMatchObject({ billingMethod: "actual_rates", billingAmount: null });
    const nte = await call("PATCH", `/api/v1/sales/orders/${ord.id}`, {
      billingMethod: "not_to_exceed",
    });
    expect(nte.statusCode).toBe(422);
    const ok = await call("PATCH", `/api/v1/sales/orders/${ord.id}`, {
      billingMethod: "not_to_exceed",
      billingAmount: 25000,
    });
    expect(ok.json()).toMatchObject({ billingMethod: "not_to_exceed", billingAmount: "25000.00" });
  });

  it("milestones are payments against a fixed fee and cannot exceed it", async () => {
    const { order: ord } = await order();
    const url = `/api/v1/sales/orders/${ord.id}/milestones`;
    const dep = await call("POST", url, { name: "Deposit", kind: "deposit", percent: 30 });
    expect(dep.json()).toMatchObject({ resolvedAmount: "12000.00", billed: false });
    const prog = await call("POST", url, { name: "Rough-in", amount: 20000 });
    expect(prog.statusCode).toBe(201);
    const over = await call("POST", url, { name: "Too much", amount: 9000 });
    expect(over.statusCode).toBe(422);
    const both = await call("POST", url, { name: "x", amount: 100, percent: 5 });
    expect(both.statusCode).toBe(400);
    const lower = await call("PATCH", `/api/v1/sales/orders/${ord.id}`, { billingAmount: 25000 });
    expect(lower.statusCode).toBe(422);
    const tm = await call("PATCH", `/api/v1/sales/orders/${ord.id}`, {
      billingMethod: "actual_rates",
    });
    expect(tm.statusCode).toBe(422);
    expect((await call("GET", url)).json().items).toHaveLength(2);
  });

  it("converts only when approved: project, phases, milestones, links and the opportunity win", async () => {
    const { o, order: ord } = await order({ poNumber: "PO-77", poAmount: 40000 });
    const base = `/api/v1/sales/orders/${ord.id}`;
    await call("POST", `${base}/lines`, {
      kind: "labor",
      description: "Install",
      quantity: 80,
      unitPrice: 125,
    });
    await call("POST", `${base}/milestones`, { name: "Deposit", kind: "deposit", percent: 25 });
    await call("POST", `/api/v1/sales/external-refs?entityType=opportunity&entityId=${o.id}`, {
      provider: "smart_pricing_tables",
      kind: "quote",
      externalId: "Q-9",
    });
    await call("POST", `/api/v1/sales/external-refs?entityType=sales_order&entityId=${ord.id}`, {
      provider: "sembleai",
      kind: "design",
      externalId: "D-4",
    });
    const early = await call("POST", `${base}/convert`, {});
    expect(early.statusCode).toBe(422);
    await call("PATCH", base, { status: "approved" });
    const forbidden = await call("POST", `${base}/convert`, {}, await salesRep());
    expect(forbidden.statusCode).toBe(403);
    const r = await call("POST", `${base}/convert`, { phases: ["Design", "Install"] });
    expect(r.statusCode).toBe(201);
    const projectId = r.json().projectId as number;
    const proj = (await call("GET", `/api/v1/projects/${projectId}`)).json();
    expect(proj).toMatchObject({
      name: "Camera refresh",
      billingMethod: "fixed_fee",
      billingAmount: "40000.00",
      poNumber: "PO-77",
      budgetHours: "80.00",
    });
    expect(proj.phases.map((p: { name: string }) => p.name)).toEqual(["Design", "Install"]);
    const ms = (await call("GET", `/api/v1/projects/${projectId}/milestones`)).json().items;
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ projectId, resolvedAmount: "10000.00" });
    const refs = (
      await call("GET", `/api/v1/sales/external-refs?entityType=project&entityId=${projectId}`)
    ).json().items;
    expect(refs.map((x: { externalId: string }) => x.externalId).sort()).toEqual(["D-4", "Q-9"]);
    expect((await call("GET", `/api/v1/sales/opportunities/${o.id}`)).json()).toMatchObject({
      isWon: true,
    });
    expect((await call("GET", base)).json()).toMatchObject({ status: "converted", projectId });
    const again = await call("POST", `${base}/convert`, {});
    expect(again.statusCode).toBe(409);
    const edit = await call("PATCH", base, { name: "nope" });
    expect(edit.statusCode).toBe(409);
  });

  it("time and materials orders convert the same way, with no fee", async () => {
    const { order: ord } = await order({ billingMethod: "actual_rates", billingAmount: null });
    const base = `/api/v1/sales/orders/${ord.id}`;
    await call("PATCH", base, { status: "approved" });
    const r = await call("POST", `${base}/convert`, {});
    const proj = (await call("GET", `/api/v1/projects/${r.json().projectId}`)).json();
    expect(proj).toMatchObject({ billingMethod: "actual_rates", billingAmount: null });
  });

  it("a milestone fills the Bill dialog, is marked billed, and frees up if the invoice is voided", async () => {
    const { order: ord } = await order();
    const base = `/api/v1/sales/orders/${ord.id}`;
    const m = (
      await call("POST", `${base}/milestones`, { name: "Deposit", kind: "deposit", percent: 25 })
    ).json();
    await call("PATCH", base, { status: "approved" });
    const projectId = (await call("POST", `${base}/convert`, {})).json().projectId as number;
    const run = (body: object) =>
      call("POST", "/api/v1/billing/runs", {
        kind: "project",
        projectId,
        mode: "deposit",
        ...body,
      });
    const wrong = await run({ percent: 25, milestoneId: m.id + 999 });
    expect(wrong.statusCode).toBe(422);
    const r = await run({ percent: 25, description: "Deposit", milestoneId: m.id });
    expect(r.statusCode).toBe(201);
    const listed = (await call("GET", `/api/v1/projects/${projectId}/milestones`)).json().items;
    expect(listed[0].billed).toBe(true);
    const twice = await run({ percent: 25, milestoneId: m.id });
    expect(twice.statusCode).toBe(409);
    const edit = await call("PATCH", `/api/v1/sales/milestones/${m.id}`, { percent: 50 });
    expect(edit.statusCode).toBe(409);
    const del = await call("DELETE", `/api/v1/sales/milestones/${m.id}`);
    expect(del.statusCode).toBe(409);
    const invoiceId = (await call("GET", `/api/v1/billing/runs/${r.json().id}`)).json().invoices[0]
      .id;
    expect(
      (await call("POST", `/api/v1/billing/runs/${r.json().id}/post`)).statusCode,
    ).toBeLessThan(300);
    const voided = await call("POST", `/api/v1/billing/invoices/${invoiceId}/void`, {
      reason: "Wrong customer",
    });
    expect(voided.statusCode).toBeLessThan(300);
    expect(
      (await call("GET", `/api/v1/projects/${projectId}/milestones`)).json().items[0].billed,
    ).toBe(false);
    const nonPayment = await call("POST", "/api/v1/billing/runs", {
      kind: "project",
      projectId,
      mode: "time_materials",
      throughDate: "2030-01-01",
      milestoneId: m.id,
    });
    expect(nonPayment.statusCode).toBe(422);
  });

  it("permissions: orders need sales.order access", async () => {
    const { order: ord } = await order();
    expect((await call("GET", `/api/v1/sales/orders/${ord.id}`, undefined, tech)).statusCode).toBe(
      403,
    );
    expect(
      (await call("GET", `/api/v1/sales/orders/${ord.id}`, undefined, manager)).statusCode,
    ).toBe(200);
  });
});
