# 0010. Staff authentication with local passwords and TOTP

Status: Accepted
Date: 2026-11-19
Supersedes: [0005](0005-entra-sso.md)

## Context
ADR 0005 assumed Microsoft Entra ID single sign-on. Hoosier Security does not use Entra, so the PSA must
authenticate staff itself. The system holds customer site and access information and billing data, so the
bar is a strong password plus a second factor, with nothing secret exposed in logs or the audit trail.

## Decision
Staff sign in with a local password and a TOTP authenticator code (RFC 6238; works with Microsoft
Authenticator, Google Authenticator, 1Password, Authy).

- **Accounts are created by an administrator**, never self-registered: `pnpm auth set-password <identifier>`
  creates or resets a login with a one-time temporary password. The member must already exist and be active.
- **First sign-in** forces a new password (at least 12 characters, not common, not containing the name or
  email) and then authenticator enrolment, which also issues ten single-use recovery codes.
- **Passwords** are hashed with scrypt (per-password salt, parameters stored with the hash). A comparison
  runs even for unknown identifiers so timing does not reveal valid accounts.
- **MFA secrets** are encrypted at rest with AES-256-GCM using a key derived from `AUTH_SECRET`. A used code
  cannot be replayed (the last accepted time step is stored). Recovery codes are stored as SHA-256 hashes.
- **Sessions** are signed, stateless cookies (`HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS) holding the
  member id, a credential epoch and the MFA flag. On every request the API re-reads the member: they must
  be active and the epoch must match. Changing a password, an admin reset, or deactivating the member
  therefore ends other sessions immediately. Idle timeout 2 hours, absolute 12 hours; the half-signed-in
  state lasts 10 minutes.
- **CSRF**: every state-changing request must carry `x-requested-with: hoosier-psa` in addition to
  `SameSite=Lax`.
- **Throttling**: five failed attempts per account (and 30 per address) lock sign-in for 15 minutes, kept in
  memory so it works in read-only environments.
- **Credentials live in `iam.member_credential`, which has no audit trigger**, so hashes and secrets are
  never copied into `sys.audit_log`. Security events (sign-ins, failures, resets) go to `iam.auth_event`.
- **Read-only environments** (shadow, or `DB_WRITE_MODE=read_only`): signing in, including the authenticator
  step, works because it needs no database writes; password changes and enrolment are refused.
  Credentials for shadow are set with the admin CLI, which is the only tool allowed to write them there.

## Consequences
- The PSA now owns a credential store; the hardening above is part of its security surface (docs/08).
- Offboarding means deactivating the member (ends access at the next request).
- No self-service password reset: an administrator resets it, which is acceptable at current headcount.
  If the last administrator loses their authenticator and recovery codes, the CLI on the host recovers access.
- `AUTH_SECRET` must be at least 32 random characters, kept out of the repository; rotating it signs
  everyone out and invalidates enrolled authenticators (members re-enrol after an admin MFA reset).
- Single sign-on can be added later as another way to prove identity without changing permissions.

## Alternatives considered
- **Microsoft Entra ID** (ADR 0005): not available.
- **Google Workspace sign-in**, **email magic links**: not chosen; a self-contained credential store with
  MFA was preferred.
- **Passwords only**: rejected for a system holding customer access details.
