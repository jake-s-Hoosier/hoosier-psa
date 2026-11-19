import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { syncPermissions } from "./auth/permissions.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("permission enforcement (integration)", () => {
  const dbName = `hoosier_perm_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  const ids: Record<string, number> = {};

  const as = (who: string) => ({ "x-dev-member-id": String(ids[who]) });
  const call = (who: string, method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: as(who) });

  async function member(identifier: string, role: string | null): Promise<void> {
    const m = await pool.query<{ id: string }>(
      `INSERT INTO iam.member (identifier, first_name, last_name, email)
       VALUES ($1::text, $1::text, 'Test', $1::text || '@example.com') RETURNING id`,
      [identifier],
    );
    ids[identifier] = Number(m.rows[0]?.id);
    if (role) {
      await pool.query(
        `INSERT INTO iam.member_role (member_id, role_id)
         SELECT $1, id FROM iam.role WHERE name = $2`,
        [ids[identifier], role],
      );
    }
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    await migrateUp(pool);
    await ensureMarker(pool, "test");
    await member("admin", "Administrator");
    await member("tech", "Technician");
    await member("sales", "Sales");
    await member("norole", null);
    app = buildApp({
      pool,
      config: {
        AUTH_MODE: "dev",
        LOG_LEVEL: "silent",
        APP_ENV: "test",
        DB_WRITE_MODE: "read_write",
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("declares a permission on every /api/v1 route", () => {
    const missing = app.routeTable
      .filter((r) => r.url.startsWith("/api/v1/") && r.perm === undefined)
      .map((r) => `${r.method} ${r.url}`);
    expect(missing).toEqual([]);
    expect(app.routeTable.filter((r) => r.url.startsWith("/api/v1/")).length).toBeGreaterThan(20);
  });

  it("lets anyone signed in read lookups, but a member with no role nothing else", async () => {
    expect((await call("norole", "GET", "/api/v1/lookups")).statusCode).toBe(200);
    const companies = await call("norole", "GET", "/api/v1/companies");
    expect(companies.statusCode).toBe(403);
    expect(companies.json().detail).toContain("crm.company.read");
    expect((await call("norole", "GET", "/api/v1/tickets")).statusCode).toBe(403);
  });

  it("gives each role what its default grants say", async () => {
    expect((await call("tech", "GET", "/api/v1/tickets")).statusCode).toBe(200);
    expect((await call("tech", "GET", "/api/v1/companies")).statusCode).toBe(200);
    // Technicians do not create companies or lock payroll.
    expect((await call("tech", "POST", "/api/v1/companies", { name: "X" })).statusCode).toBe(403);
    expect((await call("tech", "GET", "/api/v1/pay-periods")).statusCode).toBe(403);
    expect((await call("tech", "GET", "/api/v1/timesheets/summary")).statusCode).toBe(403);
    // Sales cannot work tickets' time.
    expect((await call("sales", "GET", "/api/v1/companies")).statusCode).toBe(200);
    expect((await call("sales", "POST", "/api/v1/time-entries/timer/start", {})).statusCode).toBe(
      403,
    );
    // Administrators can do all of it.
    expect((await call("admin", "GET", "/api/v1/pay-periods")).statusCode).toBe(200);
  });

  it("limits time entry lists to your own unless you may read all", async () => {
    const own = await call("tech", "GET", `/api/v1/time-entries?memberId=${ids.tech}`);
    expect(own.statusCode).toBe(200);
    const theirs = await call("tech", "GET", `/api/v1/time-entries?memberId=${ids.admin}`);
    expect(theirs.statusCode).toBe(403);
    expect(
      (await call("admin", "GET", `/api/v1/time-entries?memberId=${ids.tech}`)).statusCode,
    ).toBe(200);
  });

  it("applies changes to a role's stored grants", async () => {
    await syncPermissions(pool);
    await pool.query(
      `INSERT INTO iam.role_permission (role_id, permission_key)
       SELECT id, 'crm.company.write' FROM iam.role WHERE name = 'Sales'
       ON CONFLICT DO NOTHING`,
    );
    // Stored rows win over the defaults: Sales now has only the stored grant.
    expect((await call("sales", "GET", "/api/v1/companies")).statusCode).toBe(403);
    expect(
      (await call("sales", "POST", "/api/v1/companies", { name: "Stored Co" })).statusCode,
    ).not.toBe(403);
  });
});
