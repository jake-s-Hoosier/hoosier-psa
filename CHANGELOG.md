# Changelog

All notable changes are recorded here. Format follows Keep a Changelog; versions follow milestones until
the first production release.

## [Unreleased]

### Added
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
