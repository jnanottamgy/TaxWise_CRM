import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createElement as h } from "react";
import { renderPdf } from "@/server/pdf";
import { defaultFirmProfile } from "@/server/firm";
import type { ReportData } from "@/lib/data/compliance";
import { ComplianceReportPdf, summarise } from "@/server/compliance/report-pdf";

const TODAY = "2026-10-23";

const data: ReportData = {
  client: {
    id: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
    display_name: "Sharma Traders",
    legal_name: "Sharma Traders Private Limited",
    client_code: "TW-C-0042",
    pan: "AAKCS1234C",
    gstin: "29AAKCS1234C1Z5",
    tan: null,
    address: "12, MG Road",
    city: "Bengaluru",
    pincode: "560001",
  },
  rows: [
    { id: "a", title: "GSTR-3B (monthly) for Aug 2026", form_code: "GSTR-3B", filing_period: "Aug 2026", financial_year: "2026-27", due_date: "2026-09-20", original_due_date: null, override_ref: null, status: "completed", workflow_status: "filed", filed_on: "2026-09-18", acknowledgement_no: "AA290826123456X" },
    { id: "b", title: "GSTR-3B (monthly) for Sep 2026", form_code: "GSTR-3B", filing_period: "Sep 2026", financial_year: "2026-27", due_date: "2026-10-20", original_due_date: null, override_ref: null, status: "completed", workflow_status: "filed", filed_on: "2026-10-22", acknowledgement_no: "AA290926654321X" },
    { id: "c", title: "Tax audit report for AY 2026-27", form_code: "Form 3CA/3CB-3CD", filing_period: "AY 2026-27", financial_year: "2025-26", due_date: "2026-10-21", original_due_date: "2026-09-30", override_ref: "CBDT Circular 07/2026 dated 28 Sep 2026", status: "pending", workflow_status: "under_review", filed_on: null, acknowledgement_no: null },
    { id: "d", title: "GSTR-3B (monthly) for Oct 2026", form_code: "GSTR-3B", filing_period: "Oct 2026", financial_year: "2026-27", due_date: "2026-11-20", original_due_date: null, override_ref: null, status: "pending", workflow_status: "not_started", filed_on: null, acknowledgement_no: null },
  ],
};

describe("compliance report", () => {
  it("summarises on time, late, overdue and not yet due (§7.7)", () => {
    const { rows, summary } = summarise(data, TODAY);
    expect(summary).toEqual({ total: 4, onTime: 1, late: 1, filedNoDate: 0, overdue: 1, due: 1 });
    expect(rows.map((r) => r.outcome.text)).toEqual(["On time", "Late by 2 days", "Not filed, 2 days overdue", "Not yet due"]);
  });

  it("renders the branded PDF, with no rows too", async () => {
    const firm = defaultFirmProfile();
    const pdf = await renderPdf(h(ComplianceReportPdf, { firm, logo: null, data, range: { from: "2026-04-01", to: "2027-03-31" }, today: TODAY, preparedBy: "CA Vinay" }) as never);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const empty = await renderPdf(h(ComplianceReportPdf, { firm, logo: null, data: { ...data, rows: [] }, range: { from: "2026-04-01", to: "2027-03-31" }, today: TODAY, preparedBy: "CA Vinay" }) as never);
    expect(empty.length).toBeGreaterThan(1000);
  }, 30_000);
});
