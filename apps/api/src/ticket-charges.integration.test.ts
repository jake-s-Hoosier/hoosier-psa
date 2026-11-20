import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("ticket materials and expenses (integration)", () => {
  const dbName = `hoosier_charge_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let boss: number;
  let board: number;
  let closedStatus: number;
  let roleId: number;
  let typeId: number;
  let camera: number; // taxable catalog item, price 200, cost 120
  let shipping: number; // non-taxable other charge
  let taxId: number;
  let seq = 0;
  const one = async (sql: string, params: unknown[] = []) =>
    Number((await pool.query<{ id: string }>(sql, params)).rows[0]?.id);
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { "x-dev-member-id": String(boss) },
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
    boss = await one(
      "INSERT INTO iam.member (identifier, first_name, last_name, email) VALUES ('b','Bo','Boss','b@e.com') RETURNING id",
    );
    await pool.query(
      "INSERT INTO iam.member_role (member_id, role_id) SELECT $1, id FROM iam.role WHERE name = 'Administrator'",
      [boss],
    );
    board = await one("INSERT INTO service.board (name) VALUES ('Service') RETURNING id");
    await pool.query(
      "INSERT INTO service.board_status (board_id, name, is_default) VALUES ($1,'New',true)",
      [board],
    );
    closedStatus = await one(
      "INSERT INTO service.board_status (board_id, name, is_closed) VALUES ($1,'Closed',true) RETURNING id",
      [board],
    );
    roleId = await one(
      "INSERT INTO catalog.work_role (name, hourly_rate) VALUES ('Tech', 100) RETURNING id",
    );
    typeId = await one(
      "INSERT INTO catalog.work_type (name, rate_multiplier, counts_against_agreement) VALUES ('Remote', 1, false) RETURNING id",
    );
    camera = await one(
      "INSERT INTO catalog.product (identifier, description, kind, unit_price, unit_cost, is_taxable, qb_item_full_name) VALUES ('CAM-1','4MP turret camera','inventory',200,120,true,'CAMS-1') RETURNING id",
    );
    shipping = await one(
      "INSERT INTO catalog.product (identifier, description, kind, unit_price, unit_cost, is_taxable) VALUES ('SHIP','Shipping','other_charge',15,15,false) RETURNING id",
    );
    taxId = await one(
      "INSERT INTO catalog.tax_code (name, rate_pct) VALUES ('IN 7%', 7) RETURNING id",
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

  const ticket = async () => {
    seq += 1;
    const co = await one(
      `INSERT INTO crm.company (identifier, name, status_id, tax_code_id)
       VALUES ('C${seq}-${process.pid}','Co ${seq}',(SELECT id FROM crm.company_status WHERE name='Active'),$1) RETURNING id`,
      [taxId],
    );
    const t = await call("POST", "/api/v1/tickets", {
      summary: "Install",
      companyId: co,
      boardId: board,
    });
    expect(t.statusCode).toBe(201);
    return { id: t.json().id as number, company: co };
  };
  const charge = async (ticketId: number, body: object) => {
    const res = await call("POST", `/api/v1/tickets/${ticketId}/charges`, body);
    expect(res.statusCode).toBe(201);
    return res.json() as { id: number; amount: string; taxable: boolean; invoiceId: number | null };
  };
  const ticketRun = (throughDate: string) =>
    call("POST", "/api/v1/billing/runs", {
      kind: "ticket",
      throughDate,
      invoiceDate: "2027-02-01",
    });
  type Inv = {
    id: number;
    companyId: number;
    subtotal: string;
    taxTotal: string;
    total: string;
    lines: Array<{
      id: number;
      kind: string;
      amount: string;
      taxable: boolean;
      description: string;
      ticketId: number;
    }>;
  };
  const invoicesOf = async (runId: number): Promise<Inv[]> => {
    const heads = (await call("GET", `/api/v1/billing/runs/${runId}`)).json().invoices as Inv[];
    return Promise.all(
      heads.map(async (h) => (await call("GET", `/api/v1/billing/invoices/${h.id}`)).json() as Inv),
    );
  };
  const row = async (id: number) =>
    (
      await pool.query(
        "SELECT invoice_id::int AS invoice, invoice_line_id::int AS line FROM service.ticket_charge WHERE id = $1",
        [id],
      )
    ).rows[0];

  it("fills a charge from the catalog and checks what it is given", async () => {
    const { id } = await ticket();
    const c = await charge(id, { productId: camera, quantity: 2, incurredOn: "2027-01-10" });
    expect(c).toMatchObject({ amount: "400.00", taxable: true });
    const exp = await charge(id, { kind: "expense", description: "Parking", unitPrice: 12 });
    expect(exp.taxable).toBe(false);
    const ship = await charge(id, { kind: "expense", productId: shipping });
    expect(ship.taxable).toBe(false);

    const bare = await call("POST", `/api/v1/tickets/${id}/charges`, {
      kind: "expense",
      unitPrice: 5,
    });
    expect(bare.statusCode).toBe(422);
    const noTicket = await call("POST", "/api/v1/tickets/999999/charges", { description: "x" });
    expect(noTicket.statusCode).toBe(404);
    const list = (await call("GET", `/api/v1/tickets/${id}/charges`)).json();
    expect(list.items).toHaveLength(3);

    const found = (await call("GET", "/api/v1/lookups/products?q=turret")).json();
    expect(found.items[0]).toMatchObject({ identifier: "CAM-1", unitPrice: "200.0000" });
    expect((await call("GET", "/api/v1/lookups/products?q=t")).json().items).toEqual([]);
  });

  it("bills materials and expenses with tax, once, and keeps unbilled kinds out", async () => {
    const { id, company } = await ticket();
    const cam = await charge(id, { productId: camera, quantity: 2, incurredOn: "2027-03-02" });
    const ship = await charge(id, {
      kind: "expense",
      productId: shipping,
      incurredOn: "2027-03-02",
    });
    const free = await charge(id, {
      productId: camera,
      billable: "no_charge",
      incurredOn: "2027-03-02",
    });
    const written = await charge(id, {
      productId: camera,
      billable: "do_not_bill",
      incurredOn: "2027-03-02",
    });
    const later = await charge(id, { productId: camera, incurredOn: "2027-03-25" });

    const res = await ticketRun("2027-03-10");
    expect(res.statusCode).toBe(201);
    const [inv] = (await invoicesOf(res.json().id)).filter((i) => i.companyId === company);
    expect(inv?.lines.map((l) => l.kind).sort()).toEqual(["expense", "product"]);
    expect(inv?.lines.every((l) => l.description.startsWith(`Ticket # ${id}  `))).toBe(true);
    expect(inv?.subtotal).toBe("415.00");
    expect(inv?.taxTotal).toBe("28.00"); // 7% of the 400.00 camera line only
    expect((await row(cam.id)).invoice).toBe(inv?.id);
    expect((await row(ship.id)).invoice).toBe(inv?.id);
    for (const c of [free, written, later]) expect((await row(c.id)).invoice).toBeNull();

    expect((await ticketRun("2027-03-10")).statusCode).toBe(422); // nothing left to bill by then
    expect((await ticketRun("2027-03-31")).statusCode).toBe(201); // the later one bills on its own
  });

  it("bills materials with labor, and with a fixed-fee ticket that is not closed yet", async () => {
    const { id, company } = await ticket();
    const e = await call("POST", "/api/v1/time-entries", {
      ticketId: id,
      workRoleId: roleId,
      workTypeId: typeId,
      workDate: "2027-04-02",
      hours: 2,
    });
    await pool.query("UPDATE timekeeping.time_entry SET status = 'approved' WHERE id = $1", [
      e.json().id,
    ]);
    await charge(id, { productId: camera, incurredOn: "2027-04-02" });
    const res = await ticketRun("2027-04-30");
    expect(res.statusCode).toBe(201);
    const [inv] = (await invoicesOf(res.json().id)).filter((i) => i.companyId === company);
    expect(inv?.lines.map((l) => l.kind).sort()).toEqual(["product", "time"]);

    const fixed = await ticket();
    await call("PATCH", `/api/v1/tickets/${fixed.id}`, {
      billingMethod: "fixed_fee",
      billingAmount: 500,
    });
    const t = await call("POST", "/api/v1/time-entries", {
      ticketId: fixed.id,
      workRoleId: roleId,
      workTypeId: typeId,
      workDate: "2027-05-02",
      hours: 1,
    });
    await pool.query("UPDATE timekeeping.time_entry SET status = 'approved' WHERE id = $1", [
      t.json().id,
    ]);
    await charge(fixed.id, { productId: camera, incurredOn: "2027-05-02" });
    const held = await ticketRun("2027-05-31");
    expect(held.statusCode).toBe(201); // the camera bills now ...
    const preview = await call("POST", "/api/v1/billing/runs", {
      kind: "ticket",
      throughDate: "2027-05-31",
      invoiceDate: "2027-06-01",
      preview: true,
    });
    // ... and the labor waits for the ticket to close
    expect(preview.json().skipped.some((s: { id: number }) => s.id === fixed.id)).toBe(true);
    await call("PATCH", `/api/v1/tickets/${fixed.id}`, { statusId: closedStatus });
    expect((await ticketRun("2027-05-31")).statusCode).toBe(201);
  });

  it("freezes a charge once it is on an invoice, and lets it go with the line", async () => {
    const { id, company } = await ticket();
    const a = await charge(id, { productId: camera, incurredOn: "2027-07-02" });
    const b = await charge(id, {
      kind: "expense",
      description: "Lift rental",
      unitPrice: 300,
      incurredOn: "2027-07-02",
    });
    const res = await ticketRun("2027-07-31");
    expect(res.statusCode).toBe(201);
    const runId = res.json().id as number;
    const [inv] = (await invoicesOf(runId)).filter((i) => i.companyId === company);

    expect(
      (await call("PATCH", `/api/v1/tickets/${id}/charges/${a.id}`, { quantity: 5 })).statusCode,
    ).toBe(409);
    expect((await call("DELETE", `/api/v1/tickets/${id}/charges/${a.id}`)).statusCode).toBe(409);
    // the database refuses too, even for code that skips the API
    await expect(
      pool.query("UPDATE service.ticket_charge SET quantity = 9 WHERE id = $1", [a.id]),
    ).rejects.toThrow(/on an invoice/);

    const line = inv?.lines.find((l) => l.kind === "product");
    const del = await call("DELETE", `/api/v1/billing/invoices/${inv?.id}/lines/${line?.id}`);
    expect(del.statusCode).toBe(200);
    expect((await row(a.id)).invoice).toBeNull();
    expect((await row(b.id)).invoice).toBe(inv?.id);
    expect(
      (await call("PATCH", `/api/v1/tickets/${id}/charges/${a.id}`, { quantity: 3 })).statusCode,
    ).toBe(200);

    const posted = await call("POST", `/api/v1/billing/runs/${runId}/post`);
    expect(posted.statusCode).toBe(200);
    expect((await row(b.id)).invoice).toBe(inv?.id);
    const shown = (await call("GET", `/api/v1/tickets/${id}/charges`)).json().items;
    expect(shown.find((c: { id: number }) => c.id === b.id).invoiceNumber).not.toBeNull();

    const voided = await call("POST", `/api/v1/billing/invoices/${inv?.id}/void`, {
      reason: "Wrong customer",
    });
    expect(voided.statusCode).toBe(200);
    expect((await row(b.id)).invoice).toBeNull();
    expect((await ticketRun("2027-07-31")).statusCode).toBe(201);
  });

  it("releases charges when the whole run is discarded", async () => {
    const { id, company } = await ticket();
    const a = await charge(id, { productId: camera, incurredOn: "2027-08-02" });
    const res = await ticketRun("2027-08-31");
    expect(res.statusCode).toBe(201);
    expect((await row(a.id)).invoice).not.toBeNull();
    const discard = await call("POST", `/api/v1/billing/runs/${res.json().id}/discard`);
    expect(discard.statusCode).toBe(200);
    expect((await row(a.id)).invoice).toBeNull();
    expect(company).toBeGreaterThan(0);
    expect((await ticketRun("2027-08-31")).statusCode).toBe(201);
  });
});
