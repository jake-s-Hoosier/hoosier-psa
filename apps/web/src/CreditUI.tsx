import type { CreditMemo, CreditMemoCreate, Invoice } from "@hoosier/shared";
import { useCallback, useEffect, useState } from "react";
import {
  applyCreditMemo,
  createCreditMemo,
  listCreditMemos,
  unapplyCreditMemo,
  voidCreditMemo,
} from "./api";
import { msg, shortDate, usd } from "./common";
import { Link } from "./router";

const OPERATING_TZ = "America/Indiana/Indianapolis";
const todayIso = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: OPERATING_TZ }).format(new Date());
const balanceOf = (i: Invoice) => Number(i.total) - Number(i.amountPaid);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Credit memos, newest first, with the ones that still have credit on account. */
export function CreditMemosTab({ can }: { can: (key: string) => boolean }) {
  const [state, setState] = useState("posted");
  const [items, setItems] = useState<CreditMemo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [voiding, setVoiding] = useState<CreditMemo | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const ctl = new AbortController();
    listCreditMemos({ state }, ctl.signal)
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
          <option value="posted">Issued credit memos</option>
          <option value="unapplied">Credit on account (not fully applied)</option>
          <option value="void">Voided</option>
          <option value="all">All</option>
        </select>
      </div>
      {error && <div className="state error">{error}</div>}
      {!items && !error && <div className="state">Loading…</div>}
      {items && items.length === 0 && (
        <div className="state">No credit memos here. Issue one from an invoice.</div>
      )}
      {items && items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>No.</th>
              <th>Date</th>
              <th>Customer</th>
              <th>Reason</th>
              <th>Applied to</th>
              <th className="num">Total</th>
              <th className="num">Unapplied</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td>
                  #{m.memoNumber}
                  {m.status === "void" && <span className="badge status-cancelled">void</span>}
                </td>
                <td>{shortDate(m.memoDate)}</td>
                <td>
                  <Link to={`/companies/${m.companyId}`}>{m.company}</Link>
                </td>
                <td>
                  {m.reason}
                  {m.sourceInvoiceId && (
                    <span className="muted">
                      {" "}
                      · for{" "}
                      <Link to={`/billing/${m.sourceInvoiceId}`}>
                        invoice #{m.sourceInvoiceNumber}
                      </Link>
                    </span>
                  )}
                </td>
                <td>
                  {m.applications.length === 0
                    ? "—"
                    : m.applications.map((a, n) => (
                        <span key={a.id}>
                          {n > 0 && ", "}
                          <Link to={`/billing/${a.invoiceId}`}>#{a.invoiceNumber}</Link>{" "}
                          <span className="muted">({usd(a.amount)})</span>
                        </span>
                      ))}
                </td>
                <td className="num">{usd(m.total)}</td>
                <td className="num">
                  {Number(m.unappliedAmount) > 0 ? usd(m.unappliedAmount) : "—"}
                </td>
                <td className="num">
                  {m.status === "posted" && can("billing.credit.write") && (
                    <button type="button" className="btn" onClick={() => setVoiding(m)}>
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
        <VoidCreditDialog
          memo={voiding}
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

function VoidCreditDialog(props: { memo: CreditMemo; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      await voidCreditMemo(props.memo.id, reason.trim());
      props.onDone();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };
  return (
    <dialog open className="dialog" aria-label="Void credit memo">
      <h3>
        Void credit memo #{props.memo.memoNumber} ({usd(props.memo.total)})
      </h3>
      {error && <div className="state error">{error}</div>}
      <label>
        Reason
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <p className="muted small">
        The credit memo stays on record. Any invoices it reduced go back to owing that amount.
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
          Void credit memo
        </button>
      </div>
    </dialog>
  );
}

/** Credits on one invoice, credit on account that could pay it, and the button to issue a new credit memo. */
export function InvoiceCredits(props: {
  invoice: Invoice;
  can: (key: string) => boolean;
  onChanged: () => void;
}) {
  const inv = props.invoice;
  const [applied, setApplied] = useState<CreditMemo[]>([]);
  const [credits, setCredits] = useState<CreditMemo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const canWrite = props.can("billing.credit.write");
  const canRead = props.can("billing.credit.read");
  const payable =
    (inv.status === "posted" || inv.status === "partially_paid") && balanceOf(inv) > 0;
  const creditable = inv.status !== "draft" && inv.status !== "void";

  const load = useCallback(() => {
    if (!canRead) return;
    listCreditMemos({ invoiceId: inv.id })
      .then((r) => setApplied(r.items))
      .catch((e) => setError(msg(e)));
    if (payable && canWrite)
      listCreditMemos({ state: "unapplied", companyId: inv.companyId })
        .then((r) => setCredits(r.items))
        .catch((e) => setError(msg(e)));
    else setCredits([]);
  }, [inv.id, inv.companyId, payable, canRead, canWrite]);
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

  const rows = applied.flatMap((m) =>
    m.applications.filter((a) => a.invoiceId === inv.id).map((a) => ({ m, a })),
  );
  const creditSum = rows.reduce((s, r) => s + Number(r.a.amount), 0);
  if (!canRead || (!creditable && rows.length === 0)) return null;
  // Payments show their own balance row; show one here only when credits are all that has been applied.
  const onlyCredits = rows.length > 0 && creditSum >= Number(inv.amountPaid) - 0.001;
  return (
    <section aria-label="Credit memos">
      {(rows.length > 0 || credits.length > 0 || error) && <h4>Credit memos</h4>}
      {error && <div className="state error">{error}</div>}
      {rows.length > 0 && (
        <table>
          <tbody>
            {rows.map(({ m, a }) => (
              <tr key={`${m.id}-${a.id}`}>
                <td>
                  Credit memo #{m.memoNumber} · {shortDate(m.memoDate)}
                  <div className="muted small">{m.reason}</div>
                </td>
                <td className="num">{usd(a.amount)}</td>
                <td className="num">
                  {canWrite && (
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Take back ${usd(a.amount)} credit from this invoice`}
                      onClick={() => act(() => unapplyCreditMemo(m.id, a.id))}
                    >
                      Take back
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {onlyCredits && (
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
          )}
        </table>
      )}
      {credits.map((c) => {
        const use = round2(Math.min(Number(c.unappliedAmount), balanceOf(inv)));
        return (
          <div key={c.id} className="field-row">
            <span className="muted">
              Credit memo #{c.memoNumber} has {usd(c.unappliedAmount)} on account
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => act(() => applyCreditMemo(c.id, inv.id, use))}
            >
              Apply {usd(use)}
            </button>
          </div>
        );
      })}
      {creditable && canWrite && (
        <div className="field-row end">
          <button type="button" className="btn" onClick={() => setIssuing(true)}>
            Issue credit memo
          </button>
        </div>
      )}
      {issuing && (
        <IssueCreditDialog
          invoice={inv}
          onClose={() => setIssuing(false)}
          onSaved={() => {
            setIssuing(false);
            props.onChanged();
          }}
        />
      )}
    </section>
  );
}

interface LineChoice {
  lineId: number;
  description: string;
  maxQty: number;
  unitPrice: number;
  taxable: boolean;
  checked: boolean;
  qty: string;
}

/** Credit lines of this invoice (all or part of each), plus an optional line of any other credit. */
function IssueCreditDialog(props: { invoice: Invoice; onClose: () => void; onSaved: () => void }) {
  const inv = props.invoice;
  const [reason, setReason] = useState("");
  const [memoDate, setMemoDate] = useState(todayIso());
  const [choices, setChoices] = useState<LineChoice[]>(() =>
    (inv.lines ?? []).map((l) => ({
      lineId: l.id,
      description: l.description,
      maxQty: Number(l.quantity),
      unitPrice: Number(l.unitPrice),
      taxable: l.taxable,
      checked: false,
      qty: String(Number(l.quantity)),
    })),
  );
  const [otherText, setOtherText] = useState("");
  const [otherAmount, setOtherAmount] = useState("");
  const [otherTaxable, setOtherTaxable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rate = inv.taxExempt ? 0 : Number(inv.taxRatePct) / 100;
  const picked = choices.filter((c) => c.checked && Number(c.qty) > 0);
  const lineAmount = (c: LineChoice) => round2(Number(c.qty) * c.unitPrice);
  const other = Number(otherAmount);
  const otherOk = otherText.trim() !== "" && Number.isFinite(other) && other > 0;
  const subtotal = picked.reduce((s, c) => s + lineAmount(c), 0) + (otherOk ? round2(other) : 0);
  const taxable =
    picked.filter((c) => c.taxable).reduce((s, c) => s + lineAmount(c), 0) +
    (otherOk && otherTaxable ? round2(other) : 0);
  const tax = round2(taxable * rate);
  const total = round2(subtotal + tax);
  const valid =
    reason.trim().length >= 3 &&
    total > 0 &&
    picked.every((c) => Number(c.qty) <= c.maxQty + 1e-9) &&
    (otherAmount === "" || otherOk || otherText.trim() === "");

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const lines: CreditMemoCreate["lines"] = picked.map((c) => ({
        description: `Credit: ${c.description}`.slice(0, 500),
        quantity: Number(c.qty),
        unitPrice: c.unitPrice,
        taxable: c.taxable,
        sourceLineId: c.lineId,
      }));
      if (otherOk)
        lines.push({
          description: otherText.trim(),
          quantity: 1,
          unitPrice: round2(other),
          taxable: otherTaxable,
        });
      // Credit this invoice first, up to what it still owes; the rest stays as credit on account.
      const toApply = round2(Math.min(total, Math.max(balanceOf(inv), 0)));
      await createCreditMemo({
        companyId: inv.companyId,
        sourceInvoiceId: inv.id,
        memoDate,
        reason: reason.trim(),
        lines,
        applications:
          toApply > 0 && (inv.status === "posted" || inv.status === "partially_paid")
            ? [{ invoiceId: inv.id, amount: toApply }]
            : [],
      });
      props.onSaved();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };

  return (
    <dialog
      open
      className="dialog"
      aria-label="Issue credit memo"
      style={{ width: "min(760px, 92vw)" }}
    >
      <h3>Issue credit memo · Invoice #{inv.invoiceNumber}</h3>
      {error && <div className="state error">{error}</div>}
      <table>
        <thead>
          <tr>
            <th />
            <th>Credit these lines</th>
            <th className="num">Qty</th>
            <th className="num">Credit</th>
          </tr>
        </thead>
        <tbody>
          {choices.map((c, n) => (
            <tr key={c.lineId}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Credit ${c.description}`}
                  checked={c.checked}
                  onChange={(e) =>
                    setChoices(
                      choices.map((x, i) => (i === n ? { ...x, checked: e.target.checked } : x)),
                    )
                  }
                />
              </td>
              <td>{c.description}</td>
              <td className="num">
                <input
                  className="input"
                  style={{ width: "5rem" }}
                  inputMode="decimal"
                  aria-label={`Quantity to credit for ${c.description}`}
                  value={c.qty}
                  disabled={!c.checked}
                  onChange={(e) =>
                    setChoices(choices.map((x, i) => (i === n ? { ...x, qty: e.target.value } : x)))
                  }
                />{" "}
                <span className="muted small">of {c.maxQty}</span>
              </td>
              <td className="num">{c.checked ? usd(lineAmount(c)) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="field-row">
        <label>
          Or another credit
          <input
            className="input"
            placeholder="Description"
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
          />
        </label>
        <label>
          Amount
          <input
            className="input"
            inputMode="decimal"
            value={otherAmount}
            onChange={(e) => setOtherAmount(e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={otherTaxable}
            onChange={(e) => setOtherTaxable(e.target.checked)}
          />{" "}
          Taxable
        </label>
      </div>
      <div className="field-row">
        <label>
          Reason
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <label>
          Date
          <input
            className="input"
            type="date"
            value={memoDate}
            onChange={(e) => setMemoDate(e.target.value)}
          />
        </label>
      </div>
      <p className="muted small">
        Credit {usd(subtotal)} + tax {usd(tax)} = <strong>{usd(total)}</strong>. Balance due on this
        invoice is {usd(balanceOf(inv))}
        {total > balanceOf(inv) && balanceOf(inv) >= 0
          ? `; the other ${usd(total - Math.max(balanceOf(inv), 0))} stays as credit on this customer.`
          : "."}
      </p>
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={busy || !valid} onClick={save}>
          Issue credit memo
        </button>
      </div>
    </dialog>
  );
}
