import { describe, expect, it } from "vitest";
import { ImportFilingsSchema, checkFilingImport, mapFilingHeaders, normaliseFormCode, parseFyInput, parseIndianDate, serviceTypeForForm } from "@/lib/schemas/registers";

describe("prior filings import (§7.15.2)", () => {
  it("reads FYs written the usual ways, and an AY as its FY", () => {
    expect(parseFyInput("2024-25")).toBe("2024-25");
    expect(parseFyInput("2024-2025")).toBe("2024-25");
    expect(parseFyInput("FY 2024-25")).toBe("2024-25");
    expect(parseFyInput("fy24-25")).toBe("2024-25");
    expect(parseFyInput("2024/25")).toBe("2024-25");
    expect(parseFyInput("AY 2025-26")).toBe("2024-25");
    expect(parseFyInput("1999-00")).toBe("1999-00");
    expect(parseFyInput("2024-26")).toBeNull();
    expect(parseFyInput("2024")).toBeNull();
  });

  it("reads dates day first, never month first", () => {
    expect(parseIndianDate("31/07/2025")).toBe("2025-07-31");
    expect(parseIndianDate("31-07-25")).toBe("2025-07-31");
    expect(parseIndianDate("5.4.2025")).toBe("2025-04-05");
    expect(parseIndianDate("31 Jul 2025")).toBe("2025-07-31");
    expect(parseIndianDate("31-July-2025")).toBe("2025-07-31");
    expect(parseIndianDate("2025-07-31")).toBe("2025-07-31");
    expect(parseIndianDate("07/31/2025")).toBeNull();
    expect(parseIndianDate("30/02/2025")).toBeNull();
    expect(parseIndianDate("yesterday")).toBeNull();
  });

  it("cleans form codes and finds their service", () => {
    expect(normaliseFormCode("gstr3b")).toBe("GSTR-3B");
    expect(normaliseFormCode("GSTR 1")).toBe("GSTR-1");
    expect(normaliseFormCode("ITR 6")).toBe("ITR-6");
    expect(normaliseFormCode("Form 24Q")).toBe("24Q");
    expect(normaliseFormCode("aoc4")).toBe("AOC-4");
    expect(normaliseFormCode("MGT 7A")).toBe("MGT-7A");
    expect(serviceTypeForForm("GSTR-9C")).toBe("gst");
    expect(serviceTypeForForm("ITR-3")).toBe("income_tax");
    expect(serviceTypeForForm("26Q")).toBe("tds");
    expect(serviceTypeForForm("AOC-4")).toBe("company_law");
    expect(serviceTypeForForm("3CA")).toBe("audit");
    expect(serviceTypeForForm("Something else")).toBeNull();
  });

  it("maps the file's headings to the columns", () => {
    expect(mapFilingHeaders(["Financial Year", "Return", "Period", "Date of filing", "ARN", "Filed by", "Remarks"])).toEqual({
      financial_year: "Financial Year",
      filing_type: "Return",
      period: "Period",
      filed_on: "Date of filing",
      acknowledgement_no: "ARN",
      filed_by_external: "Filed by",
      notes: "Remarks",
    });
    expect(mapFilingHeaders(["fy", "form", "Acknowledgement No."])).toEqual({ financial_year: "fy", filing_type: "form", acknowledgement_no: "Acknowledgement No." });
  });

  it("checks every row, uses the default firm, keeps a repeated filing once and refuses future dates", () => {
    const mapping = mapFilingHeaders(["FY", "Form", "Period", "Filed on", "Acknowledgement no.", "Previous firm"]);
    const rows = [
      { FY: "2024-25", Form: "gstr3b", Period: "Mar 2025", "Filed on": "20/04/2025", "Acknowledgement no.": "AA2903251234567", "Previous firm": "" },
      { FY: "AY 2025-26", Form: "ITR 6", Period: "", "Filed on": "31/10/2025", "Acknowledgement no.": "123456789012345", "Previous firm": "Rao & Co" },
      { FY: "2024-25", Form: "GSTR-3B", Period: "mar 2025", "Filed on": "20/04/2025", "Acknowledgement no.": "aa2903251234567", "Previous firm": "" },
      { FY: "24/26", Form: "GSTR-1", Period: "", "Filed on": "", "Acknowledgement no.": "", "Previous firm": "" },
      { FY: "2025-26", Form: "GSTR-1", Period: "Oct 2026", "Filed on": "11/11/2026", "Acknowledgement no.": "X", "Previous firm": "" },
    ];
    const r = checkFilingImport(rows, { mapping, defaultFirm: "Kumar Associates", today: "2026-10-23" });
    expect(r.valid).toHaveLength(2);
    expect(r.valid[0]).toEqual({
      financial_year: "2024-25",
      filing_type: "GSTR-3B",
      period: "Mar 2025",
      filed_on: "2025-04-20",
      acknowledgement_no: "AA2903251234567",
      filed_by_external: "Kumar Associates",
      service_type: "gst",
      notes: null,
    });
    expect(r.valid[1]).toMatchObject({ financial_year: "2024-25", filing_type: "ITR-6", filed_by_external: "Rao & Co", service_type: "income_tax" });
    expect(r.checks[1].warnings[0]).toMatch(/Read AY 2025-26 as FY 2024-25/);
    expect(r.checks[2]).toMatchObject({ line: 4, row: null, errors: [] });
    expect(r.checks[2].warnings[0]).toMatch(/Same filing as line 2/);
    expect(r.checks[3].errors[0]).toMatch(/isn't an FY/);
    expect(r.checks[4].errors).toContain("The filing date is in the future.");
    // Without a firm anywhere, the row is refused.
    const noFirm = checkFilingImport([{ FY: "2024-25", Form: "GSTR-1" }], { mapping: mapFilingHeaders(["FY", "Form"]), today: "2026-10-23" });
    expect(noFirm.valid).toEqual([]);
    expect(noFirm.checks[0].errors[0]).toMatch(/previous firm is missing/);
    // The valid rows are what the action accepts.
    expect(ImportFilingsSchema.safeParse({ clientId: "6d2f1f0e-0d3a-4b8e-9a51-8f0f1d2c3b4a", rows: r.valid }).success).toBe(true);
  });
});
