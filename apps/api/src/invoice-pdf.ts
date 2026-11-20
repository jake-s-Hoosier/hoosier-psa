import PDFDocument from "pdfkit";
import type { Seller } from "./seller.js";

export interface InvoicePdfData {
  seller: Seller;
  status: "draft" | "posted" | "partially_paid" | "paid" | "void";
  invoiceNumber: number | null;
  invoiceId: number;
  invoiceDate: string;
  dueDate: string;
  terms: string | null;
  poNumber: string | null;
  notes: string | null;
  billTo: { name: string; lines: string[] };
  taxLabel: string;
  lines: {
    description: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    detail?: string;
  }[];
  subtotal: string;
  taxTotal: string;
  total: string;
  payments: { date: string; label: string; amount: string }[];
  amountPaid: string;
}

const usd = (n: string | number) =>
  Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
const day = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
const qty = (q: string) => String(Number(q));

const MARGIN = 54;
const GREY = "#555555";

/** Draws an invoice as a letter-size PDF. Pure: the same data gives the same layout. */
export function renderInvoicePdf(d: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = MARGIN;
    const right = doc.page.width - MARGIN;
    const width = right - left;
    const colQty = left + width * 0.55;
    const colPrice = left + width * 0.7;
    const colAmt = left + width * 0.85;

    // Header: seller on the left, invoice facts on the right.
    doc.font("Helvetica-Bold").fontSize(18).text(d.seller.name, left, MARGIN);
    doc.font("Helvetica").fontSize(9).fillColor(GREY);
    for (const l of d.seller.lines) doc.text(l, left);
    doc.fillColor("black");
    const title = d.status === "draft" ? "DRAFT INVOICE" : "INVOICE";
    doc.font("Helvetica-Bold").fontSize(20).text(title, left, MARGIN, { width, align: "right" });
    doc.font("Helvetica").fontSize(10);
    const facts: [string, string][] = [
      ["Invoice #", d.invoiceNumber === null ? "—" : String(d.invoiceNumber)],
      ["Date", day(d.invoiceDate)],
      ["Due", day(d.dueDate)],
    ];
    if (d.terms) facts.push(["Terms", d.terms]);
    if (d.poNumber) facts.push(["PO", d.poNumber]);
    for (const [k, v] of facts) doc.text(`${k}:  ${v}`, left, doc.y, { width, align: "right" });

    // Bill to.
    doc.moveDown(2);
    const billY = Math.max(doc.y, MARGIN + 90);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(GREY).text("BILL TO", left, billY);
    doc.fillColor("black").font("Helvetica-Bold").fontSize(11).text(d.billTo.name, left);
    doc.font("Helvetica").fontSize(10);
    for (const l of d.billTo.lines) doc.text(l, left);

    // Lines.
    const header = (y: number) => {
      doc.font("Helvetica-Bold").fontSize(9).fillColor(GREY);
      doc.text("DESCRIPTION", left, y);
      doc.text("QTY", colQty, y, { width: colPrice - colQty - 8, align: "right" });
      doc.text("PRICE", colPrice, y, { width: colAmt - colPrice - 8, align: "right" });
      doc.text("AMOUNT", colAmt, y, { width: right - colAmt, align: "right" });
      doc
        .moveTo(left, y + 14)
        .lineTo(right, y + 14)
        .strokeColor("#999999")
        .stroke();
      doc.fillColor("black").font("Helvetica").fontSize(10);
      return y + 20;
    };
    let y = header(doc.y + 24);
    for (const l of d.lines) {
      const descWidth = colQty - left - 12;
      const text = l.detail ? `${l.description}\n${l.detail}` : l.description;
      const h = doc.heightOfString(text, { width: descWidth });
      if (y + h > doc.page.height - MARGIN - 130) {
        doc.addPage();
        y = header(MARGIN);
      }
      doc.font("Helvetica").fontSize(10).text(l.description, left, y, { width: descWidth });
      if (l.detail)
        doc.fontSize(8).fillColor(GREY).text(l.detail, left, doc.y, { width: descWidth });
      doc.fillColor("black").fontSize(10);
      doc.text(qty(l.quantity), colQty, y, { width: colPrice - colQty - 8, align: "right" });
      doc.text(usd(l.unitPrice), colPrice, y, { width: colAmt - colPrice - 8, align: "right" });
      doc.text(usd(l.amount), colAmt, y, { width: right - colAmt, align: "right" });
      y += h + 6;
    }

    // Totals (keep together on one page).
    const totalRows: [string, string, boolean][] = [
      ["Subtotal", usd(d.subtotal), false],
      [d.taxLabel, usd(d.taxTotal), false],
      ["Total", usd(d.total), true],
    ];
    for (const p of d.payments)
      totalRows.push([`Payment ${day(p.date)} · ${p.label}`, `-${usd(p.amount)}`, false]);
    const balance = Number(d.total) - Number(d.amountPaid);
    if (d.payments.length > 0 || d.status === "paid")
      totalRows.push(["Balance due", usd(balance), true]);
    const need = totalRows.length * 16 + 60;
    if (y + need > doc.page.height - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
    y += 6;
    doc
      .moveTo(colPrice - 40, y)
      .lineTo(right, y)
      .strokeColor("#999999")
      .stroke();
    y += 8;
    for (const [k, v, bold] of totalRows) {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10);
      doc.text(k, left + width * 0.3, y, {
        width: colAmt - 8 - (left + width * 0.3),
        align: "right",
        lineBreak: false,
      });
      doc.text(v, colAmt, y, { width: right - colAmt, align: "right" });
      y += 16;
    }

    // Notes and remit-to.
    doc.font("Helvetica").fontSize(9).fillColor(GREY);
    const foot = [d.notes, d.seller.remitNote].filter((s): s is string => Boolean(s));
    if (foot.length > 0) {
      doc.text(foot.join("\n\n"), left, y + 10, { width: width * 0.6 });
    }
    doc.fillColor("black");

    // Page numbers, and a watermark when this is not a live invoice.
    const mark =
      d.status === "draft"
        ? "DRAFT"
        : d.status === "void"
          ? "VOID"
          : d.status === "paid"
            ? "PAID"
            : null;
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Text below the bottom margin would make pdfkit start another page.
      doc.page.margins.bottom = 0;
      if (mark) {
        doc.save();
        doc.fillColor(mark === "PAID" ? "#2e7d32" : "#b71c1c").fillOpacity(0.12);
        doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
        doc.font("Helvetica-Bold").fontSize(110);
        doc.text(mark, 0, doc.page.height / 2 - 55, {
          width: doc.page.width,
          align: "center",
          lineBreak: false,
        });
        doc.restore();
      }
      doc.font("Helvetica").fontSize(8).fillColor(GREY);
      doc.text(
        `Page ${i + 1} of ${range.count}${d.invoiceNumber === null ? "" : ` · Invoice ${d.invoiceNumber}`}`,
        left,
        doc.page.height - MARGIN + 12,
        { width, align: "center", lineBreak: false },
      );
    }
    doc.end();
  });
}
