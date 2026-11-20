import type { Agreement, Ticket, TicketNote } from "@hoosier/shared";
import { useCallback, useEffect, useState } from "react";
import { MoveToCompany } from "./MoveToCompany";
import { ChargesSection } from "./TicketCharges";
import { AttachmentsSection, ResourcesSection } from "./TicketFiles";
import {
  type Lookups,
  addNote,
  createTicket,
  getCompanyOverview,
  getLookups,
  getTicket,
  listAgreements,
  listCompanies,
  listNotes,
  listTickets,
  logTime,
  startTimer,
  updateTicket,
} from "./api";
import { msg } from "./common";
import { Link, navigate } from "./router";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; items: Ticket[]; total: number };

const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Indiana/Indianapolis" });

export interface TicketFilters {
  companyId?: number;
  siteId?: number;
  contactId?: number;
}

export function TicketsPage({
  onTimerChange,
  can,
  memberId,
  routeTicketId,
  filters,
}: {
  /** Ticket named in the address (#/tickets/55); the detail panel follows it. */
  routeTicketId: number | null;
  /** Narrowing from another screen (#/tickets?contactId=7), e.g. from a company page. */
  filters: TicketFilters;
  onTimerChange: () => void;
  /** The signed-in member, or null in local dev mode where the API decides who you are. */
  memberId: number | null;
  /** Whether the signed-in member holds a permission; the API enforces it regardless. */
  can: (key: string) => boolean;
}) {
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [boardId, setBoardId] = useState<number | undefined>();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [filterLabel, setFilterLabel] = useState<string | null>(null);
  const filterKey = `${filters.companyId ?? ""}|${filters.siteId ?? ""}|${filters.contactId ?? ""}`;
  const search =
    filterKey === "||"
      ? ""
      : `?${new URLSearchParams(
          Object.entries(filters)
            .filter(([, v]) => v)
            .map(([k, v]) => [k, String(v)]),
        )}`;
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    getLookups()
      .then(setLookups)
      .catch(() => {});
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ state: "loading" });
    const timer = setTimeout(() => {
      listTickets({ q: query, state, boardId, ...filters }, controller.signal)
        .then((r) => setLoad({ state: "ready", items: r.items, total: r.total }))
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setLoad({ state: "error", message: msg(err) });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, state, boardId, reload, filterKey]);

  // The address decides which ticket is open, so links from other screens land on the right one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the address should trigger a fetch
  useEffect(() => {
    if (routeTicketId === null) {
      setSelected(null);
      return;
    }
    if (selected?.id === routeTicketId) return;
    const controller = new AbortController();
    getTicket(routeTicketId, controller.signal)
      .then(setSelected)
      .catch(() => {});
    return () => controller.abort();
  }, [routeTicketId]);

  // Say who the list is narrowed to, with a way back to everything.
  // biome-ignore lint/correctness/useExhaustiveDependencies: filters are covered by filterKey
  useEffect(() => {
    if (filterKey === "||") {
      setFilterLabel(null);
      return;
    }
    if (!filters.companyId) {
      setFilterLabel("one site or contact");
      return;
    }
    getCompanyOverview(filters.companyId)
      .then((o) => {
        const contact = o.contacts.find((c) => c.id === filters.contactId);
        const site = o.sites.find((x) => x.id === filters.siteId);
        setFilterLabel(
          [
            o.company.name,
            site?.name,
            contact && `${contact.firstName} ${contact.lastName ?? ""}`.trim(),
          ]
            .filter(Boolean)
            .join(" · "),
        );
      })
      .catch(() => setFilterLabel("one company"));
  }, [filterKey]);

  const refresh = () => setReload((n) => n + 1);

  return (
    <>
      <div className="page-header">
        <h2>Service tickets</h2>
        {load.state === "ready" && <span className="muted">{load.total} shown</span>}
        {can("service.ticket.write") && (
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            New ticket
          </button>
        )}
      </div>
      {filterLabel && (
        <div className="chips">
          <span className="chip">Showing tickets for {filterLabel}</span>
          <button type="button" className="link" onClick={() => navigate("/tickets")}>
            Show all tickets
          </button>
        </div>
      )}
      <div className="split">
        <div className="card">
          <div className="toolbar">
            <input
              className="input"
              type="search"
              placeholder="Search summary or ticket number"
              aria-label="Search tickets"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              className="input"
              aria-label="State"
              value={state}
              onChange={(e) => setState(e.target.value as typeof state)}
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="all">All</option>
            </select>
            <select
              className="input"
              aria-label="Board"
              value={boardId ?? ""}
              onChange={(e) => setBoardId(e.target.value ? Number(e.target.value) : undefined)}
            >
              <option value="">All boards</option>
              {lookups?.boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          {load.state === "loading" && <div className="state">Loading…</div>}
          {load.state === "error" && (
            <div className="state error">Could not load tickets: {load.message}</div>
          )}
          {load.state === "ready" && load.items.length === 0 && (
            <div className="state">No tickets match.</div>
          )}
          {load.state === "ready" && load.items.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Summary</th>
                  <th>Company</th>
                  <th>Status</th>
                  <th>Priority</th>
                </tr>
              </thead>
              <tbody>
                {load.items.map((t) => (
                  <tr key={t.id} className={selected?.id === t.id ? "selected" : undefined}>
                    <td className="mono">{t.id}</td>
                    <td>
                      <button
                        type="button"
                        className="link"
                        onClick={() => navigate(`/tickets/${t.id}${search}`)}
                      >
                        {t.summary}
                      </button>
                    </td>
                    <td>
                      <Link to={`/companies/${t.companyId}`}>{t.company}</Link>
                    </td>
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
        {selected && lookups && (
          <TicketDetail
            can={can}
            memberId={memberId}
            key={selected.id}
            ticket={selected}
            lookups={lookups}
            onClose={() => navigate(`/tickets${search}`)}
            onChanged={(t) => {
              setSelected(t);
              refresh();
            }}
            onTimerChange={onTimerChange}
          />
        )}
      </div>
      {creating && lookups && (
        <NewTicketDialog
          lookups={lookups}
          onClose={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            refresh();
            navigate(`/tickets/${t.id}${search}`);
          }}
        />
      )}
    </>
  );
}

/** Which agreement covers this ticket. Staff who cannot see agreements still see its name. */
const METHOD_LABEL: Record<Ticket["billingMethod"], string> = {
  actual_rates: "Actual rates",
  fixed_fee: "Fixed fee",
  not_to_exceed: "Not to exceed",
  override_rate: "Override rate",
};
const AMOUNT_LABEL: Record<Ticket["billingMethod"], string> = {
  actual_rates: "",
  fixed_fee: "Fee",
  not_to_exceed: "Cap",
  override_rate: "Hourly rate",
};

/** How time on the ticket is billed. Only people who can edit tickets and see billing change it. */
function BillingField(props: {
  ticket: Ticket;
  canEdit: boolean;
  disabled: boolean;
  onSave: (billingMethod: Ticket["billingMethod"], billingAmount: number | null) => void;
}) {
  const { ticket } = props;
  const [method, setMethod] = useState(ticket.billingMethod);
  const [amount, setAmount] = useState(ticket.billingAmount ?? "");
  useEffect(() => {
    setMethod(ticket.billingMethod);
    setAmount(ticket.billingAmount ?? "");
  }, [ticket.billingMethod, ticket.billingAmount]);
  const changed =
    method !== ticket.billingMethod ||
    (method !== "actual_rates" && Number(amount) !== Number(ticket.billingAmount ?? 0));
  const valid = method === "actual_rates" || Number(amount) > 0;
  if (!props.canEdit)
    return ticket.billingMethod === "actual_rates" ? null : (
      <div className="muted">
        Billed as {METHOD_LABEL[ticket.billingMethod].toLowerCase()}
        {ticket.billingAmount ? ` · $${ticket.billingAmount}` : ""}
      </div>
    );
  return (
    <div className="field-row">
      <label>
        Billing
        <select
          className="input"
          value={method}
          disabled={props.disabled}
          onChange={(e) => setMethod(e.target.value as Ticket["billingMethod"])}
        >
          {(Object.keys(METHOD_LABEL) as Array<Ticket["billingMethod"]>).map((m) => (
            <option key={m} value={m}>
              {METHOD_LABEL[m]}
            </option>
          ))}
        </select>
      </label>
      {method !== "actual_rates" && (
        <label>
          {AMOUNT_LABEL[method]}
          <input
            className="input"
            type="number"
            min="0"
            step="any"
            value={amount}
            disabled={props.disabled}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
      )}
      {changed && (
        <button
          type="button"
          className="btn"
          disabled={props.disabled || !valid}
          onClick={() => props.onSave(method, method === "actual_rates" ? null : Number(amount))}
        >
          Save billing
        </button>
      )}
    </div>
  );
}

function AgreementField(props: {
  ticket: Ticket;
  canRead: boolean;
  canEdit: boolean;
  disabled: boolean;
  onPick: (agreementId: number | null) => void;
}) {
  const { ticket } = props;
  const [options, setOptions] = useState<Agreement[]>([]);
  useEffect(() => {
    if (!props.canRead) return;
    listAgreements({ companyId: ticket.companyId, status: "active" })
      .then((r) => setOptions(r.items))
      .catch(() => setOptions([]));
  }, [props.canRead, ticket.companyId]);
  if (!props.canRead) {
    return ticket.agreement ? <div className="muted">Covered by {ticket.agreement}</div> : null;
  }
  if (options.length === 0 && !ticket.agreementId) return null;
  return (
    <label>
      Agreement
      <select
        className="input"
        value={ticket.agreementId ?? ""}
        disabled={props.disabled || !props.canEdit}
        onChange={(e) => props.onPick(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">None</option>
        {ticket.agreementId && !options.some((o) => o.id === ticket.agreementId) && (
          <option value={ticket.agreementId}>{ticket.agreement}</option>
        )}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      {ticket.agreementId && <Link to={`/agreements/${ticket.agreementId}`}>Open agreement</Link>}
    </label>
  );
}

function TicketDetail(props: {
  can: (key: string) => boolean;
  memberId: number | null;
  ticket: Ticket;
  lookups: Lookups;
  onClose: () => void;
  onChanged: (t: Ticket) => void;
  onTimerChange: () => void;
}) {
  const { ticket, lookups } = props;
  const board = lookups.boards.find((b) => b.id === ticket.boardId);
  const [notes, setNotes] = useState<TicketNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteBody, setNoteBody] = useState("");
  const [noteKind, setNoteKind] = useState("discussion");
  const [roleId, setRoleId] = useState(lookups.workRoles[0]?.id ?? 0);
  const [typeId, setTypeId] = useState(lookups.workTypes[0]?.id ?? 0);
  const [hours, setHours] = useState("");
  const [busy, setBusy] = useState(false);

  const loadNotes = useCallback(() => {
    listNotes(ticket.id)
      .then((r) => setNotes(r.items))
      .catch((e) => setError(msg(e)));
  }, [ticket.id]);
  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="card detail" aria-label={`Ticket ${ticket.id}`}>
      <div className="detail-head">
        <div>
          <div className="mono muted">#{ticket.id}</div>
          <h3>{ticket.summary}</h3>
          <div className="muted">
            <Link to={`/companies/${ticket.companyId}`}>{ticket.company}</Link>
            {ticket.site && <> · {ticket.site}</>}
            {ticket.contact && (
              <>
                {" · "}
                <Link to={`/tickets?companyId=${ticket.companyId}&contactId=${ticket.contactId}`}>
                  {ticket.contact}
                </Link>
              </>
            )}
            {" · "}
            {ticket.board}
          </div>
        </div>
        <button type="button" className="btn" onClick={props.onClose} aria-label="Close details">
          ×
        </button>
      </div>
      {error && <div className="state error">{error}</div>}

      <div className="field-row">
        <label>
          Status
          <select
            className="input"
            value={ticket.statusId}
            disabled={busy || !props.can("service.ticket.write")}
            onChange={(e) =>
              run(async () =>
                props.onChanged(
                  await updateTicket(ticket.id, { statusId: Number(e.target.value) }),
                ),
              )
            }
          >
            {board?.statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select
            className="input"
            value={ticket.priorityId}
            disabled={busy || !props.can("service.ticket.write")}
            onChange={(e) =>
              run(async () =>
                props.onChanged(
                  await updateTicket(ticket.id, { priorityId: Number(e.target.value) }),
                ),
              )
            }
          >
            {lookups.priorities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <BillingField
        ticket={ticket}
        canEdit={props.can("service.ticket.write")}
        disabled={busy}
        onSave={(billingMethod, billingAmount) =>
          run(async () =>
            props.onChanged(await updateTicket(ticket.id, { billingMethod, billingAmount })),
          )
        }
      />
      <AgreementField
        ticket={ticket}
        canRead={props.can("billing.agreement.read")}
        canEdit={props.can("service.ticket.write")}
        disabled={busy}
        onPick={(agreementId) =>
          run(async () => props.onChanged(await updateTicket(ticket.id, { agreementId })))
        }
      />

      {props.can("service.ticket.write") && (
        <MoveToCompany
          currentCompanyId={ticket.companyId}
          onMove={(companyId) =>
            run(async () => props.onChanged(await updateTicket(ticket.id, { companyId })))
          }
        />
      )}
      <ResourcesSection
        ticketId={ticket.id}
        lookups={lookups}
        canEdit={props.can("service.ticket.write")}
        onError={setError}
      />
      <ChargesSection
        ticketId={ticket.id}
        canEdit={props.can("service.ticket.write")}
        onError={setError}
      />
      <AttachmentsSection
        ticketId={ticket.id}
        memberId={props.memberId}
        canEdit={props.can("service.ticket.write")}
        canDeleteAny={props.can("service.ticket.delete")}
        onError={setError}
      />

      {props.can("timekeeping.time.write_own") && (
        <>
          <h4>Time</h4>
          <div className="field-row">
            <label>
              Role
              <select
                className="input"
                value={roleId}
                onChange={(e) => setRoleId(Number(e.target.value))}
              >
                {lookups.workRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Work type
              <select
                className="input"
                value={typeId}
                onChange={(e) => setTypeId(Number(e.target.value))}
              >
                {lookups.workTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="field-row">
            <button
              type="button"
              className="btn primary"
              disabled={busy || !roleId || !typeId}
              onClick={() =>
                run(async () => {
                  await startTimer({ ticketId: ticket.id, workRoleId: roleId, workTypeId: typeId });
                  props.onTimerChange();
                })
              }
            >
              Start timer
            </button>
            <input
              className="input"
              inputMode="decimal"
              placeholder="Hours"
              aria-label="Hours to log"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={busy || !(Number(hours) > 0)}
              onClick={() =>
                run(async () => {
                  await logTime({
                    ticketId: ticket.id,
                    workRoleId: roleId,
                    workTypeId: typeId,
                    workDate: today(),
                    hours: Number(hours),
                  });
                  setHours("");
                  props.onTimerChange();
                })
              }
            >
              Log time
            </button>
          </div>
        </>
      )}

      <h4>Notes</h4>
      {notes === null ? (
        <div className="state">Loading…</div>
      ) : notes.length === 0 ? (
        <div className="state">No notes yet.</div>
      ) : (
        <ul className="notes">
          {notes.map((n) => (
            <li key={n.id} className={`note note-${n.kind}`}>
              <div className="muted">
                {n.kind} · {new Date(n.createdAt).toLocaleString()}
              </div>
              <div className="note-body">{n.body}</div>
            </li>
          ))}
        </ul>
      )}
      {props.can("service.ticket.write") && (
        <>
          <div className="field-row">
            <select
              className="input"
              aria-label="Note type"
              value={noteKind}
              onChange={(e) => setNoteKind(e.target.value)}
            >
              <option value="discussion">Discussion</option>
              <option value="internal">Internal</option>
              <option value="resolution">Resolution</option>
            </select>
          </div>
          <textarea
            className="input"
            rows={3}
            placeholder="Add a note"
            aria-label="Note text"
            value={noteBody}
            onChange={(e) => setNoteBody(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={busy || !noteBody.trim()}
            onClick={() =>
              run(async () => {
                await addNote(ticket.id, { kind: noteKind, body: noteBody });
                setNoteBody("");
                loadNotes();
              })
            }
          >
            Add note
          </button>
        </>
      )}
    </aside>
  );
}

export function NewTicketDialog(props: {
  lookups: Lookups;
  onClose: () => void;
  onCreated: (t: Ticket) => void;
  /** Start with this company already chosen (from a company page). */
  initial?: { companyId: number; companyName: string; siteId?: number; contactId?: number };
}) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [boardId, setBoardId] = useState(props.lookups.boards[0]?.id ?? 0);
  const [companyQuery, setCompanyQuery] = useState(props.initial?.companyName ?? "");
  const [companies, setCompanies] = useState<Array<{ id: number; name: string }>>([]);
  const [companyId, setCompanyId] = useState<number | null>(props.initial?.companyId ?? null);
  const [siteId, setSiteId] = useState<number | null>(props.initial?.siteId ?? null);
  const [contactId, setContactId] = useState<number | null>(props.initial?.contactId ?? null);
  const [sites, setSites] = useState<Array<{ id: number; name: string }>>([]);
  const [contacts, setContacts] = useState<Array<{ id: number; name: string }>>([]);

  // Once a company is chosen, offer only its own sites and people.
  useEffect(() => {
    if (!companyId) {
      setSites([]);
      setContacts([]);
      return;
    }
    getCompanyOverview(companyId)
      .then((o) => {
        setSites(o.sites.map((x) => ({ id: x.id, name: x.name })));
        setContacts(
          o.contacts
            .filter((c) => !c.isInactive)
            .map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName ?? ""}`.trim() })),
        );
      })
      .catch(() => {});
  }, [companyId]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (companyId !== null || companyQuery.trim().length < 2) {
      setCompanies([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      listCompanies(companyQuery, controller.signal)
        .then((r) => setCompanies(r.items.slice(0, 8)))
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [companyQuery, companyId]);

  const submit = async () => {
    if (!companyId) return;
    setBusy(true);
    setError(null);
    try {
      props.onCreated(
        await createTicket({
          summary,
          companyId,
          siteId: siteId ?? undefined,
          contactId: contactId ?? undefined,
          boardId,
          description: description.trim() || undefined,
        }),
      );
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };

  return (
    <dialog open className="dialog" aria-label="New ticket">
      <h3>New ticket</h3>
      {error && <div className="state error">{error}</div>}
      <label>
        Company
        <input
          className="input"
          placeholder="Type to search"
          value={companyQuery}
          onChange={(e) => {
            setCompanyQuery(e.target.value);
            setCompanyId(null);
            setSiteId(null);
            setContactId(null);
          }}
        />
      </label>
      {companyId === null && companies.length > 0 && (
        <ul className="picker">
          {companies.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => {
                  setCompanyId(c.id);
                  setCompanyQuery(c.name);
                  setCompanies([]);
                }}
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {companyId !== null && (sites.length > 0 || contacts.length > 0) && (
        <div className="field-row">
          <label>
            Site
            <select
              className="input"
              value={siteId ?? ""}
              onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">No specific site</option>
              {sites.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Contact
            <select
              className="input"
              value={contactId ?? ""}
              onChange={(e) => setContactId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">No specific contact</option>
              {contacts.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <label>
        Board
        <select
          className="input"
          value={boardId}
          onChange={(e) => setBoardId(Number(e.target.value))}
        >
          {props.lookups.boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Summary
        <input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} />
      </label>
      <label>
        Description
        <textarea
          className="input"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !companyId || !summary.trim() || !boardId}
          onClick={submit}
        >
          Create ticket
        </button>
      </div>
    </dialog>
  );
}
