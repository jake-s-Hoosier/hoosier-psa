import pg from "pg";

export { loadMigrations, migrateUp, migrationStatus, MIGRATIONS_DIR } from "./migrate.js";
export type { MigrationFile, MigrationStatus } from "./migrate.js";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
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
