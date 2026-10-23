import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/admin", () => ({
  createAdminClient: () => {
    throw new Error("no service role in unit tests");
  },
}));
vi.mock("@/lib/auth/current-user", () => ({ getSession: async () => ({ status: "anonymous" }) }));

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultFirmProfile } from "@/server/firm";
import { buildInvoicePdf, documentTitle } from "@/server/pdf/invoice";
import { buildReceiptPdf } from "@/server/pdf/receipt";
import { buildCreditNotePdf } from "@/server/pdf/credit-note";
import type { InvoiceDocument } from "@/lib/data/invoices";
import type { ReceiptDocument } from "@/lib/data/receipts";
import type { CreditNoteDocument } from "@/lib/data/credit-notes";

/**
 * The invoice, receipt and credit-note PDFs render (§11, §6.4 Rule 46). Set INVOICE_PDF_OUT to a
 * folder to write the samples there for a visual check.
 */

const firm = {
  ...defaultFirmProfile(),
  bank: { name: "HDFC Bank", accountName: "TaxWise Consultants", accountNumber: "50200012345678", ifsc: "HDFC0001234", branch: "Sadashiva Nagar" },
  upi: { id: "taxwise@hdfcbank", payeeName: "TaxWise Consultants" },
};

function invoice(over: Partial<InvoiceDocument> = {}): InvoiceDocument {
  return {
    id: "8f1e2a7c-4b1d-4c2e-9a77-1c2b3d4e5f60",
    client_id: "1f1e2a7c-4b1d-4c2e-9a77-1c2b3d4e5f60",
    invoice_number: "TW/26-27/0042",
    invoice_kind: "tax_invoice",
    status: "sent",
    is_overdue: false,
    cancelled_at: null,
    issue_date: "2026-10-01",
    due_date: "2026-10-16",
    billing_period_label: "Sep 2026",
    notes: "GSTR-1 and GSTR-3B for September 2026.",
    terms: "Payment within 15 days of the invoice date.",
    recipient: { name: "Sharma Traders Private Limited", address: "12, MG Road, Bengaluru, Karnataka 560001", gstin: "29AABCS1234C1Z5", state_code: "29", registered: true },
    place_of_supply_code: "29",
    firm_gstin: "29AAXFT1811B1Z3",
    reverse_charge: false,
    items: [
      { description: "GST compliance for Sep 2026", sac_code: "998231", quantity: 1, rate: 10000, amount: 10000, tax_rate: 18, is_reimbursement: false },
      { description: "ROC filing fee paid on your behalf (reimbursement of expenses incurred as pure agent)", sac_code: "9982", quantity: 1, rate: 600, amount: 600, tax_rate: 0, is_reimbursement: true },
    ],
    totals: {
      taxable_amount: 10000,
      cgst_amount: 900,
      sgst_amount: 900,
      igst_amount: 0,
      reimbursement_amount: 600,
      round_off: 0,
      total_amount: 12400,
      amount_received: 0,
      tds_credited: 0,
      credit_noted: 0,
      outstanding_amount: 12400,
    },
    signatory_id: null,
    signatory_name: "Asha Rao",
    original: null,
    e_invoice: { irn: null, ack_no: null, ack_date: null, signed_qr: null },
    ...over,
  };
}

function out(name: string, bytes: Buffer) {
  const dir = process.env.INVOICE_PDF_OUT;
  if (dir) writeFileSync(join(dir, name), bytes);
}

describe("invoice PDF (§6.4 Rule 46, §11)", () => {
  it("renders an intra-state tax invoice with a reimbursement, the UPI QR and the signature block", async () => {
    const { bytes, fileName } = await buildInvoicePdf({ firm, doc: invoice(), firmStateCode: "29", eInvoicing: false });
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(fileName).toBe("Invoice-TW-26-27-0042.pdf");
    out("invoice-intra.pdf", bytes);
  });

  it("renders an inter-state invoice (IGST), an e-invoice and a draft", async () => {
    const inter = await buildInvoicePdf({
      firm,
      doc: invoice({
        place_of_supply_code: "27",
        recipient: { name: "Beta Industries", address: "Andheri East, Mumbai, Maharashtra 400069", gstin: "27AABCB1234C1Z5", state_code: "27", registered: true },
        totals: { ...invoice().totals, cgst_amount: 0, sgst_amount: 0, igst_amount: 1800 },
        e_invoice: { irn: "a".repeat(64), ack_no: "112410012345678", ack_date: "2026-10-01T10:00:00+05:30", signed_qr: "eyJhbGciOiJSUzI1NiJ9.sample.signature" },
      }),
      firmStateCode: "29",
      eInvoicing: true,
    });
    expect(inter.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    out("invoice-inter.pdf", inter.bytes);
    const draft = await buildInvoicePdf({ firm, doc: invoice({ invoice_number: null, status: "draft" }), firmStateCode: "29", eInvoicing: false });
    expect(draft.fileName).toMatch(/^Invoice-draft-/);
    out("invoice-draft.pdf", draft.bytes);
  });

  it("titles drafts and debit notes", () => {
    expect(documentTitle({ invoice_kind: "tax_invoice", status: "sent" })).toBe("Tax invoice");
    expect(documentTitle({ invoice_kind: "tax_invoice", status: "draft" })).toBe("Draft invoice");
    expect(documentTitle({ invoice_kind: "debit_note", status: "sent" })).toBe("Debit note");
    expect(documentTitle({ invoice_kind: "debit_note", status: "awaiting_approval" })).toBe("Draft debit note");
  });
});

describe("receipt and credit-note PDFs (§7.9.4, §7.9.7, §11)", () => {
  it("renders a receipt with TDS", async () => {
    const doc: ReceiptDocument = {
      id: "2f1e2a7c-4b1d-4c2e-9a77-1c2b3d4e5f60",
      receipt_number: "TW-R/26-27/0007",
      payment_date: "2026-10-20",
      amount_received: 10800,
      tds_amount: 1000,
      tds_section: "393",
      method: "bank_transfer",
      reference: "UTR123456789",
      reversed_at: null,
      reversal_reason: null,
      created_at: "2026-10-21T06:30:00Z",
      invoice: { id: "x", invoice_number: "TW/26-27/0042", issue_date: "2026-10-01", total_amount: 11800, outstanding_amount: 0, client_id: "c", client_name: "Sharma Traders Private Limited", client_address: "12, MG Road, Bengaluru", client_gstin: "29AABCS1234C1Z5" },
    };
    const { bytes, fileName } = await buildReceiptPdf({ firm, doc, signerName: "Anita Rao" });
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(fileName).toBe("Receipt-TW-R-26-27-0007.pdf");
    out("receipt.pdf", bytes);
  });

  it("renders a tax-reducing and a commercial credit note", async () => {
    const base: CreditNoteDocument = {
      id: "3f1e2a7c-4b1d-4c2e-9a77-1c2b3d4e5f60",
      credit_note_number: "TW-CN/26-27/0003",
      issue_date: "2026-10-22",
      reason: "Agreed reduction for the delayed filing",
      reason_code: "fee_reduction",
      reduces_gst: true,
      taxable_amount: 1000,
      tax_rate: 18,
      cgst_amount: 90,
      sgst_amount: 90,
      igst_amount: 0,
      total_amount: 1180,
      place_of_supply_code: "29",
      notes: null,
      issued_by: null,
      invoice: { id: "x", invoice_number: "TW/26-27/0042", issue_date: "2026-10-01", client_name: "Sharma Traders Private Limited", client_address: "12, MG Road, Bengaluru", client_gstin: "29AABCS1234C1Z5", client_state_code: "29", firm_gstin: "29AAXFT1811B1Z3" },
    };
    const gst = await buildCreditNotePdf({ firm, doc: base, signerName: "Asha Rao" });
    expect(gst.fileName).toBe("Credit-note-TW-CN-26-27-0003.pdf");
    out("credit-note.pdf", gst.bytes);
    const commercial = await buildCreditNotePdf({ firm, doc: { ...base, reduces_gst: false, tax_rate: null, cgst_amount: 0, sgst_amount: 0, total_amount: 1000 }, signerName: null });
    expect(commercial.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    out("credit-note-commercial.pdf", commercial.bytes);
  });
});
