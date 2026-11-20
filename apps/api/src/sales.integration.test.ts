import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("sales opportunities (integration)", () => {
  const dbName = `hoosier_sales_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let boss: number;
  let manager: number;
  let tech: number;
  let seq = 0;
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
       VALUES ('S${seq}-${process.pid}','Sales Co ${seq}',(SELECT id FROM crm.company_status WHERE name='Active')) RETURNING id`,
    );
  };
  const stages = async () =>
    (
      (await call("GET", "/api/v1/sales/stages")).json().items as Array<{
        id: number;
        name: string;
      }>
    ).reduce((m, s) => Object.assign(m, { [s.name]: s.id }), {} as Record<string, number>);
  const make = async (companyId: number, extra: object = {}) => {
    const r = await call("POST", "/api/v1/sales/opportunities", {
      companyId,
      name: "Access control upgrade",
      expectedAmount: 20000,
      ...extra,
    });
    expect(r.statusCode).toBe(201);
    return r.json() as { id: number; stage: string; weightedAmount: string };
  };

  it("seeds stages and creates an opportunity in the first open stage, owned by the creator", async () => {
    const st = await stages();
    expect(Object.keys(st)).toEqual(
      expect.arrayContaining(["Qualify", "Proposal sent", "Won", "Lost"]),
    );
    const c = await company();
    const o = await make(c);
    expect(o).toMatchObject({ stage: "Qualify", weightedAmount: "2000.00", ownerMemberId: boss });
  });

  it("moves through stages; weighted value follows; won stamps the close; lost needs a reason", async () => {
    const st = await stages();
    const c = await company();
    const o = await make(c);
    const prop = await call("PATCH", `/api/v1/sales/opportunities/${o.id}`, {
      stageId: st["Proposal sent"],
    });
    expect(prop.json()).toMatchObject({
      stage: "Proposal sent",
      weightedAmount: "10000.00",
      closedAt: null,
    });
    const lostNoReason = await call("PATCH", `/api/v1/sales/opportunities/${o.id}`, {
      stageId: st.Lost,
    });
    expect(lostNoReason.statusCode).toBeGreaterThanOrEqual(400);
    const lost = await call("PATCH", `/api/v1/sales/opportunities/${o.id}`, {
      stageId: st.Lost,
      lostReason: "Went with incumbent",
    });
    expect(lost.json()).toMatchObject({ isLost: true, lostReason: "Went with incumbent" });
    expect(lost.json().closedAt).not.toBeNull();
    const reopened = await call("PATCH", `/api/v1/sales/opportunities/${o.id}`, {
      stageId: st.Negotiation,
    });
    expect(reopened.json()).toMatchObject({ closedAt: null, lostReason: null });
    const won = await call("PATCH", `/api/v1/sales/opportunities/${o.id}`, { stageId: st.Won });
    expect(won.json()).toMatchObject({ isWon: true });
    expect(won.json().closedAt).not.toBeNull();
  });

  it("filters the list by state and reports the open pipeline by stage", async () => {
    const st = await stages();
    const c = await company();
    const a = await make(c, { name: "A", expectedAmount: 1000 });
    const b = await make(c, { name: "B", expectedAmount: 3000 });
    await call("PATCH", `/api/v1/sales/opportunities/${b.id}`, { stageId: st.Won });
    const open = (await call("GET", `/api/v1/sales/opportunities?companyId=${c}`)).json().items;
    expect(open.map((x: { name: string }) => x.name)).toEqual(["A"]);
    const won = (await call("GET", `/api/v1/sales/opportunities?companyId=${c}&state=won`)).json()
      .items;
    expect(won).toHaveLength(1);
    const pipe = (await call("GET", "/api/v1/sales/pipeline")).json().items as Array<{
      stage: string;
      count: number;
    }>;
    expect(pipe.find((p) => p.stage === "Qualify")?.count).toBeGreaterThanOrEqual(1);
    expect(pipe.some((p) => p.stage === "Won")).toBe(false);
    expect(a.id).toBeGreaterThan(0);
  });

  it("checks that the site and contact belong to the company", async () => {
    const c1 = await company();
    const c2 = await company();
    const site = await one(
      "INSERT INTO crm.site (company_id, name) VALUES ($1,'HQ') RETURNING id",
      [c2],
    );
    const bad = await call("POST", "/api/v1/sales/opportunities", {
      companyId: c1,
      name: "x",
      siteId: site,
    });
    expect(bad.statusCode).toBe(422);
  });

  it("logs activities and completes tasks", async () => {
    const c = await company();
    const o = await make(c);
    const call1 = await call("POST", `/api/v1/sales/opportunities/${o.id}/activities`, {
      kind: "call",
      subject: "Intro call",
      body: "Wants 12 doors",
    });
    expect(call1.statusCode).toBe(201);
    const noDue = await call("POST", `/api/v1/sales/opportunities/${o.id}/activities`, {
      kind: "call",
      subject: "x",
      dueDate: "2027-01-05",
    });
    expect(noDue.statusCode).toBe(422);
    const task = await call("POST", `/api/v1/sales/opportunities/${o.id}/activities`, {
      kind: "task",
      subject: "Send site walk notes",
      dueDate: "2027-01-05",
    });
    expect(task.json()).toMatchObject({ assignedMemberId: boss, completedAt: null });
    expect((await call("GET", `/api/v1/sales/opportunities/${o.id}`)).json().openTasks).toBe(1);
    const done = await call(
      "PATCH",
      `/api/v1/sales/opportunities/${o.id}/activities/${task.json().id}`,
      {
        completed: true,
      },
    );
    expect(done.json().completedAt).not.toBeNull();
    expect((await call("GET", `/api/v1/sales/opportunities/${o.id}`)).json().openTasks).toBe(0);
    const completeCall = await call(
      "PATCH",
      `/api/v1/sales/opportunities/${o.id}/activities/${call1.json().id}`,
      { completed: true },
    );
    expect(completeCall.statusCode).toBe(422);
    const list = (await call("GET", `/api/v1/sales/opportunities/${o.id}/activities`)).json().items;
    expect(list).toHaveLength(2);
    const del = await call(
      "DELETE",
      `/api/v1/sales/opportunities/${o.id}/activities/${call1.json().id}`,
    );
    expect(del.statusCode).toBe(204);
  });

  it("links quotes and designs from other systems once, and lists and removes them", async () => {
    const c = await company();
    const o = await make(c);
    const url = `/api/v1/sales/external-refs?entityType=opportunity&entityId=${o.id}`;
    const quote = await call("POST", url, {
      provider: "smart_pricing_tables",
      kind: "quote",
      externalId: "Q-1001",
      version: "3",
      status: "sent",
      amount: 18250,
      url: "https://example.com/q/1001",
    });
    expect(quote.statusCode).toBe(201);
    const design = await call("POST", url, {
      provider: "sembleai",
      kind: "design",
      externalId: "proj-77",
    });
    expect(design.statusCode).toBe(201);
    const dup = await call("POST", url, {
      provider: "smart_pricing_tables",
      kind: "quote",
      externalId: "Q-1001",
    });
    expect(dup.statusCode).toBe(409);
    const badUrl = await call("POST", url, {
      provider: "other",
      kind: "document",
      externalId: "d1",
      url: "javascript:alert(1)",
    });
    expect(badUrl.statusCode).toBe(400);
    const list = (await call("GET", url)).json().items;
    expect(list.map((r: { kind: string }) => r.kind)).toEqual(["design", "quote"]);
    expect(
      (await call("DELETE", `/api/v1/sales/external-refs/${quote.json().id}`)).statusCode,
    ).toBe(204);
    expect((await call("GET", url)).json().items).toHaveLength(1);
    const missing = await call(
      "POST",
      "/api/v1/sales/external-refs?entityType=opportunity&entityId=999999",
      { provider: "other", kind: "other", externalId: "z" },
    );
    expect(missing.statusCode).toBe(404);
  });

  it("permissions: sales and managers write; technicians have no access", async () => {
    const c = await company();
    const o = await make(c);
    expect(
      (await call("GET", `/api/v1/sales/opportunities/${o.id}`, undefined, manager)).statusCode,
    ).toBe(200);
    expect(
      (await call("GET", `/api/v1/sales/opportunities/${o.id}`, undefined, tech)).statusCode,
    ).toBe(403);
    expect(
      (await call("POST", "/api/v1/sales/opportunities", { companyId: c, name: "n" }, tech))
        .statusCode,
    ).toBe(403);
  });
});
