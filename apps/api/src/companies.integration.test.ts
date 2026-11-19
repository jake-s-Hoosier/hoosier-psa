import { migrateUp } from "@hoosier/db";
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
  let memberId: number;
  let activeStatusId: number;
  const auth = () => ({ "x-dev-member-id": String(memberId) });

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    await migrateUp(pool);
    const m = await pool.query<{ id: string }>(
      `INSERT INTO iam.member (identifier, first_name, last_name, email)
       VALUES ('api-test', 'Api', 'Test', 'api@example.com') RETURNING id`,
    );
    memberId = Number(m.rows[0]?.id);
    const s = await pool.query<{ id: string }>(
      "SELECT id FROM crm.company_status WHERE name = 'Active'",
    );
    activeStatusId = Number(s.rows[0]?.id);
    app = buildApp({ pool, config: { AUTH_MODE: "dev", LOG_LEVEL: "silent" } });
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
});
