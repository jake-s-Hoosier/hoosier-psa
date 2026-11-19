import { useCallback, useEffect, useState } from "react";
import {
  type Lookups,
  type TicketAttachment,
  type TicketResource,
  addResource,
  deleteAttachment,
  downloadAttachment,
  listAttachments,
  listResources,
  removeResource,
  uploadAttachment,
} from "./api";

const msg = (e: unknown) => (e instanceof Error ? e.message : "Request failed");

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Who is working the ticket. */
export function ResourcesSection(props: {
  ticketId: number;
  lookups: Lookups;
  canEdit: boolean;
  onError: (m: string | null) => void;
}) {
  const [items, setItems] = useState<TicketResource[] | null>(null);
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);
  const { ticketId, onError } = props;

  useEffect(() => {
    listResources(ticketId)
      .then((r) => setItems(r.items))
      .catch((e) => onError(msg(e)));
  }, [ticketId, onError]);

  const run = async (fn: () => Promise<{ items: TicketResource[] }>) => {
    setBusy(true);
    try {
      setItems((await fn()).items);
      onError(null);
    } catch (e) {
      onError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  const taken = new Set((items ?? []).map((r) => r.memberId));
  const available = props.lookups.members.filter((m) => !taken.has(m.id));

  return (
    <>
      <h4>Resources</h4>
      {items === null ? (
        <div className="state">Loading…</div>
      ) : items.length === 0 ? (
        <div className="state">Nobody assigned yet.</div>
      ) : (
        <div className="chips">
          {items.map((r) => (
            <span key={r.memberId} className="chip">
              {r.name}
              {props.canEdit && (
                <button
                  type="button"
                  className="link"
                  disabled={busy}
                  aria-label={`Remove ${r.name}`}
                  onClick={() => run(() => removeResource(ticketId, r.memberId))}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {props.canEdit && available.length > 0 && (
        <div className="field-row">
          <select
            className="input"
            aria-label="Add a resource"
            value={pick}
            onChange={(e) => setPick(Number(e.target.value))}
          >
            <option value={0}>Add a person…</option>
            {available.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={busy || pick === 0}
            onClick={() =>
              run(async () => {
                const r = await addResource(ticketId, pick);
                setPick(0);
                return r;
              })
            }
          >
            Add
          </button>
        </div>
      )}
    </>
  );
}

/** Files attached to the ticket. Downloads always save to disk; nothing renders inside the app. */
export function AttachmentsSection(props: {
  ticketId: number;
  memberId: number | null;
  canEdit: boolean;
  canDeleteAny: boolean;
  onError: (m: string | null) => void;
}) {
  const [items, setItems] = useState<TicketAttachment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { ticketId, onError } = props;

  const load = useCallback(() => {
    listAttachments(ticketId)
      .then((r) => setItems(r.items))
      .catch((e) => onError(msg(e)));
  }, [ticketId, onError]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onError(null);
      load();
    } catch (e) {
      onError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h4>Attachments</h4>
      {items === null ? (
        <div className="state">Loading…</div>
      ) : items.length === 0 ? (
        <div className="state">No files attached.</div>
      ) : (
        <ul className="plain-list">
          {items.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="link"
                onClick={() => run(() => downloadAttachment(a))}
              >
                {a.fileName}
              </button>
              <span className="muted">
                {" "}
                · {size(a.sizeBytes)} · {new Date(a.createdAt).toLocaleDateString()}
              </span>
              {props.canEdit &&
                (props.canDeleteAny ||
                  props.memberId === null ||
                  a.uploadedByMemberId === props.memberId) && (
                  <button
                    type="button"
                    className="link"
                    disabled={busy}
                    aria-label={`Remove ${a.fileName}`}
                    onClick={() => run(() => deleteAttachment(ticketId, a.id))}
                  >
                    {" "}
                    remove
                  </button>
                )}
            </li>
          ))}
        </ul>
      )}
      {props.canEdit && (
        <label className="btn">
          {busy ? "Working…" : "Attach a file"}
          <input
            type="file"
            hidden
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void run(() => uploadAttachment(ticketId, file));
            }}
          />
        </label>
      )}
    </>
  );
}
