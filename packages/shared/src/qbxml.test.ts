import { describe, expect, it } from "vitest";
import { type QbInvoiceInput, qbInvoiceAdd } from "./qbxml.js";

const base: QbInvoiceInput = {
  requestId: "inv-7",
  refNumber: "193400",
  txnDate: "2027-02-01",
  dueDate: "2027-03-03",
  customerListId: "80000001-1",
  termsName: "Net 30",
  salesTaxItem: "Indiana Sales Tax",
  taxExempt: false,
  taxTotal: "7.00",
  poNumber: null,
  memo: null,
  lines: [
    {
      kind: "agreement",
      description: 'Monitoring & "alerts"',
      quantity: "1",
      unitPrice: "100.00",
      amount: "100.00",
      taxable: true,
      itemFullName: "MONITORING",
      serviceDate: null,
    },
    {
      kind: "time",
      description: "Ticket # 49447  Server locked up — labor",
      quantity: "1.5",
      unitPrice: "115",
      amount: "172.50",
      taxable: false,
      itemFullName: null,
      serviceDate: "2027-01-16",
    },
  ],
};

describe("qbInvoiceAdd", () => {
  it("builds the request ConnectWise's invoices imply", () => {
    const r = qbInvoiceAdd(base);
    expect(r.problems).toEqual([]);
    const xml = r.xml as string;
    expect(xml).toContain('<?qbxml version="13.0"?>');
    expect(xml).toContain("<CustomerRef><ListID>80000001-1</ListID></CustomerRef>");
    expect(xml).toContain("<TemplateRef><FullName>Hoosier-Invoice</FullName></TemplateRef>");
    expect(xml).toContain(
      "<ItemSalesTaxRef><FullName>Indiana Sales Tax</FullName></ItemSalesTaxRef>",
    );
    expect(xml).toContain("<RefNumber>193400</RefNumber>");
    expect(xml).toContain("<Desc>Monitoring &amp; &quot;alerts&quot;</Desc>");
    // taxable line gets Tax and an item; labor gets SRV and no item
    expect(xml).toMatch(
      /<ItemRef><FullName>MONITORING<\/FullName><\/ItemRef>.*?<FullName>Tax<\/FullName>/s,
    );
    const labor = xml.split("<InvoiceLineAdd>")[2] as string;
    expect(labor).not.toContain("<ItemRef>");
    expect(labor).toContain("<Quantity>1.5</Quantity>");
    expect(labor).toContain("<ServiceDate>2027-01-16</ServiceDate>");
    expect(labor).toContain("<SalesTaxCodeRef><FullName>SRV</FullName>");
  });

  it("uses Exempt and SRV for a tax-exempt customer", () => {
    const xml = qbInvoiceAdd({ ...base, taxExempt: true, taxTotal: "0.00", salesTaxItem: null })
      .xml as string;
    expect(xml).toContain("<ItemSalesTaxRef><FullName>Exempt</FullName></ItemSalesTaxRef>");
    expect(xml).not.toContain("<FullName>Tax</FullName>");
  });

  it("refuses to build while links are missing, and says what", () => {
    const r = qbInvoiceAdd({
      ...base,
      customerListId: null,
      termsName: null,
      salesTaxItem: null,
      lines: [{ ...(base.lines[0] as QbInvoiceInput["lines"][number]), itemFullName: null }],
    });
    expect(r.xml).toBeNull();
    expect(r.problems).toHaveLength(4);
  });

  it("strips characters XML cannot hold and notes cut text", () => {
    const long = "x".repeat(5000);
    const r = qbInvoiceAdd({ ...base, poNumber: "PO-1234567890123456789012345678", memo: long });
    expect(r.notes).toHaveLength(2);
    expect(r.xml).not.toContain("\u0001");
    const bad = qbInvoiceAdd({ ...base, memo: "a\u0001b" });
    expect(bad.xml).toContain("<Memo>ab</Memo>");
  });
});
