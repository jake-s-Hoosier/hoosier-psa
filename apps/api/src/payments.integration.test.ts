import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("payments (integration)", () => {
  const dbName = `hoosier_pay_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let boss: number;
  let manager: number;
  let tech: number;
  let seq = 0;
  let number = 90000;
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
    boss = await member("boss", "Administrator");
    manager = await member("mgr", "Manager");
    tech = await member("tech", "Technician");
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

  const company = async () => {
    seq += 1;
    return one(
      `INSERT INTO crm.company (identifier, name, status_id)
       VALUES ('P${seq}-${process.pid}','Payer ${seq}',(SELECT id FROM crm.company_status WHERE name='Active')) RETURNING id`,
    );
  };
  /** A posted invoice for the given total (no tax), inserted directly. */
  const invoice = async (companyId: number, total: number, status = "posted") => {
    number += 1;
    return one(
      `INSERT INTO billing.invoice (company_id, status, invoice_number, invoice_date, due_date, subtotal, tax_total, total)
       VALUES ($1,$2,$3,'2027-01-05','2027-02-04',$4,0,$4) RETURNING id`,
      [companyId, status, status === "draft" ? null : number, total],
    );
  };
  const pay = (
    companyId: number,
    amount: number,
    applications: object[] = [],
    extra: object = {},
  ) =>
    call("POST", "/api/v1/payments", {
      companyId,
      receivedOn: "2027-01-20",
      method: "check",
      reference: "1001",
      amount,
      applications,
      ...extra,
    });
  const inv = async (id: number) =>
    (
      await pool.query(
        "SELECT status, amount_paid::float AS paid FROM billing.invoice WHERE id = $1",
        [id],
      )
    ).rows[0];

  it("pays an invoice in two parts and marks it partly paid, then paid", async () => {
    const co = await company();
    const i = await invoice(co, 300);
    const first = await pay(co, 100, [{ invoiceId: i, amount: 100 }]);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      appliedAmount: "100.00",
      unappliedAmount: "0.00",
      status: "posted",
    });
    expect(await inv(i)).toEqual({ status: "partially_paid", paid: 100 });

    const second = await pay(co, 200, [{ invoiceId: i, amount: 200 }], {
      method: "ach",
      reference: "T-77",
    });
    expect(second.statusCode).toBe(201);
    expect(await inv(i)).toEqual({ status: "paid", paid: 300 });

    const list = (await call("GET", `/api/v1/payments?invoiceId=${i}`)).json();
    expect(list.total).toBe(2);
    expect(list.items[0].applications[0].invoiceId).toBe(i);
    // a paid invoice takes nothing more
    const more = await pay(co, 10, [{ invoiceId: i, amount: 10 }]);
    expect(more.statusCode).toBe(422);
  });

  it("refuses what cannot be right", async () => {
    const co = await company();
    const other = await company();
    const i = await invoice(co, 100);
    const draft = await invoice(co, 50, "draft");
    const theirs = await invoice(other, 100);

    expect((await pay(co, 150, [{ invoiceId: i, amount: 150 }])).json().title).toBe(
      "More than the balance",
    );
    expect((await pay(co, 100, [{ invoiceId: theirs, amount: 100 }])).json().title).toBe(
      "Wrong customer",
    );
    expect((await pay(co, 50, [{ invoiceId: draft, amount: 50 }])).json().title).toBe(
      "Not payable",
    );
    expect(
      (
        await pay(co, 100, [
          { invoiceId: i, amount: 60 },
          { invoiceId: i, amount: 40 },
        ])
      ).statusCode,
    ).toBe(422);
    expect((await pay(co, 50, [{ invoiceId: i, amount: 60 }])).json().title).toBe(
      "More than received",
    );
    expect((await pay(co, 10.005)).statusCode).toBe(422);
    expect((await pay(co, 0)).statusCode).toBe(400);
    expect((await pay(co, 10, [], { feeAmount: 10 })).statusCode).toBe(400);
    expect((await pay(999999, 10)).statusCode).toBe(422);
    // a refused payment leaves nothing behind
    expect(await inv(i)).toEqual({ status: "posted", paid: 0 });
    const left = await pool.query(
      "SELECT count(*)::int AS n FROM payments.payment WHERE company_id = $1",
      [co],
    );
    expect(left.rows[0].n).toBe(0);
  });

  it("keeps an overpayment as credit and applies it later", async () => {
    const co = await company();
    const a = await invoice(co, 200);
    const b = await invoice(co, 400);
    const made = await pay(co, 500, [{ invoiceId: a, amount: 200 }]);
    expect(made.json()).toMatchObject({ appliedAmount: "200.00", unappliedAmount: "300.00" });
    const id = made.json().id as number;
    const credits = (await call("GET", `/api/v1/payments?state=unapplied&companyId=${co}`)).json();
    expect(credits.items.map((p: { id: number }) => p.id)).toEqual([id]);

    expect(
      (await call("POST", `/api/v1/payments/${id}/apply`, { invoiceId: b, amount: 350 }))
        .statusCode,
    ).toBe(422);
    const applied = await call("POST", `/api/v1/payments/${id}/apply`, {
      invoiceId: b,
      amount: 300,
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().unappliedAmount).toBe("0.00");
    expect(await inv(b)).toEqual({ status: "partially_paid", paid: 300 });
    expect(
      (await call("GET", `/api/v1/payments?state=unapplied&companyId=${co}`)).json().total,
    ).toBe(0);
  });

  it("takes an application back, and voids a payment to reopen its invoices", async () => {
    const co = await company();
    const i = await invoice(co, 250);
    const made = await pay(co, 250, [{ invoiceId: i, amount: 250 }]);
    const id = made.json().id as number;
    expect(await inv(i)).toEqual({ status: "paid", paid: 250 });

    const undone = await call(
      "DELETE",
      `/api/v1/payments/${id}/applications/${made.json().applications[0].id}`,
    );
    expect(undone.statusCode).toBe(200);
    expect(undone.json().unappliedAmount).toBe("250.00");
    expect(await inv(i)).toEqual({ status: "posted", paid: 0 });

    await call("POST", `/api/v1/payments/${id}/apply`, { invoiceId: i, amount: 250 });
    const voidInvoice = await call("POST", `/api/v1/billing/invoices/${i}/void`, {
      reason: "Billed in error",
    });
    expect(voidInvoice.statusCode).toBe(409); // has payments

    const voided = await call("POST", `/api/v1/payments/${id}/void`, { reason: "Check bounced" });
    expect(voided.statusCode).toBe(200);
    expect(voided.json()).toMatchObject({
      status: "void",
      appliedAmount: "0.00",
      unappliedAmount: "0.00",
    });
    expect(await inv(i)).toEqual({ status: "posted", paid: 0 });
    expect(
      (await call("POST", `/api/v1/payments/${id}/void`, { reason: "again" })).statusCode,
    ).toBe(409);
    expect(
      (await call("POST", `/api/v1/payments/${id}/apply`, { invoiceId: i, amount: 10 })).statusCode,
    ).toBe(409);
    expect(
      (await call("GET", "/api/v1/payments?state=void"))
        .json()
        .items.some((p: { id: number }) => p.id === id),
    ).toBe(true);

    // with the payment void, the invoice can be voided
    expect(
      (await call("POST", `/api/v1/billing/invoices/${i}/void`, { reason: "Billed in error" }))
        .statusCode,
    ).toBe(200);
  });

  it("edits notes, reference and fee only", async () => {
    const co = await company();
    const made = await pay(co, 100);
    const id = made.json().id as number;
    const ok = await call("PATCH", `/api/v1/payments/${id}`, {
      reference: "1002",
      notes: "Hand delivered",
      feeAmount: 2.9,
    });
    expect(ok.json()).toMatchObject({
      reference: "1002",
      notes: "Hand delivered",
      feeAmount: "2.90",
    });
    expect((await call("PATCH", `/api/v1/payments/${id}`, { feeAmount: 100 })).statusCode).toBe(
      422,
    );
    expect((await call("PATCH", `/api/v1/payments/${id}`, {})).statusCode).toBe(400);
  });

  it("is enforced by the database too", async () => {
    const co = await company();
    const i = await invoice(co, 100);
    const made = await pay(co, 200, [{ invoiceId: i, amount: 60 }]);
    const id = made.json().id as number;
    await expect(
      pool.query(
        "INSERT INTO payments.payment_application (payment_id, invoice_id, amount) VALUES ($1,$2,50)",
        [id, i],
      ),
    ).rejects.toThrow(/More than the invoice balance/);
    await expect(pool.query("DELETE FROM payments.payment WHERE id = $1", [id])).rejects.toThrow(
      /voided, not deleted/,
    );
    await expect(
      pool.query("UPDATE payments.payment SET amount = 5 WHERE id = $1", [id]),
    ).rejects.toThrow(/cannot be changed/);
    const draft = await invoice(co, 10, "draft");
    await expect(
      pool.query(
        "INSERT INTO payments.payment_application (payment_id, invoice_id, amount) VALUES ($1,$2,5)",
        [id, draft],
      ),
    ).rejects.toThrow(/posted, unpaid/);
  });

  it("limits who can see and record payments", async () => {
    const co = await company();
    expect((await call("GET", "/api/v1/payments", undefined, tech)).statusCode).toBe(403);
    expect((await call("GET", "/api/v1/payments", undefined, manager)).statusCode).toBe(200);
    const denied = await call(
      "POST",
      "/api/v1/payments",
      { companyId: co, receivedOn: "2027-01-20", method: "cash", amount: 5 },
      manager,
    );
    expect(denied.statusCode).toBe(403);
  });
});
