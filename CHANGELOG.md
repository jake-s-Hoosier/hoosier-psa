# Changelog

All notable changes are recorded here. Format follows Keep a Changelog; versions follow milestones until
the first production release.

## [Unreleased]

### Added
- Milestone 0 foundation: pnpm TypeScript monorepo, Biome, Vitest, GitHub Actions CI.
- PostgreSQL migrations 0001-0006: foundation (audit, triggers), `iam`, `catalog`, `crm`, `service`,
  `timekeeping`; checksummed migration runner with advisory locking.
- Shared business rules: money and rounding, billing rounding, semi-monthly pay periods,
  Sunday-Saturday workweeks, overtime allocation across periods, permission keys, API contracts.
- API skeleton: health endpoints, companies resource, problem+json errors, validation, dev-only auth.
- Web shell with design tokens and a companies list.
- Documentation set (vision, parity matrix, architecture, domain model, time and payroll, billing,
  accounting, roadmap, security, design system, payments, migration) and ADRs 0001-0008.
