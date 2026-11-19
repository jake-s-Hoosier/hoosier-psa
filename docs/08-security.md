# 08. Security

> **Implementation status (milestone 0).** In place: database-level audit trail, immutable migrations,
> input validation, parameterised SQL, problem+json errors, production refusal of dev auth. Specified
> here and delivered in milestone 1: Entra sign-in and sessions, per-route permission enforcement,
> separate database roles, rate limiting and CSRF header checks. Later milestones: portal
> authentication and payment handling.

## Threat model in brief

Assets: customer and site information (including access codes and security-system details), billing
and payment data, employee time and cost data. Realistic threats: stolen staff credentials, an
over-privileged account, an injection or authorization bug in the API, leaked secrets, and loss of
data. Hoosier Security is a security integrator; customers expect its own systems to meet that bar.

## Authentication

- Staff sign in with **Microsoft Entra ID** using the OIDC authorization-code flow with PKCE, from a
  confidential server-side client ([ADR 0005](adr/0005-entra-sso.md)). There are no local passwords.
- MFA and conditional access are enforced in Entra, not re-implemented here.
- The API issues an opaque session in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; sessions have idle
  and absolute timeouts and are revocable server-side.
- A member must exist in `iam.member` and be active; sign-in alone grants nothing. Deactivating a member
  ends their sessions.
- `AUTH_MODE=dev` (trusts a header) exists only for local development and the API refuses to start with it
  when `NODE_ENV=production`.
- Customer portal authentication (milestone 5) is separate: email-verified one-time links or codes, scoped to
  the contacts of one company. It never shares sessions or code paths with staff authentication.

## Authorization

- Permission keys (`module.resource.action`) are defined in code and synced to `iam.permission`; roles
  group them; members hold roles. Code checks keys, never role names.
- Every API route declares the permission it needs; a route without a declaration fails a unit test.
- "Own" versus "all" scopes (time entries, tickets) are separate keys.
- Defaults live in `packages/shared/src/permissions.ts` and are seeded; changes are made in the admin UI and audited.

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
