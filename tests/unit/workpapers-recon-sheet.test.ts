import { describe, expect, it } from "vitest";
import { REGISTER_FIELD_SPECS } from "@/lib/domain/gstr2b";
import { TB_FIELD_SPECS } from "@/lib/domain/schedule3";
import { MAX_SHEET_ROWS, csvToMatrix, decodeText, detectHeaderRow, headerNames, matrixToRecords, plainCell, previewRows } from "@/components/workpapers/shared/sheet";

describe("decodeText", () => {
  it("drops a UTF-8 byte-order mark", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Ledger,Debit")]);
    expect(decodeText(bytes)).toBe("Ledger,Debit");
  });

  it("reads bytes that aren't UTF-8 as Windows-1252", () => {
    // "Café" with é as the single byte 0xE9 (Windows-1252), which is invalid UTF-8.
    expect(decodeText(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe("Café");
  });
});

describe("csvToMatrix", () => {
  it("keeps quoted commas and skips blank lines", () => {
    const m = csvToMatrix('Ledger,Debit\n"Sundry Debtors, Mumbai",1200\n\n,\nCash,50\n');
    expect(m).toEqual([
      ["Ledger", "Debit"],
      ["Sundry Debtors, Mumbai", "1200"],
      ["Cash", "50"],
    ]);
  });

  it("reads semicolon-separated files", () => {
    expect(csvToMatrix("Ledger;Debit\nCash;50")).toEqual([
      ["Ledger", "Debit"],
      ["Cash", "50"],
    ]);
  });
});

describe("plainCell (exceljs values)", () => {
  it("gives formula results, rich text, hyperlink text, and null for errors", () => {
    expect(plainCell({ formula: "SUM(A1:A2)", result: 42 })).toBe(42);
    expect(plainCell({ richText: [{ text: "Sundry " }, { text: "Creditors" }] })).toBe("Sundry Creditors");
    expect(plainCell({ text: "Invoice", hyperlink: "https://example.org" })).toBe("Invoice");
    expect(plainCell({ error: "#DIV/0!" })).toBeNull();
    expect(plainCell({ sharedFormula: "A1" })).toBeNull();
  });

  it("passes plain values and dates through", () => {
    const d = new Date("2026-09-30T00:00:00Z");
    expect(plainCell(d)).toBe(d);
    expect(plainCell("Cash")).toBe("Cash");
    expect(plainCell(12.5)).toBe(12.5);
    expect(plainCell(undefined)).toBeNull();
  });
});

describe("detectHeaderRow", () => {
  it("finds the header under a company name and period (Tally exports)", () => {
    const m = [["Sharma Textiles Pvt Ltd"], ["Trial Balance", "1-Apr-2025 to 31-Mar-2026"], [], ["Particulars", "Group", "Closing Debit", "Closing Credit"], ["Cash", "Cash-in-Hand", "5000", ""]];
    expect(detectHeaderRow(m, TB_FIELD_SPECS)).toBe(3);
  });

  it("finds the purchase register header", () => {
    const m = [["Purchase register September 2026"], ["GSTIN of supplier", "Invoice number", "Invoice date", "Taxable value", "IGST", "CGST", "SGST"], ["27AAPFU0939F1ZV", "MT/245", "12-09-2026", "100000", "0", "9000", "9000"]];
    expect(detectHeaderRow(m, REGISTER_FIELD_SPECS)).toBe(1);
  });

  it("falls back to the first row with two filled cells", () => {
    const m = [["Notes"], ["Alpha", "Beta"], ["1", "2"]];
    expect(detectHeaderRow(m, TB_FIELD_SPECS)).toBe(1);
  });

  it("looks at the first 20 rows only", () => {
    const m: unknown[][] = Array.from({ length: 25 }, () => ["x"]);
    m[22] = ["Particulars", "Debit", "Credit"];
    expect(detectHeaderRow(m, TB_FIELD_SPECS)).toBe(0);
  });
});

describe("headerNames and matrixToRecords", () => {
  it("names blank and repeated headers", () => {
    expect(headerNames(["Ledger", "", "Amount", "amount"], 5)).toEqual(["Ledger", "Column 2", "Amount", "amount (2)", "Column 5"]);
  });

  it("keys rows by header and keeps columns past the header's width", () => {
    const r = matrixToRecords([["Title"], ["Ledger", "Debit"], ["Cash", "50", "stray"]], 1);
    expect(r.headers).toEqual(["Ledger", "Debit", "Column 3"]);
    expect(r.rows).toEqual([{ Ledger: "Cash", Debit: "50", "Column 3": "stray" }]);
    expect(r.headerRow).toBe(2);
    expect(r.firstRowNumber).toBe(3);
    expect(r.rowCount).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it("caps the rows read", () => {
    const m: unknown[][] = [["Ledger", "Debit"], ...Array.from({ length: MAX_SHEET_ROWS + 5 }, (_, i) => [`L${i}`, "1"])];
    const r = matrixToRecords(m, 0);
    expect(r.rowCount).toBe(MAX_SHEET_ROWS);
    expect(r.truncated).toBe(true);
  });

  it("previews the first non-blank rows as text", () => {
    const r = matrixToRecords([["Ledger", "Debit"], ["", ""], ["Cash", 50], ["Bank", 75]], 0);
    expect(previewRows(r, 1)).toEqual([["Cash", "50"]]);
  });
});
