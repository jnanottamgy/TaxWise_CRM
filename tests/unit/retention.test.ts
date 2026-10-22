import { describe, expect, it } from "vitest";
import {
  canPurge,
  gstAnnualReturnDueDate,
  resolveRetentionParams,
  RETENTION_DEFAULTS,
  RETENTION_SEED_PARAMETERS,
  retentionByYear,
  retentionCandidates,
  retentionExpired,
  retentionUntil,
  reviewForDisposal,
} from "@/lib/domain/retention";

const UPLOADED = "2026-10-22";

describe("each retention rule (§6.8)", () => {
  it("working papers: 7 years from the auditor's report (SQC 1)", () => {
    expect(retentionUntil({ uploadedOn: UPLOADED, auditReportDate: "2026-09-30" })).toMatchObject({ rule: "working_papers", until: "2033-09-30" });
    // A report signed on 29 Feb keeps to 28 Feb seven years on.
    expect(retentionUntil({ uploadedOn: UPLOADED, auditReportDate: "2028-02-29" }).until).toBe("2035-02-28");
  });

  it("a company's books: 8 financial years (s.128(5)): FY X kept to the end of FY X + 8", () => {
    expect(retentionUntil({ uploadedOn: UPLOADED, companyBooksFinancialYear: "2025-26" })).toMatchObject({ rule: "company_books", until: "2034-03-31" });
  });

  it("GST records: 72 months from the annual return's due date (s.36), 31 Dec after the FY (s.44)", () => {
    expect(gstAnnualReturnDueDate("2025-26")).toBe("2026-12-31");
    expect(retentionUntil({ uploadedOn: UPLOADED, gstFinancialYear: "2025-26" })).toMatchObject({ rule: "gst_records", until: "2032-12-31" });
  });

  it("GST records follow an extended annual-return due date when one is given", () => {
    expect(retentionUntil({ uploadedOn: UPLOADED, gstFinancialYear: "2025-26", gstAnnualReturnDueDate: "2027-02-28" }).until).toBe("2033-02-28");
  });

  it("income-tax records: 6 years from the end of the assessment year (Rule 6F(5)) [verify the 2026 Rules]", () => {
    // FY 2025-26 → AY 2026-27 ends 31 Mar 2027 → + 6 years.
    expect(retentionUntil({ uploadedOn: UPLOADED, incomeTaxFinancialYear: "2025-26" })).toMatchObject({ rule: "income_tax_records", until: "2033-03-31" });
  });

  it("falls back to upload + 7 years only when no rule applies (§5.8)", () => {
    expect(retentionUntil({ uploadedOn: UPLOADED })).toMatchObject({ rule: "default", until: "2033-10-22" });
    expect(retentionCandidates({ uploadedOn: UPLOADED, gstFinancialYear: "2025-26" }).map((c) => c.rule)).toEqual(["gst_records"]);
  });
});

describe("the longest rule wins (§6.8)", () => {
  it("compares every applicable rule", () => {
    const r = retentionUntil({
      uploadedOn: UPLOADED,
      auditReportDate: "2026-09-30", // 2033-09-30
      companyBooksFinancialYear: "2025-26", // 2034-03-31
      gstFinancialYear: "2025-26", // 2032-12-31
      incomeTaxFinancialYear: "2025-26", // 2033-03-31
    });
    expect(r.rule).toBe("company_books");
    expect(r.until).toBe("2034-03-31");
    expect(r.candidates.map((c) => [c.rule, c.until])).toEqual([
      ["working_papers", "2033-09-30"],
      ["company_books", "2034-03-31"],
      ["gst_records", "2032-12-31"],
      ["income_tax_records", "2033-03-31"],
    ]);
    expect(r.explanation).toContain("Companies Act s.128(5)");
  });

  it("a late audit report outlasts the books", () => {
    const r = retentionUntil({ uploadedOn: UPLOADED, auditReportDate: "2027-09-30", companyBooksFinancialYear: "2025-26" });
    expect(r).toMatchObject({ rule: "working_papers", until: "2034-09-30" });
  });

  it("uses edited periods", () => {
    const params = { ...RETENTION_DEFAULTS, workingPapersYears: 10 };
    expect(retentionUntil({ uploadedOn: UPLOADED, auditReportDate: "2026-09-30" }, params).until).toBe("2036-09-30");
  });

  it("throws for a malformed financial year", () => {
    expect(() => retentionUntil({ uploadedOn: UPLOADED, companyBooksFinancialYear: "2025-27" })).toThrow(RangeError);
  });
});

describe("purging and the disposal review (§6.8, §7.19)", () => {
  it("blocks purging until retention_until has passed (the date itself is still kept)", () => {
    expect(canPurge("2033-09-30", "2033-09-29")).toMatchObject({ ok: false });
    const onTheDay = canPurge("2033-09-30", "2033-09-30");
    expect(onTheDay).toEqual({ ok: false, error: "This document must be kept until 30 Sep 2033 under the retention rules, so it can't be purged yet." });
    expect(canPurge("2033-09-30", "2033-10-01")).toEqual({ ok: true });
    expect(retentionExpired("2033-09-30", "2033-10-01")).toBe(true);
    expect(retentionExpired(null, "2033-10-01")).toBe(false);
  });

  it("blocks purging a document with no retention date", () => {
    expect(canPurge(null, "2040-01-01")).toMatchObject({ ok: false, error: expect.stringContaining("no retention date") });
  });

  it("lists documents past retention for review, oldest first; nothing is deleted automatically", () => {
    const docs = [
      { id: "kept", retentionUntil: "2034-03-31" },
      { id: "b", retentionUntil: "2033-06-30" },
      { id: "a", retentionUntil: "2032-12-31" },
      { id: "gone", retentionUntil: "2030-01-01", deletedAt: "2031-01-01T00:00:00Z" },
      { id: "none", retentionUntil: null },
    ];
    const list = reviewForDisposal(docs, "2033-10-22");
    expect(list.map((d) => d.id)).toEqual(["a", "b"]);
    expect(docs).toHaveLength(5);
  });

  it("summarises documents by the year their retention ends", () => {
    expect(
      retentionByYear([
        { id: "1", retentionUntil: "2033-03-31" },
        { id: "2", retentionUntil: "2032-12-31" },
        { id: "3", retentionUntil: "2033-09-30" },
        { id: "4", retentionUntil: null },
        { id: "5", retentionUntil: "2031-01-01", deletedAt: "2026-01-01" },
      ]),
    ).toEqual([
      { year: 2032, count: 1 },
      { year: 2033, count: 2 },
    ]);
  });
});

describe("parameters (§5.12, §16)", () => {
  it("resolves every key from the seed, with the 2026 income-tax row unverified", () => {
    const now = resolveRetentionParams(RETENTION_SEED_PARAMETERS, "2026-10-22");
    expect(now.params).toEqual(RETENTION_DEFAULTS);
    expect(now.missing).toEqual([]);
    expect(now.unverified).toEqual(["retention.income_tax_years_after_ay"]);
    const before = resolveRetentionParams(RETENTION_SEED_PARAMETERS, "2025-10-22");
    expect(before.unverified).toEqual([]);
    expect(before.params.incomeTaxYearsAfterAssessmentYear).toBe(6);
  });

  it("falls back to the defaults for missing or unusable values", () => {
    const r = resolveRetentionParams([{ key: "retention.gst_records_months", value: "seventy-two", effectiveFrom: "2017-07-01" }], "2026-10-22");
    expect(r.params).toEqual(RETENTION_DEFAULTS);
    expect(r.missing).toContain("retention.gst_records_months");
  });

  it("seeds the §6.8 periods", () => {
    const byKey = new Map(RETENTION_SEED_PARAMETERS.map((r) => [`${r.key}@${r.effectiveFrom}`, r]));
    expect(byKey.get("retention.working_papers_years@2009-04-01")?.value).toBe(7);
    expect(byKey.get("retention.company_books_financial_years@2014-04-01")?.value).toBe(8);
    expect(byKey.get("retention.gst_records_months@2017-07-01")?.value).toBe(72);
    expect(byKey.get("retention.income_tax_years_after_ay@1962-04-01")).toMatchObject({ value: 6, effectiveTo: "2026-03-31", verified: true });
    expect(byKey.get("retention.income_tax_years_after_ay@2026-04-01")).toMatchObject({ value: 6, effectiveTo: null, verified: false });
    expect(byKey.get("retention.default_years@2009-04-01")?.value).toBe(7);
  });
});
