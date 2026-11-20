# Changelog

All notable changes are recorded here. Format follows Keep a Changelog; versions follow milestones until
the first production release.

## [Unreleased]

### Added
- Connected records. Every record has an address (`#/companies/12`, `#/tickets/55`, `#/tickets?contactId=7`), so any
  screen can link to any other. New **company page**: alerts, activity stats, contacts and sites (add, edit, remove),
  the company's tickets, recent time and notes, with "New ticket" prefilled from the company, a site or a contact.
  Tickets now show and link to their company, site and contact; the ticket list can be narrowed to a site or contact.
  Company create/edit, site and contact CRUD, company notes (including alerts) and `/companies/:id/overview` in the API;
  tickets and time entries can be filtered by company, site and contact.
- Inbound email to tickets through Microsoft 365 ([ADR 0012](docs/adr/0012-microsoft-365-mail.md), migration 0011):
  Graph reader (`Mail.Read`, polled, read-only), processor that opens tickets for known contacts, adds replies to the
  ticket named in the subject or threaded by `In-Reply-To`/`References` (only from a known contact of that company or staff),
  sends unknown or ambiguous senders to a fallback company, ignores automatic mail and our own mailboxes, stores attachments,
  and is safe to repeat. New **Email** screen (mailboxes, message log), `/api/v1/mailboxes`, permission `service.mailbox.manage`,
  "Move to another company" on tickets (`PATCH companyId`; site and contact must belong to the ticket's company).
  `MAIL_POLL_ENABLED` and `GRAPH_*` settings, off by default and refused in the shadow.
- Role administration: **Access** screen and `/api/v1/admin/*` (needs `iam.manage`): list roles with effective
  grants, create custom roles, edit any role's permissions, reset a built-in role to its defaults, delete
  unused custom roles, set each member's roles, deactivate or reactivate members (signs them out). A change that
  would leave nobody able to manage roles is refused. Migration 0010 audits role grants, role membership and
  ticket resources (composite-key tables) with the acting member.
- Ticket resources (add and remove people on a ticket) and file attachments (upload up to 25 MB, list, download as
  attachment only, remove; [ADR 0011](docs/adr/0011-attachments-in-postgres.md), migration 0010). Lookups now include active members.
- Permission enforcement: every `/api/v1` route declares the permission it needs and is refused without it
  (deny by default, proven by a route-table test). Permissions are the union of a member's roles, using
  stored `iam.role_permission` rows when present and the code defaults otherwise. Own versus all scoping for
  time entries, approval needs `timekeeping.time.approve` and never your own time, `/auth/me` returns the
  member's permissions, and the web app hides navigation and actions they cannot use. The API syncs the
  permission catalogue at startup (writable environments only); the admin CLI gained `grant-role`,
  `revoke-role` (never the last Administrator), `sync-permissions` and roles in `status`.
- Staff sign-in without Entra (ADR 0010, supersedes 0005; migration 0009): local password (scrypt) plus
  authenticator-app code, recovery codes, forced first-login password change and MFA enrolment, signed
  session cookies re-checked against the database each request, CSRF header, sign-in throttling, admin CLI
  (`pnpm auth set-password | reset-mfa | status`), login screens in the web app. Credentials sit in an
  unaudited table so secrets never reach the audit log. `AUTH_MODE` is now `dev` or `session`;
  `AUTH_SECRET` replaces the unused Entra settings. Signing in works in read-only environments.
- Web: service tickets page (search, state and board filters, create, status and priority changes, notes,
  start timer, log time) and a running-timer bar on every page. API: read-only `/api/v1/lookups` for form
  reference data.
- Importer now brings over sites, contacts (with normalised phone and email channels), company default
  contacts and sites, work roles and types, CW board statuses with closed flags, priorities with colours,
  ticket notes and ticket-to-contact links. Report summaries count high-volume problems instead of
  listing each one. Shared `toE164` / `phoneExtension` helpers.
- Migration 0008 (work type pricing): rate type (multiplier, custom, adjustment), bill time
  (billable, do not bill, no charge), minimum and maximum billable hours, optional rounding increment.
  Time entries price from these rules; replaces `is_billable_default`.
- Timesheets and payroll: submit, recall and approve by date range; pay period generation (semi-monthly),
  lock (blocked while any time is unsubmitted; stamps and freezes entries) and export (JSON and CSV in
  decimal and h:mm, with weekly overtime across periods and paid leave). Payroll math lives in
  `packages/shared/src/payroll.ts`.
- CW import tool (`packages/importer`): read-only mirror access, transactional dry-run, id-preserving
  idempotent upserts for members, companies, ticket lookups, tickets and time entries, exception report
  and reconciliation counts. Documented mirror gaps in docs/11.
- Tickets API (`/api/v1/tickets`): list with filters, create with board defaults, update with
  status-on-board validation and close/reopen stamping, notes, first-response tracking.
- Time API (`/api/v1/time-entries`): one-per-member timer, manual entries by hours or range, rate and
  cost snapshots, billing rounding from exact duration, locked pay period refusal, void instead of delete.
  Rounding default (15 min, up) is a placeholder pending the billing decisions in docs/05.
- Write safety: environment marker table (migration 0007) with one-way go-live approval, refusal to
  target `cw_datawarehouse`, read-only database connections by default (`DB_WRITE_MODE`), API read-only
  guard, `/api/v1/system/status` and an environment banner in the web UI. See docs/12 and ADR 0009.
- Milestone 0 foundation: pnpm TypeScript monorepo, Biome, Vitest, GitHub Actions CI.
- PostgreSQL migrations 0001-0006: foundation (audit, triggers), `iam`, `catalog`, `crm`, `service`,
  `timekeeping`; checksummed migration runner with advisory locking.
- Shared business rules: money and rounding, billing rounding, semi-monthly pay periods,
  Sunday-Saturday workweeks, overtime allocation across periods, permission keys, API contracts.
- API skeleton: health endpoints, companies resource, problem+json errors, validation, dev-only auth.
- Web shell with design tokens and a companies list.
- Documentation set (vision, parity matrix, architecture, domain model, time and payroll, billing,
  accounting, roadmap, security, design system, payments, migration) and ADRs 0001-0008.
