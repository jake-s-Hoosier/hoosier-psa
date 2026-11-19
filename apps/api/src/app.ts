import type { Pool } from "@hoosier/db";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { HttpError, errorHandler } from "./errors.js";
import { companyRoutes } from "./routes/companies.js";
import { healthRoutes } from "./routes/health.js";

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
  config: Pick<Config, "AUTH_MODE" | "LOG_LEVEL">;
}

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

  app.register(healthRoutes);
  app.register(companyRoutes, { prefix: "/api/v1/companies" });
  return app;
}
