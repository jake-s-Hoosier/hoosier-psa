import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { cleanContentType, cleanFileName } from "./routes/ticket-files.js";

describe("attachment name and type cleaning", () => {
  it("keeps only the last path segment and drops control characters and quotes", () => {
    expect(cleanFileName("C:\\Users\\jo\\report.pdf")).toBe("report.pdf");
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName('a"b\u0000c.txt')).toBe("abc.txt");
    expect(cleanFileName("   ")).toBe("");
    expect(cleanFileName("é".repeat(300))).toHaveLength(255);
  });
  it("accepts plain media types and falls back for anything odd", () => {
    expect(cleanContentType("Application/PDF; charset=x")).toBe("application/pdf");
    expect(cleanContentType("text/html")).toBe("text/html");
    expect(cleanContentType("not a type")).toBe("application/octet-stream");
    expect(cleanContentType(undefined)).toBe("application/octet-stream");
  });
});

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("ticket resources and attachments (integration)", () => {
  const dbName = `hoosier_files_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  const ids: Record<string, number> = {};
  let ticketId: number;

  const one = async (sql: string, params: unknown[] = []) =>
    Number((await pool.query<{ id: string }>(sql, params)).rows[0]?.id);
  const hdr = (who: string, extra: Record<string, string> = {}) => ({
    "x-dev-member-id": String(ids[who]),
    ...extra,
  });
  const upload = (who: string, name: string, body: Buffer | string, type = "application/pdf") =>
    app.inject({
      method: "POST",
      url: `/api/v1/tickets/${ticketId}/attachments?filename=${encodeURIComponent(name)}`,
      headers: hdr(who, { "content-type": type }),
      payload: body,
    });

  async function member(identifier: string, role: string | null, active = true) {
    ids[identifier] = await one(
      `INSERT INTO iam.member (identifier, first_name, last_name, email, is_active)
       VALUES ($1::text, $1::text, 'Test', $1::text || '@example.com', $2) RETURNING id`,
      [identifier, active],
    );
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
    await member("tech2", "Technician");
    await member("sales", "Sales");
    await member("gone", null, false);
    const company = await one(
      "INSERT INTO crm.company (identifier, name, status_id) VALUES ('ACME','Acme',(SELECT id FROM crm.company_status WHERE name='Active')) RETURNING id",
    );
    const board = await one("INSERT INTO service.board (name) VALUES ('Service') RETURNING id");
    const status = await one(
      "INSERT INTO service.board_status (board_id, name, is_default) VALUES ($1,'New',true) RETURNING id",
      [board],
    );
    const prio = await one("SELECT id FROM service.priority WHERE name='Normal'");
    ticketId = await one(
      "INSERT INTO service.ticket (summary, company_id, board_id, status_id, priority_id) VALUES ('t',$1,$2,$3,$4) RETURNING id",
      [company, board, status, prio],
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
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("adds, lists and removes resources, idempotently and audited", async () => {
    const url = `/api/v1/tickets/${ticketId}/resources`;
    const add = await app.inject({
      method: "POST",
      url,
      headers: hdr("tech"),
      payload: { memberId: ids.tech2 },
    });
    expect(add.statusCode).toBe(200);
    expect(add.json().items.map((r: { identifier: string }) => r.identifier)).toEqual(["tech2"]);
    const again = await app.inject({
      method: "POST",
      url,
      headers: hdr("tech"),
      payload: { memberId: ids.tech2 },
    });
    expect(again.json().items).toHaveLength(1);
    const inactive = await app.inject({
      method: "POST",
      url,
      headers: hdr("tech"),
      payload: { memberId: ids.gone },
    });
    expect(inactive.statusCode).toBe(422);
    const unknown = await app.inject({
      method: "POST",
      url,
      headers: hdr("tech"),
      payload: { memberId: 999999 },
    });
    expect(unknown.statusCode).toBe(422);
    // Sales can look but not change.
    expect((await app.inject({ method: "GET", url, headers: hdr("sales") })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: hdr("sales"),
          payload: { memberId: ids.tech },
        })
      ).statusCode,
    ).toBe(403);
    const audit = await pool.query(
      "SELECT member_id FROM sys.audit_log WHERE table_name = 'service.ticket_resource' AND row_pk = $1",
      [`${ticketId}/${ids.tech2}`],
    );
    expect(audit.rowCount).toBe(1);
    const del = await app.inject({
      method: "DELETE",
      url: `${url}/${ids.tech2}`,
      headers: hdr("tech"),
    });
    expect(del.json().items).toEqual([]);
  });

  it("stores a file, lists it, and downloads identical bytes as an attachment", async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 37, 80, 68, 70]);
    const up = await upload("tech", "C:\\fakepath\\Site survey é.pdf", bytes);
    expect(up.statusCode).toBe(201);
    const meta = up.json();
    expect(meta).toMatchObject({
      fileName: "Site survey é.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/tickets/${ticketId}/attachments`,
      headers: hdr("sales"),
    });
    expect(list.json().items).toHaveLength(1);

    const dl = await app.inject({
      method: "GET",
      url: `/api/v1/tickets/${ticketId}/attachments/${meta.id}/download`,
      headers: hdr("sales"),
    });
    expect(dl.statusCode).toBe(200);
    expect(Buffer.compare(dl.rawPayload, bytes)).toBe(0);
    expect(dl.headers["content-disposition"]).toContain("attachment;");
    expect(dl.headers["content-disposition"]).toContain(
      "filename*=UTF-8''Site%20survey%20%C3%A9.pdf",
    );
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(dl.headers["content-security-policy"])).toContain("sandbox");
  });

  it("keeps file contents out of the audit log", async () => {
    const marker = "UNIQUE-AUDIT-LEAK-CHECK";
    const up = await upload("tech", "leak.txt", marker, "text/plain");
    expect(up.statusCode).toBe(201);
    const hit = await pool.query("SELECT 1 FROM sys.audit_log WHERE new_row::text LIKE $1", [
      `%${marker}%`,
    ]);
    expect(hit.rowCount).toBe(0);
    const meta = await pool.query(
      "SELECT 1 FROM sys.audit_log WHERE table_name = 'service.ticket_attachment' AND action = 'INSERT'",
    );
    expect(meta.rowCount).toBeGreaterThan(0);
  });

  it("accepts a JSON file as plain bytes, and refuses empty, oversized or unnamed uploads", async () => {
    const json = await upload("tech", "data.json", '{"a":1}', "application/json");
    expect(json.statusCode).toBe(201);
    expect(json.json().sizeBytes).toBe(7);
    expect(
      (await upload("tech", "empty.bin", Buffer.alloc(0), "application/octet-stream")).statusCode,
    ).toBe(422);
    const big = await upload(
      "tech",
      "big.bin",
      Buffer.alloc(25 * 1024 * 1024 + 1),
      "application/octet-stream",
    );
    expect(big.statusCode).toBe(413);
    const noName = await app.inject({
      method: "POST",
      url: `/api/v1/tickets/${ticketId}/attachments`,
      headers: hdr("tech", { "content-type": "text/plain" }),
      payload: "x",
    });
    expect(noName.statusCode).toBe(400);
  });

  it("needs the right permission, and 404s for a missing ticket or file", async () => {
    expect((await upload("sales", "nope.txt", "x", "text/plain")).statusCode).toBe(403);
    const missingTicket = await app.inject({
      method: "POST",
      url: "/api/v1/tickets/999999/attachments?filename=a.txt",
      headers: hdr("tech", { "content-type": "text/plain" }),
      payload: "x",
    });
    expect(missingTicket.statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/tickets/${ticketId}/attachments/999999/download`,
          headers: hdr("tech"),
        })
      ).statusCode,
    ).toBe(404);
  });

  it("lets you remove your own uploads; others need service.ticket.delete; bytes are kept", async () => {
    const up = (await upload("tech", "mine.txt", "mine", "text/plain")).json();
    const url = `/api/v1/tickets/${ticketId}/attachments/${up.id}`;
    expect((await app.inject({ method: "DELETE", url, headers: hdr("tech2") })).statusCode).toBe(
      403,
    );
    expect((await app.inject({ method: "DELETE", url, headers: hdr("tech") })).statusCode).toBe(
      204,
    );
    expect(
      (await app.inject({ method: "GET", url: `${url}/download`, headers: hdr("tech") }))
        .statusCode,
    ).toBe(404);
    const kept = await pool.query(
      "SELECT 1 FROM service.ticket_attachment_blob WHERE attachment_id = $1",
      [up.id],
    );
    expect(kept.rowCount).toBe(1);
    // An administrator holds service.ticket.delete and may remove anyone's.
    const other = (await upload("tech", "other.txt", "other", "text/plain")).json();
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v1/tickets/${ticketId}/attachments/${other.id}`,
          headers: hdr("boss"),
        })
      ).statusCode,
    ).toBe(204);
  });
});
