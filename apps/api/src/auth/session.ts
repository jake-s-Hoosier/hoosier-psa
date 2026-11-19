import type { Pool } from "@hoosier/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type SessionClaims, signSession, verifySession } from "./crypto.js";

export const COOKIE_NAME = "psa_session";
export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "hoosier-psa";

/** Signed out after this long without a request. */
export const IDLE_MS = 2 * 60 * 60 * 1000;
/** Hard limit regardless of activity. */
export const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
/** Time allowed between entering the password and finishing the second factor or a forced change. */
export const PARTIAL_MS = 10 * 60 * 1000;

export type AuthStage = "password_change" | "mfa_enroll" | "mfa_required" | "ok";

export interface AuthMember {
  id: number;
  identifier: string;
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  epoch: number;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
}

export function stageOf(member: AuthMember, mfaVerified: boolean): AuthStage {
  if (member.mfaEnabled && !mfaVerified) return "mfa_required";
  if (member.mustChangePassword) return "password_change";
  if (!member.mfaEnabled) return "mfa_enroll";
  return "ok";
}

export async function loadAuthMember(pool: Pool, memberId: number): Promise<AuthMember | null> {
  const { rows } = await pool.query<{
    id: string;
    identifier: string;
    email: string;
    first_name: string;
    last_name: string;
    is_active: boolean;
    session_epoch: number;
    must_change_password: boolean;
    mfa_enabled_at: Date | null;
  }>(
    `SELECT m.id, m.identifier::text, m.email::text, m.first_name, m.last_name, m.is_active,
            c.session_epoch, c.must_change_password, c.mfa_enabled_at
       FROM iam.member m JOIN iam.member_credential c ON c.member_id = m.id
      WHERE m.id = $1`,
    [memberId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    identifier: r.identifier,
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    isActive: r.is_active,
    epoch: r.session_epoch,
    mustChangePassword: r.must_change_password,
    mfaEnabled: r.mfa_enabled_at !== null,
  };
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function setSessionCookie(
  req: FastifyRequest,
  reply: FastifyReply,
  claims: SessionClaims,
  authSecret: string,
): void {
  const maxAge = Math.max(0, Math.floor((claims.exp - Date.now()) / 1000));
  const secure = req.protocol === "https" ? "; Secure" : "";
  void reply.header(
    "set-cookie",
    `${COOKIE_NAME}=${signSession(claims, authSecret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  );
}

export function clearSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
  const secure = req.protocol === "https" ? "; Secure" : "";
  void reply.header(
    "set-cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

export function newClaims(member: AuthMember, mfa: boolean, now = Date.now()): SessionClaims {
  // Until the second factor (or first-time setup) is done the session is short-lived.
  const partial = stageOf(member, mfa) !== "ok";
  return {
    m: member.id,
    e: member.epoch,
    iat: now,
    seen: now,
    exp: now + (partial ? PARTIAL_MS : ABSOLUTE_MS),
    mfa,
  };
}

export { verifySession };
