import { describe, expect, it } from "vitest";
import {
  checkGstDocumentNumber,
  checkSeriesPrefix,
  formatDocumentNumber,
  formatSeriesNumber,
  isSeriesKey,
  isValidGstInvoiceNumber,
  NUMBERING_DEFAULTS,
  planNextNumber,
  SERIES,
  SERIES_KEYS,
} from "@/lib/domain/numbering";

describe("series definitions (§5.11, §5.2)", () => {
  it("has the seven series keys", () => {
    expect([...SERIES_KEYS]).toEqual(["invoice", "credit_note", "quotation", "receipt", "client_code", "task", "lead"]);
    expect(Object.keys(SERIES).sort()).toEqual([...SERIES_KEYS].sort());
    expect(isSeriesKey("invoice")).toBe(true);
    expect(isSeriesKey("debit_note")).toBe(false);
  });

  it("uses the firm_settings default prefixes", () => {
    expect(SERIES.invoice.defaultPrefix).toBe("TW");
    expect(SERIES.credit_note.defaultPrefix).toBe("TW-CN");
    expect(SERIES.quotation.defaultPrefix).toBe("TW-Q");
    expect(SERIES.receipt.defaultPrefix).toBe("TW-R");
    expect(SERIES.client_code.defaultPrefix).toBe("TW-C");
    expect(SERIES.invoice.prefixSetting).toBe("invoice_prefix");
    expect(SERIES.task.prefixSetting).toBeNull();
  });

  it("FY-scoped: invoice, credit note, quotation, receipt; not: client code, task, lead", () => {
    expect(SERIES_KEYS.filter((k) => SERIES[k].fyScoped)).toEqual(["invoice", "credit_note", "quotation", "receipt"]);
  });

  it("the 16-character limit is a parameter with the Rule 46 value", () => {
    expect(NUMBERING_DEFAULTS.gstDocumentMaxLength).toBe(16);
  });
});

describe("formatDocumentNumber", () => {
  it("formats FY-scoped numbers as <prefix>/<yy-yy>/<0000>", () => {
    expect(formatDocumentNumber({ prefix: "TW", fyShort: "26-27", seq: 42, pad: 4 })).toBe("TW/26-27/0042");
    expect(formatDocumentNumber({ prefix: "TW", fyShort: "26-27", seq: 1, pad: 4 })).toBe("TW/26-27/0001");
  });

  it("formats other series as <prefix>-<0000>", () => {
    expect(formatDocumentNumber({ prefix: "TW-C", seq: 1, pad: 4 })).toBe("TW-C-0001");
    expect(formatDocumentNumber({ prefix: "T", fyShort: null, seq: 123, pad: 6 })).toBe("T-000123");
  });

  it("never truncates a sequence longer than the padding", () => {
    expect(formatDocumentNumber({ prefix: "TW", fyShort: "26-27", seq: 12345, pad: 4 })).toBe("TW/26-27/12345");
  });

  it("refuses a sequence below 1 or not whole", () => {
    expect(() => formatDocumentNumber({ prefix: "TW", seq: 0, pad: 4 })).toThrow(RangeError);
    expect(() => formatDocumentNumber({ prefix: "TW", seq: -1, pad: 4 })).toThrow(RangeError);
    expect(() => formatDocumentNumber({ prefix: "TW", seq: 1.5, pad: 4 })).toThrow(RangeError);
  });
});

describe("formatSeriesNumber", () => {
  it("formats every series with its default prefix", () => {
    expect(formatSeriesNumber("invoice", { seq: 42, date: "2026-10-22" })).toBe("TW/26-27/0042");
    expect(formatSeriesNumber("credit_note", { seq: 1, fy: "2026-27" })).toBe("TW-CN/26-27/0001");
    expect(formatSeriesNumber("quotation", { seq: 7, fy: "2026-27" })).toBe("TW-Q/26-27/0007");
    expect(formatSeriesNumber("receipt", { seq: 3, date: "2027-03-31" })).toBe("TW-R/26-27/0003");
    expect(formatSeriesNumber("client_code", { seq: 1 })).toBe("TW-C-0001");
    expect(formatSeriesNumber("task", { seq: 123 })).toBe("T-000123");
    expect(formatSeriesNumber("lead", { seq: 1 })).toBe("L-0001");
  });

  it("takes the FY from the date (1 April starts a new FY)", () => {
    expect(formatSeriesNumber("invoice", { seq: 1, date: "2027-04-01" })).toBe("TW/27-28/0001");
  });

  it("uses a configured prefix", () => {
    expect(formatSeriesNumber("invoice", { seq: 5, prefix: "TWC", fy: "2026-27" })).toBe("TWC/26-27/0005");
  });

  it("needs the FY for FY-scoped series", () => {
    expect(() => formatSeriesNumber("invoice", { seq: 1 })).toThrow("financial year");
  });

  it("every default first number satisfies Rule 46", () => {
    for (const key of SERIES_KEYS) {
      const n = formatSeriesNumber(key, { seq: 1, fy: "2026-27" });
      expect(isValidGstInvoiceNumber(n), n).toBe(true);
    }
    expect(formatSeriesNumber("credit_note", { seq: 9999, fy: "2026-27" })).toHaveLength(16);
  });
});

describe("GST Rule 46 number check (§0.1 rule 6, §6.4)", () => {
  it("accepts up to 16 letters, digits, - and /", () => {
    expect(isValidGstInvoiceNumber("TW/26-27/0042")).toBe(true);
    expect(isValidGstInvoiceNumber("TW-CN/26-27/0001")).toBe(true); // exactly 16
    expect(isValidGstInvoiceNumber("a")).toBe(true);
    expect(isValidGstInvoiceNumber("tw/26-27/0042")).toBe(true);
  });

  it("rejects 17+ characters, empty strings and other characters", () => {
    expect(isValidGstInvoiceNumber("TW-CN/26-27/10000")).toBe(false); // 17
    expect(isValidGstInvoiceNumber("")).toBe(false);
    for (const bad of ["TW 26-27 0042", "TW_26_27", "TW#0042", "TW/26-27/0042.", "TW\\26"]) {
      expect(isValidGstInvoiceNumber(bad), bad).toBe(false);
    }
  });

  it("takes the limit as a parameter", () => {
    expect(isValidGstInvoiceNumber("TW/26-27/0042", 12)).toBe(false);
    expect(isValidGstInvoiceNumber("TW-CN/26-27/10000", 20)).toBe(true);
  });

  it("checkGstDocumentNumber explains failures", () => {
    expect(checkGstDocumentNumber("TW/26-27/0042")).toEqual({ ok: true });
    expect(checkGstDocumentNumber("")).toEqual({ ok: false, error: "The number is empty." });
    expect(checkGstDocumentNumber("TW 1")).toEqual({ ok: false, error: "GST invoice numbers can use only letters, digits, - and /." });
    expect(checkGstDocumentNumber("TW-CN/26-27/10000")).toEqual({
      ok: false,
      error: "TW-CN/26-27/10000 is 17 characters; GST invoice numbers can have at most 16.",
    });
  });
});

describe("checkSeriesPrefix (Settings → Numbering)", () => {
  const fy = "2026-27";

  it("accepts the defaults and reports the sample and capacity", () => {
    expect(checkSeriesPrefix("invoice", "TW", { fy })).toEqual({ ok: true, prefix: "TW", sample: "TW/26-27/0001", length: 13, maxSequence: 9_999_999 });
    expect(checkSeriesPrefix("credit_note", "TW-CN", { fy })).toEqual({
      ok: true,
      prefix: "TW-CN",
      sample: "TW-CN/26-27/0001",
      length: 16,
      maxSequence: 9999,
    });
    expect(checkSeriesPrefix("client_code", "TW-C", { fy })).toMatchObject({ ok: true, sample: "TW-C-0001", maxSequence: 99_999_999_999 });
  });

  it("returns an error when the prefix makes numbers longer than 16 characters", () => {
    expect(checkSeriesPrefix("invoice", "TWCINV", { fy })).toEqual({
      ok: false,
      error: "With the prefix TWCINV, invoice numbers would be 17 characters (TWCINV/26-27/0001). They can have at most 16. Use a prefix of at most 5 characters.",
    });
    const r = checkSeriesPrefix("client_code", "TAXWISE-CLIENT", { fy });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("at most 11 characters");
  });

  it("respects a different limit", () => {
    expect(checkSeriesPrefix("invoice", "TW-INV", { fy, maxLength: 20 }).ok).toBe(true);
  });

  it("refuses empty prefixes and bad characters", () => {
    expect(checkSeriesPrefix("invoice", "  ", { fy })).toEqual({ ok: false, error: "Enter a prefix." });
    expect(checkSeriesPrefix("invoice", "TW#", { fy })).toEqual({ ok: false, error: "A prefix can use only letters, digits, - and /." });
    expect(checkSeriesPrefix("invoice", "T W", { fy }).ok).toBe(false);
    expect(checkSeriesPrefix("invoice", "-TW", { fy })).toEqual({ ok: false, error: "Start and end the prefix with a letter or a digit." });
    expect(checkSeriesPrefix("invoice", "TW/", { fy }).ok).toBe(false);
  });

  it("trims surrounding spaces", () => {
    expect(checkSeriesPrefix("invoice", " TW ", { fy })).toMatchObject({ ok: true, prefix: "TW" });
  });
});

describe("planNextNumber (mirror of next_document_number)", () => {
  it("continues within the same FY", () => {
    expect(planNextNumber("invoice", { financialYear: "2026-27", nextValue: 42 }, { date: "2026-10-22" })).toEqual({
      ok: true,
      number: "TW/26-27/0042",
      seq: 42,
      next: { financialYear: "2026-27", nextValue: 43 },
    });
  });

  it("starts at 1 on first use", () => {
    expect(planNextNumber("quotation", { financialYear: null, nextValue: 1 }, { date: "2026-10-22" })).toMatchObject({
      ok: true,
      number: "TW-Q/26-27/0001",
      next: { financialYear: "2026-27", nextValue: 2 },
    });
  });

  it("restarts at 1 when the FY rolls over", () => {
    expect(planNextNumber("invoice", { financialYear: "2026-27", nextValue: 120 }, { date: "2027-04-01" })).toEqual({
      ok: true,
      number: "TW/27-28/0001",
      seq: 1,
      next: { financialYear: "2027-28", nextValue: 2 },
    });
    expect(planNextNumber("invoice", { financialYear: "2026-27", nextValue: 120 }, { date: "2027-03-31" })).toMatchObject({
      number: "TW/26-27/0120",
    });
  });

  it("restarts even when FYs were skipped", () => {
    expect(planNextNumber("receipt", { financialYear: "2024-25", nextValue: 9 }, { date: "2026-10-22" })).toMatchObject({
      number: "TW-R/26-27/0001",
    });
  });

  it("refuses a date in an FY earlier than the counter's, rather than reusing numbers", () => {
    const r = planNextNumber("invoice", { financialYear: "2027-28", nextValue: 5 }, { date: "2027-03-31" });
    expect(r).toEqual({
      ok: false,
      error: "The invoice series has moved on to FY 2027-28, so it can't number a document dated in FY 2026-27.",
    });
  });

  it("refuses a number longer than 16 characters", () => {
    const r = planNextNumber("credit_note", { financialYear: "2026-27", nextValue: 10000 }, { date: "2026-10-22" });
    expect(r).toEqual({
      ok: false,
      error: "The next credit note number (TW-CN/26-27/10000) would be longer than 16 characters. Shorten the prefix in Settings → Numbering.",
    });
    expect(planNextNumber("invoice", { financialYear: "2026-27", nextValue: 1 }, { date: "2026-10-22", prefix: "TWCINV" }).ok).toBe(false);
  });

  it("trims the prefix and refuses characters GST Rule 46 doesn't allow, before anything else (as the SQL does)", () => {
    expect(planNextNumber("invoice", { financialYear: "2026-27", nextValue: 3 }, { date: "2026-10-22", prefix: " TWC " })).toMatchObject({
      ok: true,
      number: "TWC/26-27/0003",
    });
    expect(planNextNumber("invoice", { financialYear: "2026-27", nextValue: 3 }, { date: "2026-10-22", prefix: "TW#1" })).toEqual({
      ok: false,
      error: 'The invoice prefix "TW#1" can use only letters, digits, - and /. Fix it in Settings → Numbering.',
    });
    expect(planNextNumber("client_code", { financialYear: null, nextValue: 1 }, { date: "2026-10-22", prefix: "   " })).toEqual({
      ok: false,
      error: 'The client code prefix "" can use only letters, digits, - and /. Fix it in Settings → Numbering.',
    });
    // The prefix is checked before the FY: an earlier-FY date with a bad prefix reports the prefix.
    expect(planNextNumber("invoice", { financialYear: "2027-28", nextValue: 5 }, { date: "2026-10-22", prefix: "TW 1" })).toMatchObject({
      ok: false,
      error: expect.stringContaining('prefix "TW 1"'),
    });
  });

  it("never resets series that aren't FY-scoped", () => {
    expect(planNextNumber("client_code", { financialYear: null, nextValue: 42 }, { date: "2027-04-01" })).toEqual({
      ok: true,
      number: "TW-C-0042",
      seq: 42,
      next: { financialYear: null, nextValue: 43 },
    });
    expect(planNextNumber("task", { financialYear: "2026-27", nextValue: 123 }, { date: "2030-01-01" })).toMatchObject({
      number: "T-000123",
      next: { financialYear: "2026-27", nextValue: 124 },
    });
    expect(planNextNumber("lead", { financialYear: null, nextValue: 1 }, { date: "2026-10-22" })).toMatchObject({ number: "L-0001" });
  });

  it("uses a configured prefix", () => {
    expect(planNextNumber("invoice", { financialYear: "2026-27", nextValue: 7 }, { date: "2026-10-22", prefix: "TWC" })).toMatchObject({
      number: "TWC/26-27/0007",
    });
  });

  it("reports a damaged counter", () => {
    const r = planNextNumber("invoice", { financialYear: "2026-27", nextValue: 0 }, { date: "2026-10-22" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("counter is damaged");
  });

  it("issues consecutive numbers with no gaps or repeats across a rollover", () => {
    let state = { financialYear: "2026-27" as string | null, nextValue: 9998 };
    const issued: string[] = [];
    for (const date of ["2027-03-30", "2027-03-31", "2027-04-01", "2027-04-01", "2027-04-02"]) {
      const r = planNextNumber("invoice", state, { date });
      if (!r.ok) throw new Error(r.error);
      issued.push(r.number);
      state = r.next;
    }
    expect(issued).toEqual(["TW/26-27/9998", "TW/26-27/9999", "TW/27-28/0001", "TW/27-28/0002", "TW/27-28/0003"]);
    expect(new Set(issued).size).toBe(issued.length);
  });
});
