import type { Pool } from "@hoosier/db";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { type RoutePermission, loadPermissions, satisfies } from "./auth/permissions.js";
import {
  ABSOLUTE_MS,
  type AuthStage,
  COOKIE_NAME,
  CSRF_HEADER,
  CSRF_VALUE,
  IDLE_MS,
  clearSessionCookie,
  loadAuthMember,
  readCookie,
  setSessionCookie,
  stageOf,
  verifySession,
} from "./auth/session.js";
import type { Config } from "./config.js";
import { HttpError, errorHandler } from "./errors.js";
import { adminRoutes } from "./routes/admin.js";
import { agreementRoutes } from "./routes/agreements.js";
import { authRoutes } from "./routes/auth.js";
import { billingRoutes } from "./routes/billing.js";
import { companyRoutes } from "./routes/companies.js";
import { creditMemoRoutes } from "./routes/credit-memos.js";
import { crmRecordRoutes } from "./routes/crm-records.js";
import { dispatchRoutes } from "./routes/dispatch.js";
import { healthRoutes } from "./routes/health.js";
import { lookupRoutes } from "./routes/lookups.js";
import { mailboxRoutes } from "./routes/mailboxes.js";
import { salesOrderRoutes } from "./routes/orders.js";
import { payPeriodRoutes } from "./routes/pay-periods.js";
import { paymentRoutes } from "./routes/payments.js";
import { procurementRoutes } from "./routes/procurement.js";
import { projectRoutes } from "./routes/projects.js";
import { reportRoutes } from "./routes/reports.js";
import { salesRoutes } from "./routes/sales.js";
import { systemRoutes } from "./routes/system.js";
import { ticketChargeRoutes } from "./routes/ticket-charges.js";
import { ticketFileRoutes } from "./routes/ticket-files.js";
import { ticketRoutes } from "./routes/tickets.js";
import { timeRoutes } from "./routes/time.js";
import { timesheetRoutes } from "./routes/timesheets.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Staff member making the request; null for unauthenticated routes. */
    memberId: number | null;
  }
  interface FastifyInstance {
    pool: Pool;
    routeTable: Array<{ method: string; url: string; perm: RoutePermission | undefined }>;
  }
  interface FastifyContextConfig {
    /** What the route requires; see RoutePermission. */
    perm?: RoutePermission;
  }
}

export interface AppDeps {
  pool: Pool;
  config: Pick<Config, "AUTH_MODE" | "LOG_LEVEL" | "APP_ENV" | "DB_WRITE_MODE"> & {
    AUTH_SECRET?: string | undefined;
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Reachable without being signed in. */
const PUBLIC_PATH =
  /^\/(healthz|readyz|api\/v1\/system\/status|api\/v1\/auth\/(login|logout))(\?|$)/;
/** Reachable part-way through sign-in (password entered, second factor or setup still to do). */
const SIGN_IN_PATH = /^\/api\/v1\/auth\//;
/** Writes that are allowed even in read-only mode because they change no business data. */
const READ_ONLY_EXEMPT = /^\/api\/v1\/auth\/(login|logout|mfa\/verify)(\?|$)/;

export function buildApp({ pool, config }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: config.LOG_LEVEL === "silent" ? false : { level: config.LOG_LEVEL },
    trustProxy: true, // behind the Cloudflare tunnel
  });

  app.decorate("pool", pool);
  app.decorateRequest("memberId", null);
  app.decorateRequest("authStage", null);
  app.decorateRequest("authMfa", false);
  app.decorateRequest("permissions", undefined as unknown as ReadonlySet<string>);

  // Every route must declare what it requires (config.perm). The table is kept so a test can prove it.
  const routeTable: Array<{ method: string; url: string; perm: RoutePermission | undefined }> = [];
  app.decorate("routeTable", routeTable);
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      routeTable.push({ method, url: route.url, perm: route.config?.perm });
    }
  });

  /** Loads the caller's permissions and refuses the request unless the route's requirement is met. */
  async function authorize(req: FastifyRequest): Promise<void> {
    if (req.is404 || !req.url.startsWith("/api/v1/") || req.memberId === null) return;
    const perm = req.routeOptions.config?.perm;
    req.permissions = await loadPermissions(app.pool, req.memberId);
    if (perm === undefined) {
      req.log.error({ url: req.url }, "route declares no permission; refusing");
      throw new HttpError(403, "Forbidden", "This route has no permission rule");
    }
    if (!satisfies(perm, req.permissions)) {
      const needed = typeof perm === "string" ? perm : perm.join(" or ");
      throw new HttpError(403, "Forbidden", `You do not have permission: ${needed}`);
    }
  }
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_req, reply) => {
    void reply
      .status(404)
      .type("application/problem+json")
      .send({ type: "about:blank", title: "Not Found", status: 404 });
  });

  // Authentication.
  //  - session: signed cookie from /api/v1/auth/login, re-checked against the database on every request
  //    (member still active, session epoch unchanged, second factor done).
  //  - dev: local development and tests; trusts x-dev-member-id; refused in production by loadConfig.
  const authSecret = config.AUTH_SECRET;
  app.addHook("onRequest", async (req, reply) => {
    const isPublic = PUBLIC_PATH.test(req.url);
    if (config.AUTH_MODE === "dev") {
      if (isPublic) return;
      const raw = req.headers["x-dev-member-id"];
      const id = Number(Array.isArray(raw) ? raw[0] : raw);
      if (!Number.isInteger(id) || id <= 0) {
        throw new HttpError(401, "Unauthorized", "Missing or invalid credentials");
      }
      req.memberId = id;
      req.authStage = "ok";
      req.authMfa = true;
      await authorize(req);
      return;
    }
    if (!authSecret) throw new Error("AUTH_SECRET missing");

    // Cookies are sent by browsers automatically, so state-changing requests must carry a header a
    // cross-site form cannot set (on top of SameSite=Lax).
    if (!SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
      throw new HttpError(403, "Missing header", `Send the ${CSRF_HEADER} header`);
    }
    if (isPublic) return;

    const token = readCookie(req.headers.cookie, COOKIE_NAME);
    const claims = token ? verifySession(token, authSecret) : null;
    const now = Date.now();
    if (!claims || claims.exp <= now || now - claims.seen > IDLE_MS) {
      if (token) clearSessionCookie(req, reply);
      throw new HttpError(401, "Unauthorized", "Sign in required");
    }
    const member = await loadAuthMember(app.pool, claims.m);
    if (!member || !member.isActive || member.epoch !== claims.e) {
      clearSessionCookie(req, reply);
      throw new HttpError(401, "Unauthorized", "Sign in required");
    }
    const stage: AuthStage = stageOf(member, claims.mfa);
    if (stage !== "ok" && !SIGN_IN_PATH.test(req.url)) {
      throw new HttpError(403, "Sign-in incomplete", `Next step: ${stage}`);
    }
    req.memberId = member.id;
    req.authStage = stage;
    req.authMfa = claims.mfa;
    if (stage === "ok") await authorize(req);
    // Sliding idle timeout: re-issue while active, never beyond the absolute limit.
    if (stage === "ok" && now - claims.seen > 60_000) {
      setSessionCookie(
        req,
        reply,
        { ...claims, seen: now, exp: Math.min(claims.iat + ABSOLUTE_MS, claims.exp) },
        authSecret,
      );
    }
  });

  // First line of write protection: in read-only mode no mutating request reaches a handler.
  // The database pool is read-only as well (createPool), so this is a clear message, not the only guard.
  app.addHook("onRequest", async (req) => {
    if (
      config.DB_WRITE_MODE === "read_only" &&
      !SAFE_METHODS.has(req.method) &&
      !READ_ONLY_EXEMPT.test(req.url)
    ) {
      throw new HttpError(
        403,
        "Read-only mode",
        `This ${config.APP_ENV} environment is read-only; changes are not accepted`,
      );
    }
  });

  app.register(healthRoutes);
  app.register(systemRoutes, {
    prefix: "/api/v1/system",
    appEnv: config.APP_ENV,
    writeMode: config.DB_WRITE_MODE,
  });
  if (config.AUTH_MODE === "session" && authSecret) {
    app.register(authRoutes, {
      prefix: "/api/v1/auth",
      authSecret,
      writable: config.DB_WRITE_MODE === "read_write",
    });
  }
  app.register(adminRoutes, { prefix: "/api/v1/admin" });
  app.register(agreementRoutes, { prefix: "/api/v1/agreements" });
  app.register(billingRoutes, { prefix: "/api/v1/billing" });
  app.register(paymentRoutes, { prefix: "/api/v1/payments" });
  app.register(creditMemoRoutes, { prefix: "/api/v1/credit-memos" });
  app.register(companyRoutes, { prefix: "/api/v1/companies" });
  app.register(crmRecordRoutes, { prefix: "/api/v1/companies" });
  app.register(lookupRoutes, { prefix: "/api/v1/lookups" });
  app.register(mailboxRoutes, { prefix: "/api/v1/mailboxes" });
  app.register(ticketRoutes, { prefix: "/api/v1/tickets" });
  app.register(ticketFileRoutes, { prefix: "/api/v1/tickets" });
  app.register(ticketChargeRoutes, { prefix: "/api/v1/tickets" });
  app.register(projectRoutes, { prefix: "/api/v1/projects" });
  app.register(dispatchRoutes, { prefix: "/api/v1/dispatch" });
  app.register(procurementRoutes, { prefix: "/api/v1/procurement" });
  app.register(reportRoutes, { prefix: "/api/v1/reports" });
  app.register(salesRoutes, { prefix: "/api/v1/sales" });
  app.register(salesOrderRoutes, { prefix: "/api/v1/sales" });
  app.register(timeRoutes, { prefix: "/api/v1/time-entries" });
  app.register(timesheetRoutes, { prefix: "/api/v1/timesheets" });
  app.register(payPeriodRoutes, { prefix: "/api/v1/pay-periods" });
  return app;
}
