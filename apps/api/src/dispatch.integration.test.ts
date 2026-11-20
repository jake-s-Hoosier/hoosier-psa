import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("dispatch (integration)", () => {
  const dbName = `hoosier_dispatch_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let boss: number;
  let manager: number;
  let tech: number;
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
    sales = await member("sales", "Sales");
    await pool.query("UPDATE iam.member SET is_field_tech = true WHERE id = ANY($1)", [[tech]]);
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
       VALUES ('D${seq}-${process.pid}','Dispatch Co ${seq}',(SELECT id FROM crm.company_status WHERE name='Active')) RETURNING id`,
    );
  };
  const ticket = async (summary = "Door will not latch") =>
    (
      await call("POST", "/api/v1/tickets", { summary, companyId: await company(), boardId })
    ).json() as { id: number };
  const T = (h: number, day = 2) => `2030-01-0${day}T${String(h).padStart(2, "0")}:00:00.000Z`;
  const board = async (who = boss) =>
    (
      await call("GET", `/api/v1/dispatch/board?from=${T(0, 1)}&to=${T(0, 9)}`, undefined, who)
    ).json();

  it("schedules a visit, makes the person a ticket resource, and takes the ticket off the queue", async () => {
    const t = await ticket();
    expect((await board()).unassigned.map((u: { id: number }) => u.id)).toContain(t.id);
    const r = await call("POST", "/api/v1/dispatch/entries", {
      ticketId: t.id,
      memberId: tech,
      startsAt: T(13),
      endsAt: T(15),
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().entry).toMatchObject({
      ticketId: t.id,
      memberId: tech,
      kind: "ticket",
      status: "scheduled",
    });
    expect(r.json().conflicts).toEqual([]);
    const res = await pool.query(
      "SELECT 1 FROM service.ticket_resource WHERE ticket_id = $1 AND member_id = $2",
      [t.id, tech],
    );
    expect(res.rowCount).toBe(1);
    const b = await board();
    expect(b.unassigned.map((u: { id: number }) => u.id)).not.toContain(t.id);
    expect(b.entries.map((e: { id: number }) => e.id)).toContain(r.json().entry.id);
    expect(b.members.map((m: { id: number }) => m.id)).toContain(tech);
  });

  it("reports overlaps for the same person but still saves; canceled visits never clash", async () => {
    const a = await ticket("A");
    const b = await ticket("B");
    const first = await call("POST", "/api/v1/dispatch/entries", {
      ticketId: a.id,
      memberId: tech,
      startsAt: T(9, 3),
      endsAt: T(11, 3),
    });
    const second = await call("POST", "/api/v1/dispatch/entries", {
      ticketId: b.id,
      memberId: tech,
      startsAt: T(10, 3),
      endsAt: T(12, 3),
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().conflicts.map((c: { id: number }) => c.id)).toEqual([
      first.json().entry.id,
    ]);
    const adjacent = await call("POST", "/api/v1/dispatch/entries", {
      ticketId: b.id,
      memberId: tech,
      startsAt: T(12, 3),
      endsAt: T(13, 3),
    });
    expect(adjacent.json().conflicts).toEqual([]);
    const canceled = await call("PATCH", `/api/v1/dispatch/entries/${first.json().entry.id}`, {
      status: "canceled",
    });
    expect(canceled.json().conflicts).toEqual([]);
    const again = await call("POST", "/api/v1/dispatch/entries", {
      ticketId: a.id,
      memberId: tech,
      startsAt: T(9, 3),
      endsAt: T(10, 3),
    });
    expect(again.json().conflicts).toEqual([]);
  });

  it("moves and reassigns a visit, and checks the times", async () => {
    const t = await ticket();
    const e = (
      await call("POST", "/api/v1/dispatch/entries", {
        ticketId: t.id,
        memberId: tech,
        startsAt: T(8, 4),
        endsAt: T(9, 4),
      })
    ).json().entry;
    const moved = await call("PATCH", `/api/v1/dispatch/entries/${e.id}`, {
      startsAt: T(14, 4),
      endsAt: T(16, 4),
      memberId: manager,
    });
    expect(moved.json().entry).toMatchObject({ memberId: manager, startsAt: T(14, 4) });
    const res = await pool.query(
      "SELECT member_id FROM service.ticket_resource WHERE ticket_id = $1",
      [t.id],
    );
    expect(res.rows.map((r) => Number(r.member_id)).sort()).toEqual([tech, manager].sort());
    const bad = await call("PATCH", `/api/v1/dispatch/entries/${e.id}`, { endsAt: T(7, 4) });
    expect(bad.statusCode).toBe(422);
    const title = await call("PATCH", `/api/v1/dispatch/entries/${e.id}`, { title: "x" });
    expect(title.statusCode).toBe(422);
  });

  it("time off and meetings need a title and no ticket", async () => {
    const off = await call("POST", "/api/v1/dispatch/entries", {
      kind: "time_off",
      memberId: tech,
      title: "Vacation",
      startsAt: T(0, 5),
      endsAt: T(0, 7),
    });
    expect(off.statusCode).toBe(201);
    expect(off.json().entry).toMatchObject({ kind: "time_off", ticketId: null, title: "Vacation" });
    const noTitle = await call("POST", "/api/v1/dispatch/entries", {
      kind: "meeting",
      memberId: tech,
      startsAt: T(8, 5),
      endsAt: T(9, 5),
    });
    expect(noTitle.statusCode).toBe(400);
    const t = await ticket();
    const withTicket = await call("POST", "/api/v1/dispatch/entries", {
      kind: "meeting",
      title: "x",
      ticketId: t.id,
      memberId: tech,
      startsAt: T(8, 5),
      endsAt: T(9, 5),
    });
    expect(withTicket.statusCode).toBe(400);
    const clash = await call("POST", "/api/v1/dispatch/entries", {
      ticketId: t.id,
      memberId: tech,
      startsAt: T(8, 6),
      endsAt: T(9, 6),
    });
    expect(clash.json().conflicts).toHaveLength(1);
  });

  it("will not schedule closed tickets or inactive people, and limits the board range", async () => {
    const t = await ticket();
    await pool.query(
      `UPDATE service.ticket SET closed_at = now(),
         status_id = (SELECT id FROM service.board_status WHERE board_id = $2 LIMIT 1) WHERE id = $1`,
      [t.id, boardId],
    );
    const closed = await call("POST", "/api/v1/dispatch/entries", {
      ticketId: t.id,
      memberId: tech,
      startsAt: T(8, 6),
      endsAt: T(9, 6),
    });
    expect(closed.statusCode).toBe(422);
    const open = await ticket();
    const nobody = await call("POST", "/api/v1/dispatch/entries", {
      ticketId: open.id,
      memberId: 999999,
      startsAt: T(8, 6),
      endsAt: T(9, 6),
    });
    expect(nobody.statusCode).toBe(422);
    const wide = await call(
      "GET",
      "/api/v1/dispatch/board?from=2030-01-01T00:00:00Z&to=2030-06-01T00:00:00Z",
    );
    expect(wide.statusCode).toBe(422);
  });

  it("deletes a visit; lists a ticket's visits", async () => {
    const t = await ticket();
    const e = (
      await call("POST", "/api/v1/dispatch/entries", {
        ticketId: t.id,
        memberId: tech,
        startsAt: T(8, 7),
        endsAt: T(9, 7),
      })
    ).json().entry;
    expect(
      (await call("GET", `/api/v1/dispatch/entries?ticketId=${t.id}`)).json().items,
    ).toHaveLength(1);
    expect((await call("DELETE", `/api/v1/dispatch/entries/${e.id}`)).statusCode).toBe(204);
    expect((await call("DELETE", `/api/v1/dispatch/entries/${e.id}`)).statusCode).toBe(404);
  });

  it("permissions: technicians can look but not schedule; sales cannot see the board", async () => {
    const t = await ticket();
    expect(
      (await call("GET", `/api/v1/dispatch/board?from=${T(0, 1)}&to=${T(0, 2)}`, undefined, tech))
        .statusCode,
    ).toBe(200);
    const w = await call(
      "POST",
      "/api/v1/dispatch/entries",
      { ticketId: t.id, memberId: tech, startsAt: T(8, 7), endsAt: T(9, 7) },
      tech,
    );
    expect(w.statusCode).toBe(403);
    expect(
      (await call("GET", `/api/v1/dispatch/board?from=${T(0, 1)}&to=${T(0, 2)}`, undefined, sales))
        .statusCode,
    ).toBe(403);
  });
});
