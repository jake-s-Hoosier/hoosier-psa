import type { TimeEntry } from "@hoosier/shared";
import { useCallback, useEffect, useState } from "react";
import { CompaniesPage } from "./CompaniesPage";
import { LoginPage } from "./LoginPage";
import { TicketsPage } from "./TicketsPage";
import { TimerBar } from "./TimerBar";
import {
  ApiError,
  type AuthView,
  type SystemStatus,
  authLogout,
  authMe,
  getSystemStatus,
  getTimer,
} from "./api";

const NAV = [
  { id: "companies", label: "Companies", ready: true },
  { id: "tickets", label: "Service tickets", ready: true },
  { id: "time", label: "Time", ready: false },
  { id: "dispatch", label: "Dispatch", ready: false },
  { id: "projects", label: "Projects", ready: false },
  { id: "agreements", label: "Agreements", ready: false },
  { id: "billing", label: "Billing", ready: false },
] as const;

type PageId = (typeof NAV)[number]["id"];

const ENV_LABEL: Record<SystemStatus["environment"], string> = {
  development: "DEVELOPMENT: local test data",
  test: "TEST: automated test data",
  uat: "UAT: test data, safe to experiment",
  shadow: "SHADOW: read-only copy of ConnectWise data",
  production: "PRODUCTION",
};

/** Always shows which environment you are in; production is only called out when it is read-only. */
function EnvironmentBanner() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getSystemStatus(controller.signal)
      .then(setStatus)
      .catch(() => {});
    return () => controller.abort();
  }, []);
  if (!status) return null;
  const readOnly = status.writeMode === "read_only";
  if (status.environment === "production" && !readOnly) return null;
  return (
    <output className={`env-banner env-${status.environment}`}>
      <strong>{ENV_LABEL[status.environment]}</strong>
      {readOnly
        ? " · READ-ONLY: changes are disabled"
        : " · changes are saved to this environment only"}
    </output>
  );
}

type Auth =
  | { state: "checking" }
  | { state: "signed_out"; partial: AuthView | null }
  | { state: "in"; me: AuthView | null };

export function App() {
  const [auth, setAuth] = useState<Auth>({ state: "checking" });
  const checkAuth = useCallback(() => {
    authMe()
      .then((me) =>
        setAuth(me.stage === "ok" ? { state: "in", me } : { state: "signed_out", partial: me }),
      )
      .catch((e) => {
        // 404: the API runs with AUTH_MODE=dev (local development), so there is no sign-in screen.
        if (e instanceof ApiError && e.status === 404) setAuth({ state: "in", me: null });
        else setAuth({ state: "signed_out", partial: null });
      });
  }, []);
  useEffect(() => {
    checkAuth();
    const onUnauthorized = () => setAuth({ state: "signed_out", partial: null });
    window.addEventListener("psa:unauthorized", onUnauthorized);
    return () => window.removeEventListener("psa:unauthorized", onUnauthorized);
  }, [checkAuth]);

  if (auth.state === "checking") return <div className="state">Loading…</div>;
  if (auth.state === "signed_out") {
    return (
      <>
        <EnvironmentBanner />
        <LoginPage initial={auth.partial} onSignedIn={checkAuth} />
      </>
    );
  }
  return (
    <Shell
      me={auth.me}
      onSignOut={() => {
        void authLogout().then(() => setAuth({ state: "signed_out", partial: null }));
      }}
    />
  );
}

function Shell({ me, onSignOut }: { me: AuthView | null; onSignOut: () => void }) {
  const [page, setPage] = useState<PageId>("tickets");
  const [timer, setTimer] = useState<TimeEntry | null>(null);
  const refreshTimer = useCallback(() => {
    getTimer()
      .then((r) => setTimer(r.timer))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshTimer();
  }, [refreshTimer]);

  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <h1>Hoosier PSA</h1>
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={!item.ready}
            aria-current={page === item.id ? "page" : undefined}
            title={item.ready ? undefined : "Coming in a later milestone"}
            onClick={() => setPage(item.id)}
          >
            {item.label}
          </button>
        ))}
        {me && (
          <div className="nav-user">
            <span className="muted">
              {me.member.firstName} {me.member.lastName}
            </span>
            <button type="button" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        )}
      </nav>
      <div className="content">
        <EnvironmentBanner />
        {timer && <TimerBar timer={timer} onStopped={refreshTimer} />}
        <main className="main">
          {page === "companies" && <CompaniesPage />}
          {page === "tickets" && <TicketsPage onTimerChange={refreshTimer} />}
        </main>
      </div>
    </div>
  );
}
