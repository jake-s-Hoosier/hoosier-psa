import type {
  BillingMilestone,
  MilestoneKind,
  Opportunity,
  OrderLineKind,
  ProjectBillingMethod,
  SalesOrder,
  SalesOrderLine,
} from "@hoosier/shared";
import { useCallback, useEffect, useState } from "react";
import { ExternalRefs } from "./OpportunitiesPage";
import {
  type MilestoneOwner,
  addMilestone,
  addOrderLine,
  convertOrder,
  createOrder,
  deleteMilestone,
  deleteOrderLine,
  getOrder,
  listMilestonesFor,
  listOrderLines,
  listOrders,
  updateOrder,
} from "./api";
import { msg, usd } from "./common";
import { navigate } from "./router";

const METHOD_LABEL: Record<ProjectBillingMethod, string> = {
  fixed_fee: "Fixed fee",
  actual_rates: "Time and materials (actual rates)",
  not_to_exceed: "Time and materials, not to exceed",
  override_rate: "Time and materials at one rate",
};
const AMOUNT_LABEL: Record<ProjectBillingMethod, string> = {
  fixed_fee: "Fixed fee ($)",
  actual_rates: "",
  not_to_exceed: "Cap ($)",
  override_rate: "Hourly rate ($)",
};
const STATUS_LABEL: Record<SalesOrder["status"], string> = {
  draft: "Draft",
  approved: "Approved",
  converted: "Converted to project",
  canceled: "Canceled",
};

/** Orders for one opportunity: start one, open one to manage lines and milestones, and convert it to a project. */
export function OrdersPanel(props: {
  opportunity: Opportunity;
  canWrite: boolean;
  canConvert: boolean;
}) {
  const [items, setItems] = useState<SalesOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const ctl = new AbortController();
    listOrders({ opportunityId: props.opportunity.id }, ctl.signal)
      .then((r) => setItems(r.items))
      .catch((e) => {
        if (!ctl.signal.aborted) setError(msg(e));
      });
    return () => ctl.abort();
  }, [props.opportunity.id, reload]);

  return (
    <>
      {error && <div className="state error">{error}</div>}
      {items.length === 0 && <div className="state">No sales order yet.</div>}
      {items.length > 0 && (
        <table>
          <tbody>
            {items.map((o) => (
              <tr key={o.id}>
                <td>
                  <button type="button" className="link" onClick={() => setOpenId(o.id)}>
                    {o.name}
                  </button>
                </td>
                <td>{METHOD_LABEL[o.billingMethod]}</td>
                <td className="num">{o.billingAmount ? usd(o.billingAmount) : ""}</td>
                <td>{STATUS_LABEL[o.status]}</td>
                <td>
                  {o.projectId && (
                    <a className="link" href={`#/projects/${o.projectId}`}>
                      Project {o.projectId}
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {props.canWrite && (
        <button type="button" className="btn" onClick={() => setCreating(true)}>
          New sales order
        </button>
      )}
      {creating && (
        <NewOrderDialog
          opportunity={props.opportunity}
          onClose={() => setCreating(false)}
          onCreated={(o) => {
            setCreating(false);
            setReload((n) => n + 1);
            setOpenId(o.id);
          }}
        />
      )}
      {openId !== null && (
        <OrderDialog
          id={openId}
          canWrite={props.canWrite}
          canConvert={props.canConvert}
          onClose={() => {
            setOpenId(null);
            setReload((n) => n + 1);
          }}
        />
      )}
    </>
  );
}

function FeeFields(props: {
  method: ProjectBillingMethod;
  amount: string;
  onMethod: (m: ProjectBillingMethod) => void;
  onAmount: (a: string) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <label>
        How it will be billed
        <select
          className="input"
          value={props.method}
          disabled={props.disabled}
          onChange={(e) => props.onMethod(e.target.value as ProjectBillingMethod)}
        >
          {(Object.keys(METHOD_LABEL) as ProjectBillingMethod[]).map((m) => (
            <option key={m} value={m}>
              {METHOD_LABEL[m]}
            </option>
          ))}
        </select>
      </label>
      {props.method !== "actual_rates" && (
        <label>
          {AMOUNT_LABEL[props.method]}
          <input
            className="input"
            inputMode="decimal"
            value={props.amount}
            disabled={props.disabled}
            onChange={(e) => props.onAmount(e.target.value)}
          />
        </label>
      )}
    </>
  );
}

function NewOrderDialog(props: {
  opportunity: Opportunity;
  onClose: () => void;
  onCreated: (o: SalesOrder) => void;
}) {
  const [method, setMethod] = useState<ProjectBillingMethod>("fixed_fee");
  const [amount, setAmount] = useState(props.opportunity.expectedAmount ?? "");
  const [po, setPo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      props.onCreated(
        await createOrder({
          opportunityId: props.opportunity.id,
          billingMethod: method,
          billingAmount: method === "actual_rates" ? null : Number(amount),
          poNumber: po.trim() || undefined,
        }),
      );
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };
  return (
    <dialog open className="dialog" aria-label="New sales order">
      <h3>New sales order</h3>
      <p className="muted small">
        For {props.opportunity.company}. Fixed fee or time and materials; you can change it until
        the order becomes a project.
      </p>
      {error && <div className="state error">{error}</div>}
      <div className="field-grid">
        <FeeFields method={method} amount={amount} onMethod={setMethod} onAmount={setAmount} />
        <label>
          Customer PO (optional)
          <input className="input" value={po} onChange={(e) => setPo(e.target.value)} />
        </label>
      </div>
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || (method !== "actual_rates" && !(Number(amount) > 0))}
          onClick={go}
        >
          Create
        </button>
      </div>
    </dialog>
  );
}

function OrderDialog(props: {
  id: number;
  canWrite: boolean;
  canConvert: boolean;
  onClose: () => void;
}) {
  const [order, setOrder] = useState<SalesOrder | null>(null);
  const [lines, setLines] = useState<SalesOrderLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<ProjectBillingMethod>("fixed_fee");
  const [amount, setAmount] = useState("");
  const [po, setPo] = useState("");
  const [converting, setConverting] = useState(false);
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const ctl = new AbortController();
    Promise.all([getOrder(props.id, ctl.signal), listOrderLines(props.id, ctl.signal)])
      .then(([o, l]) => {
        setOrder(o);
        setLines(l.items);
        setMethod(o.billingMethod);
        setAmount(o.billingAmount ?? "");
        setPo(o.poNumber ?? "");
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(msg(e));
      });
    return () => ctl.abort();
  }, [props.id, reload]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      refresh();
    } catch (e) {
      setError(msg(e));
    }
  };

  if (!order)
    return (
      <dialog open className="dialog" aria-label="Sales order">
        {error ? <div className="state error">{error}</div> : <div className="state">Loading…</div>}
        <button type="button" className="btn" onClick={props.onClose}>
          Close
        </button>
      </dialog>
    );

  const editable = order.status === "draft" || order.status === "approved";
  const canEdit = props.canWrite && editable;
  const dirty =
    method !== order.billingMethod ||
    (method !== "actual_rates" && Number(amount) !== Number(order.billingAmount ?? 0)) ||
    po.trim() !== (order.poNumber ?? "");

  return (
    <dialog
      open
      className="dialog wide"
      aria-label="Sales order"
      style={{ width: "min(860px, 94vw)", maxHeight: "90vh", overflow: "auto" }}
    >
      <h3>
        {order.name} <span className="badge">{STATUS_LABEL[order.status]}</span>
      </h3>
      <p className="muted small">{order.company}</p>
      {error && <div className="state error">{error}</div>}

      <div className="field-grid">
        <FeeFields
          method={method}
          amount={amount}
          onMethod={setMethod}
          onAmount={setAmount}
          disabled={!canEdit}
        />
        <label>
          Customer PO
          <input
            className="input"
            value={po}
            disabled={!canEdit}
            onChange={(e) => setPo(e.target.value)}
          />
        </label>
      </div>
      {canEdit && dirty && (
        <button
          type="button"
          className="btn"
          onClick={() =>
            act(() =>
              updateOrder(order.id, {
                billingMethod: method,
                billingAmount: method === "actual_rates" ? null : Number(amount),
                poNumber: po.trim() || null,
              }),
            )
          }
        >
          Save changes
        </button>
      )}

      <h4>Scope and budget</h4>
      <p className="muted small">
        Lines are the budget and bill of materials. They do not create charges. Labor hours become
        the project's budget hours. Lines total {usd(order.linesTotal)}, labor{" "}
        {Number(order.laborHours)} hours.
        {order.billingMethod === "fixed_fee" &&
          order.linesTotal !== order.billingAmount &&
          Number(order.linesTotal) > 0 &&
          canEdit && (
            <>
              {" "}
              <button
                type="button"
                className="link"
                onClick={() =>
                  act(() => updateOrder(order.id, { billingAmount: Number(order.linesTotal) }))
                }
              >
                Use the lines total as the fee
              </button>
            </>
          )}
      </p>
      <LineEditor
        orderId={order.id}
        lines={lines}
        canEdit={canEdit}
        onChanged={refresh}
        setError={setError}
      />

      {order.billingMethod === "fixed_fee" && (
        <>
          <h4>Billing milestones</h4>
          <MilestonesPanel
            owner={{ orderId: order.id }}
            fee={order.billingAmount}
            canWrite={canEdit}
            onChanged={refresh}
          />
        </>
      )}

      <h4>Quotes, estimates and designs</h4>
      <ExternalRefs entityType="sales_order" entityId={order.id} canWrite={canEdit} />

      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Close
        </button>
        {props.canWrite && order.status === "draft" && (
          <button
            type="button"
            className="btn"
            onClick={() => act(() => updateOrder(order.id, { status: "canceled" }))}
          >
            Cancel order
          </button>
        )}
        {props.canWrite && order.status === "canceled" && (
          <button
            type="button"
            className="btn"
            onClick={() => act(() => updateOrder(order.id, { status: "draft" }))}
          >
            Reopen as draft
          </button>
        )}
        {props.canWrite && order.status === "approved" && (
          <button
            type="button"
            className="btn"
            onClick={() => act(() => updateOrder(order.id, { status: "draft" }))}
          >
            Back to draft
          </button>
        )}
        {props.canWrite && order.status === "draft" && (
          <button
            type="button"
            className="btn"
            onClick={() => act(() => updateOrder(order.id, { status: "approved" }))}
          >
            Mark approved
          </button>
        )}
        {order.status === "approved" && props.canConvert && (
          <button type="button" className="btn primary" onClick={() => setConverting(true)}>
            Convert to project
          </button>
        )}
        {order.projectId && (
          <button
            type="button"
            className="btn primary"
            onClick={() => navigate(`/projects/${order.projectId}`)}
          >
            Open project
          </button>
        )}
      </div>
      {converting && (
        <ConvertDialog
          order={order}
          onClose={() => setConverting(false)}
          onDone={(projectId) => navigate(`/projects/${projectId}`)}
        />
      )}
    </dialog>
  );
}

function LineEditor(props: {
  orderId: number;
  lines: SalesOrderLine[];
  canEdit: boolean;
  onChanged: () => void;
  setError: (e: string | null) => void;
}) {
  const [kind, setKind] = useState<OrderLineKind>("material");
  const [description, setDescription] = useState("");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      props.setError(null);
      props.onChanged();
    } catch (e) {
      props.setError(msg(e));
    }
  };
  return (
    <>
      {props.lines.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Description</th>
              <th className="num">Qty / hours</th>
              <th className="num">Price</th>
              <th className="num">Cost</th>
              <th className="num">Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {props.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.kind}</td>
                <td>{l.description}</td>
                <td className="num">{Number(l.quantity)}</td>
                <td className="num">{usd(l.unitPrice)}</td>
                <td className="num">{usd(l.unitCost)}</td>
                <td className="num">{usd(l.lineTotal)}</td>
                <td className="num">
                  {props.canEdit && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => run(() => deleteOrderLine(props.orderId, l.id))}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {props.canEdit && (
        <div className="field-row">
          <select
            className="input"
            aria-label="Line type"
            value={kind}
            onChange={(e) => setKind(e.target.value as OrderLineKind)}
          >
            <option value="labor">Labor</option>
            <option value="material">Material</option>
            <option value="other">Other</option>
          </select>
          <input
            className="input"
            placeholder="Description"
            aria-label="Line description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <input
            className="input"
            placeholder="Qty"
            aria-label="Quantity"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
          <input
            className="input"
            placeholder="Price"
            aria-label="Unit price"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <input
            className="input"
            placeholder="Cost"
            aria-label="Unit cost"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={!description.trim() || !(Number(qty) > 0)}
            onClick={() =>
              run(async () => {
                await addOrderLine(props.orderId, {
                  kind,
                  description: description.trim(),
                  quantity: Number(qty),
                  unitPrice: Number(price) || 0,
                  unitCost: Number(cost) || 0,
                });
                setDescription("");
                setPrice("");
                setCost("");
                setQty("1");
              })
            }
          >
            Add line
          </button>
        </div>
      )}
    </>
  );
}

/** Planned deposit and progress payments of a fixed fee. Shared by orders and projects. */
export function MilestonesPanel(props: {
  owner: MilestoneOwner;
  fee: string | null;
  canWrite: boolean;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<BillingMilestone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<MilestoneKind>("progress");
  const [by, setBy] = useState<"percent" | "amount">("percent");
  const [value, setValue] = useState("");
  const [reload, setReload] = useState(0);
  const ownerKey =
    "orderId" in props.owner ? `o${props.owner.orderId}` : `p${props.owner.projectId}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: ownerKey identifies the owner; reload is a manual trigger
  useEffect(() => {
    const ctl = new AbortController();
    listMilestonesFor(props.owner, ctl.signal)
      .then((r) => setItems(r.items))
      .catch((e) => {
        if (!ctl.signal.aborted) setError(msg(e));
      });
    return () => ctl.abort();
  }, [ownerKey, reload]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      setReload((n) => n + 1);
      props.onChanged?.();
    } catch (e) {
      setError(msg(e));
    }
  };
  const planned = items.reduce((a, m) => a + Number(m.resolvedAmount ?? 0), 0);

  return (
    <>
      {error && <div className="state error">{error}</div>}
      {items.length === 0 && <div className="state">No milestones planned.</div>}
      {items.length > 0 && (
        <table>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td>{m.kind === "deposit" ? "Down payment" : "Progress"}</td>
                <td className="num">{m.percent ? `${Number(m.percent)}%` : ""}</td>
                <td className="num">{m.resolvedAmount ? usd(m.resolvedAmount) : ""}</td>
                <td>{m.billed ? <span className="badge status-paid">Billed</span> : ""}</td>
                <td className="num">
                  {props.canWrite && !m.billed && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => run(() => deleteMilestone(m.id))}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {props.fee && items.length > 0 && (
        <p className="muted small">
          Planned {usd(planned)} of {usd(props.fee)}.
        </p>
      )}
      {props.canWrite && (
        <div className="field-row">
          <input
            className="input"
            placeholder="Name (Deposit, Rough-in…)"
            aria-label="Milestone name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            className="input"
            aria-label="Milestone type"
            value={kind}
            onChange={(e) => setKind(e.target.value as MilestoneKind)}
          >
            <option value="deposit">Down payment</option>
            <option value="progress">Progress</option>
          </select>
          <select
            className="input"
            aria-label="Milestone by"
            value={by}
            onChange={(e) => setBy(e.target.value as "percent" | "amount")}
          >
            <option value="percent">% of fee</option>
            <option value="amount">$ amount</option>
          </select>
          <input
            className="input"
            placeholder={by === "percent" ? "%" : "$"}
            aria-label="Milestone value"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={!name.trim() || !(Number(value) > 0)}
            onClick={() =>
              run(async () => {
                await addMilestone(props.owner, {
                  name: name.trim(),
                  kind,
                  ...(by === "percent" ? { percent: Number(value) } : { amount: Number(value) }),
                });
                setName("");
                setValue("");
              })
            }
          >
            Add milestone
          </button>
        </div>
      )}
    </>
  );
}

function ConvertDialog(props: {
  order: SalesOrder;
  onClose: () => void;
  onDone: (projectId: number) => void;
}) {
  const [name, setName] = useState(props.order.name);
  const [phases, setPhases] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await convertOrder(props.order.id, {
        projectName: name.trim() || undefined,
        phases: phases
          .split("\n")
          .map((p) => p.trim())
          .filter(Boolean),
      });
      props.onDone(r.projectId);
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };
  return (
    <dialog open className="dialog" aria-label="Convert to project">
      <h3>Convert to project</h3>
      <p className="muted small">
        Creates a project with this order's billing method, fee and PO, carries the milestones and
        links over, and marks the opportunity won.
      </p>
      {error && <div className="state error">{error}</div>}
      <label>
        Project name
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Phases (optional, one per line)
        <textarea
          className="input"
          rows={4}
          value={phases}
          onChange={(e) => setPhases(e.target.value)}
        />
      </label>
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={go}>
          Create project
        </button>
      </div>
    </dialog>
  );
}
