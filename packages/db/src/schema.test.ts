import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActor } from "./index.js";
import { loadMigrations, migrateUp, migrationStatus } from "./migrate.js";

// Integration tests run against a throwaway database on TEST_DATABASE_URL's server.
// CI provides one; locally: TEST_DATABASE_URL=postgres://user:pw@localhost:5432/postgres pnpm test
const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("schema (integration)", () => {
  const dbName = `hoosier_psa_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    await migrateUp(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("applies every migration and is idempotent", async () => {
    const files = await loadMigrations();
    expect(await migrateUp(pool)).toEqual([]);
    const status = await migrationStatus(pool);
    expect(status).toHaveLength(files.length);
    expect(status.every((s) => s.state === "applied")).toBe(true);
  });

  async function seedCompany(client: pg.PoolClient): Promise<number> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO crm.company (identifier, name, status_id)
       VALUES ('ACME', 'Acme Corp', (SELECT id FROM crm.company_status WHERE name = 'Active'))
       RETURNING id`,
    );
    return Number(rows[0]?.id);
  }

  it("audits changes with the acting member and skips no-op updates", async () => {
    const memberId = await withActor(pool, null, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO iam.member (identifier, first_name, last_name, email)
         VALUES ('tester', 'Test', 'User', 'tester@example.com') RETURNING id`,
      );
      return Number(rows[0]?.id);
    });

    const companyId = await withActor(pool, memberId, seedCompany);
    await withActor(pool, memberId, (c) =>
      c.query("UPDATE crm.company SET name = 'Acme Corporation' WHERE id = $1", [companyId]),
    );
    await withActor(pool, memberId, (c) =>
      c.query("UPDATE crm.company SET name = 'Acme Corporation' WHERE id = $1", [companyId]),
    );

    const { rows } = await pool.query(
      `SELECT action, member_id::int AS member_id, changed
         FROM sys.audit_log WHERE table_name = 'crm.company' AND row_pk = $1 ORDER BY id`,
      [String(companyId)],
    );
    expect(rows.map((r) => r.action)).toEqual(["INSERT", "UPDATE"]);
    expect(rows[1]?.member_id).toBe(memberId);
    expect(rows[1]?.changed).toEqual(["name"]);
  });

  it("allows only one running timer per member", async () => {
    const c = await pool.connect();
    try {
      const { rows: m } = await c.query<{ id: string }>(
        `INSERT INTO iam.member (identifier, first_name, last_name, email)
         VALUES ('timer', 'Tim', 'Er', 'timer@example.com') RETURNING id`,
      );
      const memberId = m[0]?.id;
      const { rows: co } = await c.query<{ id: string }>(
        `INSERT INTO crm.company (identifier, name, status_id)
         VALUES ('TMR', 'Timer Co', (SELECT id FROM crm.company_status WHERE name = 'Active')) RETURNING id`,
      );
      const { rows: role } = await c.query<{ id: string }>(
        "INSERT INTO catalog.work_role (name, hourly_rate) VALUES ('Tech', 120) RETURNING id",
      );
      const { rows: wt } = await c.query<{ id: string }>(
        "INSERT INTO catalog.work_type (name) VALUES ('Regular') RETURNING id",
      );
      const insert = () =>
        c.query(
          `INSERT INTO timekeeping.time_entry
             (member_id, company_id, charge_type, work_role_id, work_type_id, work_date, started_at, is_timer)
           VALUES ($1, $2, 'non_ticket', $3, $4, current_date, now(), true)`,
          [memberId, co[0]?.id, role[0]?.id, wt[0]?.id],
        );
      await insert();
      await expect(insert()).rejects.toThrow(/time_entry_one_running_timer_uq/);
    } finally {
      c.release();
    }
  });

  it("blocks edits to entries in a locked pay period unless explicitly overridden", async () => {
    const c = await pool.connect();
    try {
      const { rows: m } = await c.query<{ id: string }>(
        `INSERT INTO iam.member (identifier, first_name, last_name, email)
         VALUES ('locker', 'Lo', 'Cker', 'locker@example.com') RETURNING id`,
      );
      const { rows: co } = await c.query<{ id: string }>(
        `INSERT INTO crm.company (identifier, name, status_id)
         VALUES ('LCK', 'Lock Co', (SELECT id FROM crm.company_status WHERE name = 'Active')) RETURNING id`,
      );
      const { rows: role } = await c.query<{ id: string }>(
        "INSERT INTO catalog.work_role (name, hourly_rate) VALUES ('Lock Tech', 100) RETURNING id",
      );
      const { rows: wt } = await c.query<{ id: string }>(
        "INSERT INTO catalog.work_type (name) VALUES ('Lock Regular') RETURNING id",
      );
      const { rows: pp } = await c.query<{ id: string }>(
        `INSERT INTO timekeeping.pay_period (start_date, end_date, status)
         VALUES ('2026-01-01', '2026-01-15', 'locked') RETURNING id`,
      );
      const { rows: te } = await c.query<{ id: string }>(
        `INSERT INTO timekeeping.time_entry
           (member_id, company_id, charge_type, work_role_id, work_type_id, work_date, actual_hours, pay_period_id)
         VALUES ($1, $2, 'non_ticket', $3, $4, '2026-01-05', 1.5, $5) RETURNING id`,
        [m[0]?.id, co[0]?.id, role[0]?.id, wt[0]?.id, pp[0]?.id],
      );
      await expect(
        c.query("UPDATE timekeeping.time_entry SET actual_hours = 2 WHERE id = $1", [te[0]?.id]),
      ).rejects.toThrow(/locked pay period/);

      await c.query("BEGIN");
      await c.query("SELECT set_config('app.allow_locked_edit', 'on', true)");
      await c.query("UPDATE timekeeping.time_entry SET actual_hours = 2 WHERE id = $1", [
        te[0]?.id,
      ]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  });

  it("rejects overlapping pay periods", async () => {
    await pool.query(
      "INSERT INTO timekeeping.pay_period (start_date, end_date) VALUES ('2026-02-01', '2026-02-15')",
    );
    await expect(
      pool.query(
        "INSERT INTO timekeeping.pay_period (start_date, end_date) VALUES ('2026-02-10', '2026-02-28')",
      ),
    ).rejects.toThrow(/pay_period_no_overlap/);
  });
});
