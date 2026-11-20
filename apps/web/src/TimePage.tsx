import type { PayPeriod, TimeEntry } from "@hoosier/shared";
import { useCallback, useEffect, useState } from "react";
import {
  type Lookups,
  type PayrollPreview,
  type TimesheetSummaryRow,
  approveTimesheet,
  createTimeEntry,
  deleteTimeEntry,
  exportPayPeriodCsv,
  generatePayPeriods,
  getPayrollPreview,
  listCompanies,
  listPayPeriods,
  listTickets,
  listTimeEntries,
  lockPayPeriod,
  recallTimesheet,
  submitTimesheet,
  timesheetSummary,
  updateTimeEntry,
} from "./api";
import { hours, msg } from "./common";
import { Link } from "./router";

// ---- date helpers (plain ISO strings; the server decides the operating time zone) ----
const OPERATING_TZ = "America/Indiana/Indianapolis";
const todayIso = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: OPERATING_TZ }).format(new Date());
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Sunday through Saturday, matching payroll's workweek. */
const weekOf = (iso: string) => {
  const start = addDays(iso, -new Date(`${iso}T00:00:00Z`).getUTCDay());
  return { from: start, to: addDays(start, 6) };
};
const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

type Tab = "mine" | "approvals" | "periods";

export function TimePage(props: {
  can: (key: string) => boolean;
  lookups: Lookups | null;
  memberId: number | null;
  onTimerChange: () => void;
}) {
  const showApprovals =
    props.can("timekeeping.time.approve") && props.can("timekeeping.time.read_all");
  const showPeriods = props.can("timekeeping.period.lock");
  const [tab, setTab] = useState<Tab>("mine");
  return (
    <>
      <div className="page-header">
        <h2>Time</h2>
        <div className="tabs" role="tablist">
          <TabButton id="mine" tab={tab} setTab={setTab}>
            My timesheet
          </TabButton>
          {showApprovals && (
            <TabButton id="approvals" tab={tab} setTab={setTab}>
              Approvals
            </TabButton>
          )}
          {showPeriods && (
            <TabButton id="periods" tab={tab} setTab={setTab}>
              Pay periods
            </TabButton>
          )}
        </div>
      </div>
      {tab === "mine" && (
        <MyTimesheet
          lookups={props.lookups}
          canWrite={props.can("timekeeping.time.write_own")}
          onTimerChange={props.onTimerChange}
        />
      )}
      {tab === "approvals" && showApprovals && <Approvals memberId={props.memberId} />}
      {tab === "periods" && showPeriods && <PayPeriods />}
    </>
  );
}

function TabButton(props: {
  id: Tab;
  tab: Tab;
  setTab: (t: Tab) => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      className="tab"
      aria-selected={props.tab === props.id}
      onClick={() => props.setTab(props.id)}
    >
      {props.children}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge status-${status}`}>{status}</span>;
}

// ---------------------------------------------------------------------------------------------
// My timesheet
// ---------------------------------------------------------------------------------------------

function MyTimesheet(props: {
  lookups: Lookups | null;
  canWrite: boolean;
  onTimerChange: () => void;
}) {
  const [anchor, setAnchor] = useState(todayIso());
  const week = weekOf(anchor);
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<TimeEntry | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    listTimeEntries(week.from, week.to)
      .then((r) => setEntries(r.items))
      .catch((e) => setError(msg(e)));
  }, [week.from, week.to]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload whenever the week changes
  useEffect(() => {
    setEntries(null);
    load();
  }, [week.from]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      load();
      props.onTimerChange();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const days = Array.from({ length: 7 }, (_, i) => addDays(week.from, i));
  const byDay = (d: string) => (entries ?? []).filter((e) => e.workDate === d);
  const total = (entries ?? []).reduce((s, e) => s + e.actualHours, 0);
  const count = (status: string) => (entries ?? []).filter((e) => e.status === status).length;
  const openCount = count("open");
  const submittedCount = count("submitted");

  return (
    <div className="card">
      <div className="toolbar">
        <button type="button" className="btn" onClick={() => setAnchor(addDays(week.from, -7))}>
          ← Prev
        </button>
        <button type="button" className="btn" onClick={() => setAnchor(todayIso())}>
          This week
        </button>
        <button type="button" className="btn" onClick={() => setAnchor(addDays(week.from, 7))}>
          Next →
        </button>
        <strong className="week-label">
          {dayLabel(week.from)} – {dayLabel(week.to)}
        </strong>
        <span className="muted">Total {hours(total)}</span>
        {props.canWrite && (
          <span className="toolbar-end">
            <button type="button" className="btn" onClick={() => setEditing("new")}>
              Add time
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || openCount === 0}
              onClick={() =>
                act(() => submitTimesheet(week.from, week.to), "Week submitted for approval.")
              }
            >
              Submit week{openCount > 0 ? ` (${openCount})` : ""}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || submittedCount === 0}
              onClick={() =>
                act(() => recallTimesheet(week.from, week.to), "Submitted time recalled.")
              }
            >
              Recall
            </button>
          </span>
        )}
      </div>
      {error && <div className="state error">{error}</div>}
      {notice && <div className="state">{notice}</div>}
      {entries === null && !error && <div className="state">Loading…</div>}
      {entries !== null &&
        days.map((d) => {
          const rows = byDay(d);
          const dayTotal = rows.reduce((s, e) => s + e.actualHours, 0);
          return (
            <section key={d} className="time-day">
              <header>
                <strong>{dayLabel(d)}</strong>
                <span className="muted">{rows.length > 0 ? hours(dayTotal) : ""}</span>
              </header>
              {rows.length > 0 && (
                <table>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <Link to={`/companies/${e.companyId}`}>{e.company}</Link>
                        </td>
                        <td>
                          {e.ticketId ? (
                            <Link to={`/tickets/${e.ticketId}`}>
                              #{e.ticketId} {e.ticketSummary}
                            </Link>
                          ) : (
                            <span className="muted">Non-ticket time</span>
                          )}
                          {e.notes && <div className="muted small">{e.notes}</div>}
                        </td>
                        <td className="num">{hours(e.actualHours)}</td>
                        <td>
                          {e.isTimer ? <span className="badge">timer running</span> : null}
                          {!e.isTimer && <StatusBadge status={e.status} />}
                        </td>
                        <td className="actions">
                          {props.canWrite && e.status === "open" && !e.isTimer && (
                            <>
                              <button
                                type="button"
                                className="btn small"
                                onClick={() => setEditing(e)}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="btn small"
                                disabled={busy}
                                onClick={() => {
                                  if (window.confirm("Remove this time entry?"))
                                    void act(() => deleteTimeEntry(e.id), "Entry removed.");
                                }}
                              >
                                Remove
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      {editing !== null && props.lookups && (
        <EntryDialog
          lookups={props.lookups}
          entry={editing === "new" ? null : editing}
          defaultDate={anchor === week.from || anchor > week.to ? todayIso() : anchor}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice("Saved.");
            load();
          }}
        />
      )}
    </div>
  );
}

function EntryDialog(props: {
  lookups: Lookups;
  entry: TimeEntry | null;
  defaultDate: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = props.entry;
  const [kind, setKind] = useState<"ticket" | "other">(
    editing && editing.ticketId === null ? "other" : "ticket",
  );
  const [ticketQuery, setTicketQuery] = useState(
    editing?.ticketId ? `#${editing.ticketId} ${editing.ticketSummary ?? ""}` : "",
  );
  const [ticketId, setTicketId] = useState<number | null>(editing?.ticketId ?? null);
  const [tickets, setTickets] = useState<Array<{ id: number; summary: string; company: string }>>(
    [],
  );
  const [companyQuery, setCompanyQuery] = useState(
    editing && !editing.ticketId ? editing.company : "",
  );
  const [companyId, setCompanyId] = useState<number | null>(
    editing && !editing.ticketId ? editing.companyId : null,
  );
  const [companies, setCompanies] = useState<Array<{ id: number; name: string }>>([]);
  const [workDate, setWorkDate] = useState(editing?.workDate ?? props.defaultDate);
  const [hrs, setHrs] = useState(editing ? String(editing.actualHours) : "");
  const [roleId, setRoleId] = useState(editing?.workRoleId ?? props.lookups.workRoles[0]?.id ?? 0);
  const [typeId, setTypeId] = useState(editing?.workTypeId ?? props.lookups.workTypes[0]?.id ?? 0);
  const [billable, setBillable] = useState<"billable" | "do_not_bill" | "no_charge" | "">(
    editing && editing.ticketId !== null ? (editing.billable as "billable") : "",
  );
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (kind !== "ticket" || ticketId !== null || ticketQuery.trim().length < 2) {
      setTickets([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      listTickets({ q: ticketQuery.replace(/^#/, ""), state: "open" }, ctl.signal)
        .then((r) =>
          setTickets(
            r.items.slice(0, 8).map((x) => ({ id: x.id, summary: x.summary, company: x.company })),
          ),
        )
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [kind, ticketId, ticketQuery]);

  useEffect(() => {
    if (kind !== "other" || companyId !== null || companyQuery.trim().length < 2) {
      setCompanies([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      listCompanies(companyQuery, ctl.signal)
        .then((r) => setCompanies(r.items.slice(0, 8).map((c) => ({ id: c.id, name: c.name }))))
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [kind, companyId, companyQuery]);

  const hoursNum = Number(hrs);
  const valid =
    hoursNum > 0 &&
    hoursNum <= 24 &&
    roleId > 0 &&
    typeId > 0 &&
    (editing ? true : kind === "ticket" ? ticketId !== null : companyId !== null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await updateTimeEntry(editing.id, {
          workDate,
          hours: hoursNum,
          workRoleId: roleId,
          workTypeId: typeId,
          ...(editing.ticketId !== null && billable ? { billable } : {}),
          notes: notes.trim() || null,
        });
      } else {
        await createTimeEntry({
          ...(kind === "ticket"
            ? { ticketId: ticketId as number }
            : { companyId: companyId as number }),
          workDate,
          hours: hoursNum,
          workRoleId: roleId,
          workTypeId: typeId,
          ...(kind === "ticket" && billable ? { billable } : {}),
          notes: notes.trim() || undefined,
        });
      }
      props.onSaved();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };

  return (
    <dialog open className="dialog" aria-label={editing ? "Edit time" : "Add time"}>
      <h3>{editing ? "Edit time" : "Add time"}</h3>
      {error && <div className="state error">{error}</div>}
      {!editing && (
        <div className="field-row">
          <label className="radio">
            <span>
              <input type="radio" checked={kind === "ticket"} onChange={() => setKind("ticket")} />{" "}
              On a ticket
            </span>
          </label>
          <label className="radio">
            <span>
              <input type="radio" checked={kind === "other"} onChange={() => setKind("other")} />{" "}
              Not on a ticket (shop, training, admin)
            </span>
          </label>
        </div>
      )}
      {editing ? (
        <div className="muted">
          {editing.company}
          {editing.ticketId
            ? ` · #${editing.ticketId} ${editing.ticketSummary ?? ""}`
            : " · Non-ticket time"}
        </div>
      ) : kind === "ticket" ? (
        <>
          <label>
            Ticket
            <input
              className="input"
              placeholder="Search open tickets by number or words"
              value={ticketQuery}
              onChange={(e) => {
                setTicketQuery(e.target.value);
                setTicketId(null);
              }}
            />
          </label>
          {ticketId === null && tickets.length > 0 && (
            <ul className="picker">
              {tickets.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setTicketId(t.id);
                      setTicketQuery(`#${t.id} ${t.summary}`);
                    }}
                  >
                    #{t.id} {t.summary} <span className="muted">· {t.company}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <label>
            Company
            <input
              className="input"
              placeholder="Type to search (your own company for internal time)"
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
                    }}
                  >
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="field-row">
        <label>
          Date
          <input
            className="input"
            type="date"
            value={workDate}
            onChange={(e) => setWorkDate(e.target.value)}
          />
        </label>
        <label>
          Hours
          <input
            className="input"
            inputMode="decimal"
            placeholder="1.5"
            value={hrs}
            onChange={(e) => setHrs(e.target.value)}
          />
        </label>
      </div>
      <div className="field-row">
        <label>
          Role
          <select
            className="input"
            value={roleId}
            onChange={(e) => setRoleId(Number(e.target.value))}
          >
            {props.lookups.workRoles.map((r) => (
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
            {props.lookups.workTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {(editing ? editing.ticketId !== null : kind === "ticket") && (
          <label>
            Billing
            <select
              className="input"
              value={billable}
              onChange={(e) => setBillable(e.target.value as typeof billable)}
            >
              <option value="">Use work type default</option>
              <option value="billable">Billable</option>
              <option value="do_not_bill">Do not bill</option>
              <option value="no_charge">No charge</option>
            </select>
          </label>
        )}
      </div>
      <label>
        Notes
        <textarea
          className="input"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      {!editing && kind === "other" && (
        <div className="muted small">
          Time with no ticket is paid time and is never billed to a customer.
        </div>
      )}
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={busy || !valid} onClick={save}>
          {editing ? "Save changes" : "Add time"}
        </button>
      </div>
    </dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------

function Approvals({ memberId }: { memberId: number | null }) {
  // Approve the last full workweek by default; managers usually review the week just ended.
  const [anchor, setAnchor] = useState(addDays(weekOf(todayIso()).from, -7));
  const week = weekOf(anchor);
  const [rows, setRows] = useState<TimesheetSummaryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    timesheetSummary(week.from, week.to)
      .then((r) => setRows(r.items))
      .catch((e) => setError(msg(e)));
  }, [week.from, week.to]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload whenever the week changes
  useEffect(() => {
    setRows(null);
    load();
  }, [week.from]);

  const members = new Map<
    number,
    { identifier: string; byStatus: Record<string, TimesheetSummaryRow> }
  >();
  for (const r of rows ?? []) {
    const m = members.get(r.memberId) ?? { identifier: r.identifier, byStatus: {} };
    m.byStatus[r.status] = r;
    members.set(r.memberId, m);
  }

  const approve = async (id: number) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await approveTimesheet(id, week.from, week.to);
      setNotice(`Approved ${r.approved} ${r.approved === 1 ? "entry" : "entries"}.`);
      load();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const cell = (m: { byStatus: Record<string, TimesheetSummaryRow> }, s: string) =>
    m.byStatus[s] ? `${hours(m.byStatus[s].hours)} (${m.byStatus[s].entries})` : "—";

  return (
    <div className="card">
      <div className="toolbar">
        <button type="button" className="btn" onClick={() => setAnchor(addDays(week.from, -7))}>
          ← Prev
        </button>
        <button type="button" className="btn" onClick={() => setAnchor(addDays(week.from, 7))}>
          Next →
        </button>
        <strong className="week-label">
          {dayLabel(week.from)} – {dayLabel(week.to)}
        </strong>
      </div>
      {error && <div className="state error">{error}</div>}
      {notice && <div className="state">{notice}</div>}
      {rows === null && !error && <div className="state">Loading…</div>}
      {rows !== null && members.size === 0 && (
        <div className="state">No time recorded this week.</div>
      )}
      {rows !== null && members.size > 0 && (
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th className="num">Open</th>
              <th className="num">Submitted</th>
              <th className="num">Approved</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...members.entries()].map(([id, m]) => (
              <tr key={id}>
                <td>{m.identifier}</td>
                <td className="num">{cell(m, "open")}</td>
                <td className="num">{cell(m, "submitted")}</td>
                <td className="num">{cell(m, "approved")}</td>
                <td className="actions">
                  {m.byStatus.submitted && (
                    <button
                      type="button"
                      className="btn small primary"
                      disabled={busy || id === memberId}
                      title={
                        id === memberId ? "Someone else has to approve your own time" : undefined
                      }
                      onClick={() => approve(id)}
                    >
                      Approve
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Pay periods
// ---------------------------------------------------------------------------------------------

function PayPeriods() {
  const [periods, setPeriods] = useState<PayPeriod[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [preview, setPreview] = useState<PayrollPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [month, setMonth] = useState(todayIso().slice(0, 7));

  const loadPeriods = useCallback(() => {
    listPayPeriods()
      .then((r) => setPeriods(r.items))
      .catch((e) => setError(msg(e)));
  }, []);
  useEffect(() => {
    loadPeriods();
  }, [loadPeriods]);

  const loadPreview = useCallback((id: number) => {
    setPreview(null);
    getPayrollPreview(id)
      .then(setPreview)
      .catch((e) => setError(msg(e)));
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: preview follows the selection
  useEffect(() => {
    if (selected !== null) loadPreview(selected);
  }, [selected]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      loadPeriods();
      if (selected !== null) loadPreview(selected);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const current = periods?.find((p) => p.id === selected) ?? null;

  return (
    <div className="split">
      <div className="card">
        <div className="toolbar">
          <input
            className="input"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            aria-label="Month"
          />
          <button
            type="button"
            className="btn"
            disabled={busy || !month}
            onClick={() => {
              const [y, m] = month.split("-").map(Number);
              void run(() => generatePayPeriods(y as number, m as number), "Pay periods created.");
            }}
          >
            Create periods for month
          </button>
        </div>
        {error && <div className="state error">{error}</div>}
        {notice && <div className="state">{notice}</div>}
        {periods === null && !error && <div className="state">Loading…</div>}
        {periods !== null && periods.length === 0 && (
          <div className="state">No pay periods yet. Create the two periods for a month above.</div>
        )}
        {periods !== null && periods.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.id} className={p.id === selected ? "selected" : undefined}>
                  <td>
                    <button type="button" className="link-button" onClick={() => setSelected(p.id)}>
                      {p.startDate} → {p.endDate}
                    </button>
                  </td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {current && (
        <aside className="card card-pad detail wide-detail">
          <h3>
            {current.startDate} → {current.endDate}
          </h3>
          {!preview && <div className="state">Loading…</div>}
          {preview && (
            <>
              {preview.unsubmittedEntries > 0 && (
                <div className="state error">
                  {preview.unsubmittedEntries} time{" "}
                  {preview.unsubmittedEntries === 1 ? "entry is" : "entries are"} still open (not
                  submitted). The period cannot be locked until they are submitted.
                </div>
              )}
              {preview.warnings.length > 0 && (
                <ul className="warnings">
                  {preview.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              {preview.items.length === 0 ? (
                <div className="state">No submitted time in this period yet.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th className="num">Regular</th>
                      <th className="num">OT</th>
                      <th className="num">PTO</th>
                      <th className="num">Hol</th>
                      <th className="num">Sick</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.items.map((r) => (
                      <tr key={r.memberId}>
                        <td>{r.name}</td>
                        <td className="num">{r.regularHm}</td>
                        <td className="num">{r.overtimeHm}</td>
                        <td className="num">{r.ptoHm}</td>
                        <td className="num">{r.holidayHm}</td>
                        <td className="num">{r.sickHm}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="field-row end">
                {current.status === "open" && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || preview.unsubmittedEntries > 0}
                    onClick={() => {
                      if (
                        window.confirm("Lock this pay period? Time in it can no longer be changed.")
                      )
                        void run(() => lockPayPeriod(current.id), "Pay period locked.");
                    }}
                  >
                    Lock period
                  </button>
                )}
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || current.status === "open"}
                  title={current.status === "open" ? "Lock the period before exporting" : undefined}
                  onClick={() =>
                    void run(() => exportPayPeriodCsv(current.id), "Payroll file downloaded.")
                  }
                >
                  Export payroll CSV
                </button>
              </div>
            </>
          )}
        </aside>
      )}
    </div>
  );
}
