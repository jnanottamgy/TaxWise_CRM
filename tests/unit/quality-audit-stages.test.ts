import { describe, expect, it } from "vitest";
import {
  AUDIT_SEED_PARAMETERS,
  AUDIT_STAGES,
  AUDIT_STEPS,
  AUDIT_TYPES,
  STAGE_STANDARDS,
  auditRetainUntil,
  caroApplicability,
  checkSignoff,
  computeMateriality,
  countsTowardsCompanyLimit,
  EMPTY_COMPANY_FACTS,
  fileAssemblyCountdown,
  fileAssemblyDue,
  gateSentence,
  gateSteps,
  isSmallCompany,
  kycReminder,
  kycReviewDate,
  materialityComplete,
  nextStage,
  previousStage,
  readChecklist,
  readCompanyFacts,
  readGate,
  readMateriality,
  representationLetter,
  representationSignatories,
  resolveAuditParams,
  signableStages,
  stageProgress,
  stepState,
  stepsFor,
  taxAuditReportForm,
  toStoredCompanyFacts,
  type AuditStep,
  type CompanyFacts,
  type StepSignoff,
} from "@/lib/domain/audit-stages";
import type { StatutoryParameterRow } from "@/lib/domain/gst";
import { formatDate } from "@/lib/format";

/**
 * Audit engagements to the Standards on Auditing (§6.9, §7.15.5): the stages and the SA checklist,
 * sign-offs, materiality (SA 320), the SA 230 assembly countdown and retention, small company /
 * CARO 2020 / the company audit limit, the tax audit report's form by statute, the gate's words, the
 * SA 580 representation letter, and the KYC re-confirmation reminder.
 */

const rows: StatutoryParameterRow[] = AUDIT_SEED_PARAMETERS.map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, verified: r.verified }));
const CRORE = 1_00_00_000;
const facts = (over: Partial<CompanyFacts>): CompanyFacts => ({ ...EMPTY_COMPANY_FACTS, ...over });
const signed = (over: Partial<StepSignoff>): StepSignoff => ({ preparedBy: null, preparedAt: null, reviewedBy: null, reviewedAt: null, notApplicable: false, naReason: null, note: null, ...over });

describe("stages and the SA checklist (§6.9)", () => {
  it("runs seven stages in order, one at a time, never back from Archive", () => {
    expect(AUDIT_STAGES).toEqual(["acceptance", "planning", "risk_assessment", "execution", "completion", "reporting", "archived"]);
    expect(nextStage("acceptance")).toBe("planning");
    expect(nextStage("reporting")).toBe("archived");
    expect(nextStage("archived")).toBeNull();
    expect(previousStage("acceptance")).toBeNull();
    expect(previousStage("planning")).toBe("acceptance");
    expect(previousStage("archived")).toBeNull();
    for (const s of AUDIT_STAGES) expect(STAGE_STANDARDS[s].length).toBeGreaterThan(0);
  });

  it("every stage has steps with SA references and guidance; keys are unique", () => {
    const keys = AUDIT_STEPS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const stage of AUDIT_STAGES) expect(AUDIT_STEPS.filter((s) => s.stage === stage).length).toBeGreaterThan(0);
    for (const s of AUDIT_STEPS) {
      expect(s.sa.length).toBeGreaterThan(0);
      expect(s.guidance.length).toBeGreaterThan(20);
      expect(/^[a-z]+\.[a-z_]+$/.test(s.key)).toBe(true);
    }
  });

  it("names the Standards §6.9 lists at each stage", () => {
    const refs = (stage: string) => AUDIT_STEPS.filter((s) => s.stage === stage).flatMap((s) => s.sa).join(" ");
    expect(refs("acceptance")).toContain("SA 210");
    expect(refs("acceptance")).toContain("Clause 8");
    for (const sa of ["SA 300", "SA 320"]) expect(refs("planning")).toContain(sa);
    for (const sa of ["SA 315", "SA 240", "SA 250", "SA 550"]) expect(refs("risk_assessment")).toContain(sa);
    for (const sa of ["SA 330", "SA 500", "SA 505", "SA 520", "SA 530", "SA 540"]) expect(refs("execution")).toContain(sa);
    for (const sa of ["SA 450", "SA 560", "SA 570", "SA 580", "SA 260", "SA 265"]) expect(refs("completion")).toContain(sa);
    for (const sa of ["SA 700", "SA 705", "SA 701", "SA 706", "CARO 2020"]) expect(refs("reporting")).toContain(sa);
    expect(refs("archived")).toContain("SA 230");
  });

  it("keeps company-only steps (KAMs, CARO) off other audits, and the tax audit form step off company audits", () => {
    const tax = stepsFor("tax_audit", "reporting").map((s) => s.key);
    const company = stepsFor("statutory_companies_act", "reporting").map((s) => s.key);
    expect(tax).not.toContain("rep.caro");
    expect(tax).toContain("rep.tax_audit_form");
    expect(company).toContain("rep.caro");
    expect(company).not.toContain("rep.tax_audit_form");
    for (const t of AUDIT_TYPES) expect(stepsFor(t, "acceptance").length).toBe(7);
  });

  it("signs the current stage's steps, and Archive's from Reporting; nothing once archived", () => {
    expect(signableStages("planning")).toEqual(["planning"]);
    expect(signableStages("reporting")).toEqual(["reporting", "archived"]);
    expect(signableStages("archived")).toEqual([]);
    const toArchive = gateSteps("tax_audit", "reporting", "archived").map((s) => s.stage);
    expect(new Set(toArchive)).toEqual(new Set(["reporting", "archived"]));
    expect(gateSteps("tax_audit", "planning", "acceptance")).toEqual([]);
  });
});

describe("sign-offs", () => {
  const step = AUDIT_STEPS.find((s) => s.key === "plan.strategy") as AuditStep;
  const naStep = AUDIT_STEPS.find((s) => s.key === "exec.sampling") as AuditStep;
  const base = { step, auditType: "statutory_companies_act" as const, currentStage: "planning" as const, actorId: "u1", evidenceCount: 1 };

  it("reads the stored checklist defensively", () => {
    const c = readChecklist({ steps: { "plan.strategy": { prepared_by: "u1", prepared_at: "2026-10-01T05:00:00Z", reviewed_by: "u2", reviewed_at: "2026-10-02T05:00:00Z" }, bad: "x", "exec.sampling": { na: true, na_reason: "No sampling", prepared_by: "u1", prepared_at: "2026-10-01T05:00:00Z" } } });
    expect(stepState(c["plan.strategy"])).toBe("reviewed");
    expect(stepState(c["exec.sampling"])).toBe("not_applicable");
    expect(c.bad).toBeUndefined();
    expect(readChecklist(null)).toEqual({});
    expect(readChecklist({ steps: [] })).toEqual({});
  });

  it("needs a working paper before prepare, a reason for N/A, and someone else to review", () => {
    expect(checkSignoff({ ...base, signoff: null, action: "prepare", evidenceCount: 0 })).toMatchObject({ ok: false });
    expect(checkSignoff({ ...base, signoff: null, action: "prepare" })).toEqual({ ok: true });
    expect(checkSignoff({ ...base, signoff: null, action: "not_applicable", reason: "n/a" })).toMatchObject({ ok: false, error: "This step can't be marked not applicable." });
    expect(checkSignoff({ ...base, step: naStep, currentStage: "execution", signoff: null, action: "not_applicable", reason: "No" })).toMatchObject({ ok: false });
    expect(checkSignoff({ ...base, step: naStep, currentStage: "execution", signoff: null, action: "not_applicable", reason: "No population to sample" })).toEqual({ ok: true });
    const prepared = signed({ preparedBy: "u1", preparedAt: "2026-10-01T05:00:00Z" });
    expect(checkSignoff({ ...base, signoff: prepared, action: "review" })).toMatchObject({ ok: false, error: "You prepared this step, so someone else has to review it." });
    expect(checkSignoff({ ...base, signoff: prepared, action: "review", actorId: "u2" })).toEqual({ ok: true });
    expect(checkSignoff({ ...base, signoff: null, action: "review", actorId: "u2" })).toMatchObject({ ok: false });
    expect(checkSignoff({ ...base, signoff: null, action: "reopen" })).toMatchObject({ ok: false });
  });

  it("refuses steps of another stage and anything once archived", () => {
    expect(checkSignoff({ ...base, currentStage: "execution", signoff: null, action: "prepare" })).toMatchObject({ ok: false });
    expect(checkSignoff({ ...base, currentStage: "archived", signoff: null, action: "prepare" })).toMatchObject({ ok: false, error: "This audit file is archived and read-only." });
    const kam = AUDIT_STEPS.find((s) => s.key === "rep.kam") as AuditStep;
    expect(checkSignoff({ ...base, step: kam, auditType: "tax_audit", currentStage: "reporting", signoff: null, action: "prepare" })).toMatchObject({ ok: false });
  });

  it("counts a stage done only when every step is reviewed", () => {
    const steps = stepsFor("tax_audit", "planning");
    const all = Object.fromEntries(steps.map((s) => [s.key, signed({ preparedBy: "u1", preparedAt: "x", reviewedBy: "u2", reviewedAt: "y" })]));
    expect(stageProgress("tax_audit", "planning", all)).toMatchObject({ total: steps.length, done: steps.length, complete: true });
    const one = { ...all, [steps[0].key]: signed({ preparedBy: "u1", preparedAt: "x" }) };
    expect(stageProgress("tax_audit", "planning", one)).toMatchObject({ done: steps.length - 1, awaitingReview: 1, complete: false });
  });
});

describe("materiality (SA 320)", () => {
  it("works overall, performance and trivial in paise, rounded", () => {
    const m = computeMateriality({ basis: "revenue", baseAmountPaise: 10 * CRORE * 100, percent: 1, performancePercent: 75, trivialPercent: 5 });
    expect(m).toEqual({ overallPaise: 10_00_000_00, performancePaise: 7_50_000_00, trivialPaise: 50_000_00, warnings: [] });
    const odd = computeMateriality({ basis: "profit_before_tax", baseAmountPaise: 1_23_45_678_91, percent: 5, performancePercent: 60, trivialPercent: 3 });
    expect(odd.overallPaise).toBe(6_17_283_95);
    expect(odd.performancePaise).toBe(3_70_370_37);
  });

  it("warns, never blocks, when a percentage is outside the usual range", () => {
    const m = computeMateriality({ basis: "revenue", baseAmountPaise: 10 * CRORE * 100, percent: 3, performancePercent: 90, trivialPercent: 8 });
    expect(m.warnings.length).toBe(3);
    expect(computeMateriality({ basis: "revenue", baseAmountPaise: 0, percent: 1, performancePercent: 75, trivialPercent: 5 }).warnings[0]).toMatch(/isn't positive/);
  });

  it("reads the stored figures and checks them as the Planning gate does", () => {
    const stored = { basis: "revenue", base_amount: 100000000, percent: 1, overall: 1000000, performance_percent: 75, performance: 750000, trivial_percent: 5, trivial: 50000, rationale: "Revenue is the users' focus.", determined_on: "2026-10-01", determined_by: "u1" };
    expect(materialityComplete(readMateriality(stored))).toBe(true);
    expect(materialityComplete(readMateriality({ ...stored, performance: 2000000 }))).toBe(false);
    expect(materialityComplete(readMateriality({ ...stored, trivial: 800000 }))).toBe(false);
    expect(readMateriality({ ...stored, basis: "ebitda" })).toBeNull();
    expect(readMateriality(null)).toBeNull();
  });
});

describe("file assembly (SA 230) and retention (SQC 1)", () => {
  it("is due 60 days after the report date", () => {
    expect(fileAssemblyDue("2026-09-01")).toBe("2026-10-31");
  });

  it("counts down, warns in the last 14 days, and records late assembly", () => {
    const r = "2026-09-01";
    expect(fileAssemblyCountdown({ reportDate: null, archivedOn: null, today: "2026-10-24" }).state).toBe("no_report");
    expect(fileAssemblyCountdown({ reportDate: r, archivedOn: null, today: "2026-09-10" })).toEqual({ state: "running", due: "2026-10-31", daysLeft: 51, daysLate: null });
    expect(fileAssemblyCountdown({ reportDate: r, archivedOn: null, today: "2026-10-24" })).toMatchObject({ state: "due_soon", daysLeft: 7 });
    expect(fileAssemblyCountdown({ reportDate: r, archivedOn: null, today: "2026-10-31" })).toMatchObject({ state: "due_soon", daysLeft: 0 });
    expect(fileAssemblyCountdown({ reportDate: r, archivedOn: null, today: "2026-11-02" })).toMatchObject({ state: "overdue", daysLate: 2 });
    expect(fileAssemblyCountdown({ reportDate: r, archivedOn: "2026-10-30", today: "2026-11-30" }).state).toBe("assembled");
    expect(fileAssemblyCountdown({ reportDate: r, archivedOn: "2026-11-05", today: "2026-11-30" })).toMatchObject({ state: "assembled_late", daysLate: 5 });
  });

  it("keeps working papers 7 years from the report date", () => {
    expect(auditRetainUntil("2026-09-01")).toBe("2033-09-01");
    expect(auditRetainUntil("2024-02-29")).toBe("2031-02-28");
  });
});

describe("small company, CARO 2020 and the company audit limit", () => {
  it("uses the small-company limits in force on the date", () => {
    const r2024 = resolveAuditParams(rows, "2024-04-01");
    const r2026 = resolveAuditParams(rows, "2026-04-01");
    const f = facts({ isPublic: false, paidUpCapital: 5 * CRORE, turnover: 50 * CRORE });
    expect(isSmallCompany(f, r2024.params.smallCompany)).toBe(false);
    expect(isSmallCompany(f, r2026.params.smallCompany)).toBe(true);
    expect(r2026.unverified).toContain("company.small_company_limits");
    expect(isSmallCompany(facts({ isPublic: true, paidUpCapital: 1, turnover: 1 }))).toBe(false);
    expect(isSmallCompany(facts({ isPublic: false, isHoldingOrSubsidiary: true, paidUpCapital: 1, turnover: 1 }))).toBe(false);
    expect(isSmallCompany(facts({ isPublic: false, paidUpCapital: null, turnover: 1 }))).toBeNull();
  });

  it("indicates CARO 2020 by Para 1(2)'s exclusions", () => {
    expect(caroApplicability(facts({ isBanking: true })).applicable).toBe(false);
    expect(caroApplicability(facts({ isInsurance: true })).applicable).toBe(false);
    expect(caroApplicability(facts({ isSection8: true })).applicable).toBe(false);
    expect(caroApplicability(facts({ isOnePersonCompany: true, isPublic: false })).applicable).toBe(false);
    expect(caroApplicability(facts({ isPublic: false, paidUpCapital: 2 * CRORE, turnover: 20 * CRORE })).applicable).toBe(false);
    expect(caroApplicability(facts({ isPublic: true, paidUpCapital: 2 * CRORE, turnover: 20 * CRORE })).applicable).toBe(true);
    // A subsidiary of a private company is never small, but Para 1(2)(v) can still exclude it.
    const sub = facts({ isPublic: false, isHoldingOrSubsidiary: true, paidUpCapital: 50_00_000, turnover: 5 * CRORE, capitalAndReserves: 80_00_000, maxBorrowings: 0, revenue: 5 * CRORE });
    expect(caroApplicability(sub).applicable).toBe(false);
    expect(caroApplicability({ ...sub, isHoldingOrSubsidiaryOfPublic: true }).applicable).toBe(true);
    expect(caroApplicability({ ...sub, revenue: 12 * CRORE }).applicable).toBe(true);
    expect(caroApplicability(facts({})).applicable).toBeNull();
  });

  it("counts only audits s.141(3)(g) counts", () => {
    const exclusion = 100 * CRORE * 100;
    expect(countsTowardsCompanyLimit(facts({ isOnePersonCompany: true }), exclusion)).toBe(false);
    expect(countsTowardsCompanyLimit(facts({ isDormant: true }), exclusion)).toBe(false);
    expect(countsTowardsCompanyLimit(facts({ isPublic: true, paidUpCapital: 1 * CRORE, turnover: 1 * CRORE }), exclusion)).toBe(true);
    expect(countsTowardsCompanyLimit(facts({ isPublic: false, paidUpCapital: 150 * CRORE, turnover: 900 * CRORE }), exclusion)).toBe(true);
    expect(countsTowardsCompanyLimit(facts({ isPublic: false, paidUpCapital: 50 * CRORE, turnover: 500 * CRORE }), exclusion)).toBe(false);
    expect(countsTowardsCompanyLimit(facts({ isPublic: null }), exclusion)).toBeNull();
  });

  it("round-trips the stored company facts", () => {
    const f = facts({ isPublic: false, isSection8: true, paidUpCapital: 1234.5, revenue: 0 });
    expect(readCompanyFacts(toStoredCompanyFacts(f))).toEqual(f);
    expect(readCompanyFacts("junk")).toEqual(EMPTY_COMPANY_FACTS);
  });
});

describe("the tax audit report's form by statute (§6.1)", () => {
  it("is Form 3CA/3CB with 3CD up to AY 2026-27 and Form 26 from tax year 2026-27", () => {
    expect(taxAuditReportForm("2025-26")).toBe("Form 3CA/3CB with Form 3CD");
    expect(taxAuditReportForm("2026-27")).toBe("Form 26");
  });
});

describe("the gate's words", () => {
  it("reads the database's answer defensively and joins the missing items", () => {
    const g = readGate({ ok: false, from: "acceptance", to: "planning", missing: [{ code: "kyc", message: "complete the client's KYC (PAN)" }, { nope: 1 }], warnings: [], is_engagement_partner: true }, { from: "acceptance", to: "planning" });
    expect(g.missing).toEqual([{ code: "kyc", message: "complete the client's KYC (PAN)", step: null }]);
    expect(g.isEngagementPartner).toBe(true);
    expect(readGate(null, { from: "planning", to: "risk_assessment" })).toMatchObject({ ok: false, from: "planning", to: "risk_assessment", missing: [] });
    expect(gateSentence("planning", g.missing)).toBe("Before Planning: complete the client's KYC (PAN).");
    expect(gateSentence("archived", [{ code: "a", message: "one." }, { code: "b", message: "two" }])).toBe("Before Archive: one; two.");
    expect(gateSentence("planning", [])).toBe("");
  });
});

describe("written representations (SA 580)", () => {
  const base = { entityName: "Sharma Steels Private Limited", financialYear: "2025-26", engagementLetterDate: "2026-06-15", reportDate: "2026-09-10", caroApplicable: true, formatDate: (d: string) => formatDate(d) };

  it("covers SA 580's required representations and the specific ones for a company audit", () => {
    const l = representationLetter({ ...base, auditType: "statutory_companies_act", entityType: "pvt_ltd" });
    const text = [l.opening, ...l.sections.flatMap((s) => s.items)].join(" ");
    for (const sa of ["SA 580", "SA 540", "SA 550", "SA 560", "SA 450", "SA 501", "SA 570", "SA 240", "SA 250"]) expect(text).toContain(sa);
    expect(text).toContain("dated 15 Jun 2026");
    expect(text).toContain("Companies (Auditor's Report) Order, 2020");
    expect(text).not.toContain("section 197");
    expect(l.subject).toContain("31 Mar 2026");
    expect(l.signatories).toEqual(["Managing Director / Whole-time Director", "Chief Financial Officer"]);
    expect(l.misstatementSchedule).toBe(true);
    expect(l.dateNote).toContain("10 Sep 2026");
  });

  it("drops the CARO paragraph when CARO doesn't apply, and adds s.197 for a public company", () => {
    const noCaro = representationLetter({ ...base, auditType: "statutory_companies_act", entityType: "pvt_ltd", caroApplicable: false });
    expect(noCaro.sections.flatMap((s) => s.items).join(" ")).not.toContain("Auditor's Report");
    const pub = representationLetter({ ...base, auditType: "statutory_companies_act", entityType: "public_ltd" });
    expect(pub.sections.flatMap((s) => s.items).join(" ")).toContain("section 197");
  });

  it("words a tax audit by its statute: Form 3CD under the 1961 Act, Form 26 under the 2025 Act", () => {
    const old = representationLetter({ ...base, auditType: "tax_audit", entityType: "partnership" });
    expect(old.subject).toContain("section 44AB");
    expect(old.sections.map((s) => s.title)).toContain("Tax audit report (Form 3CD)");
    expect(old.sections.flatMap((s) => s.items).join(" ")).toContain("40A(3)");
    expect(old.signatories).toEqual(["Partner", "Partner"]);
    const neu = representationLetter({ ...base, financialYear: "2026-27", auditType: "tax_audit", entityType: "proprietorship" });
    expect(neu.subject).toContain("Income-tax Act, 2025");
    expect(neu.sections.map((s) => s.title)).toContain("Tax audit report (Form 26)");
    expect(neu.sections.flatMap((s) => s.items).join(" ")).not.toContain("40A(3)");
    expect(neu.signatories).toEqual(["Proprietor"]);
  });

  it("uses the framework the engagement letter names, and fits non-audit work", () => {
    const l = representationLetter({ ...base, auditType: "other", entityType: "trust", framework: "the accounting standards for non-profit organisations" });
    expect(l.opening).toContain("non-profit organisations");
    const gst = representationLetter({ ...base, auditType: "gst_audit", entityType: "llp", engagementLetterDate: null, reportDate: null });
    expect(gst.misstatementSchedule).toBe(false);
    expect(gst.sections.map((s) => s.title)).toContain("GST");
    expect(gst.sections[0].items[0]).toContain("as set out in the terms of the audit engagement,");
    expect(gst.dateNote).not.toMatch(/\d{1,2} [A-Z][a-z]{2} \d{4}/);
    expect(representationSignatories(null)).toEqual(["Authorised signatory"]);
    expect(representationSignatories("huf")).toEqual(["Karta"]);
  });
});

describe("KYC re-confirmation (§6.8)", () => {
  it("falls due a year after verification unless a review date is set", () => {
    expect(kycReviewDate(null, "2025-10-24")).toBe("2026-10-24");
    expect(kycReviewDate("2026-12-01", "2025-10-24")).toBe("2026-12-01");
    expect(kycReviewDate(null, null)).toBeNull();
  });

  it("reminds within 30 days and once it has passed", () => {
    expect(kycReminder("2026-11-10", "2026-10-24")).toBe("due_soon");
    expect(kycReminder("2026-11-23", "2026-10-24")).toBe("due_soon");
    expect(kycReminder("2026-11-24", "2026-10-24")).toBeNull();
    expect(kycReminder("2026-10-24", "2026-10-24")).toBe("due_soon");
    expect(kycReminder("2026-10-23", "2026-10-24")).toBe("due");
    expect(kycReminder(null, "2026-10-24")).toBeNull();
  });
});
