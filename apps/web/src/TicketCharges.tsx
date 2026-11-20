import type { ProductChoice, TicketCharge } from "@hoosier/shared";
import { useEffect, useState } from "react";
import { addCharge, deleteCharge, listCharges, searchProducts } from "./api";
import { msg, usd } from "./common";

const BILLABLE_LABEL: Record<TicketCharge["billable"], string> = {
  billable: "Billable",
  no_charge: "No charge",
  do_not_bill: "Do not bill",
};

/** Materials and expenses on a ticket. They are billed with the ticket's time by a ticket billing run. */
export function ChargesSection(props: {
  ticketId: number;
  canEdit: boolean;
  onError: (m: string | null) => void;
}) {
  const { ticketId, onError } = props;
  const [items, setItems] = useState<TicketCharge[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<"product" | "expense">("product");
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<ProductChoice[]>([]);
  const [product, setProduct] = useState<ProductChoice | null>(null);
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [taxable, setTaxable] = useState(true);
  const [billable, setBillable] = useState<TicketCharge["billable"]>("billable");

  useEffect(() => {
    listCharges(ticketId)
      .then((r) => setItems(r.items))
      .catch((e) => onError(msg(e)));
  }, [ticketId, onError]);

  useEffect(() => {
    if (search.trim().length < 2 || product) {
      setFound([]);
      return;
    }
    const timer = setTimeout(() => {
      searchProducts(search.trim())
        .then((r) => setFound(r.items))
        .catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [search, product]);

  const choose = (p: ProductChoice) => {
    setProduct(p);
    setSearch(`${p.identifier} · ${p.description}`);
    setDescription(p.description);
    setPrice(String(Number(p.unitPrice)));
    setTaxable(p.taxable);
    setFound([]);
  };
  const reset = () => {
    setProduct(null);
    setSearch("");
    setDescription("");
    setQuantity("1");
    setPrice("");
    setTaxable(kind === "product");
    setBillable("billable");
  };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setItems((await listCharges(ticketId)).items);
      onError(null);
    } catch (e) {
      onError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  const valid =
    Number(quantity) > 0 &&
    (product !== null || description.trim() !== "") &&
    Number(price) >= 0 &&
    price !== "";

  return (
    <>
      <h4>Materials and expenses</h4>
      {items === null ? (
        <div className="state">Loading…</div>
      ) : items.length === 0 ? (
        <div className="state">Nothing charged yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Qty</th>
              <th className="num">Price</th>
              <th className="num">Amount</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.kind === "expense" ? "Expense · " : ""}
                  {c.description}
                  {c.taxable ? "" : " (no tax)"}
                </td>
                <td className="num">{Number(c.quantity)}</td>
                <td className="num">{usd(c.unitPrice)}</td>
                <td className="num">{usd(c.amount)}</td>
                <td>
                  {c.invoiceId !== null
                    ? c.invoiceNumber !== null
                      ? `Invoiced #${c.invoiceNumber}`
                      : "On a draft invoice"
                    : BILLABLE_LABEL[c.billable]}
                </td>
                <td>
                  {props.canEdit && c.invoiceId === null && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      aria-label={`Remove ${c.description}`}
                      onClick={() => run(() => deleteCharge(ticketId, c.id))}
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {props.canEdit && (
        <>
          <div className="field-row">
            <label>
              Type
              <select
                className="input"
                value={kind}
                onChange={(e) => {
                  const k = e.target.value as "product" | "expense";
                  setKind(k);
                  if (!product) setTaxable(k === "product");
                }}
              >
                <option value="product">Material</option>
                <option value="expense">Expense</option>
              </select>
            </label>
            <label>
              Catalog item
              <input
                className="input"
                value={search}
                placeholder="Search by part number or name"
                onChange={(e) => {
                  setSearch(e.target.value);
                  setProduct(null);
                }}
              />
            </label>
          </div>
          {found.length > 0 && (
            <ul className="small">
              {found.map((p) => (
                <li key={p.id}>
                  <button type="button" className="link" onClick={() => choose(p)}>
                    {p.identifier} · {p.description} · {usd(p.unitPrice)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="field-row">
            <label>
              Description
              <input
                className="input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label>
              Qty
              <input
                className="input"
                type="number"
                min="0"
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </label>
            <label>
              Price each
              <input
                className="input"
                type="number"
                min="0"
                step="any"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>
          </div>
          <div className="field-row">
            <label>
              Billing
              <select
                className="input"
                value={billable}
                onChange={(e) => setBillable(e.target.value as TicketCharge["billable"])}
              >
                {(Object.keys(BILLABLE_LABEL) as Array<TicketCharge["billable"]>).map((b) => (
                  <option key={b} value={b}>
                    {BILLABLE_LABEL[b]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={taxable}
                onChange={(e) => setTaxable(e.target.checked)}
              />{" "}
              Taxable
            </label>
            <button
              type="button"
              className="btn"
              disabled={busy || !valid}
              onClick={() =>
                run(async () => {
                  await addCharge(ticketId, {
                    kind,
                    productId: product?.id,
                    description: description.trim() || undefined,
                    quantity: Number(quantity),
                    unitPrice: Number(price),
                    taxable,
                    billable,
                  });
                  reset();
                })
              }
            >
              Add
            </button>
          </div>
        </>
      )}
    </>
  );
}
