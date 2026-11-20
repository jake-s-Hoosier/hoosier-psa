/**
 * QuickBooks Desktop InvoiceAdd, as QBXML (docs/06). Pure text generation: nothing here talks to QuickBooks.
 * The mapping rules were read from two years of invoices ConnectWise pushed (see docs/06, "Mapping findings"):
 *  - one AR account, the "Hoosier-Invoice" template, no class, no customer message, not printed or e-mailed;
 *  - the header sales tax item is the customer's tax code ("Indiana Sales Tax", "Exempt", ...);
 *  - a line's tax code is "Tax" when the line is taxable and the customer is not exempt, otherwise "SRV";
 *  - recurring and product lines carry the product's QuickBooks item; ticket labor lines carry no item and a
 *    description that starts "Ticket # <n>" (downstream reports classify on that text).
 */

/** The QBXML version in the request header. Confirm against the installed QuickBooks Desktop before the first send. */
export const QBXML_VERSION = "13.0";

export const QB_AR_ACCOUNT = "Accounts Receivable (AR)";
export const QB_TEMPLATE = "Hoosier-Invoice";
export const QB_TAXABLE_CODE = "Tax";
export const QB_NON_TAXABLE_CODE = "SRV";
export const QB_EXEMPT_TAX_ITEM = "Exempt";

export interface QbInvoiceLineInput {
  kind: string;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxable: boolean;
  /** The product's QuickBooks item FullName; ticket labor has none. */
  itemFullName: string | null;
  /** Last day the line covers, shown as the line's service date. */
  serviceDate: string | null;
}

export interface QbInvoiceInput {
  requestId: string;
  refNumber: string;
  txnDate: string;
  dueDate: string;
  customerListId: string | null;
  termsName: string | null;
  /** The customer's tax code as named in QuickBooks, for the header sales tax item. */
  salesTaxItem: string | null;
  taxExempt: boolean;
  taxTotal: string;
  poNumber: string | null;
  memo: string | null;
  lines: QbInvoiceLineInput[];
}

export interface QbInvoiceResult {
  /** Null while there are problems that would make QuickBooks reject the invoice. */
  xml: string | null;
  /** Things to fix before this can be sent (missing links) or to be aware of (text cut to fit). */
  problems: string[];
  notes: string[];
}

const MAX_REF = 11;
const MAX_PO = 25;
const MAX_TEXT = 4095;

export const xmlEscape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // control characters are not allowed in XML 1.0
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

const tag = (name: string, value: string | null | undefined) =>
  value === null || value === undefined || value === ""
    ? ""
    : `<${name}>${xmlEscape(value)}</${name}>`;

/** QuickBooks wants plain decimals: quantity up to 5 places, money to 2. */
const qty = (v: string) =>
  Number(v)
    .toFixed(5)
    .replace(/\.?0+$/, "") || "0";
const money = (v: string) => Number(v).toFixed(2);

export function qbInvoiceAdd(input: QbInvoiceInput): QbInvoiceResult {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!input.customerListId)
    problems.push("The customer is not linked to a QuickBooks customer (qb_customer_list_id)");
  if (!input.termsName) problems.push("The invoice's terms have no QuickBooks terms name");
  if (Number(input.taxTotal) > 0 && !input.taxExempt && !input.salesTaxItem)
    problems.push("The invoice charges tax but its tax code has no QuickBooks sales tax name");
  if (input.refNumber.length > MAX_REF)
    problems.push(
      `Invoice number ${input.refNumber} is longer than QuickBooks allows (${MAX_REF})`,
    );
  if (input.lines.length === 0) problems.push("The invoice has no lines");
  for (const l of input.lines) {
    if (l.kind === "agreement" && !l.itemFullName)
      problems.push(`Line "${l.description.slice(0, 40)}" has no QuickBooks item`);
  }
  const cut = (s: string, max: number, what: string) => {
    if (s.length <= max) return s;
    notes.push(`${what} was cut to ${max} characters`);
    return s.slice(0, max);
  };

  if (problems.length > 0) return { xml: null, problems, notes };

  const lines = input.lines
    .map((l) => {
      const code = l.taxable && !input.taxExempt ? QB_TAXABLE_CODE : QB_NON_TAXABLE_CODE;
      return [
        "<InvoiceLineAdd>",
        l.itemFullName ? `<ItemRef>${tag("FullName", l.itemFullName)}</ItemRef>` : "",
        tag("Desc", cut(l.description, MAX_TEXT, "A line description")),
        tag("Quantity", qty(l.quantity)),
        tag("Rate", money(l.unitPrice)),
        tag("Amount", money(l.amount)),
        tag("ServiceDate", l.serviceDate),
        `<SalesTaxCodeRef>${tag("FullName", code)}</SalesTaxCodeRef>`,
        "</InvoiceLineAdd>",
      ].join("");
    })
    .join("");

  const header = [
    `<CustomerRef>${tag("ListID", input.customerListId)}</CustomerRef>`,
    `<ARAccountRef>${tag("FullName", QB_AR_ACCOUNT)}</ARAccountRef>`,
    `<TemplateRef>${tag("FullName", QB_TEMPLATE)}</TemplateRef>`,
    tag("TxnDate", input.txnDate),
    tag("RefNumber", input.refNumber),
    tag("PONumber", input.poNumber ? cut(input.poNumber, MAX_PO, "The PO number") : null),
    `<TermsRef>${tag("FullName", input.termsName)}</TermsRef>`,
    tag("DueDate", input.dueDate),
    input.taxExempt || input.salesTaxItem
      ? `<ItemSalesTaxRef>${tag("FullName", input.taxExempt ? QB_EXEMPT_TAX_ITEM : input.salesTaxItem)}</ItemSalesTaxRef>`
      : "",
    tag("Memo", input.memo ? cut(input.memo, MAX_TEXT, "The memo") : null),
    "<IsToBePrinted>false</IsToBePrinted>",
  ].join("");

  const xml =
    `<?xml version="1.0" encoding="utf-8"?>\n<?qbxml version="${QBXML_VERSION}"?>\n` +
    `<QBXML><QBXMLMsgsRq onError="stopOnError"><InvoiceAddRq requestID="${xmlEscape(input.requestId)}">` +
    `<InvoiceAdd>${header}${lines}</InvoiceAdd></InvoiceAddRq></QBXMLMsgsRq></QBXML>`;
  return { xml, problems, notes };
}
