import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("reports (integration)", () => {
  const dbName = `hoosier_report_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let boss: number;
  let manager: number;
  let tech: number;
  let roleId: number;
  let typeId: number;
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
    roleId = await one(
      "INSERT INTO catalog.work_role (name, hourly_rate) VALUES ('Tech', 100) RETURNING id",
    );
    typeId = await one(
      "INSERT INTO catalog.work_type (name, rate_multiplier) VALUES ('Regular', 1) RETURNING id",
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
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  const company = async (name?: string) => {
    seq += 1;
    return one(
      `INSERT INTO crm.company (identifier, name, status_id)
       VALUES ('R${seq}-${process.pid}',$1,(SELECT id FROM crm.company_status WHERE name='Active')) RETURNING id`,
      [name ?? `Report Co ${seq}`],
    );
  };
  const agreementType = async (name: string) =>
    (
      await call("POST", "/api/v1/agreements/types", {
        name,
        billCycle: "monthly",
        coverage: "none",
        autoRenew: true,
      })
    ).json().id as number;
  const agreement = async (
    companyId: number,
    typeId: number,
    lines: Array<{
      description: string;
      quantity?: number;
      unitPrice: number;
      unitCost?: number;
      vendor?: number;
      effectiveTo?: string;
    }>,
    extra: object = {},
  ) => {
    const r = await call("POST", "/api/v1/agreements", {
      companyId,
      typeId,
      name: `Agr ${seq}-${Math.random().toString(36).slice(2, 6)}`,
      startDate: "2026-01-01",
      billStartDate: "2026-01-01",
      billCycle: "monthly",
      ...extra,
    });
    expect(r.statusCode).toBe(201);
    const a = r.json() as { id: number };
    for (const l of lines) {
      const add = await call("POST", `/api/v1/agreements/${a.id}/additions`, {
        description: l.description,
        quantity: l.quantity ?? 1,
        unitPrice: l.unitPrice,
        unitCost: l.unitCost ?? 0,
        vendorCompanyId: l.vendor,
        effectiveFrom: "2026-01-01",
        effectiveTo: l.effectiveTo,
        prorate: false,
      });
      expect(add.statusCode).toBe(201);
    }
    return a.id;
  };
  const rmr = async (q = "") =>
    (await call("GET", `/api/v1/reports/rmr?asOf=2026-06-15${q}`)).json();

  it("totals RMR and margin, grouped by type, vendor, customer or agreement", async () => {
    const vend = await company("Alarm Vendor");
    const ca = await company("Alpha Co");
    const cb = await company("Beta Co");
    const monitoring = await agreementType("Monitoring R1");
    const jfi = await agreementType("JFI R1");
    const a1 = await agreement(ca, monitoring, [
      { description: "Panel monitoring", quantity: 4, unitPrice: 50, unitCost: 20, vendor: vend },
    ]);
    await agreement(cb, jfi, [
      { description: "Support", unitPrice: 300, unitCost: 100 },
      { description: "Licence", quantity: 2, unitPrice: 40, unitCost: 10, vendor: vend },
    ]);
    const base = await rmr();
    const mine = (name: string) => base.groups.find((g: { name: string }) => g.name === name);
    expect(mine("Monitoring R1")).toMatchObject({
      revenue: "200.00",
      cost: "80.00",
      margin: "120.00",
      marginPct: 60,
      agreements: 1,
      additions: 1,
    });
    expect(mine("JFI R1")).toMatchObject({ revenue: "380.00", cost: "120.00", additions: 2 });
    const byVendor = await rmr("&groupBy=vendor");
    const v = byVendor.groups.find((g: { name: string }) => g.name === "Alarm Vendor");
    expect(v).toMatchObject({ revenue: "280.00", cost: "100.00", additions: 2 });
    expect(byVendor.groups.some((g: { name: string }) => g.name === "No vendor recorded")).toBe(
      true,
    );
    const byCustomer = await rmr("&groupBy=customer");
    expect(byCustomer.groups.find((g: { name: string }) => g.name === "Beta Co")).toMatchObject({
      revenue: "380.00",
    });
    const byAgreement = await rmr("&groupBy=agreement");
    expect(byAgreement.groups.some((g: { name: string }) => g.name.includes("Alpha Co"))).toBe(
      true,
    );
    const sum = base.groups.reduce((s: number, g: { revenue: string }) => s + Number(g.revenue), 0);
    expect(base.totals.revenue).toBe(sum.toFixed(2));
    expect(base.totals.marginPct).not.toBeNull();
    expect(a1).toBeGreaterThan(0);
  });

  it("honours the date: ended lines, cancelled agreements and future starts drop out", async () => {
    const c = await company("Dated Co");
    const t = await agreementType("Dated R2");
    await agreement(c, t, [
      { description: "Ended", unitPrice: 100, unitCost: 50, effectiveTo: "2026-03-31" },
    ]);
    const cancelled = await agreement(c, t, [
      { description: "Cancelled", unitPrice: 100, unitCost: 50 },
    ]);
    const cx = await call("POST", `/api/v1/agreements/${cancelled}/cancel`, {
      date: "2026-05-31",
      reason: "Left",
    });
    expect(cx.statusCode).toBeLessThan(300);
    await agreement(c, t, [{ description: "Future", unitPrice: 100, unitCost: 50 }], {
      startDate: "2026-09-01",
      billStartDate: "2026-09-01",
    });
    const r = await rmr("&groupBy=customer");
    expect(r.groups.find((g: { name: string }) => g.name === "Dated Co")).toBeUndefined();
    const early = (
      await call("GET", "/api/v1/reports/rmr?asOf=2026-02-15&groupBy=customer")
    ).json();
    expect(early.groups.find((g: { name: string }) => g.name === "Dated Co")).toMatchObject({
      revenue: "200.00",
    });
  });

  it("flags missing cost, negative and thin margins, and agreements that bill nothing", async () => {
    const c = await company("Flag Co");
    const t = await agreementType("Flags R3");
    const id = await agreement(c, t, [
      { description: "No cost", unitPrice: 100, unitCost: 0 },
      { description: "Loses money", unitPrice: 50, unitCost: 80 },
      { description: "Thin", unitPrice: 100, unitCost: 85 },
      { description: "Healthy", unitPrice: 100, unitCost: 40 },
    ]);
    const empty = await agreement(c, t, []);
    const r = await rmr("&floorPct=30");
    const mineFlags = r.flags.filter((f: { agreementId: number }) => f.agreementId === id);
    const kinds = Object.fromEntries(
      mineFlags.map((f: { description: string; kind: string }) => [f.description, f.kind]),
    );
    expect(kinds).toEqual({
      "No cost": "no_cost",
      "Loses money": "negative_margin",
      Thin: "below_floor",
    });
    expect(r.flags.find((f: { agreementId: number }) => f.agreementId === empty)).toMatchObject({
      kind: "no_active_additions",
    });
    const strict = await rmr("&floorPct=70");
    expect(
      strict.flags.filter(
        (f: { agreementId: number; kind: string }) =>
          f.agreementId === id && f.kind === "below_floor",
      ),
    ).toHaveLength(2);
    const order = r.flags.map((f: { kind: string }) => f.kind);
    expect(order.indexOf("negative_margin")).toBeLessThan(order.indexOf("no_active_additions"));
  });

  it("agreement service report: billed recurring, its cost and labor that was not billed", async () => {
    const c = await company("Service Co");
    const t = await agreementType("Service R4");
    const id = await agreement(c, t, [{ description: "Plan", unitPrice: 500, unitCost: 200 }]);
    const run = await call("POST", "/api/v1/billing/runs", {
      kind: "agreement",
      month: "2026-06",
      invoiceDate: "2026-06-01",
    });
    expect(run.statusCode).toBe(201);
    expect(
      (await call("POST", `/api/v1/billing/runs/${run.json().id}/post`)).statusCode,
    ).toBeLessThan(300);
    const tk = (
      await call("POST", "/api/v1/tickets", { summary: "Visit", companyId: c, boardId })
    ).json();
    await pool.query("UPDATE service.ticket SET agreement_id = $1 WHERE id = $2", [id, tk.id]);
    const entry = (hrs: number, status: string) =>
      pool.query(
        `INSERT INTO timekeeping.time_entry
           (member_id, company_id, charge_type, ticket_id, work_role_id, work_type_id, work_date, actual_hours, billed_hours, cost_rate, status)
         VALUES ($1,$2,'service_ticket',$3,$4,$5,'2026-06-10',$6,$6,50,$7)`,
        [tech, c, tk.id, roleId, typeId, hrs, status === "billed" ? "open" : status],
      );
    await entry(2, "approved"); // absorbed: 2h x 50 = 100
    await entry(4, "void"); // ignored
    const r = (
      await call("GET", "/api/v1/reports/agreement-service?asOf=2026-06-15&months=12")
    ).json();
    const row = r.rows.find((x: { agreementId: number }) => x.agreementId === id);
    expect(row).toMatchObject({
      billed: "500.00",
      recurringCost: "200.00",
      hours: "2.00",
      absorbedLaborCost: "100.00",
      margin: "200.00",
    });
    expect(row.marginPct).toBe(40);
    expect(r.totals.billed).not.toBe("0.00");
    const narrow = (
      await call("GET", "/api/v1/reports/agreement-service?asOf=2027-12-15&months=1")
    ).json();
    expect(narrow.rows.find((x: { agreementId: number }) => x.agreementId === id)).toBeUndefined();
  });

  it("project margin: invoiced against labor and material cost, with budget hours and unbilled value", async () => {
    const c = await company("Project Co");
    const p = (
      await call("POST", "/api/v1/projects", {
        companyId: c,
        name: "Margin job",
        billingMethod: "fixed_fee",
        billingAmount: 10000,
        budgetHours: 40,
      })
    ).json();
    const tk = (
      await call("POST", "/api/v1/tickets", {
        summary: "Install",
        companyId: c,
        boardId,
        projectId: p.id,
      })
    ).json();
    await pool.query(
      `INSERT INTO timekeeping.time_entry
         (member_id, company_id, charge_type, ticket_id, work_role_id, work_type_id, work_date, actual_hours, billed_hours, bill_rate, cost_rate, status)
       VALUES ($1,$2,'service_ticket',$3,$4,$5,'2026-06-10',10,10,120,60,'approved')`,
      [tech, c, tk.id, roleId, typeId],
    );
    await pool.query(
      `INSERT INTO service.ticket_charge (ticket_id, kind, description, quantity, unit_price, unit_cost)
       VALUES ($1,'expense','Cable',100,3,2)`,
      [tk.id],
    );
    const dep = await call("POST", "/api/v1/billing/runs", {
      kind: "project",
      projectId: p.id,
      mode: "deposit",
      percent: 30,
      invoiceDate: "2026-06-12",
    });
    expect(dep.statusCode).toBe(201);
    const draft = (await call("GET", "/api/v1/reports/projects"))
      .json()
      .rows.find((x: { projectId: number }) => x.projectId === p.id);
    expect(draft.invoiced).toBe("0.00"); // a draft invoice is not revenue yet
    await call("POST", `/api/v1/billing/runs/${dep.json().id}/post`);
    const r = (await call("GET", "/api/v1/reports/projects")).json();
    const row = r.rows.find((x: { projectId: number }) => x.projectId === p.id);
    expect(row).toMatchObject({
      invoiced: "3000.00",
      feeBilledPct: 30,
      hours: "10.00",
      laborCost: "600.00",
      materialCost: "200.00",
      cost: "800.00",
      margin: "2200.00",
      unbilledValue: "1500.00",
      budgetHours: "40.00",
    });
    expect(row.marginPct).toBeCloseTo(73.3, 1);
    expect(
      (await call("GET", "/api/v1/reports/projects?status=closed"))
        .json()
        .rows.some((x: { projectId: number }) => x.projectId === p.id),
    ).toBe(false);
  });

  it("permissions: managers and billing see reports; technicians do not", async () => {
    expect((await call("GET", "/api/v1/reports/rmr", undefined, manager)).statusCode).toBe(200);
    expect((await call("GET", "/api/v1/reports/rmr", undefined, tech)).statusCode).toBe(403);
    expect((await call("GET", "/api/v1/reports/projects", undefined, tech)).statusCode).toBe(403);
    expect((await call("GET", "/api/v1/reports/rmr?groupBy=nonsense")).statusCode).toBe(400);
  });
});
