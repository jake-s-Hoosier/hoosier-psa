import type pg from "pg";

/**
 * Write-safety guards. Nothing in this repository may write to a production database until go-live
 * has been explicitly approved, and nothing may ever point at the ConnectWise mirror.
 * Specification: docs/12-environments-and-safe-rollout.md.
 */

export const ENVIRONMENT_NAMES = ["development", "test", "uat", "shadow", "production"] as const;
export type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

export function isEnvironmentName(value: string): value is EnvironmentName {
  return (ENVIRONMENT_NAMES as readonly string[]).includes(value);
}

/** Databases this project must never connect its application or migrations to. */
export const DEFAULT_PROTECTED_DATABASES: readonly string[] = [
  "cw_datawarehouse",
  "postgres",
  "template0",
  "template1",
];

export function databaseNameOf(connectionString: string): string {
  const url = new URL(connectionString);
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

/**
 * Throws if the connection string targets a protected database (the CW mirror, or the server's
 * maintenance databases). Applied to every application and migration connection.
 */
export function assertSafeTarget(
  connectionString: string,
  protectedNames: readonly string[] = DEFAULT_PROTECTED_DATABASES,
): void {
  const name = databaseNameOf(connectionString).toLowerCase();
  if (!name) throw new Error("DATABASE_URL does not name a database");
  if (protectedNames.map((n) => n.toLowerCase()).includes(name)) {
    throw new Error(
      `Refusing to connect: "${name}" is a protected database. This application must never use it.`,
    );
  }
}

export interface EnvironmentMarker {
  name: EnvironmentName;
  goLiveApprovedAt: Date | null;
  goLiveApprovedBy: string | null;
}

type Queryable = Pick<pg.Pool, "query">;

/** Reads the marker; null when the table or row does not exist yet. */
export async function readMarker(db: Queryable): Promise<EnvironmentMarker | null> {
  const exists = await db.query<{ t: string | null }>("SELECT to_regclass('sys.environment') AS t");
  if (!exists.rows[0]?.t) return null;
  const { rows } = await db.query<{
    name: EnvironmentName;
    go_live_approved_at: Date | null;
    go_live_approved_by: string | null;
  }>("SELECT name, go_live_approved_at, go_live_approved_by FROM sys.environment");
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.name,
    goLiveApprovedAt: row.go_live_approved_at,
    goLiveApprovedBy: row.go_live_approved_by,
  };
}

/** Creates the marker on first use; afterwards verifies it matches. Never changes an existing marker. */
export async function ensureMarker(
  db: Queryable,
  name: EnvironmentName,
): Promise<EnvironmentMarker> {
  await db.query(
    "INSERT INTO sys.environment (name) VALUES ($1) ON CONFLICT (singleton) DO NOTHING",
    [name],
  );
  const marker = await readMarker(db);
  if (!marker) throw new Error("sys.environment is missing; run migrations first");
  if (marker.name !== name) {
    throw new Error(
      `This database is marked "${marker.name}" but the application is configured as "${name}". Refusing to continue.`,
    );
  }
  return marker;
}

export type WriteActor = "api" | "importer" | "migrator";

export type WriteDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Decides whether a process may write. Pure so it can be tested exhaustively.
 *  - The database must carry a marker and it must match the process's configured environment.
 *  - Shadow is populated only by the importer; the API never writes there.
 *  - Production is locked until go-live approval is recorded.
 */
export function checkWriteAccess(input: {
  appEnv: EnvironmentName;
  marker: EnvironmentMarker | null;
  actor: WriteActor;
}): WriteDecision {
  const { appEnv, marker, actor } = input;
  if (!marker) {
    return { allowed: false, reason: "database has no environment marker (run db:migrate)" };
  }
  if (marker.name !== appEnv) {
    return {
      allowed: false,
      reason: `database is marked "${marker.name}" but the application is "${appEnv}"`,
    };
  }
  if (appEnv === "shadow" && actor === "api") {
    return {
      allowed: false,
      reason: "the shadow environment is populated only by the import tool",
    };
  }
  if (appEnv === "production" && !marker.goLiveApprovedAt) {
    return { allowed: false, reason: "production is locked until go-live is approved" };
  }
  return { allowed: true };
}

/**
 * Records go-live approval. One-way: the database trigger makes it permanent.
 * Callers (the CLI) must confirm the go-live checklist with a human first.
 */
export async function approveGoLive(db: Queryable, approvedBy: string): Promise<EnvironmentMarker> {
  const marker = await readMarker(db);
  if (!marker) throw new Error("sys.environment is missing; run migrations first");
  if (marker.name !== "production") {
    throw new Error(
      `Only a production database can be approved for go-live (this is "${marker.name}")`,
    );
  }
  if (marker.goLiveApprovedAt) throw new Error("Go-live is already approved");
  if (!approvedBy.trim()) throw new Error("approvedBy is required");
  await db.query(
    "UPDATE sys.environment SET go_live_approved_at = now(), go_live_approved_by = $1",
    [approvedBy.trim()],
  );
  const updated = await readMarker(db);
  if (!updated) throw new Error("approval was not recorded");
  return updated;
}
