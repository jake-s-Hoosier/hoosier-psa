import { ensureMarker, migrateUp } from "@hoosier/db";
import { agreementStatus } from "@hoosier/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("agreements API (integration)", () => {
  const dbName = `hoosier_ag_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let boss: number;
  let tech: number;
  let acme: number;
  let other: number;
  let typeId: number;
  let boardId: number;
  const as = (id: number) => ({ "x-dev-member-id": String(id) });
  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, who = boss) =>
    app.inject({ method, url, headers: as(who), payload: payload as object | undefined });
  const one = async (sql: string, params: unknown[] = []) =>
    Number((await pool.query<{ id: string }>(sql, params)).rows[0]?.id);
  const iso = (offsetDays: number) =>
    new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

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
    tech = await one(
      "INSERT INTO iam.member (identifier, first_name, last_name, email, hourly_cost) VALUES ('t','Tess','Tech','t@e.com',30) RETURNING id",
    );
    await pool.query(
      "INSERT INTO iam.member_role (member_id, role_id) SELECT $1, id FROM iam.role WHERE name = 'Administrator'",
      [boss],
    );
    await pool.query(
      "INSERT INTO iam.member_role (member_id, role_id) SELECT $1, id FROM iam.role WHERE name = 'Technician'",
      [tech],
    );
    const status = "(SELECT id FROM crm.company_status WHERE name='Active')";
    acme = await one(
      `INSERT INTO crm.company (identifier, name, status_id) VALUES ('ACME','Acme',${status}) RETURNING id`,
    );
    other = await one(
      `INSERT INTO crm.company (identifier, name, status_id) VALUES ('OTH','Other Co',${status}) RETURNING id`,
    );
    boardId = await one("INSERT INTO service.board (name) VALUES ('Service') RETURNING id");
    await pool.query(
      "INSERT INTO service.board_status (board_id, name, is_default) VALUES ($1,'New',true)",
      [boardId],
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
    const t = await call("POST", "/api/v1/agreements/types", {
      name: "ESP",
      billCycle: "quarterly",
      coverage: "unlimited_remote",
      autoRenew: false,
    });
    typeId = t.json().id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  const make = async (extra: object = {}) => {
    const res = await call("POST", "/api/v1/agreements", {
      companyId: acme,
      typeId,
      name: "Acme ESP",
      startDate: iso(-100),
      ...extra,
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  it("keeps agreements away from staff without the permission", async () => {
    expect((await call("GET", "/api/v1/agreements", undefined, tech)).statusCode).toBe(403);
    expect((await call("POST", "/api/v1/agreements", {}, tech)).statusCode).toBe(403);
  });

  it("creates an agreement that inherits its type's terms and bills the company itself", async () => {
    const a = await make();
    expect(a).toMatchObject({
      company: "Acme",
      billToCompany: "Acme",
      type: "ESP",
      billCycle: "quarterly",
      coverage: "unlimited_remote",
      autoRenew: false,
      status: "active",
      rmr: "0.00",
    });
    expect(a.billStartDate).toBe(a.startDate);
  });

  it("rejects a missing company, a bad type and backwards dates", async () => {
    const bad = (extra: object) =>
      call("POST", "/api/v1/agreements", {
        companyId: acme,
        typeId,
        name: "x",
        startDate: iso(0),
        ...extra,
      });
    expect((await bad({ companyId: 99999 })).statusCode).toBe(422);
    expect((await bad({ typeId: 99999 })).statusCode).toBe(422);
    expect((await bad({ endDate: iso(-5) })).statusCode).toBe(400);
  });

  it("agrees with the shared status rules for every state", async () => {
    const cases: Array<{ name: string; extra: object }> = [
      { name: "s-active", extra: { startDate: iso(-10) } },
      { name: "s-pending", extra: { startDate: iso(10) } },
      { name: "s-expired", extra: { startDate: iso(-90), endDate: iso(-5), autoRenew: false } },
      { name: "s-renewing", extra: { startDate: iso(-90), endDate: iso(-5), autoRenew: true } },
    ];
    for (const c of cases) {
      const a = await make({ name: c.name, ...c.extra });
      const expected = agreementStatus(
        { startDate: a.startDate, endDate: a.endDate, autoRenew: a.autoRenew, cancelledDate: null },
        iso(0),
      );
      expect(a.status, c.name).toBe(expected);
    }
    const cancelled = await make({ name: "s-cancelled" });
    await call("POST", `/api/v1/agreements/${cancelled.id}/cancel`, {
      date: iso(-1),
      reason: "Sold",
    });
    const list = (status: string) =>
      call("GET", `/api/v1/agreements?status=${status}&q=s-`).then((r) =>
        r.json().items.map((i: { name: string }) => i.name),
      );
    expect(await list("pending")).toEqual(["s-pending"]);
    expect(await list("expired")).toEqual(["s-expired"]);
    expect(await list("cancelled")).toEqual(["s-cancelled"]);
    expect((await list("active")).sort()).toEqual(["s-active", "s-renewing"]);
    expect((await list("all")).length).toBe(5);
  });

  it("totals recurring revenue and cost from the lines in effect", async () => {
    const a = await make({ name: "rmr" });
    const add = (body: object) => call("POST", `/api/v1/agreements/${a.id}/additions`, body);
    expect(
      (
        await add({
          description: "Monitoring",
          quantity: 2,
          unitPrice: 49.99,
          unitCost: 20,
          effectiveFrom: iso(-30),
        })
      ).statusCode,
    ).toBe(201);
    await add({ description: "Future", quantity: 1, unitPrice: 500, effectiveFrom: iso(30) });
    await add({
      description: "Ended",
      quantity: 1,
      unitPrice: 75,
      effectiveFrom: iso(-60),
      effectiveTo: iso(-10),
    });
    const d = (await call("GET", `/api/v1/agreements/${a.id}`)).json();
    expect(d.rmr).toBe("99.98");
    expect(d.monthlyCost).toBe("40.00");
    expect(d.additions).toHaveLength(3);
  });

  it("changes a price by closing the old line and opening a new one", async () => {
    const a = await make({ name: "history" });
    const first = (
      await call("POST", `/api/v1/agreements/${a.id}/additions`, {
        description: "Cloud",
        quantity: 1,
        unitPrice: 100,
        effectiveFrom: iso(-60),
      })
    ).json();
    const changed = await call("POST", `/api/v1/agreements/${a.id}/additions/${first.id}/change`, {
      effectiveFrom: iso(-1),
      unitPrice: 120,
    });
    expect(changed.statusCode).toBe(201);
    expect(changed.json()).toMatchObject({
      unitPrice: 120,
      quantity: 1,
      description: "Cloud",
      effectiveTo: null,
    });
    const d = (await call("GET", `/api/v1/agreements/${a.id}`)).json();
    expect(d.rmr).toBe("120.00");
    const old = d.additions.find((x: { id: number }) => x.id === first.id);
    expect(old.effectiveTo).toBe(iso(-2));
    expect(old.unitPrice).toBe(100);
    // Cannot backdate a change to or before the line's own start.
    const bad = await call(
      "POST",
      `/api/v1/agreements/${a.id}/additions/${changed.json().id}/change`,
      {
        effectiveFrom: iso(-1),
        unitPrice: 130,
      },
    );
    expect(bad.statusCode).toBe(422);
  });

  it("refuses to edit price, quantity or start in place, even directly in the database", async () => {
    const a = await make({ name: "guard" });
    const line = (
      await call("POST", `/api/v1/agreements/${a.id}/additions`, {
        description: "X",
        quantity: 1,
        unitPrice: 10,
        effectiveFrom: iso(-5),
      })
    ).json();
    await expect(
      pool.query("UPDATE billing.agreement_addition SET unit_price = 11 WHERE id = $1", [line.id]),
    ).rejects.toThrow(/not edited in place/);
    const ok = await call("PATCH", `/api/v1/agreements/${a.id}/additions/${line.id}`, {
      description: "Renamed",
      prorate: false,
    });
    expect(ok.json()).toMatchObject({ description: "Renamed", prorate: false });
    const ended = await call("POST", `/api/v1/agreements/${a.id}/additions/${line.id}/end`, {
      date: iso(-2),
    });
    expect(ended.json().effectiveTo).toBe(iso(-2));
    const early = await call("POST", `/api/v1/agreements/${a.id}/additions/${line.id}/end`, {
      date: iso(-30),
    });
    expect(early.statusCode).toBe(422);
  });

  it("cancelling ends the lines on that date and keeps history", async () => {
    const a = await make({ name: "cancel me" });
    await call("POST", `/api/v1/agreements/${a.id}/additions`, {
      description: "Open-ended",
      quantity: 1,
      unitPrice: 50,
      effectiveFrom: iso(-20),
    });
    await call("POST", `/api/v1/agreements/${a.id}/additions`, {
      description: "Starts later",
      quantity: 1,
      unitPrice: 5,
      effectiveFrom: iso(15),
    });
    const res = await call("POST", `/api/v1/agreements/${a.id}/cancel`, {
      date: iso(-1),
      reason: "Moved away",
    });
    expect(res.json()).toMatchObject({
      status: "cancelled",
      cancelReason: "Moved away",
      rmr: "0.00",
    });
    const d = (await call("GET", `/api/v1/agreements/${a.id}`)).json();
    expect(d.additions).toHaveLength(1); // the line that never started was dropped
    expect(d.additions[0].effectiveTo).toBe(iso(-1));
    expect(
      (await call("POST", `/api/v1/agreements/${a.id}/cancel`, { date: iso(-1), reason: "again" }))
        .statusCode,
    ).toBe(409);
  });

  it("links a ticket to an agreement of its own company only, and reports service expense", async () => {
    const a = await make({ name: "covers tickets" });
    const t = await call("POST", "/api/v1/tickets", {
      summary: "Camera down",
      companyId: acme,
      boardId,
    });
    const ticketId = t.json().id;
    const link = await call("PATCH", `/api/v1/tickets/${ticketId}`, { agreementId: a.id });
    expect(link.statusCode).toBe(200);
    expect(link.json()).toMatchObject({ agreementId: a.id, agreement: "covers tickets" });
    const foreign = await call("POST", "/api/v1/tickets", {
      summary: "Elsewhere",
      companyId: other,
      boardId,
    });
    expect(
      (await call("PATCH", `/api/v1/tickets/${foreign.json().id}`, { agreementId: a.id }))
        .statusCode,
    ).toBe(422);

    const role = await one(
      "INSERT INTO catalog.work_role (name, hourly_rate) VALUES ('Tech', 100) RETURNING id",
    );
    const type = await one(
      "INSERT INTO catalog.work_type (name, rate_multiplier) VALUES ('Regular', 1) RETURNING id",
    );
    const te = await call(
      "POST",
      "/api/v1/time-entries",
      { ticketId, workRoleId: role, workTypeId: type, workDate: iso(0), hours: 2 },
      tech,
    );
    expect(te.statusCode).toBe(201);
    const d = (await call("GET", `/api/v1/agreements/${a.id}`)).json();
    expect(d.serviceHours).toBe(2);
    expect(d.serviceCost).toBe(60);
    expect(d.ticketCount).toBe(1);
    // Clearing the link removes the ticket from the agreement's expense.
    await call("PATCH", `/api/v1/tickets/${ticketId}`, { agreementId: null });
    expect((await call("GET", `/api/v1/agreements/${a.id}`)).json().serviceHours).toBe(0);
  });

  it("filters by company, including agreements billed to it", async () => {
    const a = await make({ name: "billed elsewhere", billToCompanyId: other });
    expect(a.billToCompany).toBe("Other Co");
    const res = await call("GET", `/api/v1/agreements?companyId=${other}&status=all`);
    expect(res.json().items.map((i: { name: string }) => i.name)).toContain("billed elsewhere");
  });

  it("audits agreement changes", async () => {
    const a = await make({ name: "audited" });
    await call("PATCH", `/api/v1/agreements/${a.id}`, { poNumber: "PO-77" });
    const { rows } = await pool.query(
      "SELECT action, member_id FROM sys.audit_log WHERE table_name = 'billing.agreement' AND row_pk = $1 ORDER BY id",
      [String(a.id)],
    );
    expect(rows.map((r) => r.action)).toEqual(["INSERT", "UPDATE"]);
    expect(Number(rows[1].member_id)).toBe(boss);
  });
});
