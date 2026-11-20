import type { ScheduleEntry, UnassignedTicket } from "@hoosier/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Lookups,
  createScheduleEntry,
  deleteScheduleEntry,
  getDispatchBoard,
  updateScheduleEntry,
} from "./api";
import { msg } from "./common";

type Board = Awaited<ReturnType<typeof getDispatchBoard>>;
const DAY = 86_400_000;

const mondayOf = (d: Date) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const pad = (n: number) => String(n).padStart(2, "0");
/** An ISO instant as the value of a datetime-local input, in the browser's time zone. */
const toLocalInput = (iso: string | Date) => {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => new Date(v).toISOString();
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const dayLabel = (d: Date) =>
  d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/** The part of an entry that falls on one day: "All day", or its times clipped to that day. */
const spanOn = (e: ScheduleEntry, day: Date) => {
  const start = day.getTime();
  const end = addDays(day, 1).getTime();
  const s = new Date(e.startsAt).getTime();
  const f = new Date(e.endsAt).getTime();
  if (s <= start && f >= end) return "All day";
  const from = s < start ? "12:00 AM" : clock(e.startsAt);
  const to = f > end ? "11:59 PM" : clock(e.endsAt);
  return `${from} to ${to}`;
};

const label = (e: ScheduleEntry) =>
  e.kind === "ticket" ? `#${e.ticketId} ${e.ticketSummary ?? ""}` : (e.title ?? "");

type Editing =
  | { mode: "new"; day: Date; memberId?: number; ticket?: UnassignedTicket }
  | { mode: "edit"; entry: ScheduleEntry };

export function DispatchPage({
  can,
  lookups,
}: {
  can: (key: string) => boolean;
  lookups: Lookups | null;
}) {
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [reload, setReload] = useState(0);
  const canWrite = can("dispatch.write");
  const refresh = useCallback(() => setReload((n) => n + 1), []);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const ctl = new AbortController();
    getDispatchBoard(weekStart.toISOString(), addDays(weekStart, 7).toISOString(), ctl.signal)
      .then((b) => {
        setBoard(b);
        setError(null);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(msg(e));
      });
    return () => ctl.abort();
  }, [weekStart, reload]);

  // Entries of the same person that overlap are flagged on the board.
  const clashing = useMemo(() => {
    const set = new Set<number>();
    const byMember = new Map<number, ScheduleEntry[]>();
    for (const e of board?.entries ?? []) {
      const list = byMember.get(e.memberId) ?? [];
      list.push(e);
      byMember.set(e.memberId, list);
    }
    for (const list of byMember.values())
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i] as ScheduleEntry;
          const b = list[j] as ScheduleEntry;
          if (a.startsAt < b.endsAt && b.startsAt < a.endsAt) {
            set.add(a.id);
            set.add(b.id);
          }
        }
    return set;
  }, [board]);

  const cell = (memberId: number, day: Date) => {
    const start = day.getTime();
    const end = start + DAY;
    return (board?.entries ?? []).filter(
      (e) =>
        e.memberId === memberId &&
        new Date(e.startsAt).getTime() < end &&
        new Date(e.endsAt).getTime() > start,
    );
  };

  const saved = (conflicts: ScheduleEntry[]) => {
    setEditing(null);
    setNotice(
      conflicts.length > 0
        ? `Saved, but it overlaps ${conflicts.map((c) => `${label(c)} (${clock(c.startsAt)} to ${clock(c.endsAt)})`).join("; ")}.`
        : null,
    );
    refresh();
  };

  return (
    <>
      <div className="page-header">
        <h2>Dispatch</h2>
        <div className="field-row">
          <button
            type="button"
            className="btn"
            onClick={() => setWeekStart(addDays(weekStart, -7))}
          >
            Previous week
          </button>
          <button type="button" className="btn" onClick={() => setWeekStart(mondayOf(new Date()))}>
            This week
          </button>
          <button type="button" className="btn" onClick={() => setWeekStart(addDays(weekStart, 7))}>
            Next week
          </button>
        </div>
      </div>
      {error && <div className="state error">{error}</div>}
      {notice && (
        <output className="state error" style={{ display: "block" }}>
          {notice}
        </output>
      )}
      <div className="card" style={{ overflowX: "auto" }}>
        {!board && !error && <div className="state">Loading…</div>}
        {board && (
          <table style={{ tableLayout: "fixed", minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ width: 130 }}>Technician</th>
                {days.map((d) => (
                  <th key={d.toISOString()}>{dayLabel(d)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {board.members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <strong>{m.name}</strong>
                  </td>
                  {days.map((d) => (
                    <td key={d.toISOString()} style={{ verticalAlign: "top" }}>
                      {cell(m.id, d).map((e) => (
                        <button
                          type="button"
                          key={e.id}
                          className="btn"
                          title={`${label(e)}${e.company ? `, ${e.company}` : ""}`}
                          onClick={() => setEditing({ mode: "edit", entry: e })}
                          style={{
                            display: "block",
                            width: "100%",
                            textAlign: "left",
                            marginBottom: 4,
                            padding: "4px 6px",
                            fontSize: 12,
                            borderColor: clashing.has(e.id) ? "#b91c1c" : undefined,
                            background:
                              e.kind === "time_off"
                                ? "#f3f4f6"
                                : e.status === "completed"
                                  ? "#ecfdf5"
                                  : undefined,
                            opacity: e.status === "completed" ? 0.75 : 1,
                          }}
                        >
                          <div>
                            {spanOn(e, d)}
                            {clashing.has(e.id) && (
                              <span style={{ color: "#b91c1c" }}> overlap</span>
                            )}
                          </div>
                          <div
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {label(e)}
                          </div>
                          {e.company && <div className="muted small">{e.company}</div>}
                        </button>
                      ))}
                      {canWrite && (
                        <button
                          type="button"
                          className="link small"
                          aria-label={`Schedule ${m.name} on ${dayLabel(d)}`}
                          onClick={() => setEditing({ mode: "new", day: d, memberId: m.id })}
                        >
                          + add
                        </button>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              {board.members.length === 0 && (
                <tr>
                  <td colSpan={8} className="state">
                    No field technicians. Mark people as field techs in Access to see them here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Unscheduled tickets {board ? `(${board.unassigned.length})` : ""}</h3>
        <p className="muted small">Open tickets with no upcoming visit, most urgent first.</p>
        {board && board.unassigned.length === 0 && (
          <div className="state">Everything open is scheduled.</div>
        )}
        {board && board.unassigned.length > 0 && (
          <table>
            <tbody>
              {board.unassigned.map((t) => (
                <tr key={t.id}>
                  <td>
                    <span
                      className="badge"
                      style={{ background: t.priorityColor ?? undefined, color: "#fff" }}
                    >
                      {t.priority}
                    </span>
                  </td>
                  <td>
                    <a className="link" href={`#/tickets/${t.id}`}>
                      #{t.id}
                    </a>{" "}
                    {t.summary}
                  </td>
                  <td>{t.company}</td>
                  <td>{t.site ?? ""}</td>
                  <td>{t.status}</td>
                  <td className="num">
                    {canWrite && (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setEditing({ mode: "new", day: new Date(), ticket: t })}
                      >
                        Schedule…
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <EntryDialog
          key={editing.mode === "edit" ? editing.entry.id : "new"}
          editing={editing}
          members={board?.members ?? []}
          lookups={lookups}
          canWrite={canWrite}
          onClose={() => setEditing(null)}
          onSaved={saved}
          onDeleted={() => {
            setEditing(null);
            setNotice(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

function EntryDialog(props: {
  editing: Editing;
  members: Array<{ id: number; name: string }>;
  lookups: Lookups | null;
  canWrite: boolean;
  onClose: () => void;
  onSaved: (conflicts: ScheduleEntry[]) => void;
  onDeleted: () => void;
}) {
  const ex = props.editing.mode === "edit" ? props.editing.entry : null;
  const day = props.editing.mode === "new" ? props.editing.day : null;
  const queued = props.editing.mode === "new" ? props.editing.ticket : undefined;
  const defaultStart = day
    ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8, 0)
    : null;

  const [kind, setKind] = useState<ScheduleEntry["kind"]>(ex?.kind ?? "ticket");
  const [ticketId, setTicketId] = useState(String(ex?.ticketId ?? queued?.id ?? ""));
  const [memberId, setMemberId] = useState(
    String(ex?.memberId ?? (props.editing.mode === "new" ? (props.editing.memberId ?? "") : "")),
  );
  const [title, setTitle] = useState(ex?.title ?? "");
  const [start, setStart] = useState(
    ex ? toLocalInput(ex.startsAt) : toLocalInput(defaultStart as Date),
  );
  const [end, setEnd] = useState(
    ex
      ? toLocalInput(ex.endsAt)
      : toLocalInput(new Date((defaultStart as Date).getTime() + 2 * 3_600_000)),
  );
  const [status, setStatus] = useState<ScheduleEntry["status"]>(ex?.status ?? "scheduled");
  const [notes, setNotes] = useState(ex?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const people = props.lookups?.members.filter((m) => m.isFieldTech) ?? [];
  const options = [
    ...props.members,
    ...people.filter((p) => !props.members.some((m) => m.id === p.id)),
  ];
  const valid =
    memberId !== "" &&
    new Date(end) > new Date(start) &&
    (kind === "ticket" ? Number(ticketId) > 0 : title.trim().length > 0);

  const save = async () => {
    setBusy(true);
    try {
      const r = ex
        ? await updateScheduleEntry(ex.id, {
            memberId: Number(memberId),
            startsAt: fromLocalInput(start),
            endsAt: fromLocalInput(end),
            status,
            notes: notes.trim() || null,
            ...(ex.kind !== "ticket" ? { title: title.trim() } : {}),
          })
        : await createScheduleEntry({
            kind,
            ticketId: kind === "ticket" ? Number(ticketId) : undefined,
            memberId: Number(memberId),
            title: kind === "ticket" ? undefined : title.trim(),
            startsAt: fromLocalInput(start),
            endsAt: fromLocalInput(end),
            notes: notes.trim() || undefined,
          });
      props.onSaved(r.conflicts);
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };

  const disabled = !props.canWrite;
  return (
    <dialog open className="dialog" aria-label={ex ? "Visit" : "Schedule a visit"}>
      <h3>{ex ? "Visit" : "Schedule"}</h3>
      {error && <div className="state error">{error}</div>}
      <div className="field-grid">
        {!ex && (
          <label>
            What
            <select
              className="input"
              value={kind}
              onChange={(e) => setKind(e.target.value as ScheduleEntry["kind"])}
            >
              <option value="ticket">Ticket visit</option>
              <option value="meeting">Meeting</option>
              <option value="time_off">Time off</option>
            </select>
          </label>
        )}
        {kind === "ticket" ? (
          <label>
            Ticket number
            <input
              className="input"
              inputMode="numeric"
              value={ticketId}
              disabled={!!ex || !!queued}
              onChange={(e) => setTicketId(e.target.value)}
            />
            {(queued || ex) && (
              <span className="muted small">
                {queued
                  ? `${queued.summary} (${queued.company})`
                  : `${ex?.ticketSummary} (${ex?.company})`}
              </span>
            )}
          </label>
        ) : (
          <label>
            Title
            <input
              className="input"
              value={title}
              disabled={disabled}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
        )}
        <label>
          Who
          <select
            className="input"
            value={memberId}
            disabled={disabled}
            onChange={(e) => setMemberId(e.target.value)}
          >
            <option value="">Choose…</option>
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Starts
          <input
            className="input"
            type="datetime-local"
            value={start}
            disabled={disabled}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          Ends
          <input
            className="input"
            type="datetime-local"
            value={end}
            disabled={disabled}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        {ex && (
          <label>
            Status
            <select
              className="input"
              value={status}
              disabled={disabled}
              onChange={(e) => setStatus(e.target.value as ScheduleEntry["status"])}
            >
              <option value="scheduled">Scheduled</option>
              <option value="confirmed">Confirmed with customer</option>
              <option value="completed">Completed</option>
              <option value="canceled">Canceled</option>
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
          disabled={disabled}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <div className="field-row end">
        {ex?.ticketId && (
          <a className="btn" href={`#/tickets/${ex.ticketId}`}>
            Open ticket
          </a>
        )}
        {ex && props.canWrite && (
          <button
            type="button"
            className="btn"
            onClick={async () => {
              try {
                await deleteScheduleEntry(ex.id);
                props.onDeleted();
              } catch (e) {
                setError(msg(e));
              }
            }}
          >
            Remove
          </button>
        )}
        <button type="button" className="btn" onClick={props.onClose}>
          Close
        </button>
        {props.canWrite && (
          <button type="button" className="btn primary" disabled={busy || !valid} onClick={save}>
            Save
          </button>
        )}
      </div>
    </dialog>
  );
}
