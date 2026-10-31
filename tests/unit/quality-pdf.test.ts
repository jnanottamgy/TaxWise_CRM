import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultFirmProfile } from "@/server/firm";
import { buildManagementRepresentationPdf } from "@/server/pdf/management-representation";
import type { RepresentationLetterData } from "@/lib/data/audits";

/**
 * The management representation letter template (SA 580, §11) renders for a statutory company audit
 * (with the schedule of uncorrected misstatements and the clearly-trivial threshold), a tax audit
 * under the 2025 Act, and a GST engagement (no schedule). Set REP_PDF_OUT to a folder to write the
 * samples for a visual check.
 */

const firm = defaultFirmProfile();

function data(over: Partial<RepresentationLetterData> = {}): RepresentationLetterData {
  return {
    engagementId: "5b1e2a7c-4b1d-4c2e-9a77-1c2b3d4e5f61",
    auditType: "statutory_companies_act",
    financialYear: "2025-26",
    stage: "completion",
    reportDate: "2026-09-10",
    caroApplicable: true,
    trivialRupees: 50000,
    client: { name: "Sharma Steels Private Limited", code: "TW-C-0042", entityType: "pvt_ltd", address: "14, 2nd Cross, Peenya Industrial Area, Bengaluru 560058", pan: "AAACS1234K", cin: "U27100KA2015PTC081234" },
    engagementLetterDate: "2026-06-15",
    framework: null,
    partnerName: "Vinay Karlagere",
    firmFrn: "012345S",
    ...over,
  };
}

async function render(d: RepresentationLetterData, name: string) {
  const out = await buildManagementRepresentationPdf({ firm, data: d, preparedBy: "Vinay Karlagere" });
  if (process.env.REP_PDF_OUT) writeFileSync(join(process.env.REP_PDF_OUT, `${name}.pdf`), out.bytes);
  return out;
}

describe("management representation letter (SA 580)", () => {
  it("renders a company audit with the misstatement schedule", async () => {
    const out = await render(data(), "statutory");
    expect(out.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(out.bytes.length).toBeGreaterThan(5000);
    expect(out.fileName).toBe("Management representation TW-C-0042-FY-2025-26.pdf");
  });

  it("renders a tax audit under the 2025 Act and a GST engagement", async () => {
    const tax = await render(data({ auditType: "tax_audit", financialYear: "2026-27", client: { ...data().client, name: "Rao and Sons", entityType: "partnership", cin: null }, trivialRupees: null, caroApplicable: null }), "tax-audit");
    expect(tax.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const gst = await render(data({ auditType: "gst_audit", reportDate: null, engagementLetterDate: null, firmFrn: null, client: { ...data().client, address: null, pan: null, cin: null } }), "gst");
    expect(gst.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
