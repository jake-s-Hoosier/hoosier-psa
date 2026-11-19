import pg from "pg";
import { assertSafeTarget } from "./guard.js";

export { loadMigrations, migrateUp, migrationStatus, MIGRATIONS_DIR } from "./migrate.js";
export type { MigrationFile, MigrationStatus } from "./migrate.js";
export * from "./guard.js";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface PoolOptions {
  max?: number;
  /**
   * When true every session defaults to read-only transactions, enforced by PostgreSQL itself.
   * Any INSERT/UPDATE/DELETE/DDL then fails with SQLSTATE 25006 even if application code is wrong.
   */
  readOnly: boolean;
}

/**
 * The only way application code obtains a pool. It refuses protected databases (the CW mirror),
 * and `readOnly` must be stated explicitly so a write-capable pool is always a deliberate choice.
 */
export function createPool(connectionString: string, opts: PoolOptions): pg.Pool {
  assertSafeTarget(connectionString);
  return new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    options: opts.readOnly ? "-c default_transaction_read_only=on" : undefined,
  });
}

/**
 * Runs fn in a transaction with the acting staff member recorded for the audit trail
 * (read by sys.audit_row() via current_setting('app.member_id')).
 */
export async function withActor<T>(
  pool: pg.Pool,
  memberId: number | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.member_id', $1, true)", [
      memberId === null ? "" : String(memberId),
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
