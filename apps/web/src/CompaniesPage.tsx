import type { Company } from "@hoosier/shared";
import { useEffect, useState } from "react";
import { listCompanies } from "./api";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; items: Company[]; total: number };

export function CompaniesPage() {
  const [query, setQuery] = useState("");
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ state: "loading" });
    // Debounce typing so we do not query on every keystroke.
    const timer = setTimeout(() => {
      listCompanies(query, controller.signal)
        .then((r) => setLoad({ state: "ready", items: r.items, total: r.total }))
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setLoad({
            state: "error",
            message: err instanceof Error ? err.message : "Request failed",
          });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return (
    <>
      <div className="page-header">
        <h2>Companies</h2>
        {load.state === "ready" && <span className="muted">{load.total} total</span>}
      </div>
      <div className="card">
        <div className="toolbar">
          <input
            className="input"
            type="search"
            placeholder="Search by name or ID"
            aria-label="Search companies"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {load.state === "loading" && <div className="state">Loading…</div>}
        {load.state === "error" && (
          <div className="state error">Could not load companies: {load.message}</div>
        )}
        {load.state === "ready" && load.items.length === 0 && (
          <div className="state">No companies match.</div>
        )}
        {load.state === "ready" && load.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Status</th>
                <th>Territory</th>
                <th>Phone</th>
              </tr>
            </thead>
            <tbody>
              {load.items.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.identifier}</td>
                  <td>{c.name}</td>
                  <td>
                    <span className="badge">{c.status}</span>
                  </td>
                  <td className="muted">{c.territory ?? "—"}</td>
                  <td className="muted">{c.phone ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
