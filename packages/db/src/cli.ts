import pg from "pg";
import { migrateUp, migrationStatus } from "./migrate.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    if (command === "up") {
      const applied = await migrateUp(pool, undefined, (m) => console.log(m));
      console.log(
        applied.length ? `Applied ${applied.length} migration(s).` : "Already up to date.",
      );
    } else if (command === "status") {
      for (const m of await migrationStatus(pool)) {
        console.log(`${m.state === "applied" ? "[x]" : "[ ]"} ${m.name}`);
      }
    } else {
      console.error("Usage: cli.ts <up|status>");
      process.exit(2);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
