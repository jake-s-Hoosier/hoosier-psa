import type {
  CompanyNote,
  CompanyOverview,
  Contact,
  ContactChannelInput,
  Site,
  Ticket,
  TimeEntry,
} from "@hoosier/shared";
import { useCallback, useEffect, useState } from "react";
import { CompanyAgreements } from "./AgreementsPage";
import { NewTicketDialog } from "./TicketsPage";
import {
  type Lookups,
  addCompanyNote,
  createContact,
  createSite,
  deleteContact,
  deleteSite,
  getCompanyOverview,
  listCompanyNotes,
  listCompanyTime,
  listTickets,
  updateCompany,
  updateContact,
  updateSite,
} from "./api";
import { addressLine, fullName, hours, msg, shortDate } from "./common";
import { Link, navigate } from "./router";

export function CompanyPage({
  id,
  can,
  lookups,
}: {
  id: number;
  can: (key: string) => boolean;
  lookups: Lookups | null;
}) {
  const [data, setData] = useState<CompanyOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [editingCompany, setEditingCompany] = useState(false);
  const [siteDialog, setSiteDialog] = useState<Site | "new" | null>(null);
  const [contactDialog, setContactDialog] = useState<Contact | "new" | null>(null);
  const [ticketDialog, setTicketDialog] = useState<{ siteId?: number; contactId?: number } | null>(
    null,
  );
  const refresh = () => setReload((n) => n + 1);
  const canWrite = can("crm.company.write");

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    getCompanyOverview(id, controller.signal)
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(msg(e));
      });
    return () => controller.abort();
  }, [id, reload]);

  if (error) return <div className="state error">Could not load this company: {error}</div>;
  if (!data) return <div className="state">Loading…</div>;
  const { company, sites, contacts, alerts, stats } = data;

  return (
    <>
      <a className="link back" href="#/companies">
        ← All companies
      </a>
      <div className="page-header">
        <h2>{company.name}</h2>
        <span className="mono muted">{company.identifier}</span>
        <span className="badge">{company.status}</span>
        {company.isLead && <span className="badge">Lead</span>}
        {company.isVendor && <span className="badge">Vendor</span>}
        {canWrite && (
          <button type="button" className="btn" onClick={() => setEditingCompany(true)}>
            Edit
          </button>
        )}
        {can("service.ticket.write") && (
          <button type="button" className="btn primary" onClick={() => setTicketDialog({})}>
            New ticket
          </button>
        )}
      </div>
      <div className="muted section">
        {[company.phone, company.website, company.territory].filter(Boolean).join(" · ") ||
          "No phone or website on file"}
      </div>

      {alerts.length > 0 && (
        <div className="alert-banner" role="alert">
          <strong>Alerts</strong>
          {alerts.map((a) => (
            <p key={a.id}>{a.body}</p>
          ))}
        </div>
      )}

      <div className="stats">
        <div className="stat">
          <strong>
            <Link to={`/tickets?companyId=${company.id}`}>{stats.openTickets}</Link>
          </strong>
          <span>Open tickets</span>
        </div>
        <div className="stat">
          <strong>{stats.ticketsLast90Days}</strong>
          <span>Tickets, last 90 days</span>
        </div>
        <div className="stat">
          <strong>{hours(stats.hoursLast30Days)}</strong>
          <span>Time, last 30 days</span>
        </div>
        <div className="stat">
          <strong>{shortDate(stats.lastActivityAt)}</strong>
          <span>Last ticket activity</span>
        </div>
      </div>

      <div className="two-col section">
        <div className="card card-pad">
          <div className="section-head">
            <h3>Contacts ({contacts.length})</h3>
            {canWrite && (
              <button type="button" className="btn" onClick={() => setContactDialog("new")}>
                Add contact
              </button>
            )}
          </div>
          {contacts.length === 0 && <div className="muted">No contacts yet.</div>}
          {contacts.map((c) => (
            <div key={c.id} className={`site-card ${c.isInactive ? "inactive" : ""}`}>
              <strong>{fullName(c)}</strong>
              {c.isInactive && <span className="badge">Inactive</span>}
              <div className="muted">{[c.title, c.site].filter(Boolean).join(" · ")}</div>
              {c.channels.map((ch) => (
                <div key={`${ch.kind}-${ch.value}`}>
                  <span className="muted">{ch.kind}: </span>
                  {ch.kind === "email" ? (
                    <a className="link" href={`mailto:${ch.value}`}>
                      {ch.value}
                    </a>
                  ) : (
                    <>
                      {ch.value}
                      {ch.extension ? ` x${ch.extension}` : ""}
                    </>
                  )}
                </div>
              ))}
              <div className="chips">
                <Link to={`/tickets?companyId=${company.id}&contactId=${c.id}`}>Tickets</Link>
                {can("service.ticket.write") && (
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      setTicketDialog({ contactId: c.id, siteId: c.siteId ?? undefined })
                    }
                  >
                    New ticket
                  </button>
                )}
                {canWrite && (
                  <button type="button" className="link" onClick={() => setContactDialog(c)}>
                    Edit
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="card card-pad">
          <div className="section-head">
            <h3>Sites ({sites.length})</h3>
            {canWrite && (
              <button type="button" className="btn" onClick={() => setSiteDialog("new")}>
                Add site
              </button>
            )}
          </div>
          {sites.length === 0 && <div className="muted">No sites yet.</div>}
          {sites.map((s) => (
            <div key={s.id} className="site-card">
              <strong>{s.name}</strong>
              {s.isDefaultService && <span className="badge">Default service</span>}
              {s.isBilling && <span className="badge">Billing</span>}
              <div className="muted">{addressLine(s) || "No address"}</div>
              {s.accessNotes && <div>Access: {s.accessNotes}</div>}
              <div className="chips">
                <Link to={`/tickets?companyId=${company.id}&siteId=${s.id}`}>Tickets</Link>
                {can("service.ticket.write") && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => setTicketDialog({ siteId: s.id })}
                  >
                    New ticket
                  </button>
                )}
                {canWrite && (
                  <button type="button" className="link" onClick={() => setSiteDialog(s)}>
                    Edit
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {can("billing.agreement.read") && (
        <CompanyAgreements
          companyId={company.id}
          canWrite={can("billing.agreement.write")}
          lookups={lookups}
        />
      )}
      <CompanyTickets companyId={company.id} reload={reload} />
      <div className="two-col section">
        <CompanyTime companyId={company.id} lookups={lookups} reload={reload} />
        <CompanyNotes
          companyId={company.id}
          contacts={contacts}
          canWrite={canWrite}
          onChanged={refresh}
        />
      </div>

      {editingCompany && lookups && (
        <EditCompanyDialog
          data={data}
          lookups={lookups}
          onClose={() => setEditingCompany(false)}
          onSaved={() => {
            setEditingCompany(false);
            refresh();
          }}
        />
      )}
      {siteDialog && (
        <SiteDialog
          companyId={company.id}
          site={siteDialog === "new" ? null : siteDialog}
          onClose={() => setSiteDialog(null)}
          onSaved={() => {
            setSiteDialog(null);
            refresh();
          }}
        />
      )}
      {contactDialog && (
        <ContactDialog
          companyId={company.id}
          contact={contactDialog === "new" ? null : contactDialog}
          sites={sites}
          onClose={() => setContactDialog(null)}
          onSaved={() => {
            setContactDialog(null);
            refresh();
          }}
        />
      )}
      {ticketDialog && lookups && (
        <NewTicketDialog
          lookups={lookups}
          initial={{ companyId: company.id, companyName: company.name, ...ticketDialog }}
          onClose={() => setTicketDialog(null)}
          onCreated={(t) => navigate(`/tickets/${t.id}`)}
        />
      )}
    </>
  );
}

// ---- tickets ------------------------------------------------------------------------------------

function CompanyTickets({ companyId, reload }: { companyId: number; reload: number }) {
  const [state, setState] = useState<"open" | "all">("open");
  const [items, setItems] = useState<Ticket[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const controller = new AbortController();
    listTickets({ q: "", state, companyId }, controller.signal)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
    return () => controller.abort();
  }, [companyId, state, reload]);
  return (
    <div className="card card-pad section">
      <div className="section-head">
        <h3>Tickets</h3>
        <select
          className="input"
          aria-label="Ticket state"
          value={state}
          onChange={(e) => setState(e.target.value as "open" | "all")}
        >
          <option value="open">Open</option>
          <option value="all">All</option>
        </select>
      </div>
      {items === null && <div className="muted">Loading…</div>}
      {items?.length === 0 && <div className="muted">No tickets.</div>}
      {items && items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Summary</th>
              <th>Site</th>
              <th>Contact</th>
              <th>Status</th>
              <th>Priority</th>
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.id}</td>
                <td>
                  <Link to={`/tickets/${t.id}`}>{t.summary}</Link>
                </td>
                <td className="muted">{t.site ?? "—"}</td>
                <td className="muted">{t.contact ?? "—"}</td>
                <td>
                  <span className="badge">{t.status}</span>
                </td>
                <td className="muted">{t.priority}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---- time ---------------------------------------------------------------------------------------

function CompanyTime({
  companyId,
  lookups,
  reload,
}: { companyId: number; lookups: Lookups | null; reload: number }) {
  const [items, setItems] = useState<TimeEntry[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const controller = new AbortController();
    listCompanyTime(companyId, controller.signal)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
    return () => controller.abort();
  }, [companyId, reload]);
  const who = (id: number) => lookups?.members.find((m) => m.id === id)?.name ?? `Member ${id}`;
  return (
    <div className="card card-pad">
      <div className="section-head">
        <h3>Recent time</h3>
      </div>
      {items === null && <div className="muted">Loading…</div>}
      {items?.length === 0 && <div className="muted">No time recorded that you can see.</div>}
      {items && items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Who</th>
              <th>Ticket</th>
              <th>Hours</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td className="muted">{e.workDate}</td>
                <td>{who(e.memberId)}</td>
                <td>
                  {e.ticketId ? <Link to={`/tickets/${e.ticketId}`}>#{e.ticketId}</Link> : "—"}
                </td>
                <td>{hours(e.actualHours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---- notes --------------------------------------------------------------------------------------

function CompanyNotes(props: {
  companyId: number;
  contacts: Contact[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<CompanyNote[] | null>(null);
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<"note" | "call" | "meeting" | "alert">("note");
  const [contactId, setContactId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    listCompanyNotes(props.companyId)
      .then((r) => setItems(r.items))
      .catch((e) => setError(msg(e)));
  }, [props.companyId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: load is stable per company
  useEffect(() => load(), [props.companyId]);
  const add = async () => {
    setError(null);
    try {
      await addCompanyNote(props.companyId, {
        kind,
        body,
        contactId: contactId ?? undefined,
      });
      setBody("");
      load();
      props.onChanged();
    } catch (e) {
      setError(msg(e));
    }
  };
  return (
    <div className="card card-pad">
      <div className="section-head">
        <h3>Notes</h3>
      </div>
      {error && <div className="state error">{error}</div>}
      {items?.length === 0 && <div className="muted">No notes yet.</div>}
      {items?.map((n) => (
        <div key={n.id} className="site-card">
          <div className="muted">
            {shortDate(n.createdAt)} · {n.author ?? "Unknown"} · {n.kind}
            {n.contact ? ` · re: ${n.contact}` : ""}
          </div>
          <div>{n.body}</div>
        </div>
      ))}
      {props.canWrite && (
        <>
          <div className="field-row">
            <label>
              Type
              <select
                className="input"
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="note">Note</option>
                <option value="call">Call</option>
                <option value="meeting">Meeting</option>
                <option value="alert">Alert (shows at the top of this page)</option>
              </select>
            </label>
            <label>
              About
              <select
                className="input"
                value={contactId ?? ""}
                onChange={(e) => setContactId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">The company</option>
                {props.contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {fullName(c)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea
            className="input"
            rows={3}
            aria-label="Note text"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="field-row end">
            <button type="button" className="btn primary" disabled={!body.trim()} onClick={add}>
              Add note
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- dialogs ------------------------------------------------------------------------------------

function EditCompanyDialog(props: {
  data: CompanyOverview;
  lookups: Lookups;
  onClose: () => void;
  onSaved: () => void;
}) {
  const c = props.data.company;
  const [name, setName] = useState(c.name);
  const [phone, setPhone] = useState(c.phone ?? "");
  const [website, setWebsite] = useState(c.website ?? "");
  const [statusId, setStatusId] = useState(
    props.lookups.companyStatuses.find((s) => s.name === c.status)?.id ?? 0,
  );
  const [territoryId, setTerritoryId] = useState<number | null>(
    props.lookups.territories.find((t) => t.name === c.territory)?.id ?? null,
  );
  const [isLead, setIsLead] = useState(c.isLead);
  const [isVendor, setIsVendor] = useState(c.isVendor);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await updateCompany(c.id, {
        name,
        statusId,
        territoryId,
        phone: phone.trim() || null,
        website: website.trim() || null,
        isLead,
        isVendor,
      });
      props.onSaved();
    } catch (e) {
      setError(msg(e));
    }
  };
  return (
    <dialog open className="dialog" aria-label="Edit company">
      <h3>Edit company</h3>
      {error && <div className="state error">{error}</div>}
      <label>
        Name
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field-row">
        <label>
          Status
          <select
            className="input"
            value={statusId}
            onChange={(e) => setStatusId(Number(e.target.value))}
          >
            {props.lookups.companyStatuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Territory
          <select
            className="input"
            value={territoryId ?? ""}
            onChange={(e) => setTerritoryId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">None</option>
            {props.lookups.territories.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="field-row">
        <label>
          Phone
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label>
          Website
          <input className="input" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </label>
      </div>
      <div className="check-row">
        <input
          id="co-lead"
          type="checkbox"
          checked={isLead}
          onChange={(e) => setIsLead(e.target.checked)}
        />
        <label htmlFor="co-lead">Lead (not yet a customer)</label>
      </div>
      <div className="check-row">
        <input
          id="co-vendor"
          type="checkbox"
          checked={isVendor}
          onChange={(e) => setIsVendor(e.target.checked)}
        />
        <label htmlFor="co-vendor">Vendor</label>
      </div>
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!name.trim()} onClick={save}>
          Save
        </button>
      </div>
    </dialog>
  );
}

function SiteDialog(props: {
  companyId: number;
  site: Site | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const s = props.site;
  const [f, setF] = useState({
    name: s?.name ?? "",
    addressLine1: s?.addressLine1 ?? "",
    addressLine2: s?.addressLine2 ?? "",
    city: s?.city ?? "",
    state: s?.state ?? "IN",
    postalCode: s?.postalCode ?? "",
    phone: s?.phone ?? "",
    accessNotes: s?.accessNotes ?? "",
    isDefaultService: s?.isDefaultService ?? false,
    isBilling: s?.isBilling ?? false,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string | boolean) => setF((p) => ({ ...p, [k]: v }));
  const text = (v: string) => v.trim() || null;
  const save = async () => {
    const body = {
      name: f.name,
      addressLine1: text(f.addressLine1),
      addressLine2: text(f.addressLine2),
      city: text(f.city),
      state: text(f.state),
      postalCode: text(f.postalCode),
      phone: text(f.phone),
      accessNotes: text(f.accessNotes),
      isDefaultService: f.isDefaultService,
      isBilling: f.isBilling,
    };
    try {
      if (s) await updateSite(props.companyId, s.id, body);
      else await createSite(props.companyId, body);
      props.onSaved();
    } catch (e) {
      setError(msg(e));
    }
  };
  const remove = async () => {
    if (!s || !window.confirm(`Remove the site "${s.name}"? Its history stays on past tickets.`))
      return;
    try {
      await deleteSite(props.companyId, s.id);
      props.onSaved();
    } catch (e) {
      setError(msg(e));
    }
  };
  return (
    <dialog open className="dialog wide" aria-label={s ? "Edit site" : "New site"}>
      <h3>{s ? "Edit site" : "New site"}</h3>
      {error && <div className="state error">{error}</div>}
      <label>
        Site name
        <input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} />
      </label>
      <label>
        Address
        <input
          className="input"
          value={f.addressLine1}
          onChange={(e) => set("addressLine1", e.target.value)}
        />
      </label>
      <label>
        Address line 2
        <input
          className="input"
          value={f.addressLine2}
          onChange={(e) => set("addressLine2", e.target.value)}
        />
      </label>
      <div className="field-grid">
        <label>
          City
          <input className="input" value={f.city} onChange={(e) => set("city", e.target.value)} />
        </label>
        <label>
          State
          <input className="input" value={f.state} onChange={(e) => set("state", e.target.value)} />
        </label>
        <label>
          Postal code
          <input
            className="input"
            value={f.postalCode}
            onChange={(e) => set("postalCode", e.target.value)}
          />
        </label>
        <label>
          Phone
          <input className="input" value={f.phone} onChange={(e) => set("phone", e.target.value)} />
        </label>
      </div>
      <label>
        Access notes (gate codes, check-in rules; technicians see these)
        <textarea
          className="input"
          rows={3}
          value={f.accessNotes}
          onChange={(e) => set("accessNotes", e.target.value)}
        />
      </label>
      <div className="check-row">
        <input
          id="site-default"
          type="checkbox"
          checked={f.isDefaultService}
          onChange={(e) => set("isDefaultService", e.target.checked)}
        />
        <label htmlFor="site-default">Default service location</label>
      </div>
      <div className="check-row">
        <input
          id="site-billing"
          type="checkbox"
          checked={f.isBilling}
          onChange={(e) => set("isBilling", e.target.checked)}
        />
        <label htmlFor="site-billing">Billing address</label>
      </div>
      <div className="field-row end">
        {s && (
          <button type="button" className="btn" onClick={remove}>
            Remove site
          </button>
        )}
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!f.name.trim()} onClick={save}>
          Save
        </button>
      </div>
    </dialog>
  );
}

const MAIN_KINDS = ["email", "mobile", "office"] as const;

function ContactDialog(props: {
  companyId: number;
  contact: Contact | null;
  sites: Site[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const c = props.contact;
  const first = (kind: string) => c?.channels.find((ch) => ch.kind === kind);
  const [f, setF] = useState({
    firstName: c?.firstName ?? "",
    lastName: c?.lastName ?? "",
    title: c?.title ?? "",
    department: c?.department ?? "",
    notes: c?.notes ?? "",
    siteId: c?.siteId ?? null,
    isInactive: c?.isInactive ?? false,
    email: first("email")?.value ?? "",
    mobile: first("mobile")?.value ?? "",
    office: first("office")?.value ?? "",
    officeExt: first("office")?.extension ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string | boolean | number | null) =>
    setF((p) => ({ ...p, [k]: v }));
  const text = (v: string) => v.trim() || null;

  const save = async () => {
    // Keep any extra numbers and addresses the form does not show (a second email, a fax line, ...).
    const seen = new Set<string>();
    const extras: ContactChannelInput[] = (c?.channels ?? []).filter((ch) => {
      const isMain = (MAIN_KINDS as readonly string[]).includes(ch.kind);
      if (isMain && !seen.has(ch.kind)) {
        seen.add(ch.kind);
        return false;
      }
      return true;
    });
    const channels: ContactChannelInput[] = [
      ...(f.email.trim() ? [{ kind: "email" as const, value: f.email.trim() }] : []),
      ...(f.mobile.trim() ? [{ kind: "mobile" as const, value: f.mobile.trim() }] : []),
      ...(f.office.trim()
        ? [{ kind: "office" as const, value: f.office.trim(), extension: text(f.officeExt) }]
        : []),
      ...extras,
    ];
    const body = {
      firstName: f.firstName,
      lastName: text(f.lastName),
      title: text(f.title),
      department: text(f.department),
      notes: text(f.notes),
      siteId: f.siteId,
      isInactive: f.isInactive,
      channels,
    };
    try {
      if (c) await updateContact(props.companyId, c.id, body);
      else await createContact(props.companyId, body);
      props.onSaved();
    } catch (e) {
      setError(msg(e));
    }
  };
  const remove = async () => {
    if (!c || !window.confirm(`Remove ${fullName(c)}? Past tickets keep their name.`)) return;
    try {
      await deleteContact(props.companyId, c.id);
      props.onSaved();
    } catch (e) {
      setError(msg(e));
    }
  };
  return (
    <dialog open className="dialog wide" aria-label={c ? "Edit contact" : "New contact"}>
      <h3>{c ? "Edit contact" : "New contact"}</h3>
      {error && <div className="state error">{error}</div>}
      <div className="field-grid">
        <label>
          First name
          <input
            className="input"
            value={f.firstName}
            onChange={(e) => set("firstName", e.target.value)}
          />
        </label>
        <label>
          Last name
          <input
            className="input"
            value={f.lastName}
            onChange={(e) => set("lastName", e.target.value)}
          />
        </label>
        <label>
          Title
          <input className="input" value={f.title} onChange={(e) => set("title", e.target.value)} />
        </label>
        <label>
          Department
          <input
            className="input"
            value={f.department}
            onChange={(e) => set("department", e.target.value)}
          />
        </label>
        <label>
          Email
          <input
            className="input"
            type="email"
            value={f.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </label>
        <label>
          Mobile
          <input
            className="input"
            value={f.mobile}
            onChange={(e) => set("mobile", e.target.value)}
          />
        </label>
        <label>
          Office phone
          <input
            className="input"
            value={f.office}
            onChange={(e) => set("office", e.target.value)}
          />
        </label>
        <label>
          Extension
          <input
            className="input"
            value={f.officeExt}
            onChange={(e) => set("officeExt", e.target.value)}
          />
        </label>
      </div>
      <label>
        Works at site
        <select
          className="input"
          value={f.siteId ?? ""}
          onChange={(e) => set("siteId", e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Not tied to one site</option>
          {props.sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Notes
        <textarea
          className="input"
          rows={2}
          value={f.notes}
          onChange={(e) => set("notes", e.target.value)}
        />
      </label>
      <div className="check-row">
        <input
          id="contact-inactive"
          type="checkbox"
          checked={f.isInactive}
          onChange={(e) => set("isInactive", e.target.checked)}
        />
        <label htmlFor="contact-inactive">Inactive (no longer works there)</label>
      </div>
      <div className="field-row end">
        {c && (
          <button type="button" className="btn" onClick={remove}>
            Remove contact
          </button>
        )}
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!f.firstName.trim()} onClick={save}>
          Save
        </button>
      </div>
    </dialog>
  );
}
