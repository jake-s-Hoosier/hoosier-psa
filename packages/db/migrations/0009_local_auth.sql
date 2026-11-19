-- 0009_local_auth
-- Staff sign in with a local password plus a TOTP second factor (docs/adr/0010-local-authentication.md).
-- Hoosier Security does not use Microsoft Entra, so the OIDC column from 0002 is removed.
--
-- Credentials live in their own table, deliberately WITHOUT the audit trigger: sys.audit_log stores old
-- and new row values, and password hashes and MFA secrets must never be copied into it. Security-relevant
-- events are recorded separately in iam.auth_event (no secrets in it).

ALTER TABLE iam.member DROP COLUMN entra_subject;

CREATE TABLE iam.member_credential (
  member_id           bigint PRIMARY KEY REFERENCES iam.member (id) ON DELETE CASCADE,
  password_hash       text NOT NULL,                    -- scrypt$N$r$p$salt$hash
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  must_change_password boolean NOT NULL DEFAULT true,   -- true after an admin sets or resets the password
  mfa_secret_enc      text,                             -- AES-256-GCM, key derived from AUTH_SECRET
  mfa_enabled_at      timestamptz,                      -- null until the first code is confirmed
  mfa_last_counter    bigint NOT NULL DEFAULT 0,        -- last accepted TOTP step; stops code replay
  session_epoch       integer NOT NULL DEFAULT 0,       -- bump to sign the member out everywhere
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (mfa_enabled_at IS NULL OR mfa_secret_enc IS NOT NULL)
);
SELECT sys.attach_standard_triggers('iam.member_credential', false);

CREATE TABLE iam.recovery_code (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES iam.member (id) ON DELETE CASCADE,
  code_hash text NOT NULL,                              -- sha256 hex of the normalised code
  used_at   timestamptz,
  UNIQUE (member_id, code_hash)
);

CREATE TABLE iam.auth_event (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id  bigint REFERENCES iam.member (id) ON DELETE SET NULL,
  kind       text NOT NULL CHECK (kind IN (
    'login_ok', 'login_failed', 'mfa_ok', 'mfa_failed', 'recovery_code_used', 'password_changed',
    'mfa_enrolled', 'password_set_by_admin', 'mfa_reset_by_admin')),
  ip         text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_event_member_idx ON iam.auth_event (member_id, created_at DESC);
