import type { Ticket, TicketNote } from "@hoosier/shared";
import { useCallback, useEffect, useState } from "react";
import { MoveToCompany } from "./MoveToCompany";
import { AttachmentsSection, ResourcesSection } from "./TicketFiles";
import {
  type Lookups,
  addNote,
  createTicket,
  getLookups,
  listCompanies,
  listNotes,
  listTickets,
  logTime,
  startTimer,
  updateTicket,
} from "./api";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; items: Ticket[]; total: number };

const msg = (e: unknown) => (e instanceof Error ? e.message : "Request failed");
const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Indiana/Indianapolis" });

export function TicketsPage({
  onTimerChange,
  can,
  memberId,
}: {
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
      listTickets({ q: query, state, boardId }, controller.signal)
        .then((r) => setLoad({ state: "ready", items: r.items, total: r.total }))
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setLoad({ state: "error", message: msg(err) });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, state, boardId, reload]);

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
                      <button type="button" className="link" onClick={() => setSelected(t)}>
                        {t.summary}
                      </button>
                    </td>
                    <td className="muted">{t.company}</td>
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
            onClose={() => setSelected(null)}
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
            setSelected(t);
            refresh();
          }}
        />
      )}
    </>
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
            {ticket.company} · {ticket.board}
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

function NewTicketDialog(props: {
  lookups: Lookups;
  onClose: () => void;
  onCreated: (t: Ticket) => void;
}) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [boardId, setBoardId] = useState(props.lookups.boards[0]?.id ?? 0);
  const [companyQuery, setCompanyQuery] = useState("");
  const [companies, setCompanies] = useState<Array<{ id: number; name: string }>>([]);
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (companyQuery.trim().length < 2) {
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
  }, [companyQuery]);

  const submit = async () => {
    if (!companyId) return;
    setBusy(true);
    setError(null);
    try {
      props.onCreated(
        await createTicket({
          summary,
          companyId,
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
