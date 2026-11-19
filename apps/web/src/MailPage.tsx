import type { Company } from "@hoosier/shared";
import { useCallback, useEffect, useState } from "react";
import {
  type InboundMessage,
  type Lookups,
  type MailboxView,
  createMailbox,
  getLookups,
  listCompanies,
  listInboundMessages,
  listMailboxes,
  updateMailbox,
} from "./api";

const msg = (e: unknown) => (e instanceof Error ? e.message : "Request failed");
const OUTCOMES: Array<[string, string]> = [
  ["", "All"],
  ["created_unmatched", "Needs sorting"],
  ["error", "Errors"],
  ["created", "New tickets"],
  ["appended", "Replies"],
  ["ignored", "Ignored"],
];
const OUTCOME_LABEL: Record<string, string> = {
  created: "New ticket",
  created_unmatched: "New ticket, needs sorting",
  appended: "Reply added",
  ignored: "Ignored",
  error: "Error",
};

/** Which shared mailboxes become tickets, and what happened to each message. */
export function MailPage() {
  const [boxes, setBoxes] = useState<MailboxView[] | null>(null);
  const [messages, setMessages] = useState<InboundMessage[] | null>(null);
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [outcome, setOutcome] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    Promise.all([listMailboxes(), listInboundMessages(outcome || undefined)])
      .then(([b, m]) => {
        setBoxes(b.items);
        setMessages(m.items);
      })
      .catch((e) => setError(msg(e)));
  }, [outcome]);
  useEffect(() => {
    reload();
  }, [reload]);
  useEffect(() => {
    getLookups()
      .then(setLookups)
      .catch(() => {});
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
      reload();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <h2>Email</h2>
      </div>
      {error && <div className="state error">{error}</div>}
      <div className="card">
        <h3>Mailboxes</h3>
        {boxes === null ? (
          <div className="state">Loading…</div>
        ) : boxes.length === 0 ? (
          <div className="state">No mailbox set up yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>Board</th>
                <th>Unknown senders go to</th>
                <th>Last checked</th>
                <th>On</th>
              </tr>
            </thead>
            <tbody>
              {boxes.map((b) => (
                <tr key={b.id}>
                  <td>{b.address}</td>
                  <td>{b.board}</td>
                  <td>{b.fallbackCompany}</td>
                  <td>
                    {b.lastPolledAt ? new Date(b.lastPolledAt).toLocaleString() : "never"}
                    {b.lastError && <div className="state error">{b.lastError}</div>}
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${b.address} is on`}
                      disabled={busy}
                      checked={b.isActive}
                      onChange={(e) =>
                        run(() => updateMailbox(b.id, { isActive: e.target.checked }))
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          A new mailbox starts switched off. Switching it on reads only mail that arrives from then
          on. Mail is read, never moved or deleted, and the server needs mail polling enabled to act
          on it.
        </p>
        {lookups && (
          <AddMailbox lookups={lookups} busy={busy} onAdd={(b) => run(() => createMailbox(b))} />
        )}
      </div>

      <div className="card">
        <div className="toolbar">
          <h3>Messages</h3>
          <select
            className="input"
            aria-label="Filter by outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
          >
            {OUTCOMES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        {messages === null ? (
          <div className="state">Loading…</div>
        ) : messages.length === 0 ? (
          <div className="state">Nothing here.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>From</th>
                <th>Subject</th>
                <th>Result</th>
                <th>Ticket</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr key={m.id}>
                  <td>{new Date(m.receivedAt).toLocaleString()}</td>
                  <td>
                    {m.fromName ?? m.fromAddress}
                    <div className="muted">{m.fromAddress}</div>
                  </td>
                  <td>{m.subject}</td>
                  <td>
                    {OUTCOME_LABEL[m.outcome] ?? m.outcome}
                    {m.reason && <div className="muted">{m.reason}</div>}
                    {m.attachmentsSkipped > 0 && (
                      <div className="muted">{m.attachmentsSkipped} file(s) not kept</div>
                    )}
                  </td>
                  <td className="mono">{m.ticketId ? `#${m.ticketId}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function AddMailbox(props: {
  lookups: Lookups;
  busy: boolean;
  onAdd: (b: { address: string; boardId: number; fallbackCompanyId: number }) => void;
}) {
  const [address, setAddress] = useState("");
  const [boardId, setBoardId] = useState(props.lookups.boards[0]?.id ?? 0);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Company[]>([]);
  const [company, setCompany] = useState<Company | null>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setFound([]);
      return;
    }
    const c = new AbortController();
    const t = setTimeout(() => {
      listCompanies(query, c.signal)
        .then((r) => setFound(r.items.slice(0, 8)))
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [query]);

  return (
    <div className="field-row end">
      <label>
        New mailbox
        <input
          className="input"
          type="email"
          placeholder="support@yourcompany.com"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      </label>
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
        Company for unknown senders
        <input
          className="input"
          placeholder="Search companies"
          value={company ? company.name : query}
          readOnly={company !== null}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {company ? (
        <button type="button" className="link" onClick={() => setCompany(null)}>
          change
        </button>
      ) : (
        found.length > 0 && (
          <select
            className="input"
            aria-label="Matching companies"
            value=""
            onChange={(e) => setCompany(found.find((c) => c.id === Number(e.target.value)) ?? null)}
          >
            <option value="">Choose…</option>
            {found.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )
      )}
      <button
        type="button"
        className="btn primary"
        disabled={props.busy || !address.includes("@") || !company || !boardId}
        onClick={() => {
          if (!company) return;
          props.onAdd({ address, boardId, fallbackCompanyId: company.id });
          setAddress("");
          setCompany(null);
          setQuery("");
        }}
      >
        Add mailbox
      </button>
    </div>
  );
}
