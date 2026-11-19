# 08. Security

> **Implementation status.** In place: database-level audit trail, immutable migrations, input
> validation, parameterised SQL, problem+json errors, production refusal of dev auth, local
> password + TOTP sign-in with signed sessions, CSRF header, sign-in throttling and the admin CLI
> ([ADR 0010](adr/0010-local-authentication.md)), and per-route permission enforcement with roles
> managed from the Access screen or the admin CLI. Still to come: separate database roles,
> per-route rate limiting. Later milestones:
> portal authentication and payment handling.

## Threat model in brief

Assets: customer and site information (including access codes and security-system details), billing
and payment data, employee time and cost data. Realistic threats: stolen staff credentials, an
over-privileged account, an injection or authorization bug in the API, leaked secrets, and loss of
data. Hoosier Security is a security integrator; customers expect its own systems to meet that bar.

## Authentication

Staff sign in with a local password and an authenticator-app code ([ADR 0010](adr/0010-local-authentication.md)).

- Accounts are created by an administrator with `pnpm auth set-password <identifier>`, which prints a
  one-time temporary password. First sign-in forces a new password (12+ characters, not common, not
  containing name or email) and authenticator enrolment, then shows ten single-use recovery codes.
- Passwords: scrypt with per-password salt. MFA secrets: AES-256-GCM, key derived from `AUTH_SECRET`.
  Used codes cannot be replayed. Recovery codes are stored hashed.
- Sessions are signed cookies (`HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS). Every request re-checks
  that the member is active and the session epoch matches, so a password change, admin reset or
  deactivation ends sessions at once. Idle timeout 2 hours; absolute 12 hours.
- State-changing requests need the `x-requested-with: hoosier-psa` header. Five failed sign-ins lock the
  account (and 30 lock an address) for 15 minutes.
- `iam.member_credential` is not audited, so hashes and secrets never reach `sys.audit_log`; security
  events are in `iam.auth_event`.
- Operations: `pnpm auth set-password <id>`, `pnpm auth reset-mfa <id>`, `pnpm auth grant-role <id> <role>`, `pnpm auth revoke-role <id> <role>`, `pnpm auth sync-permissions`, `pnpm auth status`. They honour the
  environment marker and production go-live lock. Lost authenticator: reset MFA, member enrols again.
- `AUTH_MODE=dev` (trusts a header) exists only for local development and tests; the API refuses to start
  with it when `NODE_ENV` or `APP_ENV` is production.
- Customer portal authentication (milestone 5) is separate: email-verified one-time links or codes, scoped to
  the contacts of one company. It never shares sessions or code paths with staff authentication.

## Authorization

- Permission keys (`module.resource.action`) are defined in code (`packages/shared/src/permissions.ts`) and
  synced to `iam.permission` when a writable API starts (or with `pnpm auth sync-permissions`); roles group
  them; members hold roles. Code checks keys, never role names.
- **Deny by default.** Every `/api/v1` route declares what it needs in `config.perm`: a permission key, a list
  (any one suffices), `"authenticated"` (any fully signed-in member) or `"signin"` (the sign-in routes, which
  work with a partly signed-in session). A route with no declaration answers 403, and a unit test lists every
  route and fails if one has none.
- The check runs after authentication for both session and dev modes, so a half-signed-in session (password
  change or MFA pending) never reaches business routes.
- **Where grants come from.** A role's rows in `iam.role_permission` once an administrator has set any;
  otherwise the system role's defaults in code, so a fresh or read-only (shadow) database works without a
  seeding step. A member's permissions are the union over their roles. Keys no longer in code are ignored.
- **Own versus all.** Time entries: `read_own` / `write_own` for yourself, `read_all` / `write_all` for others
  (listing another member's time needs `read_all`; removing another member's entry needs `write_all`).
- **Separation of duties.** Approving time needs `timekeeping.time.approve`, and nobody can approve their own
  time. Locking and exporting pay periods need `timekeeping.period.lock`.
- The sign-in response tells the web app what the member may do so it hides controls they cannot use. That is
  a convenience only; the API enforces every rule.
- Role changes: the Access screen, or `pnpm auth grant-role <id> <role>` and `revoke-role`. Either way, a change
  that would leave no active member with `iam.manage` is refused, built-in roles cannot be renamed or deleted,
  a built-in role can be customised and reset to its defaults, and every grant change is audited with who made it; the **Access** screen (needs `iam.manage`) does the same from the browser.

## Attachments

- Uploaded files are stored in the database ([ADR 0011](adr/0011-attachments-in-postgres.md)), capped at 25 MB, and
  never written to the audit log.
- They are served only as downloads (`Content-Disposition: attachment`, `nosniff`, sandbox CSP), so an uploaded
  HTML or SVG file cannot execute in the application's origin.
- Anyone who can read a ticket can download its files; uploading and removing needs `service.ticket.write`
  (removing someone else's file needs `service.ticket.delete`). No malware scanning yet; add it before files reach the customer portal.

## Data protection

- **Audit.** `sys.audit_log` records insert, update and delete with old and new values and the acting member, written
  by database triggers so no code path can skip it. It is append-only for the application role.
- **Database roles.** Separate roles for migrations (DDL), the application (DML, no DDL, no audit-log writes
  beyond triggers), reporting (read-only views), and the import tool (read-only on the mirror).
- **In transit.** TLS at the Cloudflare edge; origin traffic stays on the host or private network.
- **At rest.** Disk encryption on HSIN-UT01 (verify BitLocker status); backups encrypted before leaving the host.
- **Secrets.** Only in environment variables or the host's secret store, never in the repository.
  `.env.example` documents names only. Rotate on staff change.
- **Sensitive fields.** Site access notes and gate codes are visible only with `crm.company.read`; they are never
  written to logs or exported in bulk reports by default.
- **Logging.** Structured logs exclude request bodies for payment, authentication and notes endpoints.

## Payment card scope (PCI DSS)

The system **never stores, processes or transmits card numbers**. Card and bank details are entered into
the provider's hosted fields or hosted page and exchanged for a token; only the token, brand, last four,
expiry and provider customer id are stored ([10](10-payments-and-autopay.md)). This keeps the application at the
lightest self-assessment level (SAQ A). Anything that would put card data through our servers needs an ADR
and a compliance review first.

## Application security practices

- Every input is validated with a zod schema; every query is parameterised.
- Output encoding by React; no `dangerouslySetInnerHTML`; user-supplied HTML (ticket email bodies) is
  sanitised server-side before storage and display.
- File uploads: size and type limits, content-type verification, stored outside the web root with
  generated names, served through authorised download routes.
- Rate limiting on authentication and on write endpoints; request size limits.
- CSRF: same-site cookies plus a required custom header on mutating requests.
- Dependencies: lockfile committed, Dependabot and `pnpm audit` in CI, minimal dependency footprint.
- Cloudflare Access in front of the staff app; the QuickBooks endpoint is restricted to HSIN-QB01.

## Backup and recovery

Nightly `pg_dump` to off-host storage; monthly restore drill into a scratch database with row-count and
checksum verification; target recovery point 24 hours (tightened to continuous WAL archiving before
cutover if the business requires it); runbooks live in `docs/runbooks/` as they are written.

## Incident handling

Security issues are reported to the GM/Integrator. The audit log and structured logs are the primary evidence;
retention for both is at least 13 months.
