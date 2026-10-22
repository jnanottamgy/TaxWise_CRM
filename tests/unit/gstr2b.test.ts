import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cellText,
  gstDocRow,
  isCreditDoc,
  mapColumns,
  normaliseHeader,
  parseCellAmount,
  parseCellDate,
  parseDocType,
  parseGstr2b,
  parseRegisterRows,
  periodLabelOf,
  REGISTER_FIELD_SPECS,
  signAmounts,
  suggestColumnMapping,
  totalTax,
  validateColumnMapping,
  type GstDocRow,
  type RegisterField,
  type SheetRow,
} from "@/lib/domain/gstr2b";

const FIXTURES = join(__dirname, "..", "fixtures", "gstr2b");
const twoBText = readFileSync(join(FIXTURES, "gstr2b-sep-2026.json"), "utf8");
const register = JSON.parse(readFileSync(join(FIXTURES, "purchase-register-sep-2026.json"), "utf8")) as { headers: string[]; rows: SheetRow[] };

const CLIENT = "29AAKCB1111F1Z3";
const KAVERI = "29AABCK1234A1Z5";

function byNumber(rows: readonly GstDocRow[], n: string): GstDocRow {
  const row = rows.find((r) => r.docNumber === n);
  if (!row) throw new Error(`no row ${n}`);
  return row;
}

function wrap(docdata: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { data: { gstin: CLIENT, rtnprd: "092026", docdata, ...extra } };
}

// -------------------------------------------------------------------------------------------------
// GSTR-2B JSON
// -------------------------------------------------------------------------------------------------

describe("parseGstr2b: the September fixture (§6.12)", () => {
  const parsed = parseGstr2b(twoBText);

  it("reads the file header", () => {
    expect(parsed.ok).toBe(true);
    expect(parsed.gstin).toBe(CLIENT);
    expect(parsed.period).toBe("092026");
    expect(parsed.periodLabel).toBe("Sep 2026");
    expect(parsed.generatedOn).toBe("2026-10-14");
  });

  it("reads B2B, B2BA, CDNR, ISD and IMPG and counts each section", () => {
    expect(parsed.rows).toHaveLength(12);
    expect(parsed.counts).toEqual({ b2b: 7, b2ba: 1, cdnr: 2, cdnra: 0, isd: 1, isda: 0, impg: 1, impgsez: 0 });
  });

  it("sums item-level values when the document carries none (DD-MM-YYYY → ISO date)", () => {
    const r = byNumber(parsed.rows, "INV/007");
    expect(r).toMatchObject({
      section: "b2b",
      supplierGstin: KAVERI,
      supplierName: "Kaveri Traders",
      docType: "invoice",
      docDate: "2026-09-05",
      taxable: 1_000_000,
      igst: 0,
      cgst: 90_000,
      sgst: 90_000,
      cess: 0,
      supplierPeriod: "092026",
      itcAvailable: true,
      reverseCharge: false,
      ref: "b2b[0].inv[0]",
    });
  });

  it("reads doc-level values given as strings", () => {
    const r = byNumber(parsed.rows, "KT-101");
    expect([r.taxable, r.cgst, r.sgst]).toEqual([500_000, 45_000, 45_000]);
  });

  it("uses the document total when items disagree, and says so (info)", () => {
    const r = byNumber(parsed.rows, "KT-102");
    expect([r.taxable, r.cgst, r.sgst]).toEqual([2_000_000, 180_000, 180_000]);
    const d = parsed.diagnostics.find((x) => x.code === "items_disagree");
    expect(d).toMatchObject({ level: "info", ref: "b2b[0].inv[2]" });
  });

  it("makes credit notes negative and keeps debit notes positive", () => {
    const cn = byNumber(parsed.rows, "CN-5");
    expect(cn.docType).toBe("credit_note");
    expect([cn.taxable, cn.cgst, cn.sgst]).toEqual([-100_000, -9_000, -9_000]);
    expect(totalTax(cn)).toBe(-18_000);
    const dn = byNumber(parsed.rows, "DN-1");
    expect(dn.docType).toBe("debit_note");
    expect(totalTax(dn)).toBe(9_000);
  });

  it("keeps the original number and date of amended documents (B2BA)", () => {
    const r = byNumber(parsed.rows, "SS-77");
    expect(r).toMatchObject({ section: "b2ba", originalDocNumber: "SS-76", originalDocDate: "2026-09-07", docDate: "2026-09-08" });
  });

  it("reads ITC availability and reverse charge", () => {
    expect(byNumber(parsed.rows, "TL/88")).toMatchObject({ itcAvailable: false, itcUnavailableReason: "P", igst: 144_000 });
    expect(byNumber(parsed.rows, "RR-12").reverseCharge).toBe(true);
  });

  it("reads ISD credits (no taxable value) and bills of entry (no supplier GSTIN)", () => {
    expect(byNumber(parsed.rows, "ISD-1")).toMatchObject({ section: "isd", docType: "isd_invoice", igst: 50_000, taxable: 0, itcAvailable: true, docDate: "2026-09-30" });
    expect(byNumber(parsed.rows, "1234567")).toMatchObject({
      section: "impg",
      docType: "bill_of_entry",
      supplierGstin: "",
      portCode: "INMAA1",
      taxable: 4_000_000,
      igst: 720_000,
      docDate: "2026-09-22",
    });
  });

  it("reports an unknown section instead of dropping it silently", () => {
    const d = parsed.diagnostics.find((x) => x.code === "unknown_section");
    expect(d?.level).toBe("warning");
    expect(d?.ref).toBe("ecoa");
    expect(d?.message).toContain("1 document was left out");
    expect(parsed.diagnostics.filter((x) => x.level === "error")).toEqual([]);
  });

  it("gives the same result for the parsed object and for a BOM-prefixed string", () => {
    expect(parseGstr2b(JSON.parse(twoBText)).rows).toEqual(parsed.rows);
    expect(parseGstr2b(`﻿${twoBText}`).rows).toHaveLength(12);
  });
});

describe("parseGstr2b: tolerance and diagnostics", () => {
  it("never throws on rubbish", () => {
    expect(parseGstr2b("{not json")).toMatchObject({ ok: false, rows: [] });
    expect(parseGstr2b("{not json").diagnostics[0]).toMatchObject({ level: "error", code: "not_json" });
    expect(parseGstr2b(42).diagnostics[0].code).toBe("no_data");
    expect(parseGstr2b(null).diagnostics[0].code).toBe("no_data");
    expect(parseGstr2b({ data: { gstin: CLIENT } }).diagnostics.map((d) => d.code)).toContain("no_documents");
  });

  it("accepts a file whose root is `data` itself, and a root with the sections directly", () => {
    const inner = JSON.parse(twoBText).data;
    expect(parseGstr2b(inner).rows).toHaveLength(12);
    const flat = parseGstr2b({ gstin: CLIENT, b2b: [{ ctin: KAVERI, inv: [{ inum: "A1", dt: "01-09-2026", txval: 100, cgst: 9, sgst: 9 }] }] });
    expect(flat.rows).toHaveLength(1);
    expect(flat.diagnostics).toEqual([]);
  });

  it("reads GSTR-1 style items (itms[].itm_det with iamt/camt/samt/csamt)", () => {
    const r = parseGstr2b(
      wrap({ b2b: [{ ctin: KAVERI, inv: [{ inum: "G1", dt: "02-09-2026", itms: [{ num: 1, itm_det: { txval: 1000, iamt: 180, csamt: 12.5 } }, { num: 2, itm_det: { txval: 500.25, iamt: 90.05 } }] }] }] }),
    );
    expect(r.rows[0]).toMatchObject({ taxable: 150_025, igst: 27_005, cess: 1_250, cgst: 0, sgst: 0 });
  });

  it("reports bad dates, bad amounts, missing numbers, bad and missing GSTINs, and keeps the documents", () => {
    const r = parseGstr2b(
      wrap({
        b2b: [
          { ctin: "29AABCK1234A1Z6", inv: [{ inum: "B1", dt: "31-02-2026", txval: "abc", cgst: 9, sgst: 9 }] },
          { inv: [{ dt: "01-09-2026", txval: 10 }] },
        ],
      }),
    );
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(["bad_gstin", "bad_date", "bad_amount", "no_gstin", "missing_number"]));
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ docDate: null, taxable: 0, cgst: 900 });
    expect(r.rows[1]).toMatchObject({ supplierGstin: "", docNumber: "" });
    expect(r.diagnostics.find((d) => d.code === "bad_amount")?.message).toBe("Taxable value “abc” isn't an amount; it was read as zero.");
  });

  it("reports sections and documents of the wrong shape", () => {
    const r = parseGstr2b(wrap({ b2b: { not: "a list" }, cdnr: [5, { ctin: KAVERI }, { ctin: KAVERI, nt: ["x"] }] }));
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes.filter((c) => c === "bad_section")).toHaveLength(1);
    expect(codes.filter((c) => c === "bad_document")).toHaveLength(3);
    expect(r.rows).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("flags a return period that isn't MMYYYY", () => {
    const r = parseGstr2b({ data: { gstin: CLIENT, rtnprd: "2026-09", docdata: {} } });
    expect(r.period).toBeNull();
    expect(r.diagnostics.map((d) => d.code)).toContain("bad_period");
  });

  it("reads CDNRA originals and ISD credit notes (negative)", () => {
    const r = parseGstr2b(
      wrap({
        cdnra: [{ ctin: KAVERI, nt: [{ ontnum: "CN-4", ontdt: "01-08-2026", ntnum: "CN-4A", typ: "C", dt: "03-09-2026", txval: 100, cgst: 9, sgst: 9 }] }],
        isd: [{ ctin: KAVERI, doclist: [{ doctyp: "ISDC", docnum: "ISDC-2", docdt: "30-09-2026", oinvnum: "ISD-1", igst: 50 }] }],
      }),
    );
    expect(r.rows[0]).toMatchObject({ section: "cdnra", docType: "credit_note", originalDocNumber: "CN-4", originalDocDate: "2026-08-01", taxable: -10_000 });
    expect(r.rows[1]).toMatchObject({ section: "isd", docType: "isd_credit_note", igst: -5_000, originalDocNumber: "ISD-1" });
  });

  it("does not double-negate credit notes the file already writes as negative", () => {
    const r = parseGstr2b(wrap({ cdnr: [{ ctin: KAVERI, nt: [{ ntnum: "CN-9", typ: "C", dt: "03-09-2026", txval: -100, cgst: -9, sgst: -9 }] }] }));
    expect([r.rows[0].taxable, r.rows[0].cgst]).toEqual([-10_000, -900]);
  });

  it("reads IMPGSEZ with the SEZ supplier's GSTIN", () => {
    const r = parseGstr2b(wrap({ impgsez: [{ ctin: KAVERI, trdnm: "SEZ Unit", boe: [{ portcode: "INBLR4", boenum: "77", boedt: "09-09-2026", txval: 1000, igst: 180 }] }] }));
    expect(r.rows[0]).toMatchObject({ section: "impgsez", supplierGstin: KAVERI, docType: "bill_of_entry", portCode: "INBLR4", igst: 18_000 });
  });
});

describe("row helpers", () => {
  it("gstDocRow fills defaults and normalises the GSTIN", () => {
    const r = gstDocRow({ supplierGstin: " 29aabck1234a1z5 ", docNumber: "A" });
    expect(r).toMatchObject({ section: "register", supplierGstin: KAVERI, docType: "invoice", taxable: 0, docDate: null, itcAvailable: null, reverseCharge: false });
  });

  it("isCreditDoc, signAmounts and totalTax", () => {
    expect(isCreditDoc("credit_note")).toBe(true);
    expect(isCreditDoc("isd_credit_note")).toBe(true);
    expect(isCreditDoc("debit_note")).toBe(false);
    expect(signAmounts("credit_note", { taxable: 100, igst: -18, cgst: 0, sgst: 0, cess: 1 })).toEqual({ taxable: -100, igst: -18, cgst: 0, sgst: 0, cess: -1 });
    expect(signAmounts("invoice", { taxable: -100, igst: 18, cgst: 0, sgst: 0, cess: 0 })).toEqual({ taxable: 100, igst: 18, cgst: 0, sgst: 0, cess: 0 });
    expect(totalTax({ igst: 1, cgst: 2, sgst: 3, cess: 4 })).toBe(10);
  });

  it("periodLabelOf", () => {
    expect(periodLabelOf("032027")).toBe("Mar 2027");
    expect(periodLabelOf("132026")).toBeNull();
    expect(periodLabelOf(null)).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------
// Spreadsheet cells
// -------------------------------------------------------------------------------------------------

describe("parseCellAmount", () => {
  it.each([
    ["1,23,456.50", 12_345_650],
    ["₹ 500", 50_000],
    ["Rs. 500", 50_000],
    ["INR 1,000", 100_000],
    ["(500.00)", -50_000],
    ["-500", -50_000],
    [" 12 ", 1_200],
    [1234.5, 123_450],
    [1.005, 101],
    [0, 0],
  ])("%s → %s paise", (input, paise) => {
    expect(parseCellAmount(input)).toEqual({ ok: true, value: paise });
  });

  it.each([[""], ["-"], ["–"], [null], [undefined]])("%s is empty", (input) => {
    expect(parseCellAmount(input)).toEqual({ ok: true, value: null });
  });

  it("refuses text, NaN and booleans with a sentence", () => {
    expect(parseCellAmount("abc")).toEqual({ ok: false, error: "“abc” isn't an amount" });
    expect(parseCellAmount(Number.NaN).ok).toBe(false);
    expect(parseCellAmount(true).ok).toBe(false);
  });
});

describe("parseCellDate", () => {
  it.each([
    ["05-09-2026", "2026-09-05"],
    ["5/9/2026", "2026-09-05"],
    ["05.09.2026", "2026-09-05"],
    ["05-09-26", "2026-09-05"],
    ["2026-09-05", "2026-09-05"],
    ["2026-09-05 00:00:00", "2026-09-05"],
    ["05-Sep-2026", "2026-09-05"],
    ["5-Sept-26", "2026-09-05"],
    ["5 September 2026", "2026-09-05"],
    ["Sep 5, 2026", "2026-09-05"],
    ["20260905", "2026-09-05"],
    ["46270", "2026-09-05"],
    [46270, "2026-09-05"],
    [46270.75, "2026-09-05"],
    [20260905, "2026-09-05"],
  ])("%s → %s", (input, iso) => {
    expect(parseCellDate(input)).toEqual({ ok: true, value: iso });
  });

  it("reads Date objects as the IST calendar date", () => {
    expect(parseCellDate(new Date("2026-09-05T00:00:00+05:30"))).toEqual({ ok: true, value: "2026-09-05" });
    expect(parseCellDate(new Date(Date.UTC(2026, 8, 5)))).toEqual({ ok: true, value: "2026-09-05" });
  });

  it("empty is null; impossible dates and text are errors", () => {
    expect(parseCellDate("")).toEqual({ ok: true, value: null });
    expect(parseCellDate(null)).toEqual({ ok: true, value: null });
    expect(parseCellDate("31-02-2026").ok).toBe(false);
    expect(parseCellDate("hello")).toEqual({ ok: false, error: "“hello” isn't a date (use DD-MM-YYYY)" });
    expect(parseCellDate(5).ok).toBe(false);
    expect(parseCellDate("05-Xyz-2026").ok).toBe(false);
  });

  it("cellText trims and stringifies", () => {
    expect(cellText("  a ")).toBe("a");
    expect(cellText(12)).toBe("12");
    expect(cellText(null)).toBe("");
    expect(cellText({})).toBe("");
  });
});

// -------------------------------------------------------------------------------------------------
// Column mapping
// -------------------------------------------------------------------------------------------------

describe("mapColumns (§6.12 column-mapping step)", () => {
  it("maps the fixture's portal-style headers exactly and leaves Voucher No unused", () => {
    const s = mapColumns(register.headers);
    expect(s.mapping).toEqual({
      supplierGstin: "GSTIN of Supplier",
      supplierName: "Supplier Name",
      docType: "Doc Type",
      docNumber: "Invoice No",
      docDate: "Invoice Date",
      taxable: "Taxable Value",
      igst: "Integrated Tax",
      cgst: "Central Tax",
      sgst: "State/UT Tax",
      cess: "Cess",
    });
    expect(Object.values(s.sources).every((v) => v === "exact")).toBe(true);
    expect(s.unusedHeaders).toEqual(["Voucher No"]);
    expect(s.complete).toBe(true);
  });

  it("handles Tally-style headers: prefers the supplier invoice number, skips rate columns", () => {
    const headers = ["Date", "Particulars", "Voucher No.", "Supplier Invoice No.", "GSTIN/UIN", "Taxable Amount", "IGST Rate", "IGST Amount", "CGST Amount", "SGST Amount"];
    const s = mapColumns(headers);
    expect(s.mapping).toMatchObject({
      docDate: "Date",
      supplierName: "Particulars",
      docNumber: "Supplier Invoice No.",
      supplierGstin: "GSTIN/UIN",
      taxable: "Taxable Amount",
      igst: "IGST Amount",
      cgst: "CGST Amount",
      sgst: "SGST Amount",
      cess: null,
      docType: null,
    });
    expect(s.unusedHeaders).toEqual(["Voucher No.", "IGST Rate"]);
  });

  it("falls back to a header that contains a spelling (partial)", () => {
    const s = mapColumns(["Vendor GSTIN No.", "Bill No", "Bill Dt", "Invoice Date (DD-MM-YYYY)", "Total Taxable Value", "IGST Paid"]);
    expect(s.mapping.supplierGstin).toBe("Vendor GSTIN No.");
    expect(s.sources.supplierGstin).toBe("partial");
    expect(s.mapping.docDate).toBe("Invoice Date (DD-MM-YYYY)");
    expect(s.mapping.taxable).toBe("Total Taxable Value");
    expect(s.mapping.igst).toBe("IGST Paid");
    expect(mapColumns(["IGST %", "IGST (₹)"]).mapping.igst).toBe("IGST (₹)");
    expect(mapColumns(["IGST %"]).mapping.igst).toBeNull();
  });

  it("starts from the client's saved mapping when its headers are still there", () => {
    const s = mapColumns(register.headers, { docNumber: "Voucher No", cess: null });
    expect(s.mapping.docNumber).toBe("Voucher No");
    expect(s.sources.docNumber).toBe("saved");
    expect(s.mapping.cess).toBeNull(); // unmapped on purpose last time
    expect(s.unusedHeaders).toContain("Invoice No");
  });

  it("ignores a saved header that is no longer in the file", () => {
    const s = mapColumns(register.headers, { docNumber: "Bill Reference" });
    expect(s.mapping.docNumber).toBe("Invoice No");
    expect(s.sources.docNumber).toBe("exact");
  });

  it("lists required fields still missing", () => {
    const s = mapColumns(["Invoice No", "Invoice Date", "Taxable Value"]);
    expect(s.missingRequired).toEqual(["supplierGstin"]);
    expect(s.complete).toBe(false);
  });

  it("normaliseHeader", () => {
    expect(normaliseHeader(" Supplier's GSTIN ")).toBe("suppliersgstin");
    expect(normaliseHeader("P&L")).toBe("pandl");
  });

  it("validateColumnMapping: required, unknown and duplicate columns", () => {
    const headers = register.headers;
    expect(validateColumnMapping(mapColumns(headers).mapping, headers, REGISTER_FIELD_SPECS)).toBeNull();
    const errors = validateColumnMapping<RegisterField>(
      { supplierGstin: "GSTIN of Supplier", docNumber: "Nope", docDate: "Invoice Date", taxable: "Invoice Date" },
      headers,
      REGISTER_FIELD_SPECS,
    );
    expect(errors).toEqual({
      docNumber: ["The file has no column called “Nope”."],
      taxable: ["“Invoice Date” is already used for document date."],
    });
    expect(validateColumnMapping<RegisterField>({}, headers, REGISTER_FIELD_SPECS)?.supplierGstin).toEqual(["Choose the column that holds the supplier gstin."]);
  });

  it("suggestColumnMapping never uses a header twice", () => {
    const s = suggestColumnMapping(["Amount"], [
      { field: "a", label: "A", required: true, synonyms: ["amount"] },
      { field: "b", label: "B", required: true, synonyms: ["amount"] },
    ]);
    expect(s.mapping).toEqual({ a: "Amount", b: null });
    expect(s.missingRequired).toEqual(["b"]);
  });
});

// -------------------------------------------------------------------------------------------------
// Purchase register rows
// -------------------------------------------------------------------------------------------------

describe("parseRegisterRows (§6.12)", () => {
  const mapping = mapColumns(register.headers).mapping;
  const result = parseRegisterRows(register.rows, mapping);

  it("accepts good rows, rejects bad ones, skips blank and total rows", () => {
    expect(result.counts).toEqual({ total: 13, accepted: 10, rejected: 1, skipped: 2 });
    expect(result.issues.filter((i) => i.level === "error")).toEqual([{ row: 13, level: "error", field: "supplierGstin", message: "Supplier GSTIN is empty." }]);
    expect(result.issues.filter((i) => i.level === "warning")).toEqual([]);
  });

  it("normalises GSTINs, dates, blanks and dashes", () => {
    expect(byNumber(result.rows, "KT-101")).toMatchObject({ supplierGstin: KAVERI, taxable: 500_000, cgst: 45_000, ref: "row 3", section: "register" });
    expect(byNumber(result.rows, "inv-7")).toMatchObject({ docDate: "2026-09-05", taxable: 1_000_000, igst: 0 });
    expect(byNumber(result.rows, "KT-102").docDate).toBe("2026-09-12");
    expect(byNumber(result.rows, "MSL450")).toMatchObject({ docDate: "2026-09-17", igst: 1_800_000, cgst: 0, sgst: 0, supplierName: "Mahalaxmi Steel Pvt Ltd" });
  });

  it("makes credit notes negative and accepts a bill of entry without a GSTIN", () => {
    expect(byNumber(result.rows, "CN-05")).toMatchObject({ docType: "credit_note", taxable: -100_000, cgst: -9_000, sgst: -9_000 });
    expect(byNumber(result.rows, "1234567")).toMatchObject({ docType: "bill_of_entry", supplierGstin: "", igst: 720_000 });
  });

  const one = (cells: Record<string, unknown>) =>
    parseRegisterRows(
      [
        {
          "GSTIN of Supplier": KAVERI,
          "Supplier Name": "Kaveri Traders",
          "Doc Type": "",
          "Invoice No": "Z-1",
          "Invoice Date": "01-09-2026",
          "Taxable Value": 1000,
          "Integrated Tax": 0,
          "Central Tax": 90,
          "State/UT Tax": 90,
          Cess: 0,
          ...cells,
        },
      ],
      mapping,
    );

  it("reads a negative invoice as a credit note (silently without a type, with a warning when the type says invoice)", () => {
    const silent = one({ "Taxable Value": -1000, "Central Tax": -90, "State/UT Tax": -90 });
    expect(silent.rows[0]).toMatchObject({ docType: "credit_note", taxable: -100_000 });
    expect(silent.issues).toEqual([]);
    const warned = one({ "Doc Type": "Invoice", "Taxable Value": -1000, "Central Tax": -90, "State/UT Tax": -90 });
    expect(warned.rows[0].docType).toBe("credit_note");
    expect(warned.issues[0]).toMatchObject({ level: "warning", field: "docType" });
  });

  it("warns on mixed signs and on negative debit notes", () => {
    expect(one({ "Central Tax": -90 }).issues[0].message).toContain("all were read as positive");
    const dn = one({ "Doc Type": "Debit Note", "Taxable Value": -1000, "Central Tax": -90, "State/UT Tax": -90 });
    expect(dn.rows[0]).toMatchObject({ docType: "debit_note", taxable: 100_000 });
    expect(dn.issues[0].message).toBe("Negative amounts on a debit note were read as positive.");
  });

  it("warns (keeps the row) for an invalid GSTIN, a bad or missing date, an unknown type, IGST with CGST, CGST ≠ SGST", () => {
    const gstin = one({ "GSTIN of Supplier": "29AABCK1234A1Z6" });
    expect(gstin.rows).toHaveLength(1);
    expect(gstin.issues[0]).toMatchObject({ level: "warning", field: "supplierGstin" });
    const date = one({ "Invoice Date": "32-09-2026" });
    expect(date.rows[0].docDate).toBeNull();
    expect(date.issues[0].message).toContain("can still match on its number");
    expect(one({ "Invoice Date": "" }).issues[0].message).toBe("Document date is empty; the row can still match on its number.");
    expect(one({ "Doc Type": "Purchase Voucher X" }).issues[0].message).toContain("wasn't recognised");
    expect(one({ "Integrated Tax": 180 }).issues.map((i) => i.field)).toContain("igst");
    expect(one({ "State/UT Tax": 80 }).issues.map((i) => i.field)).toContain("sgst");
  });

  it("rejects a row with a bad amount, no taxable value or no number", () => {
    expect(one({ "Central Tax": "ninety" }).counts.rejected).toBe(1);
    expect(one({ "Taxable Value": "" }).issues[0]).toMatchObject({ level: "error", message: "Taxable value is empty." });
    expect(one({ "Invoice No": " " }).issues[0]).toMatchObject({ level: "error", field: "docNumber" });
  });

  it("allows ISD rows without a taxable value", () => {
    const isd = one({ "Doc Type": "ISD", "Taxable Value": "", "Integrated Tax": 50, "Central Tax": 0, "State/UT Tax": 0 });
    expect(isd.rows[0]).toMatchObject({ docType: "isd_invoice", taxable: 0, igst: 5_000 });
  });

  it("refuses to read anything until the required columns are mapped", () => {
    const r = parseRegisterRows(register.rows, { ...mapping, docNumber: null });
    expect(r.counts.rejected).toBe(13);
    expect(r.issues).toEqual([{ row: 0, level: "error", field: "docNumber", message: "Map the document number column before reading the register." }]);
  });

  it("uses the given first row number", () => {
    const r = parseRegisterRows([{ "Invoice No": "Q" }], mapping, { firstRowNumber: 5 });
    expect(r.issues.every((i) => i.row === 5)).toBe(true);
  });
});

describe("parseDocType", () => {
  it.each([
    ["Invoice", "invoice", true],
    ["Tax Invoice", "invoice", true],
    ["B2B", "invoice", true],
    ["R", "invoice", true],
    ["Credit Note", "credit_note", true],
    ["CN", "credit_note", true],
    ["C", "credit_note", true],
    ["Purchase Return", "credit_note", true],
    ["Debit Note", "debit_note", true],
    ["DN", "debit_note", true],
    ["Bill of Entry", "bill_of_entry", true],
    ["Import", "bill_of_entry", true],
    ["ISD", "isd_invoice", true],
    ["ISDC", "isd_credit_note", true],
    ["Journal", "invoice", false],
  ])("%s → %s", (text, type, known) => {
    expect(parseDocType(text)).toEqual({ docType: type, known });
  });

  it("is null for an empty cell", () => {
    expect(parseDocType("  ")).toBeNull();
  });
});
