import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderPdf } from "@/server/pdf";
import { defaultFirmProfile } from "@/server/firm";
import { EngagementLetterPdf } from "@/server/pdf/engagement-letter";
import type { LetterDocument } from "@/lib/data/engagement-letters";
import type { LetterRow } from "@/lib/data/engagement-letters";

/**
 * The engagement letter PDF (§7.15.3, §11) renders for an issued tax audit letter (SA 210 contents
 * under the 1961 Act), a draft statutory audit with other services, and a non-audit letter with a
 * services schedule. Set LETTER_PDF_OUT to a folder to write the samples for a visual check.
 */

const firm = defaultFirmProfile();

function letter(over: Partial<LetterRow> = {}): LetterRow {
  return {
    id: "5b1e2a7c-4b1d-4c2e-9a77-1c2b3d4e5f61",
    client_id: "6d2f1f0e-0d3a-4b8e-9a51-8f0f1d2c3b4a",
    client_name: "Sharma Traders",
    client_code: "TW-C-0042",
    client_status: "active",
    owner_employee_id: null,
    owner_name: null,
    financial_year: "2025-26",
    service_types: ["audit"],
    is_audit: true,
    scope: "The tax audit of the books of account for the year, and the statement of particulars.",
    exclusions: "Representation before the assessing officer.",
    fee_agreed: 85000,
    services_schedule: [],
    audit_type: "tax_audit",
    reporting_framework: "The books of account and financial statements of the assessee prepared under the accounting principles generally accepted in India.",
    report_form: "The tax audit report in Form 3CB with the statement of particulars in Form 3CD, for AY 2026-27.",
    audit_engagement_id: null,
    signatory_id: "p1",
    signatory_name: "Vinay Karlagere",
    status: "issued",
    display_status: "issued",
    issued_at: "2026-07-01T06:30:00Z",
    signed_at: null,
    expires_at: "2027-03-31",
    days_to_expiry: 158,
    document_id: null,
    signed_copy_title: null,
    declined_reason: null,
    sent_at: null,
    sent_to: null,
    renewed_from_id: null,
    renewed_from_fy: null,
    renewal_id: null,
    renewal_fy: null,
    renewal_status: null,
    notes: null,
    created_by_name: "Vinay Karlagere",
    created_at: "2026-06-30T06:30:00Z",
    updated_at: "2026-07-01T06:30:00Z",
    ...over,
  };
}

function doc(l: LetterRow, entityType: LetterDocument["client"]["entityType"] = "pvt_ltd"): LetterDocument {
  return {
    letter: l,
    client: { name: l.client_name, legalName: "Sharma Traders Private Limited", code: l.client_code, entityType, address: "12, 4th Cross, Jayanagar", city: "Bengaluru", pincode: "560011", stateCode: "29", pan: "AABCS1234C", gstin: "29AABCS1234C1ZT" },
    signatory: { name: "Vinay Karlagere", membershipNo: "123456" },
    frn: "012345S",
    primaryContact: { name: "Ravi Sharma", role: "Director", email: "ravi@sharmatraders.in" },
  };
}

function out(name: string, bytes: Buffer) {
  const dir = process.env.LETTER_PDF_OUT;
  if (dir) writeFileSync(join(dir, name), bytes);
}

describe("engagement letter PDF (§7.15.3)", () => {
  it("renders an issued tax audit letter, a draft audit with other services, and a non-audit letter", async () => {
    const tax = await renderPdf(createElement(EngagementLetterPdf, { firm, logo: null, doc: doc(letter()), printedOn: "2026-10-24" }) as never);
    expect(tax.subarray(0, 5).toString()).toBe("%PDF-");
    out("letter-tax-audit.pdf", tax);

    const draft = await renderPdf(
      createElement(EngagementLetterPdf, {
        firm,
        logo: null,
        printedOn: "2026-10-24",
        doc: doc(
          letter({
            status: "draft",
            display_status: "draft",
            issued_at: null,
            financial_year: "2026-27",
            service_types: ["audit", "gst"],
            audit_type: "statutory_companies_act",
            services_schedule: [{ service_type: "gst", description: "GST returns: GSTR-1 and GSTR-3B", frequency: "monthly", fee: "4500.00" }],
          }),
        ),
      }) as never,
    );
    expect(draft.subarray(0, 5).toString()).toBe("%PDF-");
    out("letter-draft-audit.pdf", draft);

    const services = await renderPdf(
      createElement(EngagementLetterPdf, {
        firm,
        logo: null,
        printedOn: "2026-10-24",
        doc: doc(
          letter({
            service_types: ["gst", "income_tax", "tds"],
            is_audit: false,
            audit_type: null,
            reporting_framework: null,
            report_form: null,
            fee_agreed: null,
            renewed_from_fy: "2025-26",
            financial_year: "2026-27",
            services_schedule: [
              { service_type: "gst", description: "GST returns: GSTR-1 and GSTR-3B", frequency: "monthly", fee: "4500.00" },
              { service_type: "tds", description: "TDS returns: 24Q and 26Q", frequency: "quarterly", fee: "3000.00" },
              { service_type: "income_tax", description: "Income tax return", frequency: "annual", fee: null },
            ],
          }),
          "partnership",
        ),
      }) as never,
    );
    expect(services.subarray(0, 5).toString()).toBe("%PDF-");
    out("letter-services.pdf", services);
  }, 60_000);
});
