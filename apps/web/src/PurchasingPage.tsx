import type {
  Company,
  ProductChoice,
  Project,
  PurchaseOrder,
  PurchaseOrderStatus,
} from "@hoosier/shared";
import { useCallback, useEffect, useState } from "react";
import {
  type PurchaseOrderDetail,
  addPurchaseOrderLine,
  createPurchaseOrder,
  deletePurchaseOrderLine,
  deleteReceipt,
  getPurchaseOrder,
  listCompanies,
  listProjects,
  listPurchaseOrders,
  purchaseOrderAction,
  receivePurchaseOrder,
  searchProducts,
  updatePurchaseOrder,
} from "./api";
import { msg, shortDate, usd } from "./common";
import { type Route, navigate } from "./router";

const STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  draft: "Draft",
  ordered: "Ordered",
  partial: "Partly received",
  received: "Received",
  closed: "Closed short",
  canceled: "Canceled",
};

export function PurchasingPage(props: { route: Route; canWrite: boolean; canReceive: boolean }) {
  return props.route.id === null ? (
    <PoList canWrite={props.canWrite} />
  ) : (
    <PoDetail
      key={props.route.id}
      id={props.route.id}
      canWrite={props.canWrite}
      canReceive={props.canReceive}
    />
  );
}

function PoList(props: { canWrite: boolean }) {
  const [status, setStatus] = useState("open");
  const [items, setItems] = useState<PurchaseOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    setItems(null);
    listPurchaseOrders({ status }, ctl.signal)
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(msg(e));
      });
    return () => ctl.abort();
  }, [status]);

  return (
    <>
      <div className="page-header">
        <h2>Purchasing</h2>
        <div className="field-row">
          <label>
            Show
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="open">Not finished (draft, ordered, partly received)</option>
              <option value="ordered">Ordered, nothing received</option>
              <option value="partial">Partly received</option>
              <option value="received">Received</option>
              <option value="closed">Closed short</option>
              <option value="canceled">Canceled</option>
              <option value="all">All</option>
            </select>
          </label>
          {props.canWrite && (
            <button type="button" className="btn primary" onClick={() => setCreating(true)}>
              New purchase order
            </button>
          )}
        </div>
      </div>
      {error && <div className="state error">{error}</div>}
      {!items && !error && <div className="state">Loading…</div>}
      {items && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>PO</th>
                <th>Vendor</th>
                <th>Job</th>
                <th>Status</th>
                <th>Expected</th>
                <th className="num">Total</th>
                <th className="num">Still on order</th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <a className="link" href={`#/purchasing/${o.id}`}>
                      {o.poNumber}
                    </a>
                  </td>
                  <td>{o.vendor}</td>
                  <td>{o.project ?? o.salesOrder ?? (o.ticketId ? `Ticket ${o.ticketId}` : "")}</td>
                  <td>{STATUS_LABEL[o.status]}</td>
                  <td>{o.expectedDate ? shortDate(o.expectedDate) : ""}</td>
                  <td className="num">{usd(o.total)}</td>
                  <td className="num">{Number(o.openValue) > 0 ? usd(o.openValue) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && <div className="state">No purchase orders here.</div>}
        </div>
      )}
      {creating && (
        <NewPoDialog
          onClose={() => setCreating(false)}
          onCreated={(o) => {
            setCreating(false);
            navigate(`/purchasing/${o.id}`);
          }}
        />
      )}
    </>
  );
}

function NewPoDialog(props: { onClose: () => void; onCreated: (o: PurchaseOrder) => void }) {
  const [q, setQ] = useState("");
  const [vendors, setVendors] = useState<Company[]>([]);
  const [vendorId, setVendorId] = useState<number | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [expected, setExpected] = useState("");
  const [ref, setRef] = useState("");
  const [shipTo, setShipTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    listCompanies(q, ctl.signal)
      .then((r) => setVendors(r.items.filter((c) => c.isVendor)))
      .catch(() => undefined);
    return () => ctl.abort();
  }, [q]);
  useEffect(() => {
    listProjects({ state: "active" })
      .then((r) => setProjects(r.items))
      .catch(() => undefined);
  }, []);

  const go = async () => {
    if (vendorId === null) return;
    setBusy(true);
    try {
      props.onCreated(
        await createPurchaseOrder({
          vendorCompanyId: vendorId,
          projectId: projectId ? Number(projectId) : undefined,
          expectedDate: expected || undefined,
          vendorReference: ref.trim() || undefined,
          shipTo: shipTo.trim() || undefined,
        }),
      );
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };

  return (
    <dialog open className="dialog" aria-label="New purchase order">
      <h3>New purchase order</h3>
      <p className="muted small">
        Only companies marked as a vendor on their company page can be ordered from. Nothing is sent
        to the vendor from here.
      </p>
      {error && <div className="state error">{error}</div>}
      <div className="field-grid">
        <label>
          Find vendor
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label>
          Vendor
          <select
            className="input"
            value={vendorId ?? ""}
            onChange={(e) => setVendorId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Choose…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          For project (optional)
          <select
            className="input"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">None</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Expected on
          <input
            className="input"
            type="date"
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
          />
        </label>
        <label>
          Vendor's order number
          <input className="input" value={ref} onChange={(e) => setRef(e.target.value)} />
        </label>
        <label>
          Ship to
          <input className="input" value={shipTo} onChange={(e) => setShipTo(e.target.value)} />
        </label>
      </div>
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || vendorId === null}
          onClick={go}
        >
          Create draft
        </button>
      </div>
    </dialog>
  );
}

function PoDetail(props: { id: number; canWrite: boolean; canReceive: boolean }) {
  const [data, setData] = useState<PurchaseOrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const ctl = new AbortController();
    getPurchaseOrder(props.id, ctl.signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(msg(e));
      });
    return () => ctl.abort();
  }, [props.id, reload]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      refresh();
    } catch (e) {
      setError(msg(e));
    }
  };

  if (!data)
    return error ? (
      <div className="state error">{error}</div>
    ) : (
      <div className="state">Loading…</div>
    );
  const { order, lines, receipts } = data;
  const draft = order.status === "draft";
  const receivable = order.status === "ordered" || order.status === "partial";

  return (
    <>
      <div className="page-header">
        <h2>
          {order.poNumber}: {order.vendor}
        </h2>
        <div className="field-row">
          <a className="btn" href="#/purchasing">
            All purchase orders
          </a>
          {props.canWrite && draft && (
            <button
              type="button"
              className="btn primary"
              disabled={lines.length === 0}
              onClick={() => run(() => purchaseOrderAction(order.id, "place"))}
            >
              Mark as ordered
            </button>
          )}
          {props.canReceive && receivable && (
            <button type="button" className="btn primary" onClick={() => setReceiving(true)}>
              Receive items
            </button>
          )}
          {props.canWrite && order.status === "partial" && (
            <button
              type="button"
              className="btn"
              onClick={() => run(() => purchaseOrderAction(order.id, "close"))}
            >
              Close short
            </button>
          )}
          {props.canWrite && (draft || order.status === "ordered") && (
            <button
              type="button"
              className="btn"
              onClick={() => run(() => purchaseOrderAction(order.id, "cancel"))}
            >
              Cancel order
            </button>
          )}
        </div>
      </div>
      {error && <div className="state error">{error}</div>}
      <div className="card">
        <div className="field-grid">
          <div>
            <div className="muted small">Status</div>
            <strong>{STATUS_LABEL[order.status]}</strong>
          </div>
          <div>
            <div className="muted small">Job</div>
            <strong>
              {order.projectId ? (
                <a className="link" href={`#/projects/${order.projectId}`}>
                  {order.project}
                </a>
              ) : (
                (order.salesOrder ?? (order.ticketId ? `Ticket ${order.ticketId}` : "None"))
              )}
            </strong>
          </div>
          <div>
            <div className="muted small">Expected</div>
            <strong>{order.expectedDate ? shortDate(order.expectedDate) : "Not set"}</strong>
          </div>
          <div>
            <div className="muted small">Vendor's order number</div>
            <strong>{order.vendorReference ?? "Not set"}</strong>
          </div>
          <div>
            <div className="muted small">Total (with {usd(order.shippingCost)} shipping)</div>
            <strong>{usd(order.total)}</strong>
          </div>
          <div>
            <div className="muted small">Received / still on order</div>
            <strong>
              {usd(order.receivedValue)} / {usd(order.openValue)}
            </strong>
          </div>
        </div>
        {order.shipTo && <p className="muted small">Ship to: {order.shipTo}</p>}
        {order.notes && <p className="small">{order.notes}</p>}
      </div>
      <div className="card">
        <h3>Items</h3>
        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th className="num">Qty</th>
              <th className="num">Unit cost</th>
              <th className="num">Total</th>
              <th className="num">Received</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td className="num">{Number(l.quantity)}</td>
                <td className="num">{usd(l.unitCost)}</td>
                <td className="num">{usd(l.lineTotal)}</td>
                <td className="num">{Number(l.quantityReceived)}</td>
                <td>
                  {props.canWrite && draft && (
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => run(() => deletePurchaseOrderLine(l.id))}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {lines.length === 0 && <div className="state">No items yet.</div>}
        {props.canWrite && draft && (
          <AddLine poId={order.id} onAdded={refresh} onError={setError} />
        )}
        {props.canWrite && (draft || receivable) && (
          <ShippingEditor order={order} onSaved={refresh} onError={setError} />
        )}
      </div>
      <div className="card">
        <h3>Receipts</h3>
        {receipts.length === 0 && <div className="state">Nothing received yet.</div>}
        {receipts.map((r) => (
          <div key={r.id} className="small" style={{ marginBottom: 8 }}>
            <strong>{shortDate(r.receivedOn)}</strong>
            {r.reference ? `, ${r.reference}` : ""}
            {r.receivedBy ? `, by ${r.receivedBy}` : ""}
            <ul>
              {r.lines.map((l) => (
                <li key={l.id}>
                  {Number(l.quantity)} × {l.description}
                  {l.serialNumbers ? ` (serials: ${l.serialNumbers})` : ""}
                </li>
              ))}
            </ul>
            {props.canWrite && receivable && (
              <button
                type="button"
                className="btn small"
                onClick={() => run(() => deleteReceipt(r.id))}
              >
                Undo this receipt
              </button>
            )}
          </div>
        ))}
      </div>
      {receiving && (
        <ReceiveDialog
          data={data}
          onClose={() => setReceiving(false)}
          onDone={() => {
            setReceiving(false);
            refresh();
          }}
        />
      )}
    </>
  );
}

function AddLine(props: {
  poId: number;
  onAdded: () => void;
  onError: (m: string | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<ProductChoice[]>([]);
  const [product, setProduct] = useState<ProductChoice | null>(null);
  const [description, setDescription] = useState("");
  const [qty, setQty] = useState("1");
  const [cost, setCost] = useState("");

  useEffect(() => {
    if (search.trim().length < 2 || product) {
      setFound([]);
      return;
    }
    const t = setTimeout(() => {
      searchProducts(search)
        .then((r) => setFound(r.items.slice(0, 8)))
        .catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(t);
  }, [search, product]);

  const add = async () => {
    try {
      await addPurchaseOrderLine(props.poId, {
        productId: product?.id,
        description: description.trim() || undefined,
        quantity: Number(qty),
        unitCost: cost === "" ? undefined : Number(cost),
      });
      setProduct(null);
      setSearch("");
      setDescription("");
      setQty("1");
      setCost("");
      props.onAdded();
    } catch (e) {
      props.onError(msg(e));
    }
  };

  return (
    <div className="field-row">
      <label>
        Catalog item
        <input
          className="input"
          value={product ? product.identifier : search}
          onChange={(e) => {
            setProduct(null);
            setSearch(e.target.value);
          }}
        />
        {found.length > 0 && (
          <select
            className="input"
            size={Math.min(found.length, 6)}
            onChange={(e) => {
              const p = found.find((f) => f.id === Number(e.target.value)) ?? null;
              setProduct(p);
              if (p) setCost(Number(p.unitCost).toString());
            }}
          >
            {found.map((p) => (
              <option key={p.id} value={p.id}>
                {p.identifier}: {p.description}
              </option>
            ))}
          </select>
        )}
      </label>
      {!product && (
        <label>
          Or describe it
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      )}
      <label>
        Qty
        <input
          className="input"
          inputMode="decimal"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />
      </label>
      <label>
        Unit cost ($)
        <input
          className="input"
          inputMode="decimal"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="btn"
        disabled={!(Number(qty) > 0) || (!product && !description.trim())}
        onClick={add}
      >
        Add item
      </button>
    </div>
  );
}

function ShippingEditor(props: {
  order: PurchaseOrder;
  onSaved: () => void;
  onError: (m: string | null) => void;
}) {
  const [shipping, setShipping] = useState(Number(props.order.shippingCost).toString());
  const [expected, setExpected] = useState(props.order.expectedDate ?? "");
  const [ref, setRef] = useState(props.order.vendorReference ?? "");
  const save = async () => {
    try {
      await updatePurchaseOrder(props.order.id, {
        shippingCost: Number(shipping) || 0,
        expectedDate: expected || null,
        vendorReference: ref.trim() || null,
      });
      props.onSaved();
    } catch (e) {
      props.onError(msg(e));
    }
  };
  return (
    <div className="field-row">
      <label>
        Shipping ($)
        <input
          className="input"
          inputMode="decimal"
          value={shipping}
          onChange={(e) => setShipping(e.target.value)}
        />
      </label>
      <label>
        Expected on
        <input
          className="input"
          type="date"
          value={expected}
          onChange={(e) => setExpected(e.target.value)}
        />
      </label>
      <label>
        Vendor's order number
        <input className="input" value={ref} onChange={(e) => setRef(e.target.value)} />
      </label>
      <button type="button" className="btn" onClick={save}>
        Save details
      </button>
    </div>
  );
}

function ReceiveDialog(props: {
  data: PurchaseOrderDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const open = props.data.lines.filter((l) => Number(l.quantityOutstanding) > 0);
  const [qty, setQty] = useState<Record<number, string>>(
    Object.fromEntries(open.map((l) => [l.id, Number(l.quantityOutstanding).toString()])),
  );
  const [serials, setSerials] = useState<Record<number, string>>({});
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lines = open
    .map((l) => ({
      poLineId: l.id,
      quantity: Number(qty[l.id] ?? 0),
      serialNumbers: serials[l.id]?.trim() || undefined,
    }))
    .filter((l) => l.quantity > 0);

  const go = async () => {
    setBusy(true);
    try {
      await receivePurchaseOrder(props.data.order.id, {
        reference: reference.trim() || undefined,
        lines,
      });
      props.onDone();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };

  return (
    <dialog open className="dialog" aria-label="Receive items">
      <h3>Receive items on {props.data.order.poNumber}</h3>
      <p className="muted small">
        Enter what actually arrived. The rest stays on order; you cannot receive more than was
        ordered.
      </p>
      {error && <div className="state error">{error}</div>}
      <label>
        Packing slip or tracking number
        <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
      </label>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Still expected</th>
            <th>Received now</th>
            <th>Serial numbers</th>
          </tr>
        </thead>
        <tbody>
          {open.map((l) => (
            <tr key={l.id}>
              <td>{l.description}</td>
              <td className="num">{Number(l.quantityOutstanding)}</td>
              <td>
                <input
                  className="input"
                  aria-label={`Received now: ${l.description}`}
                  inputMode="decimal"
                  value={qty[l.id] ?? ""}
                  onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="input"
                  aria-label={`Serial numbers: ${l.description}`}
                  value={serials[l.id] ?? ""}
                  onChange={(e) => setSerials({ ...serials, [l.id]: e.target.value })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || lines.length === 0}
          onClick={go}
        >
          Record receipt
        </button>
      </div>
    </dialog>
  );
}
