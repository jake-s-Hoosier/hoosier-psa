import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("projects (integration)", () => {
  const dbName = `hoosier_project_test_${process.pid}`;
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
       VALUES ('P${seq}-${process.pid}','Project Co ${seq}',(SELECT id FROM crm.company_status WHERE name='Active')) RETURNING id`,
    );
  };
  const makeProject = async (companyId: number, extra: Record<string, unknown> = {}) => {
    const r = await call("POST", "/api/v1/projects", {
      companyId,
      name: "Camera install",
      billingMethod: "fixed_fee",
      billingAmount: 10000,
      ...extra,
    });
    expect(r.statusCode).toBe(201);
    return r.json() as { id: number; phases: unknown[] };
  };

  it("creates a project and lists it", async () => {
    const c = await company();
    const p = await makeProject(c, { poNumber: "PO-9", budgetHours: 120 });
    const got = await call("GET", `/api/v1/projects/${p.id}`);
    expect(got.json()).toMatchObject({
      status: "open",
      billingMethod: "fixed_fee",
      billingAmount: "10000.00",
      poNumber: "PO-9",
      ticketCount: 0,
      phases: [],
    });
    const list = await call("GET", `/api/v1/projects?companyId=${c}`);
    expect(list.json().items).toHaveLength(1);
  });

  it("needs an amount unless billed at actual rates", async () => {
    const c = await company();
    const bad = await call("POST", "/api/v1/projects", {
      companyId: c,
      name: "No fee",
      billingMethod: "fixed_fee",
    });
    expect(bad.statusCode).toBe(400);
    const ok = await call("POST", "/api/v1/projects", {
      companyId: c,
      name: "T&M",
      billingMethod: "actual_rates",
      billingAmount: 500,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().billingAmount).toBeNull();
  });

  it("changing to a capped method without an amount is refused", async () => {
    const c = await company();
    const p = await makeProject(c, { billingMethod: "actual_rates", billingAmount: undefined });
    const r = await call("PATCH", `/api/v1/projects/${p.id}`, { billingMethod: "not_to_exceed" });
    expect(r.statusCode).toBe(422);
    const ok = await call("PATCH", `/api/v1/projects/${p.id}`, {
      billingMethod: "not_to_exceed",
      billingAmount: 4000,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().billingAmount).toBe("4000.00");
  });

  it("closing stamps the date and reopening clears it", async () => {
    const c = await company();
    const p = await makeProject(c);
    const closed = await call("PATCH", `/api/v1/projects/${p.id}`, { status: "closed" });
    expect(closed.json().closedAt).not.toBeNull();
    expect(closed.json().actualEnd).not.toBeNull();
    const reopened = await call("PATCH", `/api/v1/projects/${p.id}`, { status: "open" });
    expect(reopened.json().closedAt).toBeNull();
  });

  it("manages phases: unique names, separate billing terms, no delete while in use", async () => {
    const c = await company();
    const p = await makeProject(c);
    const a = await call("POST", `/api/v1/projects/${p.id}/phases`, { name: "Rough-in" });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ billSeparately: false, billingMethod: null, sortOrder: 10 });
    const dup = await call("POST", `/api/v1/projects/${p.id}/phases`, { name: "rough-in" });
    expect(dup.statusCode).toBe(409);
    const own = await call("POST", `/api/v1/projects/${p.id}/phases`, {
      name: "Phase 2",
      billSeparately: true,
      billingMethod: "fixed_fee",
      billingAmount: 2500,
    });
    expect(own.statusCode).toBe(201);
    expect(own.json()).toMatchObject({
      billingMethod: "fixed_fee",
      billingAmount: "2500.00",
      sortOrder: 20,
    });
    // terms without separate billing are rejected
    const bad = await call("POST", `/api/v1/projects/${p.id}/phases`, {
      name: "Phase 3",
      billingMethod: "fixed_fee",
      billingAmount: 100,
    });
    expect(bad.statusCode).toBe(400);
    // folding back into the project drops its terms
    const fold = await call("PATCH", `/api/v1/projects/${p.id}/phases/${own.json().id}`, {
      billSeparately: false,
    });
    expect(fold.json()).toMatchObject({
      billSeparately: false,
      billingMethod: null,
      billingAmount: null,
    });

    const t = await call("POST", "/api/v1/tickets", {
      summary: "Pull cable",
      companyId: c,
      boardId,
      projectId: p.id,
      phaseId: a.json().id,
    });
    expect(t.statusCode).toBe(201);
    expect(t.json()).toMatchObject({ project: "Camera install", phase: "Rough-in" });
    const del = await call("DELETE", `/api/v1/projects/${p.id}/phases/${a.json().id}`);
    expect(del.statusCode).toBe(409);
    const delOther = await call("DELETE", `/api/v1/projects/${p.id}/phases/${own.json().id}`);
    expect(delOther.statusCode).toBe(204);
  });

  it("project tickets must be the project's customer and one of its phases", async () => {
    const c1 = await company();
    const c2 = await company();
    const p1 = await makeProject(c1);
    const p2 = await makeProject(c2);
    const ph2 = (await call("POST", `/api/v1/projects/${p2.id}/phases`, { name: "X" })).json();

    const wrongCompany = await call("POST", "/api/v1/tickets", {
      summary: "x",
      companyId: c2,
      boardId,
      projectId: p1.id,
    });
    expect(wrongCompany.statusCode).toBe(422);
    const wrongPhase = await call("POST", "/api/v1/tickets", {
      summary: "x",
      companyId: c1,
      boardId,
      projectId: p1.id,
      phaseId: ph2.id,
    });
    expect(wrongPhase.statusCode).toBe(422);
    const phaseOnly = await call("POST", "/api/v1/tickets", {
      summary: "x",
      companyId: c1,
      boardId,
      phaseId: ph2.id,
    });
    expect(phaseOnly.statusCode).toBe(422);
  });

  it("moves an existing ticket into and out of a project; leaving the customer leaves the project", async () => {
    const c1 = await company();
    const c2 = await company();
    const p = await makeProject(c1);
    const ph = (await call("POST", `/api/v1/projects/${p.id}/phases`, { name: "Phase A" })).json();
    const t = (
      await call("POST", "/api/v1/tickets", { summary: "loose", companyId: c1, boardId })
    ).json();
    const into = await call("PATCH", `/api/v1/tickets/${t.id}`, {
      projectId: p.id,
      phaseId: ph.id,
    });
    expect(into.json()).toMatchObject({ projectId: p.id, phaseId: ph.id });
    const list = await call("GET", `/api/v1/projects/${p.id}/tickets`);
    expect(list.json().items).toHaveLength(1);
    expect((await call("GET", `/api/v1/projects/${p.id}`)).json().ticketCount).toBe(1);
    // a different phase on the same project keeps the project
    const moved = await call("PATCH", `/api/v1/tickets/${t.id}`, { phaseId: null });
    expect(moved.json()).toMatchObject({ projectId: p.id, phaseId: null });
    // changing customers drops the project
    const away = await call("PATCH", `/api/v1/tickets/${t.id}`, { companyId: c2 });
    expect(away.json()).toMatchObject({ projectId: null, phaseId: null });
    const out = await call("PATCH", `/api/v1/tickets/${t.id}`, { projectId: null });
    expect(out.statusCode).toBe(200);
  });

  it("a closed project takes no new tickets", async () => {
    const c = await company();
    const p = await makeProject(c, { status: "closed" });
    const r = await call("POST", "/api/v1/tickets", {
      summary: "late",
      companyId: c,
      boardId,
      projectId: p.id,
    });
    expect(r.statusCode).toBe(409);
  });

  it("permissions: technicians read but cannot write; the database also guards the link", async () => {
    const c = await company();
    const p = await makeProject(c);
    expect((await call("GET", `/api/v1/projects/${p.id}`, undefined, tech)).statusCode).toBe(200);
    const w = await call(
      "POST",
      "/api/v1/projects",
      { companyId: c, name: "n", billingMethod: "actual_rates" },
      tech,
    );
    expect(w.statusCode).toBe(403);
    expect(
      (await call("PATCH", `/api/v1/projects/${p.id}`, { name: "z" }, manager)).statusCode,
    ).toBe(200);
    const other = await company();
    await expect(
      pool.query(
        `INSERT INTO service.ticket (summary, company_id, board_id, status_id, priority_id, project_id)
         VALUES ('bad',$1,$2,(SELECT id FROM service.board_status WHERE board_id=$2 LIMIT 1),
                 (SELECT id FROM service.priority LIMIT 1),$3)`,
        [other, boardId, p.id],
      ),
    ).rejects.toThrow(/project's customer/);
  });
});
