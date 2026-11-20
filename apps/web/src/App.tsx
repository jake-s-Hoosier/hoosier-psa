import type { TimeEntry } from "@hoosier/shared";
import { useCallback, useEffect, useState } from "react";
import { AdminPage } from "./AdminPage";
import { AgreementsPage } from "./AgreementsPage";
import { CompaniesPage } from "./CompaniesPage";
import { CompanyPage } from "./CompanyPage";
import { LoginPage } from "./LoginPage";
import { MailPage } from "./MailPage";
import { TicketsPage } from "./TicketsPage";
import { TimePage } from "./TimePage";
import { TimerBar } from "./TimerBar";
import {
  ApiError,
  type AuthView,
  type Lookups,
  type SystemStatus,
  authLogout,
  authMe,
  getLookups,
  getSystemStatus,
  getTimer,
} from "./api";
import { navigate, useRoute } from "./router";

const NAV = [
  { id: "companies", label: "Companies", ready: true, perm: "crm.company.read" },
  { id: "tickets", label: "Service tickets", ready: true, perm: "service.ticket.read" },
  { id: "time", label: "Time", ready: true, perm: "timekeeping.time.read_own" },
  { id: "dispatch", label: "Dispatch", ready: false },
  { id: "projects", label: "Projects", ready: false },
  { id: "agreements", label: "Agreements", ready: true, perm: "billing.agreement.read" },
  { id: "billing", label: "Billing", ready: false },
  { id: "mail", label: "Email", ready: true, perm: "service.mailbox.manage" },
  { id: "admin", label: "Access", ready: true, perm: "iam.manage" },
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
  // In local dev mode there is no sign-in, so the UI cannot know; it shows everything and the API decides.
  const held = me ? new Set(me.permissions) : null;
  const can = (key: string) => held === null || held.has(key);
  const visible = (item: (typeof NAV)[number]) => !("perm" in item) || can(item.perm);
  const firstReady = NAV.find((n) => n.ready && visible(n));
  const route = useRoute();
  const known = NAV.find((n) => n.id === route.page && n.ready && visible(n));
  const page: PageId | undefined = known?.id ?? firstReady?.id;
  const [lookups, setLookups] = useState<Lookups | null>(null);
  useEffect(() => {
    getLookups()
      .then(setLookups)
      .catch(() => {});
  }, []);
  const filters = {
    companyId: Number(route.params.get("companyId")) || undefined,
    siteId: Number(route.params.get("siteId")) || undefined,
    contactId: Number(route.params.get("contactId")) || undefined,
  };
  const [timer, setTimer] = useState<TimeEntry | null>(null);
  const refreshTimer = useCallback(() => {
    getTimer()
      .then((r) => setTimer(r.timer))
      .catch(() => {});
  }, []);
  const canTime = held === null || held.has("timekeeping.time.write_own");
  useEffect(() => {
    if (canTime) refreshTimer();
  }, [refreshTimer, canTime]);

  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <h1>Hoosier PSA</h1>
        {NAV.filter(visible).map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={!item.ready}
            aria-current={page === item.id ? "page" : undefined}
            title={item.ready ? undefined : "Coming in a later milestone"}
            onClick={() => navigate(`/${item.id}`)}
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
          {page === "companies" && can("crm.company.read") && route.id === null && (
            <CompaniesPage canWrite={can("crm.company.write")} />
          )}
          {page === "companies" && can("crm.company.read") && route.id !== null && (
            <CompanyPage key={route.id} id={route.id} can={can} lookups={lookups} />
          )}
          {page === "tickets" && can("service.ticket.read") && (
            <TicketsPage
              onTimerChange={refreshTimer}
              can={can}
              memberId={me?.member.id ?? null}
              routeTicketId={route.id}
              filters={filters}
            />
          )}
          {page === "time" && can("timekeeping.time.read_own") && (
            <TimePage
              can={can}
              lookups={lookups}
              memberId={me?.member.id ?? null}
              onTimerChange={refreshTimer}
            />
          )}
          {page === "agreements" && can("billing.agreement.read") && (
            <AgreementsPage can={can} lookups={lookups} routeId={route.id} />
          )}
          {page === "mail" && can("service.mailbox.manage") && <MailPage />}
          {page === "admin" && can("iam.manage") && <AdminPage />}
          {!firstReady && (
            <div className="state">
              Your account has no access yet. Ask an administrator for a role.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
