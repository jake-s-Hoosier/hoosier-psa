import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EnvironmentMarker,
  approveGoLive,
  assertSafeTarget,
  checkWriteAccess,
  createPool,
  databaseNameOf,
  ensureMarker,
  readMarker,
} from "./index.js";
import { migrateUp } from "./migrate.js";

describe("assertSafeTarget", () => {
  it("extracts the database name", () => {
    expect(databaseNameOf("postgres://u:p@host:5432/hoosier_psa?sslmode=require")).toBe(
      "hoosier_psa",
    );
  });

  it("refuses the CW mirror and maintenance databases, case-insensitively", () => {
    for (const name of ["cw_datawarehouse", "CW_DataWarehouse", "postgres", "template1"]) {
      expect(() => assertSafeTarget(`postgres://u:p@h:5432/${name}`)).toThrow(/protected database/);
    }
  });

  it("allows application databases and rejects a missing name", () => {
    expect(() => assertSafeTarget("postgres://u:p@h:5432/hoosier_psa_uat")).not.toThrow();
    expect(() => assertSafeTarget("postgres://u:p@h:5432/")).toThrow(/does not name a database/);
  });

  it("is enforced by createPool before any connection is made", () => {
    expect(() => createPool("postgres://u:p@h:5432/cw_datawarehouse", { readOnly: true })).toThrow(
      /protected database/,
    );
  });
});

describe("checkWriteAccess", () => {
  const marker = (name: EnvironmentMarker["name"], approved = false): EnvironmentMarker => ({
    name,
    goLiveApprovedAt: approved ? new Date() : null,
    goLiveApprovedBy: approved ? "Jake" : null,
  });

  it("denies when there is no marker", () => {
    expect(checkWriteAccess({ appEnv: "development", marker: null, actor: "api" }).allowed).toBe(
      false,
    );
  });

  it("denies when the database environment differs from the application's", () => {
    const d = checkWriteAccess({
      appEnv: "development",
      marker: marker("production", true),
      actor: "api",
    });
    expect(d).toMatchObject({ allowed: false });
    expect((d as { reason: string }).reason).toMatch(/marked "production"/);
  });

  it("allows matching non-production environments", () => {
    for (const env of ["development", "test", "uat"] as const) {
      expect(checkWriteAccess({ appEnv: env, marker: marker(env), actor: "api" }).allowed).toBe(
        true,
      );
    }
  });

  it("keeps shadow import-only", () => {
    expect(
      checkWriteAccess({ appEnv: "shadow", marker: marker("shadow"), actor: "api" }).allowed,
    ).toBe(false);
    expect(
      checkWriteAccess({ appEnv: "shadow", marker: marker("shadow"), actor: "importer" }).allowed,
    ).toBe(true);
  });

  it("locks production until go-live is approved", () => {
    expect(
      checkWriteAccess({ appEnv: "production", marker: marker("production"), actor: "api" })
        .allowed,
    ).toBe(false);
    expect(
      checkWriteAccess({ appEnv: "production", marker: marker("production", true), actor: "api" })
        .allowed,
    ).toBe(true);
  });
});

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("environment marker and read-only pool (integration)", () => {
  const dbName = `hoosier_guard_test_${process.pid}`;
  let admin: pg.Pool;
  let url: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(adminUrl as string);
    u.pathname = `/${dbName}`;
    url = u.toString();
    pool = new pg.Pool({ connectionString: url, max: 2 });
    await migrateUp(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("has no marker until one is created, and never changes an existing one", async () => {
    expect(await readMarker(pool)).toBeNull();
    expect((await ensureMarker(pool, "production")).name).toBe("production");
    await expect(ensureMarker(pool, "development")).rejects.toThrow(/marked "production"/);
    await expect(pool.query("UPDATE sys.environment SET name = 'development'")).rejects.toThrow(
      /cannot change environment/,
    );
    await expect(pool.query("DELETE FROM sys.environment")).rejects.toThrow(/cannot be deleted/);
  });

  it("makes go-live approval one-way", async () => {
    const before = await readMarker(pool);
    expect(before?.goLiveApprovedAt).toBeNull();
    const approved = await approveGoLive(pool, "Jake Shaffer");
    expect(approved.goLiveApprovedBy).toBe("Jake Shaffer");
    await expect(approveGoLive(pool, "Someone Else")).rejects.toThrow(/already approved/);
    await expect(
      pool.query(
        "UPDATE sys.environment SET go_live_approved_at = NULL, go_live_approved_by = NULL",
      ),
    ).rejects.toThrow(/permanent/);
  });

  it("refuses approval on a non-production database", async () => {
    const other = `${dbName}_dev`;
    await admin.query(`DROP DATABASE IF EXISTS ${other}`);
    await admin.query(`CREATE DATABASE ${other}`);
    const u = new URL(adminUrl as string);
    u.pathname = `/${other}`;
    const devPool = new pg.Pool({ connectionString: u.toString(), max: 1 });
    try {
      await migrateUp(devPool);
      await ensureMarker(devPool, "development");
      await expect(approveGoLive(devPool, "Jake")).rejects.toThrow(/Only a production database/);
    } finally {
      await devPool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${other}`);
    }
  });

  it("read-only pools cannot write, even with correct SQL", async () => {
    const ro = createPool(url, { readOnly: true, max: 1 });
    try {
      expect((await ro.query("SELECT count(*)::int AS n FROM crm.company")).rows[0]?.n).toBe(0);
      await expect(
        ro.query("INSERT INTO crm.territory (name) VALUES ('should-not-exist')"),
      ).rejects.toMatchObject({ code: "25006" });
      await expect(ro.query("CREATE TABLE crm.nope (id int)")).rejects.toMatchObject({
        code: "25006",
      });
      expect((await pool.query("SELECT count(*)::int AS n FROM crm.territory")).rows[0]?.n).toBe(0);
    } finally {
      await ro.end();
    }
  });
});
