import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("billing runs and invoices (integration)", () => {
  const dbName = `hoosier_bill_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let boss: number;
  let tech: number;
  let taxable: number;
  let acme: number; // 7% tax, Net 30, QuickBooks-linked
  let bare: number; // no tax code, no terms
  let productId: number;
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
  const status = "(SELECT id FROM crm.company_status WHERE name='Active')";

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
    tech = await one(
      "INSERT INTO iam.member (identifier, first_name, last_name, email) VALUES ('t','Tess','Tech','t@e.com') RETURNING id",
    );
    await pool.query(
      "INSERT INTO iam.member_role (member_id, role_id) SELECT $1, id FROM iam.role WHERE name = 'Administrator'",
      [boss],
    );
    await pool.query(
      "INSERT INTO iam.member_role (member_id, role_id) SELECT $1, id FROM iam.role WHERE name = 'Technician'",
      [tech],
    );
    const tax = await one(
      "INSERT INTO catalog.tax_code (name, rate_pct) VALUES ('IN 7%', 7) RETURNING id",
    );
    const terms = await one(
      "INSERT INTO catalog.billing_terms (name, due_days) VALUES ('Net 30', 30) RETURNING id",
    );
    acme = await one(
      `INSERT INTO crm.company (identifier, name, status_id, tax_code_id, billing_terms_id, qb_customer_list_id)
       VALUES ('ACME','Acme',${status},$1,$2,'80000001-1') RETURNING id`,
      [tax, terms],
    );
    bare = await one(
      `INSERT INTO crm.company (identifier, name, status_id) VALUES ('BARE','Bare Co',${status}) RETURNING id`,
    );
    productId = await one(
      "INSERT INTO catalog.product (identifier, description, kind, is_taxable) VALUES ('LIC','Licence','agreement',true) RETURNING id",
    );
    taxable = productId;
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

  const typeFor = async (cycle: string) =>
    (
      await call("POST", "/api/v1/agreements/types", {
        name: `T-${cycle}-${Math.random()}`,
        billCycle: cycle,
        coverage: "none",
        autoRenew: true,
      })
    ).json().id as number;
  /** An agreement billed from 2027-01-01 with lines given as [description, quantity, unit price]. */
  const agreement = async (
    companyId: number,
    cycle: string,
    lines: Array<[string, number, number, object?]>,
    extra: object = {},
  ) => {
    const res = await call("POST", "/api/v1/agreements", {
      companyId,
      typeId: await typeFor(cycle),
      name: `Agr ${Math.random().toString(36).slice(2, 6)}`,
      startDate: "2026-12-01",
      billStartDate: "2027-01-01",
      billCycle: cycle,
      ...extra,
    });
    expect(res.statusCode).toBe(201);
    const a = res.json();
    for (const [description, quantity, unitPrice, more] of lines) {
      const add = await call("POST", `/api/v1/agreements/${a.id}/additions`, {
        description,
        quantity,
        unitPrice,
        effectiveFrom: "2026-12-01",
        productId: taxable,
        ...more,
      });
      expect(add.statusCode).toBe(201);
    }
    return a as { id: number; name: string };
  };
  const preview = (month: string) => call("POST", "/api/v1/billing/runs", { month, preview: true });
  const run = (month: string, extra: object = {}) =>
    call("POST", "/api/v1/billing/runs", { month, invoiceDate: "2027-01-02", ...extra });
  const count = async (sql: string) => Number((await pool.query<{ n: string }>(sql)).rows[0]?.n);

  it("keeps billing away from staff without the permissions", async () => {
    expect((await call("GET", "/api/v1/billing/invoices", undefined, tech)).statusCode).toBe(403);
    expect(
      (await call("POST", "/api/v1/billing/runs", { month: "2027-01" }, tech)).statusCode,
    ).toBe(403);
  });

  it("previews a run without saving anything and rejects a bad month", async () => {
    await agreement(acme, "monthly", [["Cameras", 10, 12.5]]);
    const p = await preview("2027-01");
    expect(p.statusCode).toBe(200);
    expect(p.json().invoices).toHaveLength(1);
    expect(await count("SELECT count(*) AS n FROM billing.invoice")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM billing.billing_run")).toBe(0);
    expect((await call("POST", "/api/v1/billing/runs", { month: "2027-13" })).statusCode).toBe(400);
  });

  it("builds a draft invoice with tax, terms and a gap-free total", async () => {
    const res = await run("2027-01");
    expect(res.statusCode).toBe(201);
    const r = (await call("GET", `/api/v1/billing/runs/${res.json().id}`)).json();
    expect(r).toMatchObject({ status: "draft", periodMonth: "2027-01", invoiceCount: 1 });
    const inv = r.invoices[0];
    // 10 x 12.50 = 125.00, taxable at 7% = 8.75
    expect(inv).toMatchObject({
      company: "Acme",
      status: "draft",
      subtotal: "125.00",
      taxTotal: "8.75",
      total: "133.75",
      invoiceDate: "2027-01-02",
      dueDate: "2027-02-01",
      terms: "Net 30",
      invoiceNumber: null,
      warnings: [],
    });
    const full = (await call("GET", `/api/v1/billing/invoices/${inv.id}`)).json();
    expect(full.lines[0]).toMatchObject({
      kind: "agreement",
      periodStart: "2027-01-01",
      periodEnd: "2027-01-31",
      amount: "125.00",
    });
  });

  it("cannot bill the same period twice, from a rerun or a second run", async () => {
    const again = await run("2027-01");
    expect(again.statusCode).toBe(422);
    const p = (await preview("2027-01")).json();
    expect(p.invoices).toEqual([]);
    expect(p.skipped.some((s: { reason: string }) => s.reason.includes("Already billed"))).toBe(
      true,
    );
  });

  it("discarding a draft run frees its periods to be billed again", async () => {
    const runs = (await call("GET", "/api/v1/billing/runs")).json().items;
    const id = runs[0].id;
    const d = await call("POST", `/api/v1/billing/runs/${id}/discard`);
    expect(d.json().status).toBe("discarded");
    expect(await count("SELECT count(*) AS n FROM billing.invoice")).toBe(0);
    expect((await run("2027-01")).statusCode).toBe(201);
  });

  it("bills quarterly agreements only in their months and groups lines by bill-to company", async () => {
    // Billed to Acme though the agreement belongs to Bare Co.
    await agreement(bare, "quarterly", [["Monitoring", 1, 30]], { billToCompanyId: acme });
    const feb = (await preview("2027-02")).json();
    const febLines = feb.invoices.flatMap(
      (i: { lines: Array<{ description: string }> }) => i.lines,
    );
    expect(
      febLines.some((l: { description: string }) => l.description.includes("Monitoring")),
    ).toBe(false);
    const p = (await preview("2027-04")).json();
    // Quarterly: 3 months x 30. It lands on Acme's invoice (the payer), beside Acme's own monthly lines.
    const acmeInv = p.invoices.find((i: { company: string }) => i.company === "Acme");
    const mon = acmeInv.lines.find((l: { description: string }) =>
      l.description.includes("Monitoring"),
    );
    expect(mon).toMatchObject({
      amount: "90.00",
      periodStart: "2027-04-01",
      periodEnd: "2027-06-30",
    });
    expect(p.invoices.filter((i: { company: string }) => i.company === "Acme")).toHaveLength(1);
  });

  it("prorates a line that starts mid-period and warns about missing tax code and terms", async () => {
    const a = await agreement(bare, "monthly", [
      ["Late start", 1, 31, { effectiveFrom: "2027-02-15" }],
    ]);
    const p = (await preview("2027-02")).json();
    const inv = p.invoices.find((i: { company: string }) => i.company === "Bare Co");
    // 14 of 28 days
    expect(
      inv.lines.find((l: { description: string }) => l.description.includes("Late start")),
    ).toMatchObject({
      amount: "15.50",
    });
    expect(inv.lines[0].description).toContain("(prorated)");
    expect(inv.taxTotal).toBe("0.00");
    expect(inv.warnings.join(" ")).toMatch(/no tax code/);
    expect(inv.warnings.join(" ")).toMatch(/no billing terms/);
    expect(a.id).toBeGreaterThan(0);
  });

  it("skips cancelled agreements with a reason", async () => {
    const a = await agreement(acme, "monthly", [["Gone", 1, 5]]);
    const c = await call("POST", `/api/v1/agreements/${a.id}/cancel`, {
      date: "2027-02-10",
      reason: "left",
    });
    expect(c.statusCode).toBe(200);
    const p = (await preview("2027-03")).json();
    expect(p.skipped).toContainEqual(
      expect.objectContaining({ agreementId: a.id, reason: "Cancelled before this period" }),
    );
  });

  it("edits a draft: line price recalculates totals, removing a line and the invoice works", async () => {
    const r = await run("2027-03");
    const detail = (await call("GET", `/api/v1/billing/runs/${r.json().id}`)).json();
    const inv = detail.invoices.find((i: { company: string }) => i.company === "Acme");
    const full = (await call("GET", `/api/v1/billing/invoices/${inv.id}`)).json();
    const first = full.lines[0];
    const patched = await call("PATCH", `/api/v1/billing/invoices/${inv.id}/lines/${first.id}`, {
      unitPrice: 20,
      quantity: 2,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().lines[0]).toMatchObject({ amount: "40.00" });
    const meta = await call("PATCH", `/api/v1/billing/invoices/${inv.id}`, {
      poNumber: "PO-9",
      invoiceDate: "2027-03-05",
    });
    expect(meta.json()).toMatchObject({ poNumber: "PO-9", dueDate: "2027-04-04" });
    const removed = await call("DELETE", `/api/v1/billing/invoices/${inv.id}/lines/${first.id}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().lineCount).toBe(full.lines.length - 1);
    // Posting refuses an invoice with no lines.
    for (const l of removed.json().lines)
      await call("DELETE", `/api/v1/billing/invoices/${inv.id}/lines/${l.id}`);
    const blocked = await call("POST", `/api/v1/billing/runs/${r.json().id}/post`);
    expect(blocked.statusCode).toBe(422);
    expect((await call("DELETE", `/api/v1/billing/invoices/${inv.id}`)).statusCode).toBe(204);
    await call("POST", `/api/v1/billing/runs/${r.json().id}/discard`);
  });

  it("posts a run: gap-free numbers in company order, then the invoices are frozen", async () => {
    const r = await run("2027-02");
    const id = r.json().id;
    const posted = await call("POST", `/api/v1/billing/runs/${id}/post`);
    expect(posted.statusCode).toBe(200);
    expect(posted.json().status).toBe("posted");
    const invs = (await call("GET", `/api/v1/billing/runs/${id}`)).json().invoices;
    expect(invs.map((i: { invoiceNumber: number }) => i.invoiceNumber)).toEqual([1, 2]);
    expect(invs.map((i: { company: string }) => i.company)).toEqual(["Acme", "Bare Co"]);
    expect(invs.every((i: { status: string }) => i.status === "posted")).toBe(true);
    // Second post, edits and deletes are refused.
    expect((await call("POST", `/api/v1/billing/runs/${id}/post`)).statusCode).toBe(409);
    expect(
      (await call("PATCH", `/api/v1/billing/invoices/${invs[0].id}`, { notes: "x" })).statusCode,
    ).toBe(409);
    expect((await call("DELETE", `/api/v1/billing/invoices/${invs[0].id}`)).statusCode).toBe(409);
    // The database refuses too, with no help from the API.
    await expect(
      pool.query("UPDATE billing.invoice SET total = 1 WHERE id = $1", [invs[0].id]),
    ).rejects.toThrow(/cannot be edited/);
    await expect(
      pool.query("DELETE FROM billing.invoice_line WHERE invoice_id = $1", [invs[0].id]),
    ).rejects.toThrow(/posted invoice/);
    // The next run continues the sequence.
    const next = await run("2027-04");
    await call("POST", `/api/v1/billing/runs/${next.json().id}/post`);
    const n = (await call("GET", `/api/v1/billing/runs/${next.json().id}`)).json().invoices[0];
    expect(n.invoiceNumber).toBe(3);
  });

  it("voids a posted invoice with a reason, keeps its number, and frees the period", async () => {
    const list = (await call("GET", "/api/v1/billing/invoices?status=posted&q=Acme")).json().items;
    const inv = list.find((i: { invoiceNumber: number }) => i.invoiceNumber === 1);
    expect(
      (await call("POST", `/api/v1/billing/invoices/${inv.id}/void`, { reason: "" })).statusCode,
    ).toBe(400);
    const v = await call("POST", `/api/v1/billing/invoices/${inv.id}/void`, {
      reason: "Wrong price",
    });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ status: "void", invoiceNumber: 1, voidReason: "Wrong price" });
    expect(
      (await call("POST", `/api/v1/billing/invoices/${inv.id}/void`, { reason: "again" }))
        .statusCode,
    ).toBe(409);
    // The voided period can be billed again, and the new invoice takes the next number.
    const again = await run("2027-02");
    expect(again.statusCode).toBe(201);
    await call("POST", `/api/v1/billing/runs/${again.json().id}/post`);
    const fresh = (await call("GET", `/api/v1/billing/runs/${again.json().id}`)).json().invoices;
    // 1-2 were February, 3-4 April; the voided number 1 is not reused.
    expect(fresh.map((i: { invoiceNumber: number }) => i.invoiceNumber)).toEqual([5]);
  });

  it("refuses to void an invoice that has payments, and a draft", async () => {
    const draftRun = await run("2027-05");
    expect(draftRun.statusCode).toBe(201);
    const inv = (await call("GET", `/api/v1/billing/runs/${draftRun.json().id}`)).json()
      .invoices[0];
    expect(
      (await call("POST", `/api/v1/billing/invoices/${inv.id}/void`, { reason: "nope" }))
        .statusCode,
    ).toBe(409);
    await call("POST", `/api/v1/billing/runs/${draftRun.json().id}/discard`);
    const posted = (await call("GET", "/api/v1/billing/invoices?status=posted")).json().items[0];
    await pool.query(
      "UPDATE billing.invoice SET amount_paid = 10, status = 'partially_paid' WHERE id = $1",
      [posted.id],
    );
    expect(
      (await call("POST", `/api/v1/billing/invoices/${posted.id}/void`, { reason: "nope" }))
        .statusCode,
    ).toBe(409);
  });

  it("filters the invoice list by status and finds an invoice by number", async () => {
    const open = (await call("GET", "/api/v1/billing/invoices?status=open")).json();
    expect(
      open.items.every((i: { status: string }) => ["posted", "partially_paid"].includes(i.status)),
    ).toBe(true);
    const byNumber = (await call("GET", "/api/v1/billing/invoices?q=2")).json();
    expect(byNumber.items.some((i: { invoiceNumber: number }) => i.invoiceNumber === 2)).toBe(true);
  });
});
