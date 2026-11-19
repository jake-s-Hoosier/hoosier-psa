import { assertSafeTarget, checkWriteAccess, createPool, readMarker } from "@hoosier/db";
import { buildApp } from "./app.js";
import { syncPermissions } from "./auth/permissions.js";
import { loadConfig } from "./config.js";
import { GraphMailSource } from "./mail/graph.js";
import { startPoller } from "./mail/poller.js";

async function main(): Promise<void> {
  const config = loadConfig();
  assertSafeTarget(config.DATABASE_URL);

  // Startup safety checks run on a read-only connection and must pass before the server listens.
  const pool = createPool(config.DATABASE_URL, {
    readOnly: config.DB_WRITE_MODE === "read_only",
  });

  const marker = await readMarker(pool);
  if (!marker) {
    throw new Error("Database has no environment marker. Run: APP_ENV=<env> pnpm db:migrate");
  }
  if (marker.name !== config.APP_ENV) {
    throw new Error(
      `Database is marked "${marker.name}" but APP_ENV is "${config.APP_ENV}". Refusing to start.`,
    );
  }
  if (config.DB_WRITE_MODE === "read_write") {
    const decision = checkWriteAccess({ appEnv: config.APP_ENV, marker, actor: "api" });
    if (!decision.allowed) {
      throw new Error(`Refusing to start in read_write mode: ${decision.reason}`);
    }
  }

  if (config.DB_WRITE_MODE === "read_write") {
    // Keep the permission catalogue in step with the code. A read-only shadow never writes; it
    // answers from the defaults in packages/shared instead.
    const synced = await syncPermissions(pool);
    if (synced.added || synced.removed) console.log("permissions synced", synced);
  }

  const app = buildApp({ pool, config });
  app.log.info(
    {
      environment: config.APP_ENV,
      writeMode: config.DB_WRITE_MODE,
      integrations: config.INTEGRATIONS_ENABLED,
    },
    "startup safety checks passed",
  );

  let stopMail: (() => void) | undefined;
  if (config.MAIL_POLL_ENABLED) {
    const source = new GraphMailSource({
      tenantId: config.GRAPH_TENANT_ID as string,
      clientId: config.GRAPH_CLIENT_ID as string,
      clientSecret: config.GRAPH_CLIENT_SECRET as string,
    });
    stopMail = startPoller(pool, source, config.MAIL_POLL_INTERVAL_SECONDS * 1000, app.log);
    app.log.info({ everySeconds: config.MAIL_POLL_INTERVAL_SECONDS }, "mail polling started");
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    stopMail?.();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
