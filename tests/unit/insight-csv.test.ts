import { describe, expect, it } from "vitest";
import { CSV_BOM, csvCell, csvDocument, csvFileName, csvRow, csvText, looksLikeFormula } from "@/lib/domain/csv";

describe("csvCell (RFC 4180 quoting)", () => {
  it("leaves plain text alone", () => {
    expect(csvCell("Alpha Traders")).toBe("Alpha Traders");
    expect(csvCell("TW-C-0001")).toBe("TW-C-0001");
  });

  it("quotes commas, quotes, line breaks and edge spaces, doubling quotes", () => {
    expect(csvCell("Sharma, Gupta & Co")).toBe('"Sharma, Gupta & Co"');
    expect(csvCell('He said "filed"')).toBe('"He said ""filed"""');
    expect(csvCell("line 1\nline 2")).toBe('"line 1\nline 2"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
    expect(csvCell(" padded ")).toBe('" padded "');
  });

  it("writes missing values as empty and values as values", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(-1500.5)).toBe("-1500.5");
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(new Date("2026-10-22T04:30:00Z"))).toBe("2026-10-22T04:30:00.000Z");
    expect(csvCell(BigInt(12))).toBe("12");
  });

  it("writes objects and arrays as JSON, quoted", () => {
    expect(csvCell({ before: "pending", after: "active" })).toBe('"{""before"":""pending"",""after"":""active""}"');
    expect(csvCell(["gst", "tds"])).toBe('"[""gst"",""tds""]"');
  });
});

describe("formula injection (OWASP CSV injection)", () => {
  it.each(["=SUM(A1:A9)", "+91 97405 40239", "-cmd|' /C calc'!A0", "@SUM(1)", "\t=1+1", "\r=1"])("neutralises %j", (v) => {
    expect(looksLikeFormula(v)).toBe(true);
    expect(csvText(v).startsWith("'")).toBe(true);
  });

  it("keeps the quote inside the field when the field is quoted", () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
  });

  it("leaves plain numbers written as text alone", () => {
    expect(looksLikeFormula("-1500.00")).toBe(false);
    expect(csvCell("-1500.00")).toBe("-1500.00");
    expect(csvCell("42")).toBe("42");
  });

  it("neutralises formulas inside JSON text too", () => {
    // JSON of a string starts with a quote, which is safe; a bare JSON number is safe too.
    expect(csvText(JSON.parse('"=1+1"'))).toBe("'=1+1");
  });
});

describe("csvRow and csvDocument", () => {
  it("ends rows with CRLF", () => {
    expect(csvRow(["a", 1, null, "x,y"])).toBe('a,1,,"x,y"\r\n');
  });

  it("writes the header first and the BOM only when asked", () => {
    expect(csvDocument(["Client", "Outstanding"], [["Alpha", 4782], ["Beta, Ltd", 0]])).toBe('Client,Outstanding\r\nAlpha,4782\r\n"Beta, Ltd",0\r\n');
    expect(csvDocument(["a"], [], { bom: true })).toBe(`${CSV_BOM}a\r\n`);
  });
});

describe("csvFileName", () => {
  it("keeps names safe for an archive or a download", () => {
    expect(csvFileName("audit_logs")).toBe("audit_logs.csv");
    expect(csvFileName("../../etc/passwd")).toBe("etc-passwd.csv");
    expect(csvFileName("Client 360 / Sharma & Co")).toBe("Client-360-Sharma-Co.csv");
    expect(csvFileName("")).toBe("export.csv");
    expect(csvFileName("ledger", "tsv")).toBe("ledger.tsv");
  });
});
