import type { Company } from "@hoosier/shared";
import { useEffect, useState } from "react";
import { listCompanies } from "./api";

/** Re-files a ticket under another company (for example mail that landed on the fallback company). */
export function MoveToCompany(props: {
  currentCompanyId: number;
  onMove: (companyId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Company[]>([]);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setFound([]);
      return;
    }
    const c = new AbortController();
    const t = setTimeout(() => {
      listCompanies(query, c.signal)
        .then((r) => setFound(r.items.filter((x) => x.id !== props.currentCompanyId).slice(0, 8)))
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [open, query, props.currentCompanyId]);

  if (!open)
    return (
      <button type="button" className="link" onClick={() => setOpen(true)}>
        Move to another company
      </button>
    );
  return (
    <div className="field-row">
      <input
        className="input"
        placeholder="Search companies"
        aria-label="Search companies to move this ticket to"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <select
        className="input"
        aria-label="Company to move to"
        value=""
        onChange={(e) => {
          if (e.target.value) {
            props.onMove(Number(e.target.value));
            setOpen(false);
            setQuery("");
          }
        }}
      >
        <option value="">{found.length ? "Choose…" : "Type to search"}</option>
        {found.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button type="button" className="btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}
