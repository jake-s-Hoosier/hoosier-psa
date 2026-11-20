import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("credit memos (integration)", () => {
  const dbName = `hoosier_credit_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let boss: number;
  let manager: number;
  let tech: number;
  let seq = 0;
  let number = 80000;
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
       VALUES ('C${seq}-${process.pid}','Credit Co ${seq}',(SELECT id FROM crm.company_status WHERE name='Active')) RETURNING id`,
    );
  };
  /** A posted invoice with one taxable $100 line at 7%: total 107.00. */
  const invoice = async (companyId: number) => {
    number += 1;
    const id = await one(
      `INSERT INTO billing.invoice (company_id, status, invoice_date, due_date, tax_rate_pct, subtotal, tax_total, total)
       VALUES ($1,'draft','2027-01-05','2027-02-04',7,100,7,107) RETURNING id`,
      [companyId],
    );
    const line = await one(
      `INSERT INTO billing.invoice_line (invoice_id, line_no, kind, description, quantity, unit_price, amount, taxable)
       VALUES ($1,1,'fee','Monitoring',1,100,100,true) RETURNING id`,
      [id],
    );
    await pool.query("UPDATE billing.invoice SET status='posted', invoice_number=$2 WHERE id=$1", [
      id,
      number,
    ]);
    return { id, line };
  };
  const memo = (body: object) =>
    call("POST", "/api/v1/credit-memos", {
      memoDate: "2027-01-20",
      reason: "Billed in error",
      ...body,
    });
  const inv = async (id: number) =>
    (
      await pool.query(
        "SELECT status, amount_paid::float AS paid FROM billing.invoice WHERE id = $1",
        [id],
      )
    ).rows[0];

  it("credits part of an invoice with its tax and shares the invoice number series", async () => {
    const co = await company();
    const i = await invoice(co);
    const before = (await pool.query("SELECT last_number FROM billing.invoice_counter")).rows[0]
      .last_number;
    const r = await memo({
      companyId: co,
      sourceInvoiceId: i.id,
      lines: [
        {
          description: "Credit: monitoring for one month",
          quantity: 1,
          unitPrice: 40,
          taxable: true,
          sourceLineId: i.line,
        },
      ],
      applications: [{ invoiceId: i.id, amount: 42.8 }],
    });
    expect(r.statusCode).toBe(201);
    const m = r.json();
    expect(m).toMatchObject({
      status: "posted",
      subtotal: "40.00",
      taxTotal: "2.80",
      total: "42.80",
      appliedAmount: "42.80",
      unappliedAmount: "0.00",
      sourceInvoiceId: i.id,
    });
    expect(m.memoNumber).toBe(Number(before) + 1);
    expect(m.lines).toHaveLength(1);
    expect(await inv(i.id)).toEqual({ status: "partially_paid", paid: 42.8 });
    const pdf = await call("GET", `/api/v1/billing/invoices/${i.id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("will not credit more than was invoiced, or apply more than the balance", async () => {
    const co = await company();
    const i = await invoice(co);
    const big = await memo({
      companyId: co,
      sourceInvoiceId: i.id,
      lines: [{ description: "Too much", quantity: 1, unitPrice: 101, taxable: true }],
    });
    expect(big.statusCode).toBe(422);
    expect(big.json().title).toBe("More than the invoice");
    const first = await memo({
      companyId: co,
      sourceInvoiceId: i.id,
      lines: [{ description: "Most of it", quantity: 1, unitPrice: 80, taxable: true }],
    });
    expect(first.statusCode).toBe(201); // 85.60 of 107.00
    const second = await memo({
      companyId: co,
      sourceInvoiceId: i.id,
      lines: [{ description: "The rest and more", quantity: 1, unitPrice: 25, taxable: true }],
    });
    expect(second.json().title).toBe("More than the invoice"); // 26.75 > 21.40 left
    const over = await memo({
      companyId: co,
      sourceInvoiceId: i.id,
      lines: [{ description: "A little", quantity: 1, unitPrice: 10, taxable: false }],
      applications: [{ invoiceId: i.id, amount: 11 }],
    });
    expect(over.json().title).toBe("More than the credit");
    expect(
      (await memo({ companyId: co, lines: [{ description: "x", quantity: 0, unitPrice: 5 }] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await memo({ companyId: co, lines: [{ description: "x", quantity: 1, unitPrice: 0 }] }))
        .statusCode,
    ).toBe(422);
    expect(
      (await memo({ companyId: co, lines: [{ description: "x", quantity: 1, unitPrice: 5.555 }] }))
        .statusCode,
    ).toBeLessThan(500);
  });

  it("refuses the wrong customer, a draft invoice and a line from another invoice", async () => {
    const co = await company();
    const other = await company();
    const mine = await invoice(co);
    const theirs = await invoice(other);
    const line = [{ description: "Credit", quantity: 1, unitPrice: 10, taxable: false }];
    expect(
      (await memo({ companyId: co, sourceInvoiceId: theirs.id, lines: line })).json().title,
    ).toBe("Wrong customer");
    const draft = await one(
      `INSERT INTO billing.invoice (company_id, status, invoice_date, due_date, subtotal, total)
       VALUES ($1,'draft','2027-01-05','2027-02-04',10,10) RETURNING id`,
      [co],
    );
    expect((await memo({ companyId: co, sourceInvoiceId: draft, lines: line })).json().title).toBe(
      "Not creditable",
    );
    expect(
      (
        await memo({
          companyId: co,
          sourceInvoiceId: mine.id,
          lines: [{ ...line[0], sourceLineId: theirs.line }],
        })
      ).json().title,
    ).toBe("Invalid line");
    expect(
      (
        await memo({
          companyId: co,
          lines: line,
          applications: [{ invoiceId: theirs.id, amount: 5 }],
        })
      ).json().title,
    ).toBe("Wrong customer");
    // a refused memo leaves nothing behind
    const n = await pool.query(
      "SELECT count(*)::int AS n FROM billing.credit_memo WHERE company_id = $1",
      [co],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("keeps unapplied credit, applies it later, takes it back, and voids to reopen", async () => {
    const co = await company();
    const a = await invoice(co);
    const b = await invoice(co);
    // Pay A in full, then credit it: the credit has nowhere to go yet.
    const paid = await call("POST", "/api/v1/payments", {
      companyId: co,
      receivedOn: "2027-01-10",
      method: "check",
      amount: 107,
      applications: [{ invoiceId: a.id, amount: 107 }],
    });
    expect(paid.statusCode).toBe(201);
    const made = await memo({
      companyId: co,
      sourceInvoiceId: a.id,
      lines: [{ description: "Refund owed", quantity: 1, unitPrice: 50, taxable: false }],
      applications: [{ invoiceId: a.id, amount: 10 }],
    });
    expect(made.json().title).toBe("Not payable");
    const ok = await memo({
      companyId: co,
      sourceInvoiceId: a.id,
      lines: [{ description: "Refund owed", quantity: 1, unitPrice: 50, taxable: false }],
    });
    expect(ok.statusCode).toBe(201);
    const id = ok.json().id as number;
    expect(ok.json()).toMatchObject({ unappliedAmount: "50.00" });
    expect(
      (await call("GET", `/api/v1/credit-memos?state=unapplied&companyId=${co}`)).json().total,
    ).toBe(1);

    expect(
      (await call("POST", `/api/v1/credit-memos/${id}/apply`, { invoiceId: b.id, amount: 60 }))
        .statusCode,
    ).toBe(422);
    const applied = await call("POST", `/api/v1/credit-memos/${id}/apply`, {
      invoiceId: b.id,
      amount: 50,
    });
    expect(applied.statusCode).toBe(200);
    expect(await inv(b.id)).toEqual({ status: "partially_paid", paid: 50 });
    // a payment and a credit together fill the invoice, and the database counts both
    const rest = await call("POST", "/api/v1/payments", {
      companyId: co,
      receivedOn: "2027-01-11",
      method: "ach",
      amount: 57,
      applications: [{ invoiceId: b.id, amount: 57 }],
    });
    expect(rest.statusCode).toBe(201);
    expect(await inv(b.id)).toEqual({ status: "paid", paid: 107 });

    // the invoice cannot be voided while credit is applied; taking it back reopens the balance
    expect(
      (await call("POST", `/api/v1/billing/invoices/${b.id}/void`, { reason: "Oops" })).statusCode,
    ).toBe(409);
    const appId = applied.json().applications[0].id as number;
    expect(
      (await call("DELETE", `/api/v1/credit-memos/${id}/applications/${appId}`)).statusCode,
    ).toBe(200);
    expect(await inv(b.id)).toEqual({ status: "partially_paid", paid: 57 });

    // voiding the memo after re-applying reopens that invoice too
    await call("POST", `/api/v1/credit-memos/${id}/apply`, { invoiceId: b.id, amount: 50 });
    expect(await inv(b.id)).toEqual({ status: "paid", paid: 107 });
    const v = await call("POST", `/api/v1/credit-memos/${id}/void`, {
      reason: "Issued to the wrong account",
    });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({
      status: "void",
      appliedAmount: "0.00",
      unappliedAmount: "0.00",
    });
    expect(await inv(b.id)).toEqual({ status: "partially_paid", paid: 57 });
    expect(
      (await call("POST", `/api/v1/credit-memos/${id}/void`, { reason: "again" })).statusCode,
    ).toBe(409);
    expect(
      (await call("POST", `/api/v1/credit-memos/${id}/apply`, { invoiceId: b.id, amount: 5 }))
        .statusCode,
    ).toBe(409);
    // a voided credit no longer counts against what an invoice can still be credited
    const again = await memo({
      companyId: co,
      sourceInvoiceId: a.id,
      lines: [{ description: "Replacement credit", quantity: 1, unitPrice: 100, taxable: true }],
    });
    expect(again.statusCode).toBe(201);
  });

  it("is enforced by the database too", async () => {
    const co = await company();
    const i = await invoice(co);
    const made = await memo({
      companyId: co,
      sourceInvoiceId: i.id,
      lines: [{ description: "Credit", quantity: 1, unitPrice: 10, taxable: false }],
      applications: [{ invoiceId: i.id, amount: 5 }],
    });
    const id = made.json().id as number;
    await expect(pool.query("DELETE FROM billing.credit_memo WHERE id = $1", [id])).rejects.toThrow(
      /voided, not deleted/,
    );
    await expect(
      pool.query("UPDATE billing.credit_memo SET total = 99, subtotal = 99 WHERE id = $1", [id]),
    ).rejects.toThrow(/cannot be edited/);
    await expect(
      pool.query("UPDATE billing.credit_memo_line SET amount = 99 WHERE credit_memo_id = $1", [id]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      pool.query("DELETE FROM billing.credit_memo_line WHERE credit_memo_id = $1", [id]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      pool.query(
        "INSERT INTO billing.credit_memo_line (credit_memo_id, line_no, description, amount) VALUES ($1,2,'extra',1)",
        [id],
      ),
    ).rejects.toThrow(/more than the credit memo/);
    await expect(
      pool.query(
        "INSERT INTO billing.credit_application (credit_memo_id, invoice_id, amount) VALUES ($1,$2,6)",
        [id, i.id],
      ),
    ).rejects.toThrow(/More than the credit memo/);
    // a memo whose lines do not add up cannot be committed
    await expect(
      pool.query(
        `INSERT INTO billing.credit_memo (company_id, memo_number, memo_date, reason, subtotal, total)
         VALUES ($1, 999999, '2027-01-20', 'No lines', 10, 10)`,
        [co],
      ),
    ).rejects.toThrow(/do not add up/);
  });

  it("limits who can see and issue credit memos", async () => {
    const co = await company();
    expect((await call("GET", "/api/v1/credit-memos", undefined, tech)).statusCode).toBe(403);
    expect((await call("GET", "/api/v1/credit-memos", undefined, manager)).statusCode).toBe(200);
    const denied = await call(
      "POST",
      "/api/v1/credit-memos",
      {
        companyId: co,
        memoDate: "2027-01-20",
        reason: "Nope",
        lines: [{ description: "x", quantity: 1, unitPrice: 5 }],
      },
      manager,
    );
    expect(denied.statusCode).toBe(403);
  });
});
