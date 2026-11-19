# 0005. Staff authentication with Microsoft Entra ID

Status: Accepted
Date: 2026-11-19

## Context
Hoosier Security runs Microsoft 365; staff already have identities, MFA and conditional access there, and
the GM and the Operations lead administer the tenant. Local passwords would add a credential store to secure,
reset flows to build, and a second place to deprovision people.

## Decision
Staff sign in with Entra ID using OIDC authorization code with PKCE from a confidential server-side client.
The `oid` claim is stored in `iam.member.entra_subject` at first sign-in, matched initially by email. A member
must exist and be active; Entra proves identity, the PSA database decides permissions. MFA and conditional access
are Entra's responsibility. The API holds an opaque, revocable server-side session in a secure cookie.

## Consequences
- No passwords in the PSA database; offboarding in Entra plus deactivating the member ends access.
- Requires an app registration (redirect URIs, client secret rotation) and a documented runbook.
- Customers and any non-tenant users cannot use this path; the portal gets its own mechanism.
- Until implemented (milestone 1) the API supports a development-only header, refused in production.

## Alternatives considered
- **Local accounts with passwords + TOTP.** More code, more risk, weaker than the tenant's existing controls.
- **Cloudflare Access as the only gate.** Valuable defence in depth (kept), but it does not map users to PSA permissions or audit actions.
