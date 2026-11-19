import { createPool, ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("companies API (integration)", () => {
  const dbName = `hoosier_api_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let dbUrl: string;
  let memberId: number;
  let activeStatusId: number;
  const auth = () => ({ "x-dev-member-id": String(memberId) });

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    dbUrl = url.toString();
    pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
    await migrateUp(pool);
    await ensureMarker(pool, "test");
    const m = await pool.query<{ id: string }>(
      `INSERT INTO iam.member (identifier, first_name, last_name, email)
       VALUES ('api-test', 'Api', 'Test', 'api@example.com') RETURNING id`,
    );
    memberId = Number(m.rows[0]?.id);
    await pool.query(
      `INSERT INTO iam.member_role (member_id, role_id)
       SELECT m.id, r.id FROM iam.member m, iam.role r WHERE r.name = 'Administrator'`,
    );
    const s = await pool.query<{ id: string }>(
      "SELECT id FROM crm.company_status WHERE name = 'Active'",
    );
    activeStatusId = Number(s.rows[0]?.id);
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

  it("creates, fetches and lists a company, and audits the actor", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/companies",
      headers: auth(),
      payload: {
        identifier: "ACME",
        name: "Acme Corp",
        statusId: activeStatusId,
        phone: "317-555-0100",
      },
    });
    expect(created.statusCode).toBe(201);
    const company = created.json();
    expect(created.headers.location).toBe(`/api/v1/companies/${company.id}`);
    expect(company).toMatchObject({ identifier: "ACME", status: "Active", isLead: false });

    const fetched = await app.inject({
      method: "GET",
      url: `/api/v1/companies/${company.id}`,
      headers: auth(),
    });
    expect(fetched.json().name).toBe("Acme Corp");

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/companies?q=acme",
      headers: auth(),
    });
    expect(list.json()).toMatchObject({ total: 1, limit: 50, offset: 0 });

    const audit = await pool.query(
      "SELECT member_id::int AS member_id FROM sys.audit_log WHERE table_name = 'crm.company' AND row_pk = $1",
      [String(company.id)],
    );
    expect(audit.rows[0]?.member_id).toBe(memberId);
  });

  it("returns 409 for a duplicate identifier (case-insensitive)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/companies",
      headers: auth(),
      payload: { identifier: "acme", name: "Other", statusId: activeStatusId },
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 422 for an unknown status and 404 for a missing company", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/companies",
      headers: auth(),
      payload: { identifier: "NOSTATUS", name: "No Status", statusId: 999999 },
    });
    expect(bad.statusCode).toBe(422);

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/companies/424242",
      headers: auth(),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("a read-only pool blocks writes at the database even if the API layer allowed them", async () => {
    const roPool = createPool(dbUrl, { readOnly: true, max: 1 });
    const roApp = buildApp({
      pool: roPool,
      // Deliberately misconfigured: API says read_write, the pool is read-only. The database wins.
      config: {
        AUTH_MODE: "dev",
        LOG_LEVEL: "silent",
        APP_ENV: "test",
        DB_WRITE_MODE: "read_write",
      },
    });
    try {
      const res = await roApp.inject({
        method: "POST",
        url: "/api/v1/companies",
        headers: auth(),
        payload: { identifier: "BLOCKED", name: "Blocked Co", statusId: activeStatusId },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().title).toBe("Read-only mode");
      const n = await pool.query(
        "SELECT count(*)::int AS n FROM crm.company WHERE identifier = 'BLOCKED'",
      );
      expect(n.rows[0]?.n).toBe(0);
    } finally {
      await roApp.close();
      await roPool.end();
    }
  });
});
