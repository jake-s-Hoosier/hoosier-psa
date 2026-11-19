import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/** Arbitrary constant: serialises concurrent migration runs across processes. */
const ADVISORY_LOCK_KEY = 7_428_001;

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export interface MigrationFile {
  version: string; // '0001'
  name: string; // '0001_foundation'
  sql: string;
  checksum: string;
}

export interface MigrationStatus {
  name: string;
  state: "applied" | "pending";
  appliedAt?: Date;
}

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const seen = new Set<string>();
  const out: MigrationFile[] = [];
  for (const file of entries) {
    const match = FILE_PATTERN.exec(file);
    if (!match?.[1]) {
      throw new Error(`Invalid migration filename "${file}". Expected NNNN_snake_case.sql`);
    }
    if (seen.has(match[1])) {
      throw new Error(`Duplicate migration version ${match[1]}`);
    }
    seen.add(match[1]);
    const sql = await readFile(path.join(dir, file), "utf8");
    out.push({
      version: match[1],
      name: file.replace(/\.sql$/, ""),
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  return out;
}

async function ensureBookkeeping(client: pg.PoolClient): Promise<void> {
  await client.query("CREATE SCHEMA IF NOT EXISTS sys");
  await client.query(`
    CREATE TABLE IF NOT EXISTS sys.schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);
}

/**
 * Applies pending migrations in order, each in its own transaction.
 * Refuses to run if an applied migration file has been edited (checksum drift):
 * applied migrations are immutable; fix forward with a new migration.
 */
export async function migrateUp(
  pool: pg.Pool,
  dir: string = MIGRATIONS_DIR,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const files = await loadMigrations(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    await ensureBookkeeping(client);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM sys.schema_migrations",
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const [name, checksum] of done) {
      const file = files.find((f) => f.name === name);
      if (!file) throw new Error(`Applied migration ${name} is missing from the migrations folder`);
      if (file.checksum !== checksum) {
        throw new Error(`Migration ${name} was modified after being applied (checksum mismatch)`);
      }
    }

    for (const file of files) {
      if (done.has(file.name)) continue;
      log(`applying ${file.name}`);
      try {
        await client.query("BEGIN");
        await client.query(file.sql);
        await client.query("INSERT INTO sys.schema_migrations (name, checksum) VALUES ($1, $2)", [
          file.name,
          file.checksum,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file.name} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file.name);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

export async function migrationStatus(
  pool: pg.Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationStatus[]> {
  const files = await loadMigrations(dir);
  const client = await pool.connect();
  try {
    await ensureBookkeeping(client);
    const { rows } = await client.query<{ name: string; applied_at: Date }>(
      "SELECT name, applied_at FROM sys.schema_migrations",
    );
    const done = new Map(rows.map((r) => [r.name, r.applied_at]));
    return files.map((f) => {
      const appliedAt = done.get(f.name);
      return appliedAt
        ? { name: f.name, state: "applied" as const, appliedAt }
        : { name: f.name, state: "pending" as const };
    });
  } finally {
    client.release();
  }
}
