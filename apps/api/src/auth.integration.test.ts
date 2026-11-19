import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { base32Decode, hashPassword, totpAt } from "./auth/crypto.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;
const SECRET = "test-secret-".padEnd(48, "x");
const CSRF = { "x-requested-with": "hoosier-psa" };

suite("local authentication (integration)", () => {
  const dbName = `hoosier_auth_test_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let memberId: number;

  const config = (over: Record<string, string> = {}) =>
    ({
      AUTH_MODE: "session",
      AUTH_SECRET: SECRET,
      LOG_LEVEL: "silent",
      APP_ENV: "test",
      DB_WRITE_MODE: "read_write",
      ...over,
    }) as const;

  /** Minimal cookie jar: remembers the latest session cookie a response set. */
  class Client {
    cookie = "";
    async call(method: "GET" | "POST", url: string, payload?: unknown, application = app) {
      const res = await application.inject({
        method,
        url,
        payload: payload as object | undefined,
        headers: { ...CSRF, ...(this.cookie ? { cookie: this.cookie } : {}) },
      });
      const set = res.headers["set-cookie"];
      const raw = Array.isArray(set) ? set[0] : set;
      if (raw) {
        const pair = raw.split(";")[0] as string;
        this.cookie = pair.endsWith("=") ? "" : pair;
      }
      return res;
    }
  }

  const currentCode = () => totpAt(totpSecret, Math.floor(Date.now() / 1000 / 30));
  /** A real authenticator offers one new code per 30 seconds; tests reset the replay guard instead of waiting. */
  const resetCounter = () => pool.query("UPDATE iam.member_credential SET mfa_last_counter = 0");

  const login = (c: Client, password = "Temp-Password-123") =>
    c.call("POST", "/api/v1/auth/login", { identifier: "tech1", password });

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    await migrateUp(pool);
    await ensureMarker(pool, "test");
    memberId = Number(
      (
        await pool.query<{ id: string }>(
          `INSERT INTO iam.member (identifier, first_name, last_name, email)
           VALUES ('tech1', 'Tech', 'One', 'tech.one@example.com') RETURNING id`,
        )
      ).rows[0]?.id,
    );
    await pool.query(
      "INSERT INTO iam.member_credential (member_id, password_hash) VALUES ($1,$2)",
      [memberId, await hashPassword("Temp-Password-123")],
    );
    await pool.query(
      `INSERT INTO iam.member_role (member_id, role_id)
       SELECT $1, id FROM iam.role WHERE name = 'Technician'`,
      [memberId],
    );
    app = buildApp({ pool, config: config() });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("requires sign-in, a CSRF header on writes, and valid credentials", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/v1/companies" });
    expect(anon.statusCode).toBe(401);
    const noHeader = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { identifier: "tech1", password: "x" },
    });
    expect(noHeader.statusCode).toBe(403);
    const wrong = await login(new Client(), "not the password");
    expect(wrong.statusCode).toBe(401);
    const unknown = await new Client().call("POST", "/api/v1/auth/login", {
      identifier: "nobody",
      password: "Temp-Password-123",
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().detail).toBe(wrong.json().detail); // no account enumeration
    // The public status endpoint stays open so the login page can show the environment.
    expect((await app.inject({ method: "GET", url: "/api/v1/system/status" })).statusCode).toBe(
      200,
    );
  });

  const c = new Client();
  let totpSecret: Buffer;
  let recoveryCodes: string[];
  let enrolStep: number;

  it("walks a new account through password change and MFA enrolment", async () => {
    const res = await login(c);
    expect(res.json().stage).toBe("password_change");
    // Half-signed-in sessions cannot reach business routes.
    expect((await c.call("GET", "/api/v1/companies")).statusCode).toBe(403);
    const partial = (await c.call("GET", "/api/v1/auth/me")).json();
    expect(partial.member.identifier).toBe("tech1");
    expect(partial.permissions).toEqual([]); // nothing is revealed before sign-in completes

    const weak = await c.call("POST", "/api/v1/auth/password", {
      currentPassword: "Temp-Password-123",
      newPassword: "short",
    });
    expect(weak.statusCode).toBe(422);
    const wrongCurrent = await c.call("POST", "/api/v1/auth/password", {
      currentPassword: "nope nope nope",
      newPassword: "A brand new passphrase!",
    });
    expect(wrongCurrent.statusCode).toBe(401);
    const changed = await c.call("POST", "/api/v1/auth/password", {
      currentPassword: "Temp-Password-123",
      newPassword: "A brand new passphrase!",
    });
    expect(changed.json().stage).toBe("mfa_enroll");

    const setup = await c.call("POST", "/api/v1/auth/mfa/setup");
    expect(setup.statusCode).toBe(200);
    expect(setup.json().otpauthUri).toContain("otpauth://totp/");
    totpSecret = base32Decode(setup.json().secret);
    // Asking again while enrolment is pending shows the same key.
    expect((await c.call("POST", "/api/v1/auth/mfa/setup")).json().secret).toBe(
      setup.json().secret,
    );

    const bad = await c.call("POST", "/api/v1/auth/mfa/enable", { code: "000000" });
    expect(bad.statusCode).toBe(401);
    enrolStep = Math.floor(Date.now() / 1000 / 30);
    const enabled = await c.call("POST", "/api/v1/auth/mfa/enable", {
      code: totpAt(totpSecret, enrolStep),
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().stage).toBe("ok");
    recoveryCodes = enabled.json().recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);

    expect((await c.call("GET", "/api/v1/companies")).statusCode).toBe(200);
  });

  it("stores no secrets in the audit log or in plain text", async () => {
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM sys.audit_log WHERE table_name LIKE 'iam.member_credential%' OR new_row::text LIKE '%scrypt%'",
    );
    expect(audit.rows[0].n).toBe(0);
    const row = (
      await pool.query("SELECT mfa_secret_enc, password_hash FROM iam.member_credential")
    ).rows[0];
    expect(row.mfa_secret_enc).not.toContain(totpSecret.toString("base64"));
    expect(row.password_hash.startsWith("scrypt$")).toBe(true);
    const codes = await pool.query("SELECT code_hash FROM iam.recovery_code");
    expect(codes.rows.map((r) => r.code_hash)).not.toContain(recoveryCodes[0]);
  });

  it("requires the second factor on later sign-ins, refusing replayed codes", async () => {
    await c.call("POST", "/api/v1/auth/logout");
    expect((await c.call("GET", "/api/v1/companies")).statusCode).toBe(401);

    const again = new Client();
    const res = await login(again, "A brand new passphrase!");
    expect(res.json().stage).toBe("mfa_required");
    expect((await again.call("GET", "/api/v1/companies")).statusCode).toBe(403);
    expect(
      (await again.call("POST", "/api/v1/auth/mfa/verify", { code: "123456" })).statusCode,
    ).toBe(401);
    // The code used to enrol is spent.
    const replay = await again.call("POST", "/api/v1/auth/mfa/verify", {
      code: totpAt(totpSecret, enrolStep),
    });
    expect(replay.statusCode).toBe(401);
    const good = await again.call("POST", "/api/v1/auth/mfa/verify", {
      code: totpAt(totpSecret, enrolStep + 1),
    });
    expect(good.json().stage).toBe("ok");
    expect((await again.call("GET", "/api/v1/companies")).statusCode).toBe(200);
    // The Technician role's grants come back with the session so the UI can hide what is not allowed.
    const me = (await again.call("GET", "/api/v1/auth/me")).json();
    expect(me.permissions).toContain("service.ticket.write");
    expect(me.permissions).not.toContain("timekeeping.period.lock");
  });

  it("accepts each recovery code once", async () => {
    const code = recoveryCodes[0] as string;
    const first = new Client();
    await login(first, "A brand new passphrase!");
    expect((await first.call("POST", "/api/v1/auth/mfa/verify", { code })).json().stage).toBe("ok");
    const second = new Client();
    await login(second, "A brand new passphrase!");
    expect((await second.call("POST", "/api/v1/auth/mfa/verify", { code })).statusCode).toBe(401);
  });

  it("signs other sessions out when the password changes, and when the member is deactivated", async () => {
    const a = new Client();
    const b = new Client();
    for (const client of [a, b]) {
      await resetCounter();
      await login(client, "A brand new passphrase!");
      await client.call("POST", "/api/v1/auth/mfa/verify", { code: currentCode() });
    }
    expect((await a.call("GET", "/api/v1/companies")).statusCode).toBe(200);
    const changed = await b.call("POST", "/api/v1/auth/password", {
      currentPassword: "A brand new passphrase!",
      newPassword: "Another long passphrase 42",
    });
    expect(changed.statusCode).toBe(200);
    expect((await a.call("GET", "/api/v1/companies")).statusCode).toBe(401);
    expect((await b.call("GET", "/api/v1/companies")).statusCode).toBe(200); // the changing session stays in

    await pool.query("UPDATE iam.member SET is_active = false WHERE id = $1", [memberId]);
    expect((await b.call("GET", "/api/v1/companies")).statusCode).toBe(401);
    expect((await login(new Client(), "Another long passphrase 42")).statusCode).toBe(401);
    await pool.query("UPDATE iam.member SET is_active = true WHERE id = $1", [memberId]);
  });

  it("locks an account after repeated failures", async () => {
    const fresh = buildApp({ pool, config: config() });
    const client = new Client();
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await client.call(
            "POST",
            "/api/v1/auth/login",
            { identifier: "tech1", password: "bad" },
            fresh,
          )
        ).statusCode,
      ).toBe(401);
    }
    const locked = await client.call(
      "POST",
      "/api/v1/auth/login",
      { identifier: "tech1", password: "Another long passphrase 42" },
      fresh,
    );
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["retry-after"]).toBeDefined();
  });

  it("works read-only for signing in but refuses credential changes", async () => {
    const ro = buildApp({ pool, config: config({ DB_WRITE_MODE: "read_only" }) });
    const client = new Client();
    expect(
      (
        await client.call(
          "POST",
          "/api/v1/auth/login",
          { identifier: "tech1", password: "Another long passphrase 42" },
          ro,
        )
      ).json().stage,
    ).toBe("mfa_required");
    await resetCounter();
    const verified = await client.call(
      "POST",
      "/api/v1/auth/mfa/verify",
      { code: currentCode() },
      ro,
    );
    expect(verified.json().stage).toBe("ok");
    expect((await client.call("GET", "/api/v1/companies", undefined, ro)).statusCode).toBe(200);
    const pw = await client.call(
      "POST",
      "/api/v1/auth/password",
      { currentPassword: "x", newPassword: "y" },
      ro,
    );
    expect(pw.statusCode).toBe(403);
    expect(
      (
        await client.call(
          "POST",
          "/api/v1/companies",
          { identifier: "A", name: "A", statusId: 1 },
          ro,
        )
      ).statusCode,
    ).toBe(403);
  });
});
