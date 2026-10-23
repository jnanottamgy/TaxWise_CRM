import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InvoiceView } from "@/components/invoices/detail/invoice-view";
import type { InvoiceItemRow, InvoiceRow } from "@/lib/data/invoices";

/**
 * The on-screen invoice (§6.4 Rule 46, §7.9.3) renders the recipient, the lines, the CGST + SGST or
 * IGST split and the total in words.
 */

const invoice = {
  id: "0b6f2b1e-1c55-4d5a-9a3e-5f2f8a1f0c01",
  client_id: "6a1c4a22-8d1e-4b0b-9f33-0c8e8f6b2a10",
  invoice_number: "TW/26-27/0042",
  invoice_kind: "tax_invoice",
  status: "sent",
  issue_date: "2026-10-01",
  due_date: "2026-10-16",
  billing_period_label: "Sep 2026",
  place_of_supply_code: "29",
  place_of_supply_reason: null,
  reverse_charge: false,
  signatory_name: "Asha Rao",
  taxable_amount: 10000,
  cgst_amount: 900,
  sgst_amount: 900,
  igst_amount: 0,
  reimbursement_amount: 600,
  round_off: 0,
  total_amount: 12400,
  notes: "Thank you for your business.",
  terms: null,
} as unknown as InvoiceRow;

const items = [
  { id: "i1", description: "GST compliance for Sep 2026", sac_code: "998231", quantity: 1, rate: 10000, amount: 10000, tax_rate: 18, is_reimbursement: false, service_type: "gst", tax_rate_reason: null, time_entry_ids: [] },
  { id: "i2", description: "Reimbursement of ROC fees (pure agent)", sac_code: "998231", quantity: 1, rate: 600, amount: 600, tax_rate: 0, is_reimbursement: true, service_type: null, tax_rate_reason: null, time_entry_ids: [] },
] as unknown as InvoiceItemRow[];

const recipient = { name: "Sharma Traders Private Limited", address: "12 MG Road, Bengaluru, Karnataka 560001", gstin: "29AAKCS1234C1Z5", stateCode: "29", registered: true };

describe("InvoiceView", () => {
  it("shows an intra-state invoice with CGST and SGST at half the rate, reimbursements apart, and the total in words", () => {
    const html = renderToStaticMarkup(createElement(InvoiceView, { invoice, items, recipient, firmStateCode: "29", today: "2026-10-23" }));
    expect(html).toContain("Sharma Traders Private Limited");
    expect(html).toContain("29AAKCS1234C1Z5");
    expect(html).toContain("CGST 9%");
    expect(html).toContain("SGST 9%");
    expect(html).not.toContain("IGST");
    expect(html).toContain("Reimbursements (no GST)");
    expect(html).toContain("Rupees Twelve Thousand Four Hundred Only");
    expect(html).toContain("Karnataka (29)");
    expect(html).toContain("Asha Rao");
  });

  it("shows IGST for an inter-state supply and flags a missing GSTIN on a registered client", () => {
    const inter = { ...invoice, place_of_supply_code: "27", cgst_amount: 0, sgst_amount: 0, igst_amount: 1800 } as InvoiceRow;
    const html = renderToStaticMarkup(createElement(InvoiceView, { invoice: inter, items, recipient: { ...recipient, gstin: null }, firmStateCode: "29", today: "2026-10-23" }));
    expect(html).toContain("IGST 18%");
    expect(html).not.toContain("CGST");
    expect(html).toContain("GSTIN missing");
  });
});
