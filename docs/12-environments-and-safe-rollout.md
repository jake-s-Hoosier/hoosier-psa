# 12. Environments and safe rollout

Principle: **nothing in Hoosier PSA writes to a production table until we deliberately decide to go
live, and nothing ever writes to `cw_datawarehouse`.** Decision record: ADR 0009.

## Environments

| Environment | Database | Data | App writes | Purpose |
|---|---|---|---|---|
| development | `hoosier_psa_dev` | synthetic | yes (opt-in) | building features |
| test | throwaway per run | synthetic | yes | automated tests, CI |
| uat | `hoosier_psa_uat` | synthetic or scrubbed copy | yes (opt-in) | staff acceptance testing |
| shadow | `hoosier_psa_shadow` | nightly import of CW data | never (import tool only) | parallel-run reconciliation |
| production | `hoosier_psa` | **does not exist until cutover** | locked until go-live approval | live operation |

`cw_datawarehouse` is not an environment of ours: it is the ETL's database and is only ever read
(by the importer, using a read-only role).

## Layered safeguards

1. Separate databases; production is not created before cutover.
2. `sys.environment` marker per database; the app and CLI refuse an `APP_ENV` mismatch.
3. Denylist: `cw_datawarehouse`, `postgres`, `template0`, `template1` are refused as targets.
4. Read-only connections by default (`default_transaction_read_only=on`).
5. API returns 403 for any non-GET request while `DB_WRITE_MODE=read_only`.
6. Production write-lock until `approve-go-live` (one-way, recorded with who and when).
7. `INTEGRATIONS_ENABLED` (QuickBooks export, payments, customer email) only in production.
8. UI banner shows the environment and read-only state on every screen.
9. Operational: the application's database role has no grants on `cw_datawarehouse`; the importer's
   role is read-only there.

## Testing phases

1. **Build and automated tests** (development/test): every change passes lint, build, typecheck and
   tests in CI.
2. **UAT**: staff exercise real workflows (tickets, time entry, agreements) on synthetic data.
   Defects are logged and fixed; each milestone needs a signed-off UAT script.
3. **Shadow / parallel run**: CW data is imported nightly into shadow. Reports are compared against
   CW (time hours, pay periods, overtime, invoices, RMR). Differences are investigated until
   explained or fixed. Minimum: at least two complete semi-monthly payroll cycles and one full
   billing month reconcile with zero unexplained variances.
4. **Dress rehearsal**: full cutover procedure (docs/11) executed against a fresh database, timed,
   with rollback exercised.
5. **Go-live gate**, then cutover.

## Go-live gate checklist

All items must be checked before `approve-go-live production --go-live-checklist-complete`:

- [ ] UAT scripts for every in-scope milestone signed off
- [ ] Payroll, invoicing and RMR reconciliations meet the thresholds above
- [ ] Backups and a restore test completed for the production database
- [ ] Rollback plan reviewed; ConnectWise remains available for the agreed fallback window
- [ ] QuickBooks and payment integrations verified in sandbox; credentials stored securely
- [ ] Microsoft Entra sign-in enabled and `AUTH_MODE=dev` removed
- [ ] Staff trained; cutover date and freeze window communicated
- [ ] Final sign-off by the General Manager

## Commands

```bash
APP_ENV=uat DATABASE_URL=... pnpm db:migrate              # migrate and stamp marker
APP_ENV=production DATABASE_URL=... pnpm db:status         # always allowed
APP_ENV=production DATABASE_URL=... pnpm --filter @hoosier/db exec \
  node dist/cli.js approve-go-live production \
  --confirm-production --go-live-checklist-complete        # the only way to unlock production
```

Production commands other than `status` require `--confirm-production`.
