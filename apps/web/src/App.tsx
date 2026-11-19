import { useEffect, useState } from "react";
import { CompaniesPage } from "./CompaniesPage";
import { type SystemStatus, getSystemStatus } from "./api";

const NAV = [
  { id: "companies", label: "Companies", ready: true },
  { id: "tickets", label: "Service tickets", ready: false },
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

export function App() {
  const [page, setPage] = useState<PageId>("companies");

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
      </nav>
      <div className="content">
        <EnvironmentBanner />
        <main className="main">{page === "companies" && <CompaniesPage />}</main>
      </div>
    </div>
  );
}
