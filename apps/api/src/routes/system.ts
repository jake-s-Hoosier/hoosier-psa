import type { FastifyPluginAsync } from "fastify";

/** Tells the UI which environment it is talking to, so testers always know. */
export const systemRoutes: FastifyPluginAsync<{
  appEnv: string;
  writeMode: "read_only" | "read_write";
}> = async (app, opts) => {
  app.get("/status", { config: { perm: "authenticated" } }, async () => ({
    environment: opts.appEnv,
    writeMode: opts.writeMode,
  }));
};
