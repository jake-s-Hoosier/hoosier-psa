import type { Invoice, Payment } from "@hoosier/shared";
import { paymentMethods } from "@hoosier/shared";
import { useCallback, useEffect, useState } from "react";
import { applyPayment, createPayment, listPayments, unapplyPayment, voidPayment } from "./api";
import { msg, shortDate, usd } from "./common";
import { Link } from "./router";

const OPERATING_TZ = "America/Indiana/Indianapolis";
const todayIso = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: OPERATING_TZ }).format(new Date());
const METHOD: Record<string, string> = {
  check: "Check",
  ach: "ACH",
  card: "Card",
  cash: "Cash",
  wire: "Wire",
  other: "Other",
};
const balanceOf = (i: Invoice) => Number(i.total) - Number(i.amountPaid);

/** Payments received, newest first, with the ones that still have money to apply. */
export function PaymentsTab({ can }: { can: (key: string) => boolean }) {
  const [state, setState] = useState("posted");
  const [items, setItems] = useState<Payment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [voiding, setVoiding] = useState<Payment | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const ctl = new AbortController();
    listPayments({ state }, ctl.signal)
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(msg(e));
      });
    return () => ctl.abort();
  }, [state, reload]);

  return (
    <div className="card">
      <div className="toolbar">
        <select
          className="input"
          aria-label="Show"
          value={state}
          onChange={(e) => setState(e.target.value)}
        >
          <option value="posted">Recorded payments</option>
          <option value="unapplied">Credit on account (not fully applied)</option>
          <option value="void">Voided</option>
          <option value="all">All</option>
        </select>
      </div>
      {error && <div className="state error">{error}</div>}
      {!items && !error && <div className="state">Loading…</div>}
      {items && items.length === 0 && (
        <div className="state">
          No payments here. Record one from an invoice that has a balance.
        </div>
      )}
      {items && items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Received</th>
              <th>Customer</th>
              <th>Method</th>
              <th>Applied to</th>
              <th className="num">Amount</th>
              <th className="num">Unapplied</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td>{shortDate(p.receivedOn)}</td>
                <td>
                  <Link to={`/companies/${p.companyId}`}>{p.company}</Link>
                </td>
                <td>
                  {METHOD[p.method] ?? p.method}
                  {p.reference && <span className="muted"> · {p.reference}</span>}
                  {p.status === "void" && <span className="badge status-cancelled">void</span>}
                </td>
                <td>
                  {p.applications.length === 0
                    ? "—"
                    : p.applications.map((a, n) => (
                        <span key={a.id}>
                          {n > 0 && ", "}
                          <Link to={`/billing/${a.invoiceId}`}>
                            {a.invoiceNumber === null ? `#${a.invoiceId}` : `#${a.invoiceNumber}`}
                          </Link>{" "}
                          <span className="muted">({usd(a.amount)})</span>
                        </span>
                      ))}
                </td>
                <td className="num">{usd(p.amount)}</td>
                <td className="num">
                  {Number(p.unappliedAmount) > 0 ? usd(p.unappliedAmount) : "—"}
                </td>
                <td className="num">
                  {p.status === "posted" && can("billing.payment.write") && (
                    <button type="button" className="btn" onClick={() => setVoiding(p)}>
                      Void
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {voiding && (
        <VoidPaymentDialog
          payment={voiding}
          onClose={() => setVoiding(null)}
          onDone={() => {
            setVoiding(null);
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

function VoidPaymentDialog(props: { payment: Payment; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      await voidPayment(props.payment.id, reason.trim());
      props.onDone();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };
  return (
    <dialog open className="dialog" aria-label="Void payment">
      <h3>
        Void {usd(props.payment.amount)} payment from {props.payment.company}
      </h3>
      {error && <div className="state error">{error}</div>}
      <label>
        Reason
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <p className="muted small">
        The payment stays on record. Any invoices it paid go back to owing that amount.
      </p>
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || reason.trim().length < 3}
          onClick={go}
        >
          Void payment
        </button>
      </div>
    </dialog>
  );
}

/** Record a payment against one invoice; the amount starts at its balance. */
export function RecordPaymentDialog(props: {
  invoice: Invoice;
  onClose: () => void;
  onSaved: () => void;
}) {
  const inv = props.invoice;
  const [amount, setAmount] = useState(balanceOf(inv).toFixed(2));
  const [method, setMethod] = useState<(typeof paymentMethods)[number]>("check");
  const [reference, setReference] = useState("");
  const [receivedOn, setReceivedOn] = useState(todayIso());
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0 && Math.round(value * 100) / 100 === value;
  const over = valid && value > balanceOf(inv) + 0.0001;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // Anything received beyond the balance stays as credit on the customer.
      const applied = Math.min(value, balanceOf(inv));
      await createPayment({
        companyId: inv.companyId,
        receivedOn,
        method,
        reference: reference.trim() || undefined,
        amount: value,
        notes: notes.trim() || undefined,
        applications: [{ invoiceId: inv.id, amount: Math.round(applied * 100) / 100 }],
      });
      props.onSaved();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };
  return (
    <dialog open className="dialog" aria-label="Record payment">
      <h3>Record payment · Invoice #{inv.invoiceNumber}</h3>
      {error && <div className="state error">{error}</div>}
      <div className="field-row">
        <label>
          Amount received
          <input
            className="input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          Date received
          <input
            className="input"
            type="date"
            value={receivedOn}
            onChange={(e) => setReceivedOn(e.target.value)}
          />
        </label>
      </div>
      <div className="field-row">
        <label>
          Method
          <select
            className="input"
            value={method}
            onChange={(e) => setMethod(e.target.value as (typeof paymentMethods)[number])}
          >
            {paymentMethods.map((m) => (
              <option key={m} value={m}>
                {METHOD[m]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Check or reference number
          <input
            className="input"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
      </div>
      <label>
        Notes
        <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <p className="muted small">
        Balance due: {usd(balanceOf(inv))}.
        {over &&
          ` ${usd(value - balanceOf(inv))} over the balance will be kept as credit on this customer.`}
      </p>
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={busy || !valid} onClick={save}>
          Record payment
        </button>
      </div>
    </dialog>
  );
}

/** Payments on one invoice, plus any of this customer's unapplied credit that could pay it. */
export function InvoicePayments(props: {
  invoice: Invoice;
  can: (key: string) => boolean;
  onChanged: () => void;
}) {
  const inv = props.invoice;
  const [mine, setMine] = useState<Payment[]>([]);
  const [credits, setCredits] = useState<Payment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const canWrite = props.can("billing.payment.write");
  const payable =
    (inv.status === "posted" || inv.status === "partially_paid") && balanceOf(inv) > 0;

  const load = useCallback(() => {
    listPayments({ invoiceId: inv.id })
      .then((r) => setMine(r.items))
      .catch((e) => setError(msg(e)));
    if (payable && canWrite)
      listPayments({ state: "unapplied", companyId: inv.companyId })
        .then((r) => setCredits(r.items))
        .catch((e) => setError(msg(e)));
    else setCredits([]);
  }, [inv.id, inv.companyId, payable, canWrite]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the invoice's paid amount changes
  useEffect(() => {
    load();
  }, [load, inv.amountPaid]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      props.onChanged();
    } catch (e) {
      setError(msg(e));
    }
  };

  if (inv.status === "draft" || (mine.length === 0 && !payable)) return null;
  return (
    <section aria-label="Payments">
      <h4>Payments</h4>
      {error && <div className="state error">{error}</div>}
      {mine.length > 0 && (
        <table>
          <tbody>
            {mine.map((p) => {
              const here = p.applications.filter((a) => a.invoiceId === inv.id);
              return here.map((a) => (
                <tr key={`${p.id}-${a.id}`}>
                  <td>
                    {shortDate(p.receivedOn)} · {METHOD[p.method] ?? p.method}
                    {p.reference && <span className="muted"> · {p.reference}</span>}
                  </td>
                  <td className="num">{usd(a.amount)}</td>
                  <td className="num">
                    {canWrite && (
                      <button
                        type="button"
                        className="btn"
                        aria-label={`Take back ${usd(a.amount)} from this invoice`}
                        onClick={() => act(() => unapplyPayment(p.id, a.id))}
                      >
                        Take back
                      </button>
                    )}
                  </td>
                </tr>
              ));
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>
                <strong>Balance due</strong>
              </td>
              <td className="num">
                <strong>{usd(balanceOf(inv))}</strong>
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}
      {credits.map((c) => {
        const use = Math.min(Number(c.unappliedAmount), balanceOf(inv));
        return (
          <div key={c.id} className="field-row">
            <span className="muted">
              Credit on account: {usd(c.unappliedAmount)} from {shortDate(c.receivedOn)}
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => act(() => applyPayment(c.id, inv.id, Math.round(use * 100) / 100))}
            >
              Apply {usd(use)}
            </button>
          </div>
        );
      })}
      {payable && canWrite && (
        <div className="field-row end">
          <button type="button" className="btn primary" onClick={() => setRecording(true)}>
            Record payment
          </button>
        </div>
      )}
      {recording && (
        <RecordPaymentDialog
          invoice={inv}
          onClose={() => setRecording(false)}
          onSaved={() => {
            setRecording(false);
            props.onChanged();
          }}
        />
      )}
    </section>
  );
}
