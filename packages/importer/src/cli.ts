import { isEnvironmentName } from "@hoosier/db";
import pg from "pg";
import { runImport } from "./import.js";
import { createSourcePool } from "./source.js";

/**
 * Usage: APP_ENV=shadow DATABASE_URL=... CW_MIRROR_URL=... pnpm --filter @hoosier/importer import [--dry-run]
 * The mirror is opened read-only; the target must carry a matching environment marker.
 */
async function main(): Promise<void> {
  const targetUrl = process.env.DATABASE_URL;
  const sourceUrl = process.env.CW_MIRROR_URL;
  const appEnv = process.env.APP_ENV;
  if (!targetUrl || !sourceUrl || !appEnv) {
    throw new Error("DATABASE_URL, CW_MIRROR_URL and APP_ENV are required");
  }
  if (!isEnvironmentName(appEnv)) throw new Error(`Unknown APP_ENV "${appEnv}"`);
  const dryRun = process.argv.includes("--dry-run");

  const source = createSourcePool(sourceUrl, targetUrl);
  const target = new pg.Pool({ connectionString: targetUrl, max: 2 });
  try {
    const { report, reconciliation } = await runImport({
      source,
      target,
      targetUrl,
      appEnv,
      dryRun,
    });
    console.log(JSON.stringify({ dryRun, counts: report.counts, reconciliation }, null, 2));
    console.log(`\nException summary (${report.totalExceptions} total):`);
    for (const s of report.summary()) console.log(`  [${s.entity}] ${s.problem} x${s.n}`);
    console.log(dryRun ? "\nDRY RUN: nothing was written." : "\nImport committed.");
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
