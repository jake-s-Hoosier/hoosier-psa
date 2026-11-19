import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { pollOnce } from "./poller.js";
import { type Mailbox, processInboundMessage } from "./process.js";
import type { MailMessage, MailSource } from "./types.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;
const OWN = new Set(["support@hoosiersecurity.com"]);

suite("inbound email (integration)", () => {
  const dbName = `hoosier_mail_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let mailbox: Mailbox;
  const ids: Record<string, number> = {};
  let n = 0;

  const one = async (sql: string, params: unknown[] = []) =>
    Number((await pool.query<{ id: string }>(sql, params)).rows[0]?.id);

  const msg = (over: Partial<MailMessage> = {}): MailMessage => ({
    internetMessageId: `<m${++n}@test>`,
    fromAddress: "pat@acme.com",
    fromName: "Pat Lee",
    subject: "Door will not latch",
    bodyText: "The front door will not latch.",
    receivedAt: new Date(`2026-11-19T15:${String(n).padStart(2, "0")}:00Z`),
    inReplyTo: null,
    references: [],
    autoSubmitted: null,
    precedence: null,
    attachments: [],
    attachmentsUnavailable: 0,
    ...over,
  });
  const run = (m: MailMessage) => processInboundMessage(pool, mailbox, m, OWN);
  const ticket = async (id: number) =>
    (
      await pool.query(
        "SELECT t.*, s.is_closed FROM service.ticket t JOIN service.board_status s ON s.id = t.status_id WHERE t.id = $1",
        [id],
      )
    ).rows[0];
  const notes = async (id: number) =>
    (await pool.query("SELECT * FROM service.ticket_note WHERE ticket_id = $1 ORDER BY id", [id]))
      .rows;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    await migrateUp(pool);
    await ensureMarker(pool, "test");
    const active = "(SELECT id FROM crm.company_status WHERE name='Active')";
    ids.acme = await one(
      `INSERT INTO crm.company (identifier, name, status_id) VALUES ('ACME','Acme',${active}) RETURNING id`,
    );
    ids.beta = await one(
      `INSERT INTO crm.company (identifier, name, status_id) VALUES ('BETA','Beta',${active}) RETURNING id`,
    );
    ids.fallback = await one(
      `INSERT INTO crm.company (identifier, name, status_id) VALUES ('UNSORTED','Unsorted mail',${active}) RETURNING id`,
    );
    const contact = async (company: number, first: string, email: string) => {
      const c = await one(
        "INSERT INTO crm.contact (company_id, first_name) VALUES ($1,$2) RETURNING id",
        [company, first],
      );
      await pool.query(
        "INSERT INTO crm.contact_channel (contact_id, kind, value, value_normalized) VALUES ($1,'email',$2,lower($2))",
        [c, email],
      );
      return c;
    };
    ids.pat = await contact(ids.acme, "Pat", "Pat@Acme.com");
    await contact(ids.acme, "Quinn", "quinn@acme.com");
    await contact(ids.acme, "Shared", "shared@both.com");
    await contact(ids.beta, "Shared", "shared@both.com");
    await contact(ids.beta, "Bob", "bob@beta.com");
    ids.staff = await one(
      "INSERT INTO iam.member (identifier, first_name, last_name, email) VALUES ('tech','Tess','Tech','tess@hoosiersecurity.com') RETURNING id",
    );
    await pool.query(
      "INSERT INTO iam.member_role (member_id, role_id) SELECT $1, id FROM iam.role WHERE name='Administrator'",
      [ids.staff],
    );
    ids.board = await one("INSERT INTO service.board (name) VALUES ('Service') RETURNING id");
    await pool.query(
      "INSERT INTO service.board_status (board_id, name, is_default) VALUES ($1,'New',true)",
      [ids.board],
    );
    ids.closed = await one(
      "INSERT INTO service.board_status (board_id, name, is_closed) VALUES ($1,'Closed',true) RETURNING id",
      [ids.board],
    );
    ids.mailbox = await one(
      "INSERT INTO service.mailbox (address, board_id, fallback_company_id, is_active) VALUES ('support@hoosiersecurity.com',$1,$2,true) RETURNING id",
      [ids.board, ids.fallback],
    );
    mailbox = {
      id: ids.mailbox,
      address: "support@hoosiersecurity.com",
      boardId: ids.board,
      priorityId: null,
      fallbackCompanyId: ids.fallback,
      reopenOnReply: true,
    };
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

  it("opens a ticket for a known contact, matching the address case-insensitively", async () => {
    const r = await run(msg({ fromAddress: "PAT@acme.COM", subject: "RE: Door will not latch" }));
    expect(r.outcome).toBe("created");
    const t = await ticket(r.ticketId as number);
    expect(t).toMatchObject({
      company_id: String(ids.acme),
      contact_id: String(ids.pat),
      summary: "Door will not latch",
    });
    expect(t.source_id).not.toBeNull();
    expect(t.customer_updated_at).not.toBeNull();
    const [desc] = await notes(r.ticketId as number);
    expect(desc).toMatchObject({ kind: "description", author_contact_id: String(ids.pat) });
  });

  it("is safe to run twice for the same message", async () => {
    const m = msg();
    const first = await run(m);
    expect((await run(m)).outcome).toBe("duplicate");
    expect(first.outcome).toBe("created");
    const count = await pool.query(
      "SELECT count(*) AS n FROM service.ticket WHERE summary = $1 AND entered_at > now() - interval '1 minute'",
      [m.subject],
    );
    expect(Number(count.rows[0].n)).toBeGreaterThanOrEqual(1);
    const log = await pool.query(
      "SELECT count(*) AS n FROM service.inbound_email WHERE message_id = $1",
      [m.internetMessageId],
    );
    expect(Number(log.rows[0].n)).toBe(1);
  });

  it("puts mail from strangers, and from people at two companies, on the fallback company", async () => {
    const stranger = await run(
      msg({ fromAddress: "who@unknown.org", fromName: "Who", subject: "Quote please" }),
    );
    expect(stranger.outcome).toBe("created_unmatched");
    expect((await ticket(stranger.ticketId as number)).company_id).toBe(String(ids.fallback));
    expect((await notes(stranger.ticketId as number))[0].body).toContain("not a known contact");
    const both = await run(msg({ fromAddress: "shared@both.com", subject: "Which company?" }));
    expect(both.outcome).toBe("created_unmatched");
    expect(both.reason).toMatch(/several companies/);
  });

  it("adds a reply to the ticket named in the subject, trims the quote, and reopens a closed ticket", async () => {
    const created = await run(msg({ subject: "Gate stuck" }));
    const id = created.ticketId as number;
    await pool.query("UPDATE service.ticket SET status_id = $2, closed_at = now() WHERE id = $1", [
      id,
      ids.closed,
    ]);
    const r = await run(
      msg({
        subject: `Re: Gate stuck [#${id}]`,
        bodyText:
          "Still broken, please come back.\n\nOn Mon, Nov 17, 2026 at 8:00 AM Support wrote:\n> We closed it",
      }),
    );
    expect(r).toMatchObject({ outcome: "appended", ticketId: id });
    const all = await notes(id);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ kind: "discussion", body: "Still broken, please come back." });
    const t = await ticket(id);
    expect(t.is_closed).toBe(false);
    expect(t.closed_at).toBeNull();
  });

  it("threads on In-Reply-To even without a ticket number", async () => {
    const first = msg({ subject: "Camera offline" });
    const created = await run(first);
    const r = await run(msg({ subject: "Re: Camera offline", inReplyTo: first.internetMessageId }));
    expect(r).toMatchObject({ outcome: "appended", ticketId: created.ticketId });
    const viaRefs = await run(
      msg({ subject: "Camera again", references: ["<unrelated@x>", first.internetMessageId] }),
    );
    expect(viaRefs).toMatchObject({ outcome: "appended", ticketId: created.ticketId });
  });

  it("will not let a stranger write into a ticket by guessing its number", async () => {
    const created = await run(msg({ subject: "Private matter" }));
    const id = created.ticketId as number;
    const spoof = await run(
      msg({ fromAddress: "attacker@evil.com", subject: `Re: hi [#${id}]`, bodyText: "inject" }),
    );
    expect(spoof.outcome).toBe("created_unmatched");
    expect(spoof.ticketId).not.toBe(id);
    expect(await notes(id)).toHaveLength(1);
    // A contact of a different company is refused too.
    const beta = await run(msg({ fromAddress: "bob@beta.com", subject: `Re: [#${id}]` }));
    expect(beta.ticketId).not.toBe(id);
  });

  it("accepts a staff reply as a staff note and counts it as the first response", async () => {
    const created = await run(msg({ subject: "Intercom noise" }));
    const id = created.ticketId as number;
    const r = await run(
      msg({
        fromAddress: "Tess@hoosiersecurity.com",
        subject: `Re: Intercom noise [#${id}]`,
        bodyText: "On my way.",
      }),
    );
    expect(r).toMatchObject({ outcome: "appended", reason: "reply from staff" });
    const note = (await notes(id))[1];
    expect(note.author_member_id).toBe(String(ids.staff));
    expect((await ticket(id)).first_response_at).not.toBeNull();
  });

  it("ignores automatic mail and our own mailbox, without creating anything", async () => {
    const before = Number((await pool.query("SELECT count(*) AS n FROM service.ticket")).rows[0].n);
    expect(
      (await run(msg({ autoSubmitted: "auto-replied", subject: "Out of office" }))).outcome,
    ).toBe("ignored");
    expect((await run(msg({ fromAddress: "support@hoosiersecurity.com" }))).outcome).toBe(
      "ignored",
    );
    expect((await run(msg({ fromAddress: "noreply@vendor.com" }))).outcome).toBe("ignored");
    expect(Number((await pool.query("SELECT count(*) AS n FROM service.ticket")).rows[0].n)).toBe(
      before,
    );
  });

  it("stores attachments but not inline images or oversized files", async () => {
    const r = await run(
      msg({
        subject: "Photos attached",
        attachments: [
          {
            name: "photo.jpg",
            contentType: "image/jpeg",
            bytes: Buffer.from("jpegdata"),
            isInline: false,
          },
          {
            name: "logo.png",
            contentType: "image/png",
            bytes: Buffer.from("logo"),
            isInline: true,
          },
          {
            name: "../../evil.html",
            contentType: "text/html",
            bytes: Buffer.from("<script>"),
            isInline: false,
          },
          {
            name: "huge.bin",
            contentType: "application/octet-stream",
            bytes: Buffer.alloc(25 * 1024 * 1024 + 1),
            isInline: false,
          },
        ],
        attachmentsUnavailable: 1,
      }),
    );
    const files = await pool.query(
      "SELECT file_name, size_bytes FROM service.ticket_attachment WHERE ticket_id = $1 ORDER BY id",
      [r.ticketId],
    );
    expect(files.rows.map((f) => f.file_name)).toEqual(["photo.jpg", "evil.html"]);
    const log = await pool.query(
      "SELECT attachments_stored, attachments_skipped FROM service.inbound_email WHERE ticket_id = $1",
      [r.ticketId],
    );
    expect(log.rows[0]).toEqual({ attachments_stored: 2, attachments_skipped: 2 });
  });

  it("polls a source, advances the checkpoint, survives a bad message, and never repeats work", async () => {
    const good = msg({ subject: "From the poller" });
    const bad = msg({ subject: "Bad one", fromAddress: "pat@acme.com" });
    const noId = msg({ internetMessageId: "", subject: "No id" });
    let calls = 0;
    const seenSince: Date[] = [];
    const source: MailSource = {
      fetch: async (_box, since) => {
        calls++;
        seenSince.push(since);
        return [good, bad, noId];
      },
    };
    const log = { info: () => {}, error: () => {} };
    const first = await pollOnce(pool, source, log);
    expect(first[0]).toMatchObject({ fetched: 3, created: 2 });
    const second = await pollOnce(pool, source, log);
    expect(second[0]).toMatchObject({ fetched: 3, created: 0, duplicates: 2 });
    expect(calls).toBe(2);
    // The second poll starts before the newest message (overlap), not at the beginning.
    const box = (
      await pool.query(
        "SELECT last_received_at, last_error, last_polled_at FROM service.mailbox WHERE id = $1",
        [ids.mailbox],
      )
    ).rows[0];
    expect(box.last_error).toBeNull();
    expect(box.last_polled_at).not.toBeNull();
    expect((seenSince[1] as Date).getTime()).toBeLessThan(box.last_received_at.getTime());
  });

  it("records a message that fails to process as an error and carries on", async () => {
    const broken = await one(
      "INSERT INTO service.board (name) VALUES ('No statuses') RETURNING id",
    );
    const box = await one(
      "INSERT INTO service.mailbox (address, board_id, fallback_company_id, is_active) VALUES ('broken@hoosiersecurity.com',$1,$2,true) RETURNING id",
      [broken, ids.fallback],
    );
    const bad = msg({ subject: "Will fail" });
    const source: MailSource = {
      fetch: async (address) => (address.startsWith("broken") ? [bad] : []),
    };
    const r = await pollOnce(pool, source, { info: () => {}, error: () => {} });
    expect(r.find((s) => s.mailbox.startsWith("broken"))).toMatchObject({ fetched: 1, errors: 1 });
    const logged = await pool.query(
      "SELECT outcome, reason FROM service.inbound_email WHERE message_id = $1",
      [bad.internetMessageId],
    );
    expect(logged.rows[0]).toMatchObject({ outcome: "error" });
    expect(logged.rows[0].reason).toMatch(/default status/);
    const tickets = await pool.query("SELECT 1 FROM service.ticket WHERE summary = 'Will fail'");
    expect(tickets.rowCount).toBe(0);
    await pool.query("UPDATE service.mailbox SET is_active = false WHERE id = $1", [box]);
  });

  it("records a failing source on the mailbox and keeps going", async () => {
    const source: MailSource = {
      fetch: async () => {
        throw new Error("Graph 403: Access is denied");
      },
    };
    const r = await pollOnce(pool, source, { info: () => {}, error: () => {} });
    expect(r[0]?.failed).toMatch(/403/);
    const box = (
      await pool.query("SELECT last_error FROM service.mailbox WHERE id = $1", [ids.mailbox])
    ).rows[0];
    expect(box.last_error).toMatch(/Access is denied/);
  });

  it("skips mailboxes that are switched off", async () => {
    await pool.query("UPDATE service.mailbox SET is_active = false WHERE id = $1", [ids.mailbox]);
    const r = await pollOnce(
      pool,
      { fetch: async () => [msg()] },
      { info: () => {}, error: () => {} },
    );
    expect(r).toEqual([]);
    await pool.query("UPDATE service.mailbox SET is_active = true WHERE id = $1", [ids.mailbox]);
  });

  describe("mailbox API and triage", () => {
    const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
      app.inject({ method, url, payload, headers: { "x-dev-member-id": String(ids.staff) } });

    it("manages mailboxes, starting new ones switched off", async () => {
      const created = await call("POST", "/api/v1/mailboxes", {
        address: "Service@HoosierSecurity.com",
        boardId: ids.board,
        fallbackCompanyId: ids.fallback,
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        address: "service@hoosiersecurity.com",
        isActive: false,
        board: "Service",
      });
      expect(
        (
          await call("POST", "/api/v1/mailboxes", {
            address: "service@hoosiersecurity.com",
            boardId: ids.board,
            fallbackCompanyId: ids.fallback,
          })
        ).statusCode,
      ).toBe(409);
      const id = created.json().id;
      const on = await call("PATCH", `/api/v1/mailboxes/${id}`, { isActive: true });
      expect(on.json().isActive).toBe(true);
      // Switching on a never-polled mailbox starts from now: poll_from moves to the activation time.
      expect(Date.now() - new Date(on.json().pollFrom).getTime()).toBeLessThan(60_000);
      expect((await call("PATCH", `/api/v1/mailboxes/${id}`, {})).statusCode).toBe(400);
      expect((await call("GET", "/api/v1/mailboxes")).json().items.length).toBeGreaterThanOrEqual(
        2,
      );
    });

    it("lists what happened to each message", async () => {
      const all = (await call("GET", "/api/v1/mailboxes/messages")).json().items;
      expect(all.length).toBeGreaterThan(5);
      const ignored = (await call("GET", "/api/v1/mailboxes/messages?outcome=ignored")).json()
        .items;
      expect(ignored.every((m: { outcome: string }) => m.outcome === "ignored")).toBe(true);
      expect(ignored[0]).toHaveProperty("reason");
    });

    it("needs the mailbox permission", async () => {
      await pool.query(
        "INSERT INTO iam.member (identifier, first_name, last_name, email) VALUES ('plain','P','P','p@x.com')",
      );
      const plain = Number(
        (await pool.query("SELECT id FROM iam.member WHERE identifier='plain'")).rows[0].id,
      );
      await pool.query(
        "INSERT INTO iam.member_role (member_id, role_id) SELECT $1, id FROM iam.role WHERE name='Technician'",
        [plain],
      );
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/mailboxes",
        headers: { "x-dev-member-id": String(plain) },
      });
      expect(res.statusCode).toBe(403);
    });

    it("moves a triaged ticket to the right company and clears its contact", async () => {
      const t = await run(msg({ fromAddress: "newperson@acme.com", subject: "Needs sorting" }));
      const id = t.ticketId as number;
      expect((await ticket(id)).company_id).toBe(String(ids.fallback));
      const moved = await call("PATCH", `/api/v1/tickets/${id}`, {
        companyId: ids.acme,
        contactId: ids.pat,
      });
      expect(moved.statusCode).toBe(200);
      expect(moved.json()).toMatchObject({ companyId: ids.acme, contactId: ids.pat });
      const other = await call("PATCH", `/api/v1/tickets/${id}`, { companyId: ids.beta });
      expect(other.json()).toMatchObject({ companyId: ids.beta, contactId: null });
      expect(
        (await call("PATCH", `/api/v1/tickets/${id}`, { contactId: ids.pat })).statusCode,
      ).toBe(422);
      expect((await call("PATCH", `/api/v1/tickets/${id}`, { companyId: 999999 })).statusCode).toBe(
        422,
      );
    });
  });
});
