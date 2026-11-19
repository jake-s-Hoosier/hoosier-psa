import { assertSafeTarget, checkWriteAccess, isEnvironmentName, readMarker } from "@hoosier/db";
import pg from "pg";
import { generateTemporaryPassword, hashPassword } from "./auth/crypto.js";

const USAGE = `Usage: auth-cli.ts <command> [identifier]
  set-password <identifier> [--email you@example.com]
                              create or reset a staff login with a one-time temporary password;
                              --email also sets the member's email (imports carry placeholders)
  reset-mfa <identifier>      remove the member's second factor and recovery codes (they enrol again)
  status                      list members and whether they can sign in
Needs APP_ENV and DATABASE_URL. Never touches cw_datawarehouse; production needs go-live approval.`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const emailFlag = args.indexOf("--email");
  const email = emailFlag >= 0 ? args[emailFlag + 1] : undefined;
  if (emailFlag >= 0 && !(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    fail("--email needs a valid address");
  const positional = args.filter(
    (_, i) => i !== emailFlag && i !== emailFlag + 1 + (emailFlag < 0 ? 1000 : 0),
  );
  const [command, identifier] = positional;
  const url = process.env.DATABASE_URL;
  if (!url) fail("DATABASE_URL is required");
  const appEnv = process.env.APP_ENV ?? "";
  if (!isEnvironmentName(appEnv))
    fail("APP_ENV is required: development | test | uat | shadow | production");
  assertSafeTarget(url);

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const marker = await readMarker(pool);
    if (command !== "status") {
      const decision = checkWriteAccess({ appEnv, marker, actor: "migrator" });
      if (!decision.allowed) fail(`Refusing: ${decision.reason}`);
    } else if (!marker || marker.name !== appEnv) {
      fail("Database marker does not match APP_ENV");
    }

    if (command === "status") {
      const { rows } = await pool.query(
        `SELECT m.identifier::text AS identifier, m.email::text AS email, m.is_active AS active,
                (c.member_id IS NOT NULL) AS has_login, c.must_change_password AS must_change,
                (c.mfa_enabled_at IS NOT NULL) AS mfa
           FROM iam.member m LEFT JOIN iam.member_credential c ON c.member_id = m.id
          ORDER BY m.identifier`,
      );
      console.table(rows);
      return;
    }
    if (!identifier) fail(USAGE);
    const member = (
      await pool.query<{ id: string; is_active: boolean }>(
        "SELECT id, is_active FROM iam.member WHERE identifier = $1",
        [identifier],
      )
    ).rows[0];
    if (!member) fail(`No member with identifier "${identifier}"`);

    if (command === "set-password") {
      if (!member.is_active) fail("That member is inactive");
      if (email) {
        await pool.query("UPDATE iam.member SET email = $2 WHERE id = $1", [member.id, email]);
      }
      const temp = generateTemporaryPassword();
      await pool.query(
        `INSERT INTO iam.member_credential (member_id, password_hash, must_change_password)
         VALUES ($1,$2,true)
         ON CONFLICT (member_id) DO UPDATE
           SET password_hash = EXCLUDED.password_hash, password_changed_at = now(),
               must_change_password = true, session_epoch = iam.member_credential.session_epoch + 1`,
        [member.id, await hashPassword(temp)],
      );
      await pool.query(
        "INSERT INTO iam.auth_event (member_id, kind) VALUES ($1,'password_set_by_admin')",
        [member.id],
      );
      console.log(
        `Temporary password for ${identifier} (shown once, must be changed at first sign-in):\n\n  ${temp}\n`,
      );
    } else if (command === "reset-mfa") {
      await pool.query(
        `UPDATE iam.member_credential
            SET mfa_secret_enc = NULL, mfa_enabled_at = NULL, mfa_last_counter = 0,
                session_epoch = session_epoch + 1
          WHERE member_id = $1`,
        [member.id],
      );
      await pool.query("DELETE FROM iam.recovery_code WHERE member_id = $1", [member.id]);
      await pool.query(
        "INSERT INTO iam.auth_event (member_id, kind) VALUES ($1,'mfa_reset_by_admin')",
        [member.id],
      );
      console.log(
        `Second factor removed for ${identifier}; they will enrol again at next sign-in.`,
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
