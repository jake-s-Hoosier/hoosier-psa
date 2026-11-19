import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
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
  if (config.NODE_ENV === "production" && config.AUTH_MODE === "dev") {
    throw new Error("AUTH_MODE=dev is not allowed in production");
  }
  if (config.AUTH_MODE === "entra") {
    throw new Error("AUTH_MODE=entra is not implemented yet");
  }
  return config;
}
