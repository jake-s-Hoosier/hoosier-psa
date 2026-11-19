# Changelog

All notable changes are recorded here. Format follows Keep a Changelog; versions follow milestones until
the first production release.

## [Unreleased]

### Added
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
