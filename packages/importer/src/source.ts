import { databaseNameOf } from "@hoosier/db";
import pg from "pg";

/**
 * Opens the ConnectWise mirror for reading only. Two protections apply:
 *  - the session is read-only (PostgreSQL rejects any write), and
 *  - the source may never be the same database as the target.
 * The mirror is the one place assertSafeTarget() deliberately does not allow, so it has its own opener.
 */
export function createSourcePool(sourceUrl: string, targetUrl: string): pg.Pool {
  const source = databaseNameOf(sourceUrl).toLowerCase();
  const target = databaseNameOf(targetUrl).toLowerCase();
  if (!source) throw new Error("Source URL does not name a database");
  if (source === target) {
    throw new Error(`Source and target are the same database ("${source}"); refusing to import`);
  }
  return new pg.Pool({
    connectionString: sourceUrl,
    max: 2,
    options: "-c default_transaction_read_only=on",
  });
}
