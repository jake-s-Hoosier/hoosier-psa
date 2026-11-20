import type { BillingRun, BillingRunPreview, Invoice, InvoiceLine } from "@hoosier/shared";
import { useCallback, useEffect, useState } from "react";
import {
  createBillingRun,
  deleteInvoice,
  deleteInvoiceLine,
  discardBillingRun,
  getBillingRun,
  getInvoice,
  listBillingRuns,
  listInvoices,
  postBillingRun,
  previewBillingRun,
  updateInvoice,
  updateInvoiceLine,
  voidInvoice,
} from "./api";
import { msg, shortDate, usd } from "./common";
import { Link, navigate } from "./router";

const OPERATING_TZ = "America/Indiana/Indianapolis";
const todayIso = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: OPERATING_TZ }).format(new Date());

/** Invoice and run states reuse the badge colours of the other screens. */
const BADGE: Record<string, string> = {
  draft: "pending",
  posted: "approved",
  partially_paid: "submitted",
  paid: "active",
  void: "cancelled",
  discarded: "cancelled",
};
const STATUS_LABEL: Record<string, string> = {
  draft: "draft",
  posted: "posted",
  partially_paid: "part paid",
  paid: "paid",
  void: "void",
  discarded: "discarded",
};
const Badge = ({ status }: { status: string }) => (
  <span className={`badge status-${BADGE[status] ?? "pending"}`}>
    {STATUS_LABEL[status] ?? status}
  </span>
);
const number = (i: Invoice) => (i.invoiceNumber === null ? "—" : `#${i.invoiceNumber}`);
const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

type Tab = "runs" | "invoices";

export function BillingPage(props: { can: (key: string) => boolean; routeId: number | null }) {
  const [tab, setTab] = useState<Tab>(props.routeId ? "invoices" : "runs");
  // A link to #/billing/<invoice> opens the invoice list.
  useEffect(() => {
    if (props.routeId) setTab("invoices");
  }, [props.routeId]);
  return (
    <>
      <div className="page-header">
        <h2>Billing</h2>
        <div className="tabs" role="tablist">
          {(["runs", "invoices"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === t}
              onClick={() => {
                setTab(t);
                if (props.routeId) navigate("/billing");
              }}
            >
              {t === "runs" ? "Billing runs" : "Invoices"}
            </button>
          ))}
        </div>
      </div>
      {tab === "runs" && <RunsTab can={props.can} />}
      {tab === "invoices" && <InvoicesTab can={props.can} routeId={props.routeId} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

function RunsTab({ can }: { can: (key: string) => boolean }) {
  const [runs, setRuns] = useState<BillingRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);
  const refresh = () => setReload((n) => n + 1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const ctl = new AbortController();
    listBillingRuns(ctl.signal)
      .then((r) => {
        setRuns(r.items);
        setError(null);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(msg(e));
      });
    return () => ctl.abort();
  }, [reload]);

  return (
    <div className="split">
      <div className="card">
        <div className="toolbar">
          <span className="muted">
            A run bills every agreement whose cycle starts in the month, in advance, as draft
            invoices to review before posting.
          </span>
          {can("billing.invoice.write") && (
            <button type="button" className="btn primary" onClick={() => setCreating(true)}>
              New billing run
            </button>
          )}
        </div>
        {error && <div className="state error">{error}</div>}
        {!runs && !error && <div className="state">Loading…</div>}
        {runs && runs.length === 0 && (
          <div className="state">No billing runs yet. Start one to see draft invoices.</div>
        )}
        {runs && runs.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Invoice date</th>
                <th>Status</th>
                <th className="num">Invoices</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className={r.id === selected ? "selected" : undefined}>
                  <td>
                    <button type="button" className="link" onClick={() => setSelected(r.id)}>
                      {monthLabel(r.periodMonth)}
                    </button>
                  </td>
                  <td>{shortDate(r.invoiceDate)}</td>
                  <td>
                    <Badge status={r.status} />
                  </td>
                  <td className="num">{r.invoiceCount}</td>
                  <td className="num">{usd(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {selected !== null && (
        <RunPanel
          key={`${selected}-${reload}`}
          id={selected}
          can={can}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      )}
      {creating && (
        <NewRunDialog
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            setSelected(r.id);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function RunPanel(props: {
  id: number;
  can: (key: string) => boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [run, setRun] = useState<BillingRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"post" | "discard" | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    getBillingRun(props.id, ctl.signal)
      .then(setRun)
      .catch((e) => {
        if (!ctl.signal.aborted) setError(msg(e));
      });
    return () => ctl.abort();
  }, [props.id]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setConfirm(null);
      props.onChanged();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };

  if (!run) {
    return (
      <aside className="card card-pad detail wide-detail">
        {error ? <div className="state error">{error}</div> : <div className="state">Loading…</div>}
      </aside>
    );
  }
  const invoices = run.invoices ?? [];
  const warned = invoices.filter((i) => i.warnings.length > 0).length;
  return (
    <aside className="card card-pad detail wide-detail" aria-label={`Run ${run.periodMonth}`}>
      <div className="detail-head">
        <div>
          <h3>{monthLabel(run.periodMonth)}</h3>
          <div className="muted">
            Invoice date {shortDate(run.invoiceDate)} · <Badge status={run.status} />
          </div>
        </div>
        <button type="button" className="btn" onClick={props.onClose} aria-label="Close details">
          ×
        </button>
      </div>
      {error && <div className="state error">{error}</div>}
      <div className="stats">
        <div className="stat">
          <strong>{run.invoiceCount}</strong>
          <span>Invoices</span>
        </div>
        <div className="stat">
          <strong>{usd(run.total)}</strong>
          <span>Total</span>
        </div>
        <div className="stat">
          <strong>{warned}</strong>
          <span>With warnings</span>
        </div>
      </div>
      {run.status === "draft" && (
        <div className="field-row end">
          {props.can("billing.invoice.write") && (
            <button type="button" className="btn" onClick={() => setConfirm("discard")}>
              Discard run
            </button>
          )}
          {props.can("billing.invoice.post") && (
            <button type="button" className="btn primary" onClick={() => setConfirm("post")}>
              Post run
            </button>
          )}
        </div>
      )}
      {confirm && (
        <div className="state">
          {confirm === "post"
            ? `Posting numbers ${invoices.length} invoice${invoices.length === 1 ? "" : "s"} and freezes them. Voiding is the only way back.`
            : "Discarding deletes these draft invoices; the periods can be billed again."}{" "}
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() =>
              act(() => (confirm === "post" ? postBillingRun(run.id) : discardBillingRun(run.id)))
            }
          >
            {confirm === "post" ? "Post now" : "Discard now"}
          </button>{" "}
          <button type="button" className="btn" onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>Customer</th>
            <th>No.</th>
            <th className="num">Total</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id}>
              <td>
                <Link to={`/billing/${i.id}`}>{i.company}</Link>
              </td>
              <td>{number(i)}</td>
              <td className="num">{usd(i.total)}</td>
              <td>
                {i.warnings.length > 0 && (
                  <span title={i.warnings.join("\n")}>⚠ {i.warnings.length}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </aside>
  );
}

function NewRunDialog(props: { onClose: () => void; onCreated: (r: BillingRun) => void }) {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [invoiceDate, setInvoiceDate] = useState(todayIso());
  const [preview, setPreview] = useState<BillingRunPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
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
    <dialog open className="dialog wide" aria-label="New billing run">
      <h3>New billing run</h3>
      {error && <div className="state error">{error}</div>}
      <div className="field-row">
        <label>
          Month to bill
          <input
            className="input"
            type="month"
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <label>
          Invoice date
          <input
            className="input"
            type="date"
            value={invoiceDate}
            onChange={(e) => {
              setInvoiceDate(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <button
          type="button"
          className="btn"
          disabled={busy || !month || !invoiceDate}
          onClick={() => run(async () => setPreview(await previewBillingRun(month, invoiceDate)))}
        >
          Preview
        </button>
      </div>
      {preview && (
        <>
          <p className="muted small">
            Nothing is saved yet. {preview.invoices.length} invoice
            {preview.invoices.length === 1 ? "" : "s"} totalling {usd(preview.total)}
            {preview.skipped.length > 0 && `; ${preview.skipped.length} agreements skipped`}.
          </p>
          {preview.invoices.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th className="num">Lines</th>
                  <th className="num">Tax</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {preview.invoices.map((i) => (
                  <tr key={i.companyId}>
                    <td>
                      {i.company}
                      {i.warnings.length > 0 && (
                        <span title={i.warnings.join("\n")}> ⚠ {i.warnings.length}</span>
                      )}
                    </td>
                    <td className="num">{i.lineCount}</td>
                    <td className="num">{usd(i.taxTotal)}</td>
                    <td className="num">{usd(i.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {preview.skipped.length > 0 && (
            <details>
              <summary className="muted small">Skipped agreements</summary>
              <ul className="small">
                {preview.skipped.map((s) => (
                  <li key={s.agreementId}>
                    {s.company} · {s.agreement}: {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !preview || preview.invoices.length === 0}
          onClick={() =>
            run(async () => props.onCreated(await createBillingRun(month, invoiceDate)))
          }
        >
          Create draft invoices
        </button>
      </div>
    </dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------------------------

function InvoicesTab(props: { can: (key: string) => boolean; routeId: number | null }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [items, setItems] = useState<Invoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const refresh = () => setReload((n) => n + 1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => {
      listInvoices({ q, status }, ctl.signal)
        .then((r) => {
          setItems(r.items);
          setError(null);
        })
        .catch((e) => {
          if (!ctl.signal.aborted) setError(msg(e));
        });
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, status, reload]);

  return (
    <div className="split">
      <div className="card">
        <div className="toolbar">
          <input
            className="input"
            placeholder="Search by customer, number or PO"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search invoices"
          />
          <select
            className="input"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Status"
          >
            <option value="all">All</option>
            <option value="draft">Draft</option>
            <option value="open">Open</option>
            <option value="paid">Paid</option>
            <option value="void">Void</option>
          </select>
        </div>
        {error && <div className="state error">{error}</div>}
        {!items && !error && <div className="state">Loading…</div>}
        {items && items.length === 0 && <div className="state">No invoices match.</div>}
        {items && items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>No.</th>
                <th>Customer</th>
                <th>Date</th>
                <th>Status</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className={i.id === props.routeId ? "selected" : undefined}>
                  <td>
                    <Link to={`/billing/${i.id}`}>{number(i)}</Link>
                  </td>
                  <td>{i.company}</td>
                  <td>{shortDate(i.invoiceDate)}</td>
                  <td>
                    <Badge status={i.status} />
                  </td>
                  <td className="num">{usd(i.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {props.routeId !== null && (
        <InvoicePanel
          key={props.routeId}
          id={props.routeId}
          can={props.can}
          onClose={() => navigate("/billing")}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function InvoicePanel(props: {
  id: number;
  can: (key: string) => boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [inv, setInv] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    { kind: "line"; line: InvoiceLine } | { kind: "header" } | { kind: "void" } | null
  >(null);

  const load = useCallback(() => {
    getInvoice(props.id)
      .then((i) => {
        setInv(i);
        setError(null);
      })
      .catch((e) => setError(msg(e)));
  }, [props.id]);
  useEffect(() => {
    load();
  }, [load]);

  const changed = (next?: Invoice) => {
    setDialog(null);
    if (next) setInv(next);
    else load();
    props.onChanged();
  };
  const run = async (fn: () => Promise<Invoice | undefined>) => {
    try {
      changed(await fn());
    } catch (e) {
      setError(msg(e));
    }
  };

  if (!inv) {
    return (
      <aside className="card card-pad detail wide-detail">
        {error ? <div className="state error">{error}</div> : <div className="state">Loading…</div>}
      </aside>
    );
  }
  const draft = inv.status === "draft";
  const canEdit = draft && props.can("billing.invoice.write");
  return (
    <aside className="card card-pad detail wide-detail" aria-label={`Invoice ${number(inv)}`}>
      <div className="detail-head">
        <div>
          <h3>
            {inv.invoiceNumber === null ? "Draft invoice" : `Invoice ${number(inv)}`}{" "}
            <Badge status={inv.status} />
          </h3>
          <div className="muted">
            <Link to={`/companies/${inv.companyId}`}>{inv.company}</Link>
            {inv.runId && " · from a billing run"}
          </div>
        </div>
        <button type="button" className="btn" onClick={props.onClose} aria-label="Close details">
          ×
        </button>
      </div>
      {error && <div className="state error">{error}</div>}
      {inv.warnings.length > 0 && (
        <div className="notice">
          {inv.warnings.map((w) => (
            <div key={w}>⚠ {w}</div>
          ))}
        </div>
      )}
      <dl className="terms">
        <dt>Invoice date</dt>
        <dd>{shortDate(inv.invoiceDate)}</dd>
        <dt>Due</dt>
        <dd>
          {shortDate(inv.dueDate)}
          {inv.terms && ` · ${inv.terms}`}
        </dd>
        {inv.poNumber && (
          <>
            <dt>PO</dt>
            <dd>{inv.poNumber}</dd>
          </>
        )}
        {inv.notes && (
          <>
            <dt>Notes</dt>
            <dd>{inv.notes}</dd>
          </>
        )}
        {inv.voidReason && (
          <>
            <dt>Void reason</dt>
            <dd>{inv.voidReason}</dd>
          </>
        )}
      </dl>
      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th className="num">Qty</th>
            <th className="num">Amount</th>
            {canEdit && <th />}
          </tr>
        </thead>
        <tbody>
          {(inv.lines ?? []).map((l) => (
            <tr key={l.id}>
              <td>
                {l.description}
                {l.periodStart && l.periodEnd && (
                  <div className="muted small">
                    {shortDate(l.periodStart)} – {shortDate(l.periodEnd)}
                    {l.taxable ? " · taxable" : ""}
                  </div>
                )}
              </td>
              <td className="num">{Number(l.quantity)}</td>
              <td className="num">{usd(l.amount)}</td>
              {canEdit && (
                <td className="num">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setDialog({ kind: "line", line: l })}
                  >
                    Edit
                  </button>{" "}
                  <button
                    type="button"
                    className="btn"
                    aria-label={`Remove ${l.description}`}
                    onClick={() => run(() => deleteInvoiceLine(inv.id, l.id))}
                  >
                    ×
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>Subtotal</td>
            <td className="num">{usd(inv.subtotal)}</td>
            {canEdit && <td />}
          </tr>
          <tr>
            <td colSpan={2}>
              Tax{inv.taxExempt ? " (exempt)" : inv.taxCode ? ` · ${inv.taxCode}` : ""}
            </td>
            <td className="num">{usd(inv.taxTotal)}</td>
            {canEdit && <td />}
          </tr>
          <tr>
            <td colSpan={2}>
              <strong>Total</strong>
            </td>
            <td className="num">
              <strong>{usd(inv.total)}</strong>
            </td>
            {canEdit && <td />}
          </tr>
        </tfoot>
      </table>
      <div className="field-row end">
        {canEdit && (
          <>
            <button
              type="button"
              className="btn"
              onClick={() =>
                run(async () => {
                  await deleteInvoice(inv.id);
                  props.onClose();
                  return undefined;
                })
              }
            >
              Delete draft
            </button>
            <button type="button" className="btn" onClick={() => setDialog({ kind: "header" })}>
              Edit details
            </button>
          </>
        )}
        {inv.status !== "draft" && inv.status !== "void" && props.can("billing.invoice.post") && (
          <button type="button" className="btn" onClick={() => setDialog({ kind: "void" })}>
            Void invoice
          </button>
        )}
      </div>
      {dialog?.kind === "line" && (
        <LineDialog
          invoice={inv}
          line={dialog.line}
          onClose={() => setDialog(null)}
          onSaved={changed}
        />
      )}
      {dialog?.kind === "header" && (
        <HeaderDialog invoice={inv} onClose={() => setDialog(null)} onSaved={changed} />
      )}
      {dialog?.kind === "void" && (
        <VoidDialog invoice={inv} onClose={() => setDialog(null)} onSaved={changed} />
      )}
    </aside>
  );
}

function DialogActions(props: {
  onClose: () => void;
  onSave: () => void;
  busy: boolean;
  label: string;
  valid?: boolean;
}) {
  return (
    <div className="field-row end">
      <button type="button" className="btn" onClick={props.onClose}>
        Cancel
      </button>
      <button
        type="button"
        className="btn primary"
        disabled={props.busy || props.valid === false}
        onClick={props.onSave}
      >
        {props.label}
      </button>
    </div>
  );
}

function useSave(onSaved: (i: Invoice) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (fn: () => Promise<Invoice>) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await fn());
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };
  return { busy, error, save };
}

function LineDialog(props: {
  invoice: Invoice;
  line: InvoiceLine;
  onClose: () => void;
  onSaved: (i: Invoice) => void;
}) {
  const l = props.line;
  const [description, setDescription] = useState(l.description);
  const [quantity, setQuantity] = useState(String(Number(l.quantity)));
  const [unitPrice, setUnitPrice] = useState(String(Number(l.unitPrice)));
  const [taxable, setTaxable] = useState(l.taxable);
  const { busy, error, save } = useSave(props.onSaved);
  const pricingChanged =
    Number(quantity) !== Number(l.quantity) || Number(unitPrice) !== Number(l.unitPrice);
  return (
    <dialog open className="dialog" aria-label="Edit invoice line">
      <h3>Edit line</h3>
      {error && <div className="state error">{error}</div>}
      <label>
        Description
        <input
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="field-row">
        <label>
          Quantity
          <input
            className="input"
            type="number"
            step="any"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
        <label>
          Unit price
          <input
            className="input"
            type="number"
            step="any"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
          />
        </label>
      </div>
      <label className="radio">
        <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} />
        Taxable
      </label>
      {pricingChanged && (
        <p className="muted small">
          The line will bill quantity × unit price; any proration from the run is replaced.
        </p>
      )}
      <DialogActions
        onClose={props.onClose}
        busy={busy}
        label="Save"
        valid={description.trim() !== "" && Number(quantity) > 0 && Number(unitPrice) >= 0}
        onSave={() =>
          save(() =>
            updateInvoiceLine(props.invoice.id, l.id, {
              description: description.trim(),
              quantity: Number(quantity),
              unitPrice: Number(unitPrice),
              taxable,
            }),
          )
        }
      />
    </dialog>
  );
}

function HeaderDialog(props: {
  invoice: Invoice;
  onClose: () => void;
  onSaved: (i: Invoice) => void;
}) {
  const i = props.invoice;
  const [invoiceDate, setInvoiceDate] = useState(i.invoiceDate);
  const [dueDate, setDueDate] = useState(i.dueDate);
  const [poNumber, setPoNumber] = useState(i.poNumber ?? "");
  const [notes, setNotes] = useState(i.notes ?? "");
  const { busy, error, save } = useSave(props.onSaved);
  return (
    <dialog open className="dialog" aria-label="Edit invoice details">
      <h3>Invoice details</h3>
      {error && <div className="state error">{error}</div>}
      <div className="field-row">
        <label>
          Invoice date
          <input
            className="input"
            type="date"
            value={invoiceDate}
            onChange={(e) => {
              setInvoiceDate(e.target.value);
              setDueDate("");
            }}
          />
        </label>
        <label>
          Due date
          <input
            className="input"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </label>
      </div>
      <p className="muted small">
        Leave the due date empty to work it out from the customer's terms.
      </p>
      <label>
        PO number
        <input className="input" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
      </label>
      <label>
        Notes
        <textarea
          className="input"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <DialogActions
        onClose={props.onClose}
        busy={busy}
        label="Save"
        valid={invoiceDate !== ""}
        onSave={() =>
          save(() =>
            updateInvoice(i.id, {
              invoiceDate,
              ...(dueDate ? { dueDate } : {}),
              poNumber: poNumber.trim() || null,
              notes: notes.trim() || null,
            }),
          )
        }
      />
    </dialog>
  );
}

function VoidDialog(props: {
  invoice: Invoice;
  onClose: () => void;
  onSaved: (i: Invoice) => void;
}) {
  const [reason, setReason] = useState("");
  const { busy, error, save } = useSave(props.onSaved);
  return (
    <dialog open className="dialog" aria-label="Void invoice">
      <h3>Void invoice {number(props.invoice)}</h3>
      {error && <div className="state error">{error}</div>}
      <label>
        Reason
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <p className="muted small">
        The invoice stays on record with its number. Its agreement periods can be billed again.
      </p>
      <DialogActions
        onClose={props.onClose}
        busy={busy}
        label="Void invoice"
        valid={reason.trim().length >= 3}
        onSave={() => save(() => voidInvoice(props.invoice.id, reason.trim()))}
      />
    </dialog>
  );
}
