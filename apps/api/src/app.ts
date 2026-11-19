import type { Pool } from "@hoosier/db";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { HttpError, errorHandler } from "./errors.js";
import { companyRoutes } from "./routes/companies.js";
import { healthRoutes } from "./routes/health.js";
import { systemRoutes } from "./routes/system.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Staff member making the request; null for unauthenticated routes. */
    memberId: number | null;
  }
  interface FastifyInstance {
    pool: Pool;
  }
}

export interface AppDeps {
  pool: Pool;
  config: Pick<Config, "AUTH_MODE" | "LOG_LEVEL" | "APP_ENV" | "DB_WRITE_MODE">;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function buildApp({ pool, config }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: config.LOG_LEVEL === "silent" ? false : { level: config.LOG_LEVEL },
    trustProxy: true, // behind the Cloudflare tunnel
  });

  app.decorate("pool", pool);
  app.decorateRequest("memberId", null);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_req, reply) => {
    void reply
      .status(404)
      .type("application/problem+json")
      .send({ type: "about:blank", title: "Not Found", status: 404 });
  });

  // Authentication. AUTH_MODE=dev is a placeholder until Entra sign-in (see config.ts).
  app.addHook("onRequest", async (req) => {
    if (req.url.startsWith("/healthz") || req.url.startsWith("/readyz")) return;
    const raw = req.headers["x-dev-member-id"];
    const id = Number(Array.isArray(raw) ? raw[0] : raw);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(401, "Unauthorized", "Missing or invalid credentials");
    }
    req.memberId = id;
  });

  // First line of write protection: in read-only mode no mutating request reaches a handler.
  // The database pool is read-only as well (createPool), so this is a clear message, not the only guard.
  app.addHook("onRequest", async (req) => {
    if (config.DB_WRITE_MODE === "read_only" && !SAFE_METHODS.has(req.method)) {
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
  app.register(companyRoutes, { prefix: "/api/v1/companies" });
  return app;
}
