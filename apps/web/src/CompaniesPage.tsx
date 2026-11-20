import type { Company } from "@hoosier/shared";
import { useEffect, useState } from "react";
import { type Lookups, createCompany, getLookups, listCompanies } from "./api";
import { msg } from "./common";
import { Link, navigate } from "./router";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; items: Company[]; total: number };

export function CompaniesPage({ canWrite }: { canWrite: boolean }) {
  const [query, setQuery] = useState("");
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ state: "loading" });
    // Debounce typing so we do not query on every keystroke.
    const timer = setTimeout(() => {
      listCompanies(query, controller.signal)
        .then((r) => setLoad({ state: "ready", items: r.items, total: r.total }))
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setLoad({ state: "error", message: msg(err) });
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
        {canWrite && (
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            New company
          </button>
        )}
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
                  <td>
                    <Link to={`/companies/${c.id}`}>{c.name}</Link>
                  </td>
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
      {creating && (
        <NewCompanyDialog
          onClose={() => setCreating(false)}
          onCreated={(c) => navigate(`/companies/${c.id}`)}
        />
      )}
    </>
  );
}

/** Suggests a short ID from the name: first letters, upper-case, trimmed to something readable. */
const suggestId = (name: string) =>
  name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join("")
    .slice(0, 14);

function NewCompanyDialog(props: { onClose: () => void; onCreated: (c: Company) => void }) {
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [name, setName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [statusId, setStatusId] = useState<number | null>(null);
  const [phone, setPhone] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getLookups()
      .then((l) => {
        setLookups(l);
        setStatusId(
          l.companyStatuses.find((s) => s.name === "Active")?.id ??
            l.companyStatuses[0]?.id ??
            null,
        );
      })
      .catch((e) => setError(msg(e)));
  }, []);

  const submit = async () => {
    if (!statusId) return;
    setBusy(true);
    setError(null);
    try {
      props.onCreated(
        await createCompany({
          identifier,
          name,
          statusId,
          phone: phone.trim() || undefined,
          website: website.trim() || undefined,
        }),
      );
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };

  return (
    <dialog open className="dialog" aria-label="New company">
      <h3>New company</h3>
      {error && <div className="state error">{error}</div>}
      <label>
        Name
        <input
          className="input"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!idTouched) setIdentifier(suggestId(e.target.value));
          }}
        />
      </label>
      <label>
        Short ID (used in search and on tickets)
        <input
          className="input"
          value={identifier}
          onChange={(e) => {
            setIdentifier(e.target.value);
            setIdTouched(true);
          }}
        />
      </label>
      <div className="field-row">
        <label>
          Status
          <select
            className="input"
            value={statusId ?? ""}
            onChange={(e) => setStatusId(Number(e.target.value))}
          >
            {lookups?.companyStatuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Phone
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
      </div>
      <label>
        Website
        <input className="input" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </label>
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !name.trim() || !identifier.trim() || !statusId}
          onClick={submit}
        >
          Create company
        </button>
      </div>
    </dialog>
  );
}
