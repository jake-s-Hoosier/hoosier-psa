import { withActor } from "@hoosier/db";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DUMMY_HASH,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCode,
  otpauthUri,
  passwordProblem,
  verifyPassword,
  verifyTotp,
} from "../auth/crypto.js";
import { loadPermissions } from "../auth/permissions.js";
import {
  type AuthMember,
  type AuthStage,
  clearSessionCookie,
  loadAuthMember,
  newClaims,
  setSessionCookie,
  stageOf,
} from "../auth/session.js";
import { LoginThrottle } from "../auth/throttle.js";
import { HttpError } from "../errors.js";

const ISSUER = "Hoosier PSA";

declare module "fastify" {
  interface FastifyRequest {
    /** Set in session mode: how far through sign-in the caller is. */
    authStage: AuthStage | null;
    /** Whether the caller's session has passed the second factor. */
    authMfa: boolean;
    /** Permissions held through the member's roles; set for /api/v1 routes after authentication. */
    permissions: ReadonlySet<string>;
  }
}

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(500),
});
const codeSchema = z.object({ code: z.string().trim().min(1).max(32) });
const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(500),
  newPassword: z.string().min(1).max(500),
});

interface Opts {
  authSecret: string;
  writable: boolean;
}

export const authRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { authSecret, writable } = opts;
  const byAccount = new LoginThrottle(5);
  const byIp = new LoginThrottle(30);

  const view = async (m: AuthMember, stage: AuthStage) => ({
    stage,
    member: {
      id: m.id,
      identifier: m.identifier,
      email: m.email,
      firstName: m.firstName,
      lastName: m.lastName,
    },
    // Only a fully signed-in member is told what they may do; the UI uses this to hide controls.
    permissions: stage === "ok" ? [...(await loadPermissions(app.pool, m.id))].sort() : [],
  });

  /** Best-effort security log. Skipped where the database is read-only. */
  async function logEvent(req: FastifyRequest, memberId: number | null, kind: string) {
    if (!writable) return;
    try {
      await app.pool.query(
        "INSERT INTO iam.auth_event (member_id, kind, ip, user_agent) VALUES ($1,$2,$3,$4)",
        [memberId, kind, req.ip, String(req.headers["user-agent"] ?? "").slice(0, 300)],
      );
    } catch (err) {
      req.log.warn({ err }, "could not record auth event");
    }
  }

  function requireWritable(): void {
    if (!writable) {
      throw new HttpError(
        403,
        "Read-only mode",
        "This environment is read-only; this change is not accepted",
      );
    }
  }

  function requireStage(req: FastifyRequest, ...allowed: AuthStage[]): number {
    if (!req.memberId || !req.authStage || !allowed.includes(req.authStage)) {
      throw new HttpError(403, "Not allowed at this step", "Finish sign-in first");
    }
    return req.memberId;
  }

  app.post("/login", { config: { perm: "signin" } }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const key = body.identifier.toLowerCase();
    const wait = Math.max(byAccount.lockedFor(key), byIp.lockedFor(req.ip));
    if (wait > 0) {
      void reply.header("retry-after", String(wait));
      throw new HttpError(429, "Too many attempts", "Too many failed sign-ins. Try again later.");
    }

    const { rows } = await app.pool.query<{ id: string; password_hash: string }>(
      `SELECT m.id, c.password_hash FROM iam.member m
         JOIN iam.member_credential c ON c.member_id = m.id
        WHERE (m.identifier = $1 OR m.email = $1) AND m.is_active`,
      [body.identifier],
    );
    const row = rows[0];
    // Always run a hash comparison so response time does not reveal whether the account exists.
    const ok = await verifyPassword(body.password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) {
      byAccount.fail(key);
      byIp.fail(req.ip);
      await logEvent(req, row ? Number(row.id) : null, "login_failed");
      throw new HttpError(401, "Invalid credentials", "Wrong identifier or password");
    }
    const member = await loadAuthMember(app.pool, Number(row.id));
    if (!member) throw new HttpError(401, "Invalid credentials", "Wrong identifier or password");
    byAccount.succeed(key);
    setSessionCookie(req, reply, newClaims(member, false), authSecret);
    await logEvent(req, member.id, "login_ok");
    return view(member, stageOf(member, false));
  });

  app.post("/logout", { config: { perm: "signin" } }, async (req, reply) => {
    clearSessionCookie(req, reply);
    return reply.status(204).send();
  });

  app.get("/me", { config: { perm: "signin" } }, async (req) => {
    const member = await loadAuthMember(
      app.pool,
      requireStage(req, "password_change", "mfa_enroll", "mfa_required", "ok"),
    );
    if (!member) throw new HttpError(401, "Unauthorized", "Sign in again");
    return view(member, req.authStage as AuthStage);
  });

  app.post("/mfa/verify", { config: { perm: "signin" } }, async (req, reply) => {
    const memberId = requireStage(req, "mfa_required");
    const { code } = codeSchema.parse(req.body);
    const throttleKey = `mfa:${memberId}`;
    if (byAccount.lockedFor(throttleKey) > 0) {
      throw new HttpError(429, "Too many attempts", "Too many wrong codes. Try again later.");
    }
    const member = await loadAuthMember(app.pool, memberId);
    const { rows } = await app.pool.query<{ mfa_secret_enc: string; mfa_last_counter: string }>(
      "SELECT mfa_secret_enc, mfa_last_counter FROM iam.member_credential WHERE member_id = $1",
      [memberId],
    );
    if (!member || !rows[0]) throw new HttpError(401, "Unauthorized", "Sign in again");

    const secret = decryptSecret(rows[0].mfa_secret_enc, authSecret);
    const counter = verifyTotp(secret, code, Number(rows[0].mfa_last_counter));
    let kind: "mfa_ok" | "recovery_code_used" | null = null;
    if (counter !== null) {
      kind = "mfa_ok";
      if (writable) {
        await app.pool.query(
          "UPDATE iam.member_credential SET mfa_last_counter = $2 WHERE member_id = $1 AND mfa_last_counter < $2",
          [memberId, counter],
        );
      }
    } else if (/^[a-z2-7]{5}-?[a-z2-7]{5}$/i.test(code)) {
      requireWritable(); // consuming a recovery code is a write
      const used = await app.pool.query(
        "UPDATE iam.recovery_code SET used_at = now() WHERE member_id = $1 AND code_hash = $2 AND used_at IS NULL",
        [memberId, hashRecoveryCode(code)],
      );
      if (used.rowCount === 1) kind = "recovery_code_used";
    }
    if (!kind) {
      byAccount.fail(throttleKey);
      await logEvent(req, memberId, "mfa_failed");
      throw new HttpError(401, "Invalid code", "That code is not valid");
    }
    byAccount.succeed(throttleKey);
    setSessionCookie(req, reply, newClaims(member, true), authSecret);
    await logEvent(req, memberId, kind);
    return view(member, stageOf(member, true));
  });

  // First-time MFA setup: generate a secret, show it once, confirm with a code.
  app.post("/mfa/setup", { config: { perm: "signin" } }, async (req) => {
    requireWritable();
    const memberId = requireStage(req, "mfa_enroll");
    const member = await loadAuthMember(app.pool, memberId);
    if (!member) throw new HttpError(401, "Unauthorized", "Sign in again");
    // Idempotent while enrolment is pending, so a page reload or a double request shows the same key.
    const existing = await app.pool.query<{ mfa_secret_enc: string | null }>(
      "SELECT mfa_secret_enc FROM iam.member_credential WHERE member_id = $1 AND mfa_enabled_at IS NULL",
      [memberId],
    );
    const pending = existing.rows[0]?.mfa_secret_enc;
    const secret = pending ? decryptSecret(pending, authSecret) : generateTotpSecret();
    if (!pending) {
      await app.pool.query(
        "UPDATE iam.member_credential SET mfa_secret_enc = $2 WHERE member_id = $1 AND mfa_enabled_at IS NULL",
        [memberId, encryptSecret(secret, authSecret)],
      );
    }
    const b32 = base32Encode(secret);
    return { secret: b32, otpauthUri: otpauthUri(b32, member.email, ISSUER) };
  });

  app.post("/mfa/enable", { config: { perm: "signin" } }, async (req, reply) => {
    requireWritable();
    const memberId = requireStage(req, "mfa_enroll");
    const { code } = codeSchema.parse(req.body);
    const member = await loadAuthMember(app.pool, memberId);
    const { rows } = await app.pool.query<{ mfa_secret_enc: string | null }>(
      "SELECT mfa_secret_enc FROM iam.member_credential WHERE member_id = $1",
      [memberId],
    );
    if (!member || !rows[0]?.mfa_secret_enc) {
      throw new HttpError(409, "Setup not started", "Start MFA setup first");
    }
    const counter = verifyTotp(decryptSecret(rows[0].mfa_secret_enc, authSecret), code, 0);
    if (counter === null) throw new HttpError(401, "Invalid code", "That code is not valid");
    const codes = generateRecoveryCodes();
    await withActor(app.pool, memberId, async (client) => {
      await client.query(
        "UPDATE iam.member_credential SET mfa_enabled_at = now(), mfa_last_counter = $2 WHERE member_id = $1",
        [memberId, counter],
      );
      await client.query("DELETE FROM iam.recovery_code WHERE member_id = $1", [memberId]);
      for (const c of codes) {
        await client.query("INSERT INTO iam.recovery_code (member_id, code_hash) VALUES ($1,$2)", [
          memberId,
          hashRecoveryCode(c),
        ]);
      }
    });
    const updated = await loadAuthMember(app.pool, memberId);
    if (!updated) throw new HttpError(401, "Unauthorized", "Sign in again");
    setSessionCookie(req, reply, newClaims(updated, true), authSecret);
    await logEvent(req, memberId, "mfa_enrolled");
    return { ...(await view(updated, stageOf(updated, true))), recoveryCodes: codes };
  });

  app.post("/password", { config: { perm: "signin" } }, async (req, reply) => {
    requireWritable();
    const memberId = requireStage(req, "password_change", "ok");
    const body = passwordSchema.parse(req.body);
    const member = await loadAuthMember(app.pool, memberId);
    const { rows } = await app.pool.query<{ password_hash: string }>(
      "SELECT password_hash FROM iam.member_credential WHERE member_id = $1",
      [memberId],
    );
    if (!member || !rows[0]) throw new HttpError(401, "Unauthorized", "Sign in again");
    if (!(await verifyPassword(body.currentPassword, rows[0].password_hash))) {
      throw new HttpError(401, "Invalid credentials", "The current password is wrong");
    }
    const problem = passwordProblem(body.newPassword, member);
    if (problem) throw new HttpError(422, "Weak password", problem);
    if (body.newPassword === body.currentPassword) {
      throw new HttpError(422, "Weak password", "Choose a password you have not used just now");
    }
    // Bumping the epoch signs every other session out.
    await app.pool.query(
      `UPDATE iam.member_credential
          SET password_hash = $2, password_changed_at = now(), must_change_password = false,
              session_epoch = session_epoch + 1
        WHERE member_id = $1`,
      [memberId, await hashPassword(body.newPassword)],
    );
    const updated = await loadAuthMember(app.pool, memberId);
    if (!updated) throw new HttpError(401, "Unauthorized", "Sign in again");
    setSessionCookie(req, reply, newClaims(updated, req.authMfa), authSecret);
    await logEvent(req, memberId, "password_changed");
    return view(updated, stageOf(updated, req.authMfa));
  });
};
