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
   * 'dev' trusts an x-dev-member-id header and exists only until Entra sign-in lands (milestone 1,
   * docs/07-roadmap.md). It is refused in production.
   */
  AUTH_MODE: z.enum(["dev", "entra"]).default("dev"),
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
  if (config.AUTH_MODE === "entra") {
    throw new Error("AUTH_MODE=entra is not implemented yet");
  }
  if (config.APP_ENV === "shadow" && config.DB_WRITE_MODE === "read_write") {
    throw new Error(
      "The API never writes in the shadow environment (it is populated by the import tool)",
    );
  }
  if (config.INTEGRATIONS_ENABLED && config.APP_ENV !== "production") {
    throw new Error("INTEGRATIONS_ENABLED=true is only allowed when APP_ENV=production");
  }
  return config;
}
