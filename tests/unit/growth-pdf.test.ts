import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderPdf } from "@/server/pdf";
import { defaultFirmProfile } from "@/server/firm";
import { QuotationPdf } from "@/server/pdf/quotation";
import type { QuotationDocument } from "@/lib/schemas/quotations";

/**
 * The quotation PDF (§7.5.3 layout) renders for a draft-like quotation within the state (CGST + SGST),
 * another state (IGST) and an accepted one (the "Accepted electronically by" block). Set
 * QUOTATION_PDF_OUT to a folder to write the samples for a visual check.
 */

const firm = defaultFirmProfile();

function doc(over: Partial<QuotationDocument> = {}): QuotationDocument {
  return {
    id: "8f1e2a7c-4b1d-4c2e-9a77-1c2b3d4e5f60",
    number: "TW-Q/26-27/0007",
    status: "sent",
    issueDate: "2026-10-23",
    validUntil: "2026-11-22",
    revisionNumber: 0,
    revisesNumber: null,
    preparedBy: "Asha Rao",
    recipient: { name: "Ravi Sharma", company: "Sharma Traders Private Limited", email: "ravi@sharmatraders.in", phone: "+91 98765 43210", gstin: "29AABCS1234C1ZT", placeOfSupplyCode: "29" },
    lines: [
      { description: "GST compliance: GSTR-1, GSTR-3B and reconciliation", serviceType: "gst", frequency: "monthly", quantity: "12", unitPrice: "4500.00", taxRate: "18" },
      { description: "Income tax return preparation and filing", serviceType: "income_tax", frequency: "annual", quantity: "1", unitPrice: "12000.00", taxRate: "18" },
      { description: "Statutory audit under the Companies Act, 2013", serviceType: "audit", frequency: "annual", quantity: "1", unitPrice: "85000.00", taxRate: "18" },
    ],
    notes: "Fees cover the period April 2026 to March 2027. Government fees and late fees are charged at actuals.",
    terms: "Fees are payable within 15 days of each invoice.\nThis quotation is valid until the date shown.",
    acceptance: null,
    ...over,
  };
}

function out(name: string, bytes: Buffer) {
  const dir = process.env.QUOTATION_PDF_OUT;
  if (dir) writeFileSync(join(dir, name), bytes);
}

describe("quotation PDF (§7.5.3)", () => {
  it("renders within the state, another state, and an accepted revision", async () => {
    const intra = await renderPdf(createElement(QuotationPdf, { firm, logo: null, doc: doc() }) as never);
    expect(intra.subarray(0, 5).toString()).toBe("%PDF-");
    out("quotation-intra.pdf", intra);

    const inter = await renderPdf(
      createElement(QuotationPdf, { firm, logo: null, doc: doc({ recipient: { ...doc().recipient, gstin: "27AABCB1234C1ZE", placeOfSupplyCode: "27" } }) }) as never,
    );
    expect(inter.subarray(0, 5).toString()).toBe("%PDF-");
    out("quotation-inter.pdf", inter);

    const accepted = await renderPdf(
      createElement(QuotationPdf, {
        firm,
        logo: null,
        doc: doc({ status: "accepted", revisionNumber: 1, revisesNumber: "TW-Q/26-27/0005", acceptance: { name: "Ravi Sharma", at: "2026-10-25T05:30:00Z" } }),
      }) as never,
    );
    expect(accepted.subarray(0, 5).toString()).toBe("%PDF-");
    out("quotation-accepted.pdf", accepted);
  });
});
