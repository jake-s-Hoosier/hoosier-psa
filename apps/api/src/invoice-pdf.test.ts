import { describe, expect, it } from "vitest";
import { type InvoicePdfData, renderInvoicePdf } from "./invoice-pdf.js";

const base: InvoicePdfData = {
  seller: {
    name: "Hoosier Security",
    lines: ["1 Main St", "Indianapolis, IN 46256"],
    remitNote: "Make checks payable to Hoosier Security.",
  },
  status: "posted",
  invoiceNumber: 1234,
  invoiceId: 9,
  invoiceDate: "2027-01-05",
  dueDate: "2027-02-04",
  terms: "Net 30",
  poNumber: "PO-77",
  notes: null,
  billTo: { name: "Lakeview Manufacturing", lines: ["500 Lake Rd", "Fishers, IN 46037"] },
  taxLabel: "Tax · Indiana 7%",
  lines: [
    {
      description: "Alarm monitoring",
      quantity: "3",
      unitPrice: "39.99",
      amount: "119.97",
      detail: "2027-01-01 to 2027-01-31 · taxable",
    },
  ],
  subtotal: "119.97",
  taxTotal: "8.40",
  total: "128.37",
  payments: [],
  amountPaid: "0.00",
};
const pages = (b: Buffer) => (b.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

describe("renderInvoicePdf", () => {
  it("produces a one-page PDF for a short invoice", async () => {
    const pdf = await renderInvoicePdf(base);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1500);
    expect(pages(pdf)).toBe(1);
  });

  it("flows a long invoice onto more pages and still renders drafts, voids and payments", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({
      description: `Ticket # ${i + 1}  Replace door contact and test the zone with the panel`,
      quantity: "1",
      unitPrice: "10.00",
      amount: "10.00",
    }));
    const long = await renderInvoicePdf({ ...base, lines, total: "800.00", subtotal: "800.00" });
    expect(pages(long)).toBeGreaterThan(1);
    for (const status of ["draft", "void", "paid"] as const) {
      const out = await renderInvoicePdf({
        ...base,
        status,
        invoiceNumber: status === "draft" ? null : 5,
        payments: [{ date: "2027-01-20", label: "check 1001", amount: "50.00" }],
        amountPaid: "50.00",
      });
      expect(out.subarray(0, 5).toString()).toBe("%PDF-");
    }
  });
});
