import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("role administration (integration)", () => {
  const dbName = `hoosier_roleadmin_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  const ids: Record<string, number> = {};

  const call = (
    who: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: object,
  ) => app.inject({ method, url, payload, headers: { "x-dev-member-id": String(ids[who]) } });
  const roleId = async (name: string) =>
    Number((await pool.query("SELECT id FROM iam.role WHERE name = $1", [name])).rows[0].id);

  async function member(identifier: string, role: string | null) {
    const m = await pool.query<{ id: string }>(
      `INSERT INTO iam.member (identifier, first_name, last_name, email)
       VALUES ($1::text, $1::text, 'Test', $1::text || '@example.com') RETURNING id`,
      [identifier],
    );
    ids[identifier] = Number(m.rows[0]?.id);
    if (role)
      await pool.query(
        "INSERT INTO iam.member_role (member_id, role_id) SELECT $1, id FROM iam.role WHERE name = $2",
        [ids[identifier], role],
      );
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
    await member("boss", "Administrator");
    await member("tech", "Technician");
    await member("newbie", null);
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

  it("is for administrators only", async () => {
    expect((await call("tech", "GET", "/api/v1/admin/roles")).statusCode).toBe(403);
    expect((await call("boss", "GET", "/api/v1/admin/roles")).statusCode).toBe(200);
  });

  it("lists built-in roles with their effective grants", async () => {
    const roles = (await call("boss", "GET", "/api/v1/admin/roles")).json().items;
    const tech = roles.find((r: { name: string }) => r.name === "Technician");
    expect(tech.isSystem).toBe(true);
    expect(tech.customized).toBe(false);
    expect(tech.permissions).toContain("service.ticket.write");
    expect(tech.memberCount).toBe(1);
    const perms = (await call("boss", "GET", "/api/v1/admin/permissions")).json().items;
    expect(perms.length).toBeGreaterThan(10);
  });

  it("creates a custom role whose grants take effect, and audits the change", async () => {
    const created = await call("boss", "POST", "/api/v1/admin/roles", {
      name: "Estimator",
      description: "Reads companies and tickets",
      permissions: ["crm.company.read", "service.ticket.read"],
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(
      (await call("boss", "POST", "/api/v1/admin/roles", { name: "estimator", permissions: [] }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await call("boss", "POST", "/api/v1/admin/roles", {
          name: "Bad",
          permissions: ["nope.nope"],
        })
      ).statusCode,
    ).toBe(400);

    const assign = await call("boss", "PUT", `/api/v1/admin/members/${ids.newbie}/roles`, {
      roleIds: [id],
    });
    expect(assign.statusCode).toBe(200);
    expect((await call("newbie", "GET", "/api/v1/companies")).statusCode).toBe(200);
    expect((await call("newbie", "GET", "/api/v1/tickets")).statusCode).toBe(200);
    expect((await call("newbie", "POST", "/api/v1/companies", { name: "x" })).statusCode).toBe(403);

    const audit = await pool.query(
      "SELECT row_pk, member_id FROM sys.audit_log WHERE table_name = 'iam.role_permission' AND action = 'INSERT' AND row_pk LIKE $1",
      [`${id}/%`],
    );
    expect(audit.rowCount).toBe(2);
    expect(audit.rows[0].member_id).toBe(String(ids.boss));
    const memberAudit = await pool.query(
      "SELECT 1 FROM sys.audit_log WHERE table_name = 'iam.member_role' AND row_pk = $1",
      [`${ids.newbie}/${id}`],
    );
    expect(memberAudit.rowCount).toBe(1);

    // Edit grants: stored rows replace the set.
    const edit = await call("boss", "PATCH", `/api/v1/admin/roles/${id}`, {
      permissions: ["crm.company.read", "crm.company.write"],
    });
    expect(edit.json().permissions).toEqual(["crm.company.read", "crm.company.write"]);
    expect((await call("newbie", "GET", "/api/v1/tickets")).statusCode).toBe(403);
    expect(
      (
        await call("newbie", "POST", "/api/v1/companies", {
          identifier: "ESTCO",
          name: "Estimator Co",
          statusId: Number(
            (
              await pool.query("SELECT id FROM crm.company_status WHERE name = 'Active'")
            ).rows[0].id,
          ),
        })
      ).statusCode,
    ).toBe(201);
  });

  it("customizes a built-in role, refuses an empty one, and resets to defaults", async () => {
    const tech = await roleId("Technician");
    const custom = await call("boss", "PATCH", `/api/v1/admin/roles/${tech}`, {
      permissions: ["service.ticket.read"],
    });
    expect(custom.json().customized).toBe(true);
    expect((await call("tech", "POST", "/api/v1/tickets", {})).statusCode).toBe(403);
    expect(
      (await call("boss", "PATCH", `/api/v1/admin/roles/${tech}`, { permissions: [] })).statusCode,
    ).toBe(422);
    expect(
      (await call("boss", "PATCH", `/api/v1/admin/roles/${tech}`, { name: "Renamed" })).statusCode,
    ).toBe(422);
    const reset = await call("boss", "POST", `/api/v1/admin/roles/${tech}/reset`);
    expect(reset.json().customized).toBe(false);
    expect(reset.json().permissions).toContain("service.ticket.write");
  });

  it("will not delete a built-in role or one that is in use", async () => {
    expect(
      (await call("boss", "DELETE", `/api/v1/admin/roles/${await roleId("Sales")}`)).statusCode,
    ).toBe(422);
    expect(
      (await call("boss", "DELETE", `/api/v1/admin/roles/${await roleId("Estimator")}`)).statusCode,
    ).toBe(409);
    await call("boss", "PUT", `/api/v1/admin/members/${ids.newbie}/roles`, { roleIds: [] });
    expect(
      (await call("boss", "DELETE", `/api/v1/admin/roles/${await roleId("Estimator")}`)).statusCode,
    ).toBe(204);
  });

  it("never lets the last administrator be removed, demoted or deactivated", async () => {
    const adminRole = await roleId("Administrator");
    const boss = ids.boss;
    expect(
      (await call("boss", "PUT", `/api/v1/admin/members/${boss}/roles`, { roleIds: [] }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call("boss", "PATCH", `/api/v1/admin/members/${boss}`, { isActive: false }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await call("boss", "PATCH", `/api/v1/admin/roles/${adminRole}`, {
          permissions: ["crm.company.read"],
        })
      ).statusCode,
    ).toBe(409);
    // Rolled back: still an administrator.
    expect((await call("boss", "GET", "/api/v1/admin/roles")).statusCode).toBe(200);

    // With a second administrator the first may step down.
    await call("boss", "PUT", `/api/v1/admin/members/${ids.tech}/roles`, { roleIds: [adminRole] });
    expect(
      (await call("boss", "PUT", `/api/v1/admin/members/${boss}/roles`, { roleIds: [] }))
        .statusCode,
    ).toBe(200);
    expect((await call("boss", "GET", "/api/v1/admin/roles")).statusCode).toBe(403);
    expect(
      (await call("tech", "PATCH", `/api/v1/admin/members/${boss}`, { isActive: false }))
        .statusCode,
    ).toBe(200);
  });

  it("lists members with roles and sign-in state", async () => {
    const items = (await call("tech", "GET", "/api/v1/admin/members")).json().items;
    const boss = items.find((m: { identifier: string }) => m.identifier === "boss");
    expect(boss.isActive).toBe(false);
    expect(
      items.find((m: { identifier: string }) => m.identifier === "tech").roleIds.length,
    ).toBeGreaterThan(0);
  });
});
