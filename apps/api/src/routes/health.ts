import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  /** Liveness: the process is up. */
  app.get("/healthz", async () => ({ status: "ok" }));

  /** Readiness: the database answers. */
  app.get("/readyz", async (_req, reply) => {
    try {
      await app.pool.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "unavailable" });
    }
  });
};
