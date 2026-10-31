import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as React from "react";
import { createElement as h } from "react";
import { Image, Text, View } from "@react-pdf/renderer";
import {
  PdfAmountInWords,
  PdfDocument,
  PdfFacts,
  PdfKeyValue,
  PdfNotes,
  PdfSignature,
  PdfTable,
  footerLine,
  logoFormat,
  pdfAmountInWords,
  pdfDate,
  pdfFileName,
  pdfMoney,
  pdfMoneyFromRupees,
  pdfPercent,
  pdfResponseHeaders,
  pdfText,
  qrPng,
  renderPdf,
} from "@/server/pdf";
import { defaultFirmProfile } from "@/server/firm";

const firm = { ...defaultFirmProfile(), bank: { name: "HDFC Bank", accountName: "TaxWise Consultants", accountNumber: "50200012345678", ifsc: "HDFC0001234", branch: "Sadashiva Nagar" } };

/** PdfDocument with its children as createElement arguments (as JSX would pass them). */
const doc = (props: Omit<React.ComponentProps<typeof PdfDocument>, "children">, ...children: React.ReactNode[]) =>
  h(PdfDocument as unknown as React.FC<Record<string, unknown>>, props as unknown as Record<string, unknown>, ...children);

async function sampleInvoice(): Promise<Buffer> {
  const qr = await qrPng("upi://pay?pa=taxwise@hdfcbank&pn=TaxWise%20Consultants&am=11800.00&tn=TW%2F26-27%2F0042&cu=INR");
  const lines = [
    { description: "GST return filing (GSTR-1 and GSTR-3B) for September 2026", sac: "998231", taxable: 1_000_000, cgst: 90_000, sgst: 90_000 },
    { description: "Reimbursement of GST challan fees (pure agent)", sac: "—", taxable: 0, cgst: 0, sgst: 0 },
  ];
  const element = doc(
    {
      firm,
      title: "Tax invoice",
      documentTitle: "Invoice TW/26-27/0042",
      meta: [
        { label: "Invoice no.", value: "TW/26-27/0042" },
        { label: "Date", value: pdfDate("2026-10-01") },
        { label: "Due", value: pdfDate("2026-10-16") },
      ],
      footerNote: "Computer-generated invoice",
      pan: "AAXFT1811B",
    },
    h(PdfFacts, {
      facts: [
        { label: "Bill to", value: "Sharma Traders Pvt Ltd\n12, MG Road, Bengaluru 560001" },
        { label: "GSTIN", value: "29AAKFS1234C1Z5" },
        { label: "Place of supply", value: "Karnataka (29)" },
      ],
      columns: 3,
    }),
    h(PdfTable, {
      columns: [
        { key: "description", header: "Description", flex: 4 },
        { key: "sac", header: "SAC", width: 50 },
        { key: "taxable", header: "Taxable value", width: 78, align: "right" },
        { key: "cgst", header: "CGST 9%", width: 64, align: "right" },
        { key: "sgst", header: "SGST 9%", width: 64, align: "right" },
      ],
      rows: lines.map((l) => ({ description: l.description, sac: l.sac, taxable: pdfMoney(l.taxable), cgst: pdfMoney(l.cgst), sgst: pdfMoney(l.sgst) })),
      totals: [
        { label: "Taxable value", values: { taxable: pdfMoney(1_000_000), cgst: pdfMoney(90_000), sgst: pdfMoney(90_000) } },
        { label: "Total (₹)", values: { sgst: pdfMoney(1_180_000) }, emphasis: true },
      ],
    }),
    h(PdfAmountInWords, { words: pdfAmountInWords(1_180_000) }),
    h(
      View,
      { style: { flexDirection: "row", justifyContent: "space-between" } },
      h(PdfKeyValue, {
        width: "55%",
        rows: [
          { label: "Bank", value: "HDFC Bank, Sadashiva Nagar" },
          { label: "Account", value: "50200012345678" },
          { label: "IFSC", value: "HDFC0001234" },
          { label: "UPI", value: "taxwise@hdfcbank" },
        ],
      }),
      h(
        View,
        { style: { alignItems: "center" } },
        h(Image, { src: { data: qr, format: "png" }, style: { width: 72, height: 72 } }),
        h(Text, { style: { fontSize: 7 } }, "Scan to pay by UPI"),
      ),
    ),
    h(PdfNotes, { title: "Terms", text: "Payment within 15 days of the invoice date.\nInterest at 18% a year on late payment." }),
    h(PdfSignature, { firmName: firm.firmName, signerName: "CA Vinay Karlagere", designation: "Partner · Authorised Signatory" }),
  );
  return renderPdf(element as never);
}

describe("PDF rendering (§11)", () => {
  it("renders an A4 document with Inter embedded, the letterhead and the footer", async () => {
    const pdf = await sampleInvoice();
    if (process.env.PDF_PREVIEW_DIR) writeFileSync(join(process.env.PDF_PREVIEW_DIR, "sample-invoice.pdf"), pdf);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const raw = pdf.toString("latin1");
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+Inter/);
    expect(raw).not.toMatch(/\/BaseFont \/Helvetica/);
    // pdfkit writes the metadata as indirect string objects ("/Producer 16 0 R")
    expect(raw).toMatch(/\/Producer \d+ 0 R/);
    expect(raw).toMatch(/\/Title \d+ 0 R/);
  }, 30_000);

  it("makes a UPI QR code as a PNG", async () => {
    const png = await qrPng("upi://pay?pa=taxwise@hdfcbank&pn=TaxWise&cu=INR");
    expect(logoFormat(png)).toBe("png");
  });
});

describe("PDF helpers", () => {
  it("formats money, words, dates and percentages the house way", () => {
    expect(pdfMoney(12_345_650)).toBe("₹1,23,456.50");
    expect(pdfMoney(0)).toBe("₹0.00");
    expect(pdfMoney(12_345_650, { symbol: false })).toBe("1,23,456.50");
    expect(pdfMoneyFromRupees("5900.00")).toBe("₹5,900.00");
    expect(pdfMoneyFromRupees(null)).toBe("—");
    expect(pdfAmountInWords(1_180_000)).toBe("Rupees Eleven Thousand Eight Hundred Only");
    expect(pdfDate("2026-10-22")).toBe("22 Oct 2026");
    expect(pdfDate(null)).toBe("—");
    expect(pdfPercent(18)).toMatch(/^18/);
    expect(pdfText("  ")).toBe("—");
    expect(pdfText(0)).toBe("0");
  });

  it("names files and headers safely", () => {
    expect(pdfFileName("TW/26-27/0042")).toBe("TW-26-27-0042.pdf");
    expect(pdfFileName("TW-Q/26-27/0007", "Quotation")).toBe("Quotation TW-Q-26-27-0007.pdf");
    expect(pdfFileName("///")).toBe("document.pdf");
    const headers = pdfResponseHeaders('in"voice.pdf', { download: true });
    expect(headers["Content-Disposition"]).toBe('attachment; filename="in-voice.pdf"');
    expect(headers["Cache-Control"]).toBe("private, no-store");
  });

  it("the footer line credits J-TACS after an optional note", () => {
    expect(footerLine("TaxWise Consultants")).toBe("TaxWise Consultants · Powered by J-TACS");
    expect(footerLine("TaxWise Consultants", "Computer-generated invoice")).toBe("Computer-generated invoice · TaxWise Consultants · Powered by J-TACS");
  });

  it("embeds only PNG and JPEG logos", () => {
    expect(logoFormat(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(logoFormat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(logoFormat(new TextEncoder().encode("<svg xmlns="))).toBeNull();
  });
});
