import type { Agreement, AgreementAddition, AgreementDetail } from "@hoosier/shared";
import { useCallback, useEffect, useState } from "react";
import {
  type Lookups,
  addAddition,
  cancelAgreement,
  changeAddition,
  createAgreement,
  endAddition,
  getAgreement,
  listAgreements,
  listCompanies,
  updateAgreement,
} from "./api";
import { hours, msg, shortDate, usd } from "./common";
import { Link, navigate } from "./router";

const OPERATING_TZ = "America/Indiana/Indianapolis";
const todayIso = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: OPERATING_TZ }).format(new Date());
const dayBefore = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

const CYCLE_LABEL: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  semi_annual: "Semi-annual",
  annual: "Annual",
};
const COVERAGE_LABEL: Record<string, string> = {
  none: "No coverage",
  block_hours: "Block hours",
  unlimited_remote: "Unlimited remote",
  covered: "Labor covered",
};

const daysUntil = (iso: string) =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayIso()}T00:00:00Z`)) / 86_400_000);

/** True when the term ends inside its notice window and nobody has cancelled it. */
const renewalSoon = (a: Agreement) =>
  a.endDate !== null &&
  a.cancelledDate === null &&
  daysUntil(a.endDate) >= 0 &&
  daysUntil(a.endDate) <= a.renewalNoticeDays;

function StatusBadge({ a }: { a: Agreement }) {
  return (
    <>
      <span className={`badge status-${a.status}`}>{a.status}</span>
      {renewalSoon(a) && (
        <span className="badge status-submitted">renews {shortDate(a.endDate)}</span>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Agreements screen
// ---------------------------------------------------------------------------------------------

export function AgreementsPage(props: {
  can: (key: string) => boolean;
  lookups: Lookups | null;
  routeId: number | null;
}) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("active");
  const [typeId, setTypeId] = useState(0);
  const [items, setItems] = useState<Agreement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(false);
  const refresh = () => setReload((n) => n + 1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => {
      listAgreements({ q, status, typeId: typeId || undefined }, ctl.signal)
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
  }, [q, status, typeId, reload]);

  const totalRmr = (items ?? []).reduce((s, a) => s + Number(a.rmr), 0);

  return (
    <>
      <div className="page-header">
        <h2>Agreements</h2>
        {props.can("billing.agreement.write") && (
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            New agreement
          </button>
        )}
      </div>
      <div className="split">
        <div className="card">
          <div className="toolbar">
            <input
              className="input"
              placeholder="Search by agreement or company"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search agreements"
            />
            <select
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Status"
            >
              <option value="active">Active</option>
              <option value="pending">Pending</option>
              <option value="expired">Expired</option>
              <option value="cancelled">Cancelled</option>
              <option value="all">All</option>
            </select>
            <select
              className="input"
              value={typeId}
              onChange={(e) => setTypeId(Number(e.target.value))}
              aria-label="Type"
            >
              <option value={0}>All types</option>
              {props.lookups?.agreementTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          {error && <div className="state error">{error}</div>}
          {items === null && !error && <div className="state">Loading…</div>}
          {items?.length === 0 && <div className="state">No agreements match.</div>}
          {items && items.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Agreement</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th className="num">Monthly</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} className={a.id === props.routeId ? "selected" : undefined}>
                    <td>
                      <Link to={`/companies/${a.companyId}`}>{a.company}</Link>
                    </td>
                    <td>
                      <Link to={`/agreements/${a.id}`}>{a.name}</Link>
                    </td>
                    <td className="muted">{a.type}</td>
                    <td>
                      <StatusBadge a={a} />
                    </td>
                    <td className="num">{usd(a.rmr)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4} className="muted">
                    {items.length} {items.length === 1 ? "agreement" : "agreements"} listed
                  </td>
                  <td className="num">
                    <strong>{usd(totalRmr)}</strong>
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
        {props.routeId !== null && (
          <AgreementDetailPanel
            key={props.routeId}
            id={props.routeId}
            canWrite={props.can("billing.agreement.write")}
            lookups={props.lookups}
            onChanged={refresh}
            onClose={() => navigate("/agreements")}
          />
        )}
      </div>
      {creating && props.lookups && (
        <AgreementDialog
          lookups={props.lookups}
          existing={null}
          onClose={() => setCreating(false)}
          onSaved={(a) => {
            setCreating(false);
            refresh();
            navigate(`/agreements/${a.id}`);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------

type Dialog =
  | { kind: "edit" }
  | { kind: "cancel" }
  | { kind: "addLine" }
  | { kind: "change"; line: AgreementAddition }
  | { kind: "end"; line: AgreementAddition };

function AgreementDetailPanel(props: {
  id: number;
  canWrite: boolean;
  lookups: Lookups | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [a, setA] = useState<AgreementDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(() => {
    getAgreement(props.id)
      .then((r) => {
        setA(r);
        setError(null);
      })
      .catch((e) => setError(msg(e)));
  }, [props.id]);
  useEffect(() => {
    load();
  }, [load]);

  const changed = () => {
    setDialog(null);
    load();
    props.onChanged();
  };

  if (error) return <aside className="card card-pad detail">{error}</aside>;
  if (!a) return <aside className="card card-pad detail">Loading…</aside>;

  const today = todayIso();
  const lineState = (l: AgreementAddition) =>
    l.effectiveFrom > today
      ? "upcoming"
      : l.effectiveTo !== null && l.effectiveTo < today
        ? "ended"
        : "current";
  const visible = a.additions.filter((l) => showHistory || lineState(l) !== "ended");
  const margin =
    Number(a.rmr) > 0
      ? (((Number(a.rmr) - Number(a.monthlyCost)) / Number(a.rmr)) * 100).toFixed(1)
      : null;
  const live = a.status === "active" || a.status === "pending";

  return (
    <aside className="card card-pad detail wide-detail" aria-label={`Agreement ${a.name}`}>
      <div className="detail-head">
        <div>
          <h3>{a.name}</h3>
          <div className="muted">
            <Link to={`/companies/${a.companyId}`}>{a.company}</Link>
            {a.billToCompanyId !== a.companyId && (
              <>
                {" · billed to "}
                <Link to={`/companies/${a.billToCompanyId}`}>{a.billToCompany}</Link>
              </>
            )}
          </div>
        </div>
        <button type="button" className="btn" onClick={props.onClose} aria-label="Close details">
          ×
        </button>
      </div>

      <div className="stats">
        <div className="stat">
          <strong>{usd(a.rmr)}</strong>
          <span>Monthly recurring</span>
        </div>
        <div className="stat">
          <strong>{margin === null ? "—" : `${margin}%`}</strong>
          <span>Margin on lines</span>
        </div>
        <div className="stat">
          <strong>{hours(a.serviceHours)}</strong>
          <span>
            Service labor
            {a.ticketCount > 0
              ? ` (${a.ticketCount} ${a.ticketCount === 1 ? "ticket" : "tickets"})`
              : ""}
          </span>
        </div>
        <div className="stat">
          <strong>{usd(a.serviceCost)}</strong>
          <span>Service cost</span>
        </div>
      </div>

      <dl className="terms">
        <dt>Status</dt>
        <dd>
          <StatusBadge a={a} />
          {a.cancelReason && <span className="muted"> {a.cancelReason}</span>}
        </dd>
        <dt>Type</dt>
        <dd>{a.type}</dd>
        <dt>Term</dt>
        <dd>
          {shortDate(a.startDate)} → {a.endDate ? shortDate(a.endDate) : "open-ended"}
          {a.cancelledDate && ` · cancelled after ${shortDate(a.cancelledDate)}`}
          {a.endDate && (
            <span className="muted"> · {a.autoRenew ? "auto-renews" : "does not renew"}</span>
          )}
        </dd>
        <dt>Billing</dt>
        <dd>
          {CYCLE_LABEL[a.billCycle]}, from {shortDate(a.billStartDate)}
        </dd>
        <dt>Coverage</dt>
        <dd>
          {COVERAGE_LABEL[a.coverage]}
          {a.coverage === "block_hours" && a.blockHours !== null
            ? ` · ${hours(Math.max(a.blockHours - a.coveredHours, 0))} left of ${hours(a.blockHours)}`
            : a.coverage !== "none" && ` · ${hours(a.coveredHours)} covered so far`}
        </dd>
        {a.poNumber && (
          <>
            <dt>PO</dt>
            <dd>{a.poNumber}</dd>
          </>
        )}
        {a.notes && (
          <>
            <dt>Notes</dt>
            <dd>{a.notes}</dd>
          </>
        )}
      </dl>
      {props.canWrite && (
        <div className="field-row">
          <button type="button" className="btn" onClick={() => setDialog({ kind: "edit" })}>
            Edit terms
          </button>
          {a.cancelledDate === null && (
            <button type="button" className="btn" onClick={() => setDialog({ kind: "cancel" })}>
              Cancel agreement
            </button>
          )}
        </div>
      )}

      <div className="section-head">
        <h4>Recurring lines</h4>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={showHistory}
            onChange={(e) => setShowHistory(e.target.checked)}
          />{" "}
          Show ended lines
        </label>
        {props.canWrite && live && (
          <button
            type="button"
            className="btn small"
            onClick={() => setDialog({ kind: "addLine" })}
          >
            Add line
          </button>
        )}
      </div>
      {visible.length === 0 && <div className="muted">No recurring lines.</div>}
      {visible.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Line</th>
              <th className="num">Qty</th>
              <th className="num">Price</th>
              <th className="num">Cost</th>
              <th>In effect</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((l) => (
              <tr key={l.id} className={lineState(l) === "ended" ? "dim" : undefined}>
                <td>
                  {l.description}
                  {l.vendor && <div className="muted small">Cost paid to {l.vendor}</div>}
                </td>
                <td className="num">{l.quantity}</td>
                <td className="num">{usd(l.unitPrice)}</td>
                <td className="num">{usd(l.unitCost)}</td>
                <td className="small">
                  {shortDate(l.effectiveFrom)} →{" "}
                  {l.effectiveTo ? shortDate(l.effectiveTo) : "ongoing"}
                  {!l.prorate && <div className="muted">not prorated</div>}
                </td>
                <td className="actions">
                  {props.canWrite && lineState(l) !== "ended" && (
                    <>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => setDialog({ kind: "change", line: l })}
                      >
                        Change
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => setDialog({ kind: "end", line: l })}
                      >
                        End
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        A change to price or quantity ends the current line the day before and starts a new one, so
        earlier months keep the price they were billed at.
      </p>

      {dialog?.kind === "edit" && props.lookups && (
        <AgreementDialog
          lookups={props.lookups}
          existing={a}
          onClose={() => setDialog(null)}
          onSaved={changed}
        />
      )}
      {dialog?.kind === "cancel" && (
        <CancelDialog agreement={a} onClose={() => setDialog(null)} onSaved={changed} />
      )}
      {dialog?.kind === "addLine" && (
        <LineDialog agreement={a} onClose={() => setDialog(null)} onSaved={changed} />
      )}
      {dialog?.kind === "change" && (
        <ChangeLineDialog
          agreement={a}
          line={dialog.line}
          onClose={() => setDialog(null)}
          onSaved={changed}
        />
      )}
      {dialog?.kind === "end" && (
        <EndLineDialog
          agreement={a}
          line={dialog.line}
          onClose={() => setDialog(null)}
          onSaved={changed}
        />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------------

function Actions(props: {
  onClose: () => void;
  onSave: () => void;
  busy: boolean;
  valid: boolean;
  label: string;
}) {
  return (
    <div className="field-row end">
      <button type="button" className="btn" onClick={props.onClose}>
        Cancel
      </button>
      <button
        type="button"
        className="btn primary"
        disabled={props.busy || !props.valid}
        onClick={props.onSave}
      >
        {props.label}
      </button>
    </div>
  );
}

function useSave<T>(onSaved: (r: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (fn: () => Promise<T>) => {
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

function AgreementDialog(props: {
  lookups: Lookups;
  existing: AgreementDetail | null;
  onClose: () => void;
  onSaved: (a: Agreement) => void;
}) {
  const ex = props.existing;
  const types = props.lookups.agreementTypes;
  const [companyQuery, setCompanyQuery] = useState(ex?.company ?? "");
  const [companyId, setCompanyId] = useState<number | null>(ex?.companyId ?? null);
  const [companies, setCompanies] = useState<Array<{ id: number; name: string }>>([]);
  const [typeId, setTypeId] = useState(ex?.typeId ?? types[0]?.id ?? 0);
  const [name, setName] = useState(ex?.name ?? "");
  const [startDate, setStartDate] = useState(ex?.startDate ?? todayIso());
  const [endDate, setEndDate] = useState(ex?.endDate ?? "");
  const [autoRenew, setAutoRenew] = useState(ex?.autoRenew ?? types[0]?.autoRenew ?? true);
  const [notice, setNotice] = useState(String(ex?.renewalNoticeDays ?? 60));
  const [billCycle, setBillCycle] = useState<Agreement["billCycle"]>(
    (ex?.billCycle ?? types[0]?.billCycle ?? "monthly") as Agreement["billCycle"],
  );
  const [billStart, setBillStart] = useState(ex?.billStartDate ?? "");
  const [coverage, setCoverage] = useState<Agreement["coverage"]>(
    (ex?.coverage ?? types[0]?.coverage ?? "none") as Agreement["coverage"],
  );
  const [blockHours, setBlockHours] = useState(ex?.blockHours != null ? String(ex.blockHours) : "");
  const [po, setPo] = useState(ex?.poNumber ?? "");
  const [notes, setNotes] = useState(ex?.notes ?? "");
  const { busy, error, save } = useSave(props.onSaved);

  useEffect(() => {
    if (ex || companyId !== null || companyQuery.trim().length < 2) {
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
  }, [ex, companyId, companyQuery]);

  // A new agreement starts from its type's terms; the person can still change each one.
  const pickType = (id: number) => {
    setTypeId(id);
    const t = types.find((x) => x.id === id);
    if (t && !ex) {
      setBillCycle(t.billCycle as typeof billCycle);
      setCoverage(t.coverage as typeof coverage);
      setAutoRenew(t.autoRenew);
    }
  };

  const valid = name.trim().length > 0 && typeId > 0 && (ex ? true : companyId !== null);
  const common = () => ({
    typeId,
    name: name.trim(),
    startDate,
    endDate: endDate || null,
    autoRenew,
    renewalNoticeDays: Number(notice) || 0,
    billCycle,
    billStartDate: billStart || startDate,
    coverage,
    blockHours: coverage === "block_hours" && blockHours ? Number(blockHours) : null,
    poNumber: po.trim() || null,
    notes: notes.trim() || null,
  });

  return (
    <dialog open className="dialog wide" aria-label={ex ? "Edit agreement" : "New agreement"}>
      <h3>{ex ? "Edit agreement" : "New agreement"}</h3>
      {error && <div className="state error">{error}</div>}
      {ex ? (
        <div className="muted">{ex.company}</div>
      ) : (
        <>
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
      <div className="field-grid">
        <label>
          Name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Type
          <select
            className="input"
            value={typeId}
            onChange={(e) => pickType(Number(e.target.value))}
          >
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Starts
          <input
            className="input"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </label>
        <label>
          Ends (optional)
          <input
            className="input"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </label>
        <label>
          Billing cycle
          <select
            className="input"
            value={billCycle}
            onChange={(e) => setBillCycle(e.target.value as typeof billCycle)}
          >
            {Object.entries(CYCLE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Billing starts
          <input
            className="input"
            type="date"
            value={billStart}
            placeholder={startDate}
            onChange={(e) => setBillStart(e.target.value)}
          />
        </label>
        <label>
          Coverage
          <select
            className="input"
            value={coverage}
            onChange={(e) => setCoverage(e.target.value as typeof coverage)}
          >
            {Object.entries(COVERAGE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {coverage === "block_hours" && (
          <label>
            Block hours
            <input
              className="input"
              inputMode="decimal"
              value={blockHours}
              onChange={(e) => setBlockHours(e.target.value)}
            />
          </label>
        )}
        <label>
          Renewal notice (days)
          <input
            className="input"
            inputMode="numeric"
            value={notice}
            onChange={(e) => setNotice(e.target.value)}
          />
        </label>
        <label>
          Customer PO
          <input className="input" value={po} onChange={(e) => setPo(e.target.value)} />
        </label>
      </div>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={autoRenew}
          onChange={(e) => setAutoRenew(e.target.checked)}
        />{" "}
        Renews automatically at the end of the term
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
      <Actions
        onClose={props.onClose}
        busy={busy}
        valid={valid}
        label={ex ? "Save changes" : "Create agreement"}
        onSave={() =>
          void save(() =>
            ex
              ? updateAgreement(ex.id, common())
              : createAgreement({ companyId: companyId as number, ...common() }),
          )
        }
      />
    </dialog>
  );
}

function CancelDialog(props: { agreement: Agreement; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(todayIso());
  const [reason, setReason] = useState("");
  const { busy, error, save } = useSave(props.onSaved);
  return (
    <dialog open className="dialog" aria-label="Cancel agreement">
      <h3>Cancel {props.agreement.name}</h3>
      {error && <div className="state error">{error}</div>}
      <label>
        Last day of coverage
        <input
          className="input"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <label>
        Reason
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <p className="muted small">
        Recurring lines end on that date. Lines that never started are removed. Past billing is
        kept.
      </p>
      <Actions
        onClose={props.onClose}
        busy={busy}
        valid={reason.trim().length > 0 && date !== ""}
        label="Cancel agreement"
        onSave={() => void save(() => cancelAgreement(props.agreement.id, date, reason.trim()))}
      />
    </dialog>
  );
}

function LineDialog(props: { agreement: Agreement; onClose: () => void; onSaved: () => void }) {
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [from, setFrom] = useState(todayIso());
  const [prorate, setProrate] = useState(true);
  const { busy, error, save } = useSave(props.onSaved);
  const valid =
    description.trim().length > 0 && Number(quantity) > 0 && price !== "" && Number(price) >= 0;
  return (
    <dialog open className="dialog" aria-label="Add recurring line">
      <h3>Add recurring line</h3>
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
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
        <label>
          Price each, per month
          <input
            className="input"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <label>
          Cost each, per month
          <input
            className="input"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </label>
      </div>
      <label>
        Starts
        <input
          className="input"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </label>
      <label className="inline-check">
        <input type="checkbox" checked={prorate} onChange={(e) => setProrate(e.target.checked)} />{" "}
        Prorate a partial first or last month
      </label>
      <Actions
        onClose={props.onClose}
        busy={busy}
        valid={valid}
        label="Add line"
        onSave={() =>
          void save(() =>
            addAddition(props.agreement.id, {
              description: description.trim(),
              quantity: Number(quantity),
              unitPrice: Number(price),
              unitCost: Number(cost) || 0,
              effectiveFrom: from,
              prorate,
            }),
          )
        }
      />
    </dialog>
  );
}

function ChangeLineDialog(props: {
  agreement: Agreement;
  line: AgreementAddition;
  onClose: () => void;
  onSaved: () => void;
}) {
  const l = props.line;
  const [from, setFrom] = useState(todayIso() > l.effectiveFrom ? todayIso() : "");
  const [quantity, setQuantity] = useState(String(l.quantity));
  const [price, setPrice] = useState(String(l.unitPrice));
  const [cost, setCost] = useState(String(l.unitCost));
  const { busy, error, save } = useSave(props.onSaved);
  const differs =
    Number(quantity) !== l.quantity || Number(price) !== l.unitPrice || Number(cost) !== l.unitCost;
  return (
    <dialog open className="dialog" aria-label="Change recurring line">
      <h3>Change {l.description}</h3>
      {error && <div className="state error">{error}</div>}
      <label>
        New terms start
        <input
          className="input"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </label>
      <div className="field-row">
        <label>
          Quantity
          <input
            className="input"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
        <label>
          Price each
          <input
            className="input"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <label>
          Cost each
          <input
            className="input"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </label>
      </div>
      {from && (
        <p className="muted small">The current line ends on {shortDate(dayBefore(from))}.</p>
      )}
      <Actions
        onClose={props.onClose}
        busy={busy}
        valid={
          from !== "" && differs && Number(quantity) > 0 && Number(price) >= 0 && Number(cost) >= 0
        }
        label="Apply change"
        onSave={() =>
          void save(() =>
            changeAddition(props.agreement.id, l.id, {
              effectiveFrom: from,
              quantity: Number(quantity),
              unitPrice: Number(price),
              unitCost: Number(cost),
            }),
          )
        }
      />
    </dialog>
  );
}

function EndLineDialog(props: {
  agreement: Agreement;
  line: AgreementAddition;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(
    todayIso() >= props.line.effectiveFrom ? todayIso() : props.line.effectiveFrom,
  );
  const { busy, error, save } = useSave(props.onSaved);
  return (
    <dialog open className="dialog" aria-label="End recurring line">
      <h3>End {props.line.description}</h3>
      {error && <div className="state error">{error}</div>}
      <label>
        Last day billed
        <input
          className="input"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <Actions
        onClose={props.onClose}
        busy={busy}
        valid={date >= props.line.effectiveFrom}
        label="End line"
        onSave={() => void save(() => endAddition(props.agreement.id, props.line.id, date))}
      />
    </dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Company page card
// ---------------------------------------------------------------------------------------------

export function CompanyAgreements(props: {
  companyId: number;
  canWrite: boolean;
  lookups: Lookups | null;
}) {
  const [items, setItems] = useState<Agreement[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const ctl = new AbortController();
    listAgreements({ companyId: props.companyId, status: "all" }, ctl.signal)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
    return () => ctl.abort();
  }, [props.companyId, reload]);
  const live = (items ?? []).filter((a) => a.status === "active" || a.status === "pending");
  const rmr = live.reduce((s, a) => s + Number(a.rmr), 0);
  return (
    <div className="card card-pad section">
      <div className="section-head">
        <h3>Agreements{items ? ` (${live.length})` : ""}</h3>
        {live.length > 0 && <span className="muted">{usd(rmr)} per month</span>}
        {props.canWrite && props.lookups && (
          <button type="button" className="link" onClick={() => setCreating(true)}>
            New agreement
          </button>
        )}
      </div>
      {items === null && <div className="muted">Loading…</div>}
      {items?.length === 0 && <div className="muted">No agreements.</div>}
      {items && items.length > 0 && (
        <table>
          <tbody>
            {items.map((a) => (
              <tr
                key={a.id}
                className={a.status === "cancelled" || a.status === "expired" ? "dim" : undefined}
              >
                <td>
                  <Link to={`/agreements/${a.id}`}>{a.name}</Link>
                  {a.billToCompanyId !== props.companyId && (
                    <div className="muted small">Billed to {a.billToCompany}</div>
                  )}
                  {a.companyId !== props.companyId && (
                    <div className="muted small">For {a.company}</div>
                  )}
                </td>
                <td className="muted">{a.type}</td>
                <td>
                  <StatusBadge a={a} />
                </td>
                <td className="num">{usd(a.rmr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && props.lookups && (
        <AgreementDialog
          lookups={props.lookups}
          existing={null}
          onClose={() => setCreating(false)}
          onSaved={(a) => {
            setCreating(false);
            setReload((n) => n + 1);
            navigate(`/agreements/${a.id}`);
          }}
        />
      )}
    </div>
  );
}
