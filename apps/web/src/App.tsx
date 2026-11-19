import { useState } from "react";
import { CompaniesPage } from "./CompaniesPage";

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
      <main className="main">{page === "companies" && <CompaniesPage />}</main>
    </div>
  );
}
