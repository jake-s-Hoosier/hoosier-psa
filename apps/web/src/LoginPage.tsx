import { useEffect, useState } from "react";
import {
  type AuthView,
  authChangePassword,
  authLogin,
  authMfaEnable,
  authMfaSetup,
  authVerifyMfa,
} from "./api";

const msg = (e: unknown) => (e instanceof Error ? e.message : "Request failed");

/**
 * The sign-in sequence: password, then (depending on the account) the authenticator code, a forced
 * password change, or first-time authenticator setup. The server decides the next step; this page only
 * renders the stage it is given.
 */
export function LoginPage({
  initial,
  onSignedIn,
}: {
  initial: AuthView | null;
  onSignedIn: () => void;
}) {
  const [view, setView] = useState<AuthView | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const step = async (fn: () => Promise<AuthView>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      setView(next);
      if (next.stage === "ok" && recoveryCodes === null) onSignedIn();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form
        className="card login-card"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <h1>Hoosier PSA</h1>
        {error && (
          <div className="state error" role="alert">
            {error}
          </div>
        )}
        {recoveryCodes ? (
          <RecoveryCodes codes={recoveryCodes} onDone={onSignedIn} />
        ) : !view ? (
          <PasswordStep busy={busy} onSubmit={(id, pw) => step(() => authLogin(id, pw))} />
        ) : view.stage === "mfa_required" ? (
          <CodeStep
            busy={busy}
            title="Enter your authenticator code"
            hint="Or use one of your recovery codes."
            onSubmit={(code) => step(() => authVerifyMfa(code))}
          />
        ) : view.stage === "password_change" ? (
          <ChangePasswordStep
            busy={busy}
            onSubmit={(cur, next) => step(() => authChangePassword(cur, next))}
          />
        ) : view.stage === "mfa_enroll" ? (
          <EnrolStep
            busy={busy}
            onError={setError}
            onEnabled={(v, codes) => {
              setView(v);
              setRecoveryCodes(codes);
            }}
          />
        ) : null}
      </form>
    </div>
  );
}

function PasswordStep(props: { busy: boolean; onSubmit: (id: string, pw: string) => void }) {
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  return (
    <>
      <label>
        Username or email
        <input
          className="input"
          autoComplete="username"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
      </label>
      <label>
        Password
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </label>
      <button
        type="submit"
        className="btn primary"
        disabled={props.busy || !id || !pw}
        onClick={() => props.onSubmit(id, pw)}
      >
        Sign in
      </button>
    </>
  );
}

function CodeStep(props: {
  busy: boolean;
  title: string;
  hint?: string;
  onSubmit: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  return (
    <>
      <h2>{props.title}</h2>
      {props.hint && <p className="muted">{props.hint}</p>}
      <input
        className="input mono"
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="Code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <button
        type="submit"
        className="btn primary"
        disabled={props.busy || !code.trim()}
        onClick={() => props.onSubmit(code.trim())}
      >
        Continue
      </button>
    </>
  );
}

function ChangePasswordStep(props: {
  busy: boolean;
  onSubmit: (cur: string, next: string) => void;
}) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  return (
    <>
      <h2>Choose a new password</h2>
      <p className="muted">
        Use at least 12 characters. A few random words make a strong, memorable password.
      </p>
      <label>
        Current (temporary) password
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          value={cur}
          onChange={(e) => setCur(e.target.value)}
        />
      </label>
      <label>
        New password
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </label>
      <label>
        New password again
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
      </label>
      {again && next !== again && <div className="error-text">The passwords do not match</div>}
      <button
        type="submit"
        className="btn primary"
        disabled={props.busy || !cur || next.length < 12 || next !== again}
        onClick={() => props.onSubmit(cur, next)}
      >
        Save password
      </button>
    </>
  );
}

function EnrolStep(props: {
  busy: boolean;
  onError: (m: string | null) => void;
  onEnabled: (v: AuthView, codes: string[]) => void;
}) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [working, setWorking] = useState(false);

  const { onError } = props;
  useEffect(() => {
    authMfaSetup()
      .then(setSetup)
      .catch((e) => onError(msg(e)));
  }, [onError]);

  return (
    <>
      <h2>Set up your authenticator app</h2>
      <p className="muted">
        Sign-in needs a second step. In an authenticator app (Microsoft Authenticator, Google
        Authenticator, 1Password, Authy), add an account using this key, then enter the 6-digit code
        it shows.
      </p>
      {setup ? (
        <>
          <div className="mono secret">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</div>
          <a href={setup.otpauthUri} className="muted">
            Open in an authenticator app on this device
          </a>
        </>
      ) : (
        <div className="state">Preparing…</div>
      )}
      <input
        className="input mono"
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="Code from your app"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <button
        type="submit"
        className="btn primary"
        disabled={props.busy || working || !setup || !code.trim()}
        onClick={async () => {
          setWorking(true);
          props.onError(null);
          try {
            const r = await authMfaEnable(code.trim());
            props.onEnabled(r, r.recoveryCodes);
          } catch (e) {
            props.onError(msg(e));
          } finally {
            setWorking(false);
          }
        }}
      >
        Turn on
      </button>
    </>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <>
      <h2>Save your recovery codes</h2>
      <p className="muted">
        Each code works once if you lose your phone. They are shown only now; store them in your
        password manager.
      </p>
      <ul className="recovery mono">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have
        saved these codes
      </label>
      <button type="submit" className="btn primary" disabled={!saved} onClick={onDone}>
        Continue
      </button>
    </>
  );
}
