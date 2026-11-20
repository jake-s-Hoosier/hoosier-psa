import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("procurement (integration)", () => {
  const dbName = `hoosier_po_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let boss: number;
  let manager: number;
  let tech: number;
  let disp: number;
  let sales: number;
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
    disp = await member("disp", "Dispatcher");
    sales = await member("sales", "Sales");
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

  const company = async (name: string, vendor = false) => {
    seq += 1;
    return one(
      `INSERT INTO crm.company (identifier, name, status_id, is_vendor)
       VALUES ('P${seq}-${process.pid}',$1,(SELECT id FROM crm.company_status WHERE name='Active'),$2) RETURNING id`,
      [name, vendor],
    );
  };
  const newPo = async (extra: object = {}, vendor?: number) => {
    const v = vendor ?? (await company(`Vendor ${++seq}`, true));
    const r = await call("POST", "/api/v1/procurement/orders", { vendorCompanyId: v, ...extra });
    expect(r.statusCode).toBe(201);
    return r.json() as { id: number; poNumber: string; status: string };
  };
  const addLine = async (poId: number, body: object) => {
    const r = await call("POST", `/api/v1/procurement/orders/${poId}/lines`, body);
    expect(r.statusCode).toBe(201);
    return r.json() as { id: number };
  };
  const detail = async (poId: number) =>
    (await call("GET", `/api/v1/procurement/orders/${poId}`)).json();

  it("creates a draft with sequential numbers, only for vendors", async () => {
    const a = await newPo();
    const b = await newPo();
    expect(a.poNumber).toMatch(/^PO-\d+$/);
    expect(Number(b.poNumber.slice(3))).toBeGreaterThan(Number(a.poNumber.slice(3)));
    expect(a.status).toBe("draft");
    const notVendor = await company("Plain Customer");
    const r = await call("POST", "/api/v1/procurement/orders", { vendorCompanyId: notVendor });
    expect(r.statusCode).toBe(422);
    const bad = await call("POST", "/api/v1/procurement/orders", {
      vendorCompanyId: await company("V2", true),
      projectId: 999999,
    });
    expect(bad.statusCode).toBe(422);
  });

  it("lines take product defaults, total with shipping, and lock once placed", async () => {
    const po = await newPo({ shippingCost: 25 });
    const product = await one(
      "INSERT INTO catalog.product (identifier, description, unit_cost) VALUES ($1,'Dome camera',112.5) RETURNING id",
      [`CAM-${process.pid}-${seq}`],
    );
    await addLine(po.id, { productId: product, quantity: 4 });
    await addLine(po.id, { description: "Custom bracket", quantity: 2, unitCost: 10.255 });
    let d = await detail(po.id);
    expect(d.lines[0]).toMatchObject({
      description: "Dome camera",
      unitCost: "112.5000",
      lineTotal: "450.00",
    });
    expect(d.order).toMatchObject({ linesTotal: "470.51", total: "495.51", status: "draft" });
    expect(
      (await call("POST", `/api/v1/procurement/orders/${po.id}/lines`, { quantity: 1 })).statusCode,
    ).toBe(422);
    const placed = await call("POST", `/api/v1/procurement/orders/${po.id}/place`);
    expect(placed.json()).toMatchObject({ status: "ordered" });
    expect(placed.json().orderedAt).not.toBeNull();
    const locked = await call("POST", `/api/v1/procurement/orders/${po.id}/lines`, {
      description: "x",
      quantity: 1,
    });
    expect(locked.statusCode).toBe(409);
    expect(
      (await call("PATCH", `/api/v1/procurement/lines/${d.lines[0].id}`, { quantity: 9 }))
        .statusCode,
    ).toBe(409);
    expect((await call("DELETE", `/api/v1/procurement/lines/${d.lines[0].id}`)).statusCode).toBe(
      409,
    );
    expect((await call("POST", `/api/v1/procurement/orders/${po.id}/place`)).statusCode).toBe(409);
    d = await detail(po.id);
    expect(d.order.openValue).toBe("470.51");
    const empty = await newPo();
    expect((await call("POST", `/api/v1/procurement/orders/${empty.id}/place`)).statusCode).toBe(
      422,
    );
  });

  it("receives in parts, refuses over-receiving, and moves through partial to received", async () => {
    const po = await newPo();
    const l1 = await addLine(po.id, { description: "Panel", quantity: 3, unitCost: 100 });
    const l2 = await addLine(po.id, { description: "Reader", quantity: 5, unitCost: 20 });
    const early = await call("POST", `/api/v1/procurement/orders/${po.id}/receipts`, {
      lines: [{ poLineId: l1.id, quantity: 1 }],
    });
    expect(early.statusCode).toBe(409); // still a draft
    await call("POST", `/api/v1/procurement/orders/${po.id}/place`);
    const first = await call("POST", `/api/v1/procurement/orders/${po.id}/receipts`, {
      reference: "PS-1",
      lines: [
        { poLineId: l1.id, quantity: 2, serialNumbers: "A1,A2" },
        { poLineId: l2.id, quantity: 5 },
      ],
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().order).toMatchObject({
      status: "partial",
      receivedValue: "300.00",
      openValue: "100.00",
    });
    const over = await call("POST", `/api/v1/procurement/orders/${po.id}/receipts`, {
      lines: [{ poLineId: l1.id, quantity: 1.5 }],
    });
    expect(over.statusCode).toBe(422);
    const split = await call("POST", `/api/v1/procurement/orders/${po.id}/receipts`, {
      lines: [
        { poLineId: l1.id, quantity: 0.6 },
        { poLineId: l1.id, quantity: 0.6 },
      ],
    });
    expect(split.statusCode).toBe(422); // two entries for one line add up before the check
    const other = await newPo();
    const foreign = await addLine(other.id, { description: "Other", quantity: 1 });
    const wrong = await call("POST", `/api/v1/procurement/orders/${po.id}/receipts`, {
      lines: [{ poLineId: foreign.id, quantity: 1 }],
    });
    expect(wrong.statusCode).toBe(422);
    const last = await call("POST", `/api/v1/procurement/orders/${po.id}/receipts`, {
      lines: [{ poLineId: l1.id, quantity: 1 }],
    });
    expect(last.json().order).toMatchObject({
      status: "received",
      receivedValue: "400.00",
      openValue: "0.00",
    });
    const d = await detail(po.id);
    expect(d.lines[0]).toMatchObject({ quantityReceived: "3.000", quantityOutstanding: "0.000" });
    expect(d.receipts).toHaveLength(2);
    expect(d.receipts[1].lines[0].serialNumbers).toBe("A1,A2");
    // A mistaken receipt can be undone while the order is not finished by closing.
    const undo = await call("DELETE", `/api/v1/procurement/receipts/${last.json().receipts[0].id}`);
    expect(undo.statusCode).toBe(204);
    expect((await detail(po.id)).order.status).toBe("partial");
    expect((await call("POST", `/api/v1/procurement/orders/${po.id}/cancel`)).statusCode).toBe(409);
  });

  it("closes a partly received order short, and cancels one with nothing received", async () => {
    const po = await newPo();
    const l = await addLine(po.id, { description: "Switch", quantity: 4, unitCost: 50 });
    await call("POST", `/api/v1/procurement/orders/${po.id}/place`);
    expect((await call("POST", `/api/v1/procurement/orders/${po.id}/close`)).statusCode).toBe(409);
    const rec = await call("POST", `/api/v1/procurement/orders/${po.id}/receipts`, {
      lines: [{ poLineId: l.id, quantity: 1 }],
    });
    const closed = await call("POST", `/api/v1/procurement/orders/${po.id}/close`);
    expect(closed.json()).toMatchObject({
      status: "closed",
      openValue: "0.00",
      receivedValue: "50.00",
    });
    expect(
      (await call("DELETE", `/api/v1/procurement/receipts/${rec.json().receipts[0].id}`))
        .statusCode,
    ).toBe(409);
    expect(
      (await call("PATCH", `/api/v1/procurement/orders/${po.id}`, { notes: "x" })).statusCode,
    ).toBe(409);

    const c = await newPo();
    await addLine(c.id, { description: "Never", quantity: 1 });
    await call("POST", `/api/v1/procurement/orders/${c.id}/place`);
    expect((await call("POST", `/api/v1/procurement/orders/${c.id}/cancel`)).json().status).toBe(
      "canceled",
    );
    expect((await call("POST", `/api/v1/procurement/orders/${c.id}/place`)).statusCode).toBe(409);
  });

  it("edits header fields while open and filters the list", async () => {
    const vendor = await company("Filter Vendor", true);
    const cust = await company("Job Customer");
    const proj = (
      await call("POST", "/api/v1/projects", {
        companyId: cust,
        name: "PO job",
        billingMethod: "actual_rates",
      })
    ).json();
    const po = await newPo({ projectId: proj.id }, vendor);
    const patched = await call("PATCH", `/api/v1/procurement/orders/${po.id}`, {
      vendorReference: "SO-77",
      expectedDate: "2026-12-15",
      shippingCost: 12.5,
      notes: "Dock 2",
    });
    expect(patched.json()).toMatchObject({
      vendorReference: "SO-77",
      expectedDate: "2026-12-15",
      shippingCost: "12.50",
      project: "PO job",
    });
    const byProject = (await call("GET", `/api/v1/procurement/orders?projectId=${proj.id}`)).json()
      .items;
    expect(byProject.map((x: { id: number }) => x.id)).toEqual([po.id]);
    const byVendor = (
      await call("GET", `/api/v1/procurement/orders?vendorId=${vendor}&status=open`)
    ).json().items;
    expect(byVendor).toHaveLength(1);
    expect(
      (await call("GET", `/api/v1/procurement/orders?vendorId=${vendor}&status=received`)).json()
        .items,
    ).toHaveLength(0);
    expect((await call("GET", "/api/v1/procurement/orders?status=nonsense")).statusCode).toBe(400);
  });

  it("shows vendor cost on the project margin report: received and still on order", async () => {
    const cust = await company("Margin Customer");
    const vendor = await company("Margin Vendor", true);
    const proj = (
      await call("POST", "/api/v1/projects", {
        companyId: cust,
        name: "Vendor margin",
        billingMethod: "actual_rates",
      })
    ).json();
    const tk = (
      await call("POST", "/api/v1/tickets", {
        summary: "Install",
        companyId: cust,
        boardId,
        projectId: proj.id,
      })
    ).json();
    const viaProject = await newPo({ projectId: proj.id }, vendor);
    const viaTicket = await newPo({ ticketId: tk.id }, vendor);
    const unrelated = await newPo({}, vendor);
    const l1 = await addLine(viaProject.id, { description: "A", quantity: 10, unitCost: 30 });
    const l2 = await addLine(viaTicket.id, { description: "B", quantity: 2, unitCost: 100 });
    const l3 = await addLine(unrelated.id, { description: "C", quantity: 1, unitCost: 999 });
    for (const p of [viaProject, viaTicket, unrelated])
      await call("POST", `/api/v1/procurement/orders/${p.id}/place`);
    await call("POST", `/api/v1/procurement/orders/${viaProject.id}/receipts`, {
      lines: [{ poLineId: l1.id, quantity: 4 }],
    });
    await call("POST", `/api/v1/procurement/orders/${unrelated.id}/receipts`, {
      lines: [{ poLineId: l3.id, quantity: 1 }],
    });
    const row = (await call("GET", "/api/v1/reports/projects"))
      .json()
      .rows.find((x: { projectId: number }) => x.projectId === proj.id);
    expect(row).toMatchObject({ vendorReceived: "120.00", vendorOnOrder: "380.00" });
    expect(l2.id).toBeGreaterThan(0);
  });

  it("permissions: dispatchers receive but cannot edit; sales can only read; technicians see nothing", async () => {
    const po = await newPo();
    const l = await addLine(po.id, { description: "Part", quantity: 2, unitCost: 5 });
    await call("POST", `/api/v1/procurement/orders/${po.id}/place`);
    expect((await call("GET", "/api/v1/procurement/orders", undefined, disp)).statusCode).toBe(200);
    expect((await call("GET", "/api/v1/procurement/orders", undefined, sales)).statusCode).toBe(
      200,
    );
    expect((await call("GET", "/api/v1/procurement/orders", undefined, tech)).statusCode).toBe(403);
    expect(
      (await call("POST", "/api/v1/procurement/orders", { vendorCompanyId: 1 }, disp)).statusCode,
    ).toBe(403);
    expect(
      (await call("POST", `/api/v1/procurement/orders/${po.id}/cancel`, undefined, disp))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          "POST",
          `/api/v1/procurement/orders/${po.id}/receipts`,
          { lines: [{ poLineId: l.id, quantity: 1 }] },
          sales,
        )
      ).statusCode,
    ).toBe(403);
    const ok = await call(
      "POST",
      `/api/v1/procurement/orders/${po.id}/receipts`,
      { lines: [{ poLineId: l.id, quantity: 1 }] },
      disp,
    );
    expect(ok.statusCode).toBe(201);
    expect(
      (
        await call(
          "POST",
          "/api/v1/procurement/orders",
          { vendorCompanyId: await company("Mgr Vendor", true) },
          manager,
        )
      ).statusCode,
    ).toBe(201);
  });
});
