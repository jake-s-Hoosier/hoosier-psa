import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("CRM records API (integration)", () => {
  const dbName = `hoosier_crm_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let adminMember: number;
  let techMember: number;
  let statusId: number;
  let boardId: number;
  const as = (id: number) => ({ "x-dev-member-id": String(id) });

  async function id(sql: string, params: unknown[] = []): Promise<number> {
    const r = await pool.query<{ id: string }>(sql, params);
    return Number(r.rows[0]?.id);
  }
  async function call(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    who = adminMember,
  ) {
    return app.inject({ method, url, headers: as(who), payload: payload as object | undefined });
  }
  async function newCompany(identifier: string, name: string) {
    const res = await call("POST", "/api/v1/companies", { identifier, name, statusId });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: number };
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
    adminMember = await id(
      "INSERT INTO iam.member (identifier, first_name, last_name, email) VALUES ('boss','Boss','Person','b@example.com') RETURNING id",
    );
    techMember = await id(
      "INSERT INTO iam.member (identifier, first_name, last_name, email) VALUES ('tech','Tech','Person','t@example.com') RETURNING id",
    );
    await pool.query(
      `INSERT INTO iam.member_role (member_id, role_id)
       SELECT $1, id FROM iam.role WHERE name = 'Administrator'`,
      [adminMember],
    );
    await pool.query(
      `INSERT INTO iam.member_role (member_id, role_id)
       SELECT $1, id FROM iam.role WHERE name = 'Technician'`,
      [techMember],
    );
    statusId = await id("SELECT id FROM crm.company_status WHERE name = 'Active'");
    boardId = await id("INSERT INTO service.board (name) VALUES ('Service') RETURNING id");
    await pool.query(
      "INSERT INTO service.board_status (board_id, name, is_default) VALUES ($1,'New',true)",
      [boardId],
    );
    await pool.query(
      "INSERT INTO service.board_status (board_id, name, is_closed) VALUES ($1,'Closed',true)",
      [boardId],
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

  it("edits a company", async () => {
    const co = await newCompany("EDIT", "Edit Me");
    const res = await call("PATCH", `/api/v1/companies/${co.id}`, {
      name: "Edited Inc",
      phone: "317-555-0101",
      isLead: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Edited Inc", phone: "317-555-0101", isLead: true });
    expect((await call("PATCH", `/api/v1/companies/${co.id}`, {})).statusCode).toBe(400);
    expect((await call("PATCH", "/api/v1/companies/999999", { name: "x" })).statusCode).toBe(404);
  });

  it("creates sites, rejects a duplicate name, edits and removes", async () => {
    const co = await newCompany("SITES", "Sites Co");
    const a = await call("POST", `/api/v1/companies/${co.id}/sites`, {
      name: "HQ",
      addressLine1: "1 Main St",
      city: "Indianapolis",
      state: "IN",
      isDefaultService: true,
    });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ name: "HQ", city: "Indianapolis", isDefaultService: true });
    expect(
      (await call("POST", `/api/v1/companies/${co.id}/sites`, { name: "HQ" })).statusCode,
    ).toBe(409);
    const patched = await call("PATCH", `/api/v1/companies/${co.id}/sites/${a.json().id}`, {
      accessNotes: "Gate code 1234",
    });
    expect(patched.json().accessNotes).toBe("Gate code 1234");
    expect(
      (await call("DELETE", `/api/v1/companies/${co.id}/sites/${a.json().id}`)).statusCode,
    ).toBe(204);
    const overview = await call("GET", `/api/v1/companies/${co.id}/overview`);
    expect(overview.json().sites).toHaveLength(0);
  });

  it("creates contacts with normalised channels and replaces them on edit", async () => {
    const co = await newCompany("PEOPLE", "People Co");
    const site = (await call("POST", `/api/v1/companies/${co.id}/sites`, { name: "Main" })).json();
    const res = await call("POST", `/api/v1/companies/${co.id}/contacts`, {
      firstName: "Ann",
      lastName: "Lee",
      title: "Manager",
      siteId: site.id,
      channels: [
        { kind: "email", value: "Ann.Lee@People.example" },
        { kind: "mobile", value: "(317) 555-0123" },
        { kind: "email", value: "ann.lee@people.example" },
      ],
    });
    expect(res.statusCode).toBe(201);
    const contact = res.json();
    expect(contact.site).toBe("Main");
    expect(contact.channels).toHaveLength(2);
    const stored = await pool.query(
      "SELECT kind, value_normalized FROM crm.contact_channel WHERE contact_id = $1 ORDER BY kind",
      [contact.id],
    );
    expect(stored.rows).toEqual([
      { kind: "email", value_normalized: "ann.lee@people.example" },
      { kind: "mobile", value_normalized: "+13175550123" },
    ]);
    const edited = await call("PATCH", `/api/v1/companies/${co.id}/contacts/${contact.id}`, {
      channels: [{ kind: "email", value: "ann@people.example" }],
      title: "Director",
    });
    expect(edited.json()).toMatchObject({ title: "Director" });
    expect(edited.json().channels).toEqual([
      { kind: "email", value: "ann@people.example", extension: null },
    ]);
  });

  it("will not attach a contact to another company's site", async () => {
    const a = await newCompany("CROSS-A", "A");
    const b = await newCompany("CROSS-B", "B");
    const siteB = (
      await call("POST", `/api/v1/companies/${b.id}/sites`, { name: "B Site" })
    ).json();
    const res = await call("POST", `/api/v1/companies/${a.id}/contacts`, {
      firstName: "X",
      siteId: siteB.id,
    });
    expect(res.statusCode).toBe(422);
  });

  it("ties tickets to the company page: overview stats, names on tickets, filters", async () => {
    const co = await newCompany("LINKED", "Linked Co");
    const site = (await call("POST", `/api/v1/companies/${co.id}/sites`, { name: "Plant" })).json();
    const contact = (
      await call("POST", `/api/v1/companies/${co.id}/contacts`, {
        firstName: "Pat",
        lastName: "Quinn",
        siteId: site.id,
      })
    ).json();
    const t = await call("POST", "/api/v1/tickets", {
      summary: "Reader offline",
      companyId: co.id,
      siteId: site.id,
      contactId: contact.id,
      boardId,
    });
    expect(t.statusCode).toBe(201);
    expect(t.json()).toMatchObject({ site: "Plant", contact: "Pat Quinn" });

    const byContact = await call("GET", `/api/v1/tickets?contactId=${contact.id}`);
    expect(byContact.json().items).toHaveLength(1);
    const bySite = await call("GET", `/api/v1/tickets?siteId=${site.id}&state=all`);
    expect(bySite.json().items).toHaveLength(1);

    const overview = (await call("GET", `/api/v1/companies/${co.id}/overview`)).json();
    expect(overview.stats.openTickets).toBe(1);
    expect(overview.stats.ticketsLast90Days).toBe(1);
    expect(overview.contacts[0].firstName).toBe("Pat");

    // Open tickets protect the site and the contact from removal.
    expect((await call("DELETE", `/api/v1/companies/${co.id}/sites/${site.id}`)).statusCode).toBe(
      409,
    );
    expect(
      (await call("DELETE", `/api/v1/companies/${co.id}/contacts/${contact.id}`)).statusCode,
    ).toBe(409);
  });

  it("lists a company's time and filters by company", async () => {
    const co = await newCompany("TIMEY", "Timey Co");
    const other = await newCompany("TIMEZ", "Other Co");
    const role = await id(
      "INSERT INTO catalog.work_role (name, hourly_rate) VALUES ('Tech', 100) RETURNING id",
    );
    const type = await id(
      "INSERT INTO catalog.work_type (name, rate_multiplier) VALUES ('Regular', 1) RETURNING id",
    );
    for (const c of [co.id, other.id]) {
      await pool.query(
        `INSERT INTO timekeeping.time_entry (member_id, company_id, charge_type, work_role_id, work_type_id, work_date, actual_hours, billed_hours)
         VALUES ($1,$2,'non_ticket',$3,$4,current_date,2,2)`,
        [adminMember, c, role, type],
      );
    }
    const res = await call(
      "GET",
      `/api/v1/time-entries?companyId=${co.id}&memberId=${adminMember}`,
    );
    expect(res.json().items).toHaveLength(1);
    const overview = (await call("GET", `/api/v1/companies/${co.id}/overview`)).json();
    expect(overview.stats.hoursLast30Days).toBe(2);
  });

  it("keeps notes, and alerts show on the overview", async () => {
    const co = await newCompany("NOTES", "Notes Co");
    const contact = (
      await call("POST", `/api/v1/companies/${co.id}/contacts`, { firstName: "Sue" })
    ).json();
    expect(
      (
        await call("POST", `/api/v1/companies/${co.id}/notes`, {
          body: "Called about renewal",
          kind: "call",
          contactId: contact.id,
        })
      ).statusCode,
    ).toBe(201);
    const alert = await call("POST", `/api/v1/companies/${co.id}/notes`, {
      body: "Credit hold: call billing first",
      kind: "alert",
    });
    expect(alert.json()).toMatchObject({ isAlert: true, author: "Boss Person" });
    const notes = (await call("GET", `/api/v1/companies/${co.id}/notes`)).json().items;
    expect(notes).toHaveLength(2);
    expect(notes.find((n: { kind: string }) => n.kind === "call").contact).toBe("Sue");
    const overview = (await call("GET", `/api/v1/companies/${co.id}/overview`)).json();
    expect(overview.alerts).toHaveLength(1);
    const other = await newCompany("NOTES2", "Other");
    expect(
      (
        await call("POST", `/api/v1/companies/${other.id}/notes`, {
          body: "x",
          contactId: contact.id,
        })
      ).statusCode,
    ).toBe(422);
  });

  it("needs the write permission to change records, and the audit log records it", async () => {
    const co = await newCompany("PERMS", "Perms Co");
    expect(
      (await call("POST", `/api/v1/companies/${co.id}/sites`, { name: "X" }, techMember))
        .statusCode,
    ).toBe(403);
    expect(
      (await call("PATCH", `/api/v1/companies/${co.id}`, { name: "Nope" }, techMember)).statusCode,
    ).toBe(403);
    await call("POST", `/api/v1/companies/${co.id}/sites`, { name: "Audited" });
    const audit = await pool.query(
      "SELECT member_id FROM sys.audit_log WHERE table_name = 'crm.site' ORDER BY id DESC LIMIT 1",
    );
    expect(Number(audit.rows[0]?.member_id)).toBe(adminMember);
  });
});
