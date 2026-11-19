import { ENVIRONMENT_NAMES } from "@hoosier/db";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Which environment this process is. Must match the marker stored in the database it connects to. */
  APP_ENV: z.enum(ENVIRONMENT_NAMES).default("development"),
  DATABASE_URL: z.string().url(),
  /**
   * 'read_only' (default) makes PostgreSQL itself reject every write from this process.
   * 'read_write' is a deliberate choice and is still refused at startup for a production database
   * that has not been approved for go-live (docs/12-environments-and-safe-rollout.md).
   */
  DB_WRITE_MODE: z.enum(["read_only", "read_write"]).default("read_only"),
  /**
   * Master switch for anything that writes outside our own database: QuickBooks export, payment
   * providers, customer email. Defaults off and can only be on in production.
   */
  INTEGRATIONS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /**
   * 'session' is real sign-in: local password plus TOTP (docs/adr/0010-local-authentication.md).
   * 'dev' trusts an x-dev-member-id header for local development and tests, and is refused in production.
   */
  AUTH_MODE: z.enum(["dev", "session"]).default("dev"),
  /** Signs session cookies and encrypts MFA secrets. At least 32 characters; rotating it signs everyone out. */
  AUTH_SECRET: z.string().min(32).optional(),
  /**
   * Reads the active mailboxes (service.mailbox) in Microsoft 365 and turns mail into tickets. Off by default.
   * It only reads the mailbox, but it writes tickets, so it needs a writable database; in production it
   * also needs INTEGRATIONS_ENABLED (docs/adr/0012-microsoft-365-mail.md).
   */
  MAIL_POLL_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  MAIL_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
  /** Entra app registration with Mail.Read (application). Names are Microsoft's; the tenant is a Microsoft 365 tenant. */
  GRAPH_TENANT_ID: z.string().min(1).optional(),
  GRAPH_CLIENT_ID: z.string().min(1).optional(),
  GRAPH_CLIENT_SECRET: z.string().min(1).optional(),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${detail}`);
  }
  const config = parsed.data;
  if (
    (config.NODE_ENV === "production" || config.APP_ENV === "production") &&
    config.AUTH_MODE === "dev"
  ) {
    throw new Error("AUTH_MODE=dev is not allowed in production");
  }
  if (config.AUTH_MODE === "session" && !config.AUTH_SECRET) {
    throw new Error("AUTH_SECRET (at least 32 characters) is required when AUTH_MODE=session");
  }
  if (config.APP_ENV === "shadow" && config.DB_WRITE_MODE === "read_write") {
    throw new Error(
      "The API never writes in the shadow environment (it is populated by the import tool)",
    );
  }
  if (config.MAIL_POLL_ENABLED) {
    if (!config.GRAPH_TENANT_ID || !config.GRAPH_CLIENT_ID || !config.GRAPH_CLIENT_SECRET)
      throw new Error(
        "MAIL_POLL_ENABLED needs GRAPH_TENANT_ID, GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET",
      );
    if (config.DB_WRITE_MODE !== "read_write")
      throw new Error("MAIL_POLL_ENABLED needs DB_WRITE_MODE=read_write (it creates tickets)");
    if (config.APP_ENV === "shadow")
      throw new Error("The shadow environment never reads mail (it is a read-only copy)");
    if (config.APP_ENV === "production" && !config.INTEGRATIONS_ENABLED)
      throw new Error("In production, MAIL_POLL_ENABLED also needs INTEGRATIONS_ENABLED=true");
  }
  if (config.INTEGRATIONS_ENABLED && config.APP_ENV !== "production") {
    throw new Error("INTEGRATIONS_ENABLED=true is only allowed when APP_ENV=production");
  }
  return config;
}
