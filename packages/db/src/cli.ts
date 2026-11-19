import pg from "pg";
import {
  approveGoLive,
  assertSafeTarget,
  checkWriteAccess,
  ensureMarker,
  isEnvironmentName,
  readMarker,
} from "./guard.js";
import { migrateUp, migrationStatus } from "./migrate.js";

const USAGE = `Usage: cli.ts <command>
  up                      apply pending migrations (needs APP_ENV and DATABASE_URL)
  status                  show applied and pending migrations
  approve-go-live <name>  record production go-live approval (see docs/12)
Flags:
  --confirm-production    required to migrate a database marked "production"
  --go-live-checklist-complete   required by approve-go-live`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positional = rest.filter((a) => !a.startsWith("--"));

  const url = process.env.DATABASE_URL;
  if (!url) fail("DATABASE_URL is required");
  const appEnv = process.env.APP_ENV ?? "";
  if (!isEnvironmentName(appEnv)) {
    fail("APP_ENV is required: development | test | uat | shadow | production");
  }

  assertSafeTarget(url);
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const existing = await readMarker(pool);
    if (existing && existing.name !== appEnv) {
      fail(`Database is marked "${existing.name}" but APP_ENV is "${appEnv}". Refusing.`);
    }
    if (appEnv === "production" && command !== "status" && !flags.has("--confirm-production")) {
      fail("Refusing to change a production database without --confirm-production");
    }

    if (command === "up") {
      const applied = await migrateUp(pool, undefined, (m) => console.log(m));
      await ensureMarker(pool, appEnv);
      console.log(
        applied.length ? `Applied ${applied.length} migration(s).` : "Already up to date.",
      );
    } else if (command === "status") {
      for (const m of await migrationStatus(pool)) {
        console.log(`${m.state === "applied" ? "[x]" : "[ ]"} ${m.name}`);
      }
      const marker = await readMarker(pool);
      console.log(
        marker
          ? `environment: ${marker.name}${marker.goLiveApprovedAt ? ` (go-live approved ${marker.goLiveApprovedAt.toISOString()} by ${marker.goLiveApprovedBy})` : ""}`
          : "environment: (no marker yet)",
      );
    } else if (command === "approve-go-live") {
      if (appEnv !== "production") fail("approve-go-live only applies to APP_ENV=production");
      if (!flags.has("--go-live-checklist-complete")) {
        fail(
          "Pass --go-live-checklist-complete to confirm docs/12 section 'Go-live gate' is signed off",
        );
      }
      const approver = positional[0];
      if (!approver) fail("Usage: approve-go-live <approver name>");
      const decision = checkWriteAccess({
        appEnv,
        marker: await readMarker(pool),
        actor: "migrator",
      });
      if (decision.allowed) fail("Go-live is already approved");
      const marker = await approveGoLive(pool, approver);
      console.log(
        `Go-live approved by ${marker.goLiveApprovedBy} at ${marker.goLiveApprovedAt?.toISOString()}`,
      );
    } else {
      fail(USAGE);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
