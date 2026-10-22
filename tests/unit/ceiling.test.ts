import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPACITY_PARAM_KEYS, CAPACITY_SEED_PARAMETERS } from "@/lib/domain/capacity";
import {
  CEILING_DEFAULTS,
  CEILING_PARAM_KEYS,
  CEILING_SEED_PARAMETERS,
  ceilingThresholdsCrossed,
  ceilingWarning,
  checkAuditStageMove,
  checkCompanyAuditLimit,
  checkNewTaxAudit,
  countsTowardsCompanyAuditLimit,
  countsTowardsTaxAuditCeiling,
  kycCompleteness,
  peerReviewStatus,
  peerReviewValidOn,
  REPORT_FORMS,
  resolveCeilingParams,
  taxAuditCount,
  udinDatesWarning,
  udinStatus,
  type AuditStageMove,
  type CeilingUdinRecord,
  type KycRecord,
} from "@/lib/domain/ceiling";
import { ESCALATION_PARAM_KEYS, ESCALATION_SEED_PARAMETERS } from "@/lib/domain/escalation";
import type { SeedParameterRow } from "@/lib/domain/gst";
import { PRESENCE_PARAM_KEYS, PRESENCE_SEED_PARAMETERS } from "@/lib/domain/presence";
import { RETENTION_PARAM_KEYS, RETENTION_SEED_PARAMETERS } from "@/lib/domain/retention";

const CRORE = 1_00_00_000_00; // ₹1 crore in paise
const P1 = "partner-1";

// -------------------------------------------------------------------------------------------------
// Tax audit ceiling (§6.8)
// -------------------------------------------------------------------------------------------------

describe("what counts towards the tax-audit ceiling (§6.8)", () => {
  it("counts Form 3CA and 3CB u/s 44AB(a), (b) and combined", () => {
    for (const form of ["3CA", "3CB_44AB_a", "3CB_44AB_b", "3CB_combined"] as const) {
      expect(countsTowardsTaxAuditCeiling({ reportForm: form, isRevised: false })).toBe(true);
    }
  });

  it("doesn't count 3CB u/s 44AB(c), (d), (e), or non-tax-audit reports", () => {
    for (const form of ["3CB_44AB_c", "3CB_44AB_d", "3CB_44AB_e", "audit_report", "certificate", "gst_audit", "other"] as const) {
      expect(countsTowardsTaxAuditCeiling({ reportForm: form, isRevised: false })).toBe(false);
    }
    expect(REPORT_FORMS).toHaveLength(12);
  });

  it("never counts a revised report separately", () => {
    expect(countsTowardsTaxAuditCeiling({ reportForm: "3CA", isRevised: true })).toBe(false);
    expect(countsTowardsTaxAuditCeiling({ reportForm: "FORM_26", isRevised: true, form26Category: "a" })).toBe(false);
  });

  it("counts Form 26 by the category it replaces [verify]; unknown category counts, as the trigger defaults", () => {
    expect(countsTowardsTaxAuditCeiling({ reportForm: "FORM_26", isRevised: false, form26Category: "a" })).toBe(true);
    expect(countsTowardsTaxAuditCeiling({ reportForm: "FORM_26", isRevised: false, form26Category: "combined" })).toBe(true);
    expect(countsTowardsTaxAuditCeiling({ reportForm: "FORM_26", isRevised: false, form26Category: "d" })).toBe(false);
    expect(countsTowardsTaxAuditCeiling({ reportForm: "FORM_26", isRevised: false })).toBe(true);
  });

  it("is unknown (null) when the report form isn't recorded", () => {
    expect(countsTowardsTaxAuditCeiling({ reportForm: null, isRevised: false })).toBeNull();
  });
});

describe("taxAuditCount (§6.8, tax_audit_ceiling_view)", () => {
  let n = 0;
  const rec = (over: Partial<CeilingUdinRecord> = {}): CeilingUdinRecord => ({
    id: `u${++n}`,
    signingMemberId: P1,
    signedOn: "2026-09-15",
    reportForm: "3CA",
    isRevised: false,
    clientId: `client-${n}`,
    financialYear: "2025-26",
    ...over,
  });

  it("counts by the date SIGNED, per financial year", () => {
    const records = [rec({ signedOn: "2026-03-31" }), rec({ signedOn: "2026-04-01" }), rec({ signedOn: "2027-03-31" }), rec({ signedOn: "2027-04-01" })];
    expect(taxAuditCount(records, P1, "2026-27").signedInFirm).toBe(2);
    expect(taxAuditCount(records, P1, "2025-26").signedInFirm).toBe(1);
  });

  it("counts head office and branch audits of the same assessee and year as one", () => {
    const records = [
      rec({ clientId: "acme", financialYear: "2025-26" }),
      rec({ clientId: "acme", financialYear: "2025-26", signedOn: "2026-09-20" }),
      rec({ clientId: "acme", financialYear: "2024-25" }), // a different year covered counts on its own
    ];
    expect(taxAuditCount(records, P1, "2026-27").signedInFirm).toBe(2);
  });

  it("leaves out revised reports, uncounted forms and other members", () => {
    const records = [
      rec(),
      rec({ isRevised: true }),
      rec({ reportForm: "3CB_44AB_d" }),
      rec({ reportForm: "certificate" }),
      rec({ reportForm: null }),
      rec({ signingMemberId: "partner-2" }),
      rec({ signingMemberId: null }),
    ];
    expect(taxAuditCount(records, P1, "2026-27").signedInFirm).toBe(1);
  });

  it("adds the audits signed elsewhere, and counts reports with no client one by one", () => {
    const records = [rec({ clientId: null }), rec({ clientId: null })];
    const c = taxAuditCount(records, P1, "2026-27", 12);
    expect(c).toMatchObject({ signedInFirm: 2, signedElsewhere: 12, total: 14, ceiling: 60, remaining: 46, warning: null, warnLevel: null });
  });

  it("warns at 50 and 58, and flags at and over 60", () => {
    expect(taxAuditCount([], P1, "2026-27", 49).warning).toBeNull();
    expect(taxAuditCount([], P1, "2026-27", 50)).toMatchObject({ warning: "near", warnLevel: 50 });
    expect(taxAuditCount([], P1, "2026-27", 58)).toMatchObject({ warning: "near", warnLevel: 58 });
    expect(taxAuditCount([], P1, "2026-27", 60)).toMatchObject({ warning: "at_ceiling", remaining: 0 });
    expect(taxAuditCount([], P1, "2026-27", 61)).toMatchObject({ warning: "over", remaining: -1 });
    expect(ceilingWarning(57)).toBe("near");
  });
});

describe("logging one more tax audit (§6.8)", () => {
  it("warns from the 50th, and the 58th", () => {
    expect(checkNewTaxAudit({ currentTotal: 48, actorRole: "partner", confirmed: false })).toEqual({ position: 49, level: "ok", allowed: true, message: null });
    expect(checkNewTaxAudit({ currentTotal: 49, actorRole: "partner", confirmed: false })).toEqual({
      position: 50,
      level: "warn",
      allowed: true,
      message: "This is tax audit 50 of 60 for the year (10 left).",
    });
    expect(checkNewTaxAudit({ currentTotal: 57, actorRole: "manager", confirmed: false })).toMatchObject({ position: 58, level: "warn", allowed: true });
    expect(checkNewTaxAudit({ currentTotal: 59, actorRole: "manager", confirmed: false })).toMatchObject({ position: 60, level: "warn", allowed: true });
  });

  it("needs a Partner's confirmation to log a 61st", () => {
    const unconfirmed = checkNewTaxAudit({ currentTotal: 60, actorRole: "partner", confirmed: false });
    expect(unconfirmed).toEqual({
      position: 61,
      level: "confirm",
      allowed: false,
      message: "This would be tax audit 61 for the year, over the ICAI ceiling of 60. A Partner must confirm it to log it.",
    });
    expect(checkNewTaxAudit({ currentTotal: 60, actorRole: "manager", confirmed: true })).toMatchObject({ level: "confirm", allowed: false });
    expect(checkNewTaxAudit({ currentTotal: 60, actorRole: "partner", confirmed: true })).toMatchObject({ level: "confirm", allowed: true });
  });

  it("names the thresholds crossed for the 50 / 58 / 60 notifications (§9)", () => {
    expect(ceilingThresholdsCrossed(49, 50)).toEqual([50]);
    expect(ceilingThresholdsCrossed(57, 58)).toEqual([58]);
    expect(ceilingThresholdsCrossed(59, 60)).toEqual([60]);
    expect(ceilingThresholdsCrossed(40, 60)).toEqual([50, 58, 60]);
    expect(ceilingThresholdsCrossed(50, 51)).toEqual([]);
    expect(ceilingThresholdsCrossed(60, 61)).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// Company audit limit (§6.8)
// -------------------------------------------------------------------------------------------------

describe("company audit limit (Companies Act s.141(3)(g))", () => {
  it("excludes OPCs, small companies, dormant companies and private companies under ₹100 crore paid-up", () => {
    expect(countsTowardsCompanyAuditLimit({ isPrivate: true, isOnePersonCompany: true, paidUpCapitalPaise: 200 * CRORE })).toBe(false);
    expect(countsTowardsCompanyAuditLimit({ isPrivate: true, isSmallCompany: true, paidUpCapitalPaise: 1 * CRORE })).toBe(false);
    expect(countsTowardsCompanyAuditLimit({ isPrivate: false, isDormant: true, paidUpCapitalPaise: 500 * CRORE })).toBe(false);
    expect(countsTowardsCompanyAuditLimit({ isPrivate: true, paidUpCapitalPaise: 100 * CRORE - 1 })).toBe(false);
  });

  it("counts public companies, and private companies at or above ₹100 crore paid-up", () => {
    expect(countsTowardsCompanyAuditLimit({ isPrivate: false, paidUpCapitalPaise: 5 * CRORE })).toBe(true);
    expect(countsTowardsCompanyAuditLimit({ isPrivate: true, paidUpCapitalPaise: 100 * CRORE })).toBe(true);
    expect(countsTowardsCompanyAuditLimit({ isPrivate: true, paidUpCapitalPaise: null })).toBe(true);
  });

  it("warns from the 18th countable audit and refuses a 21st", () => {
    expect(checkCompanyAuditLimit(16)).toEqual({ position: 17, level: "ok", message: null });
    expect(checkCompanyAuditLimit(17)).toEqual({ position: 18, level: "warn", message: "This is company audit 18 of 20 for this partner (2 left)." });
    expect(checkCompanyAuditLimit(19)).toMatchObject({ position: 20, level: "warn" });
    expect(checkCompanyAuditLimit(20)).toEqual({ position: 21, level: "block", message: "This would be company audit 21 for this partner, over the limit of 20 (Companies Act s.141(3)(g))." });
  });
});

// -------------------------------------------------------------------------------------------------
// UDIN 60 days and peer review (§6.8)
// -------------------------------------------------------------------------------------------------

describe("UDIN within 60 days of signing (§6.8)", () => {
  it("shows the days left while pending, 0 on the last day, then the days overdue", () => {
    expect(udinStatus({ signedOn: "2026-09-01", generatedOn: null, today: "2026-10-22" })).toEqual({
      state: "pending",
      dueBy: "2026-10-31",
      daysLeft: 9,
      daysLate: null,
      daysSinceSigning: 51,
    });
    expect(udinStatus({ signedOn: "2026-09-01", generatedOn: null, today: "2026-10-31" })).toMatchObject({ state: "pending", daysLeft: 0 });
    expect(udinStatus({ signedOn: "2026-09-01", generatedOn: null, today: "2026-11-03" })).toMatchObject({ state: "overdue", daysLeft: null, daysLate: 3, daysSinceSigning: 63 });
  });

  it("marks a UDIN generated in time, or late", () => {
    expect(udinStatus({ signedOn: "2026-09-01", generatedOn: "2026-10-31", today: "2026-12-01" })).toMatchObject({ state: "generated", daysLate: null });
    expect(udinStatus({ signedOn: "2026-09-01", generatedOn: "2026-11-02", today: "2026-12-01" })).toMatchObject({ state: "generated_late", daysLate: 2 });
  });

  it("warns on save when generated more than 60 days after signing, and refuses generation before signing", () => {
    expect(udinDatesWarning("2026-09-01", "2026-10-31")).toBeNull();
    expect(udinDatesWarning("2026-09-01", "2026-11-04")).toBe("Generated 64 days after signing; ICAI requires a UDIN within 60 days.");
    expect(udinDatesWarning("2026-09-01", "2026-08-31")).toBe("The UDIN can't be generated before the document is signed.");
  });
});

describe("peer review validity (§6.8)", () => {
  it("warns from 90 days before expiry", () => {
    expect(peerReviewStatus(null, "2026-10-22")).toEqual({ state: "missing", daysLeft: null });
    expect(peerReviewStatus("2027-01-21", "2026-10-22")).toEqual({ state: "valid", daysLeft: 91 });
    expect(peerReviewStatus("2027-01-20", "2026-10-22")).toEqual({ state: "expiring", daysLeft: 90 });
    expect(peerReviewStatus("2026-10-22", "2026-10-22")).toEqual({ state: "expiring", daysLeft: 0 });
    expect(peerReviewStatus("2026-10-21", "2026-10-22")).toEqual({ state: "expired", daysLeft: -1 });
  });

  it("checks the certificate on the acceptance date", () => {
    expect(peerReviewValidOn("2026-12-31", "2026-12-31")).toBe(true);
    expect(peerReviewValidOn("2026-12-31", "2027-01-01")).toBe(false);
    expect(peerReviewValidOn(null, "2026-10-22")).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// KYC and the audit stage gates (§6.8, §6.9)
// -------------------------------------------------------------------------------------------------

const TODAY = "2026-10-22";
const individual: KycRecord = {
  entityCategory: "individual_proprietor",
  name: "Ravi Traders",
  pan: "AAAPR1234C",
  businessDescription: "Wholesale textiles",
  lastAuditedFsDocumentId: "doc-1",
  engagementTypes: ["tax_audit"],
  verifiedOn: "2026-04-10",
  nextReviewOn: "2027-04-10",
};

describe("KYC completeness by category (§6.8)", () => {
  it("an individual/proprietor needs name, PAN, business description, last audited FS and engagement type", () => {
    expect(kycCompleteness(individual, TODAY)).toEqual({ complete: true, missing: [], reviewDue: false, current: true });
    expect(kycCompleteness({ ...individual, pan: "", lastAuditedFsDocumentId: null, engagementTypes: [] }, TODAY)).toMatchObject({
      complete: false,
      missing: ["PAN", "last audited financial statements", "engagement type"],
    });
  });

  it("a corporate also needs the CIN and each director's name, address and DIN", () => {
    const corporate: KycRecord = {
      ...individual,
      entityCategory: "corporate",
      cinLlpin: "U12345KA2020PTC123456",
      principalPersons: [{ name: "A Director", address: "Bengaluru", din: "01234567" }],
    };
    expect(kycCompleteness(corporate, TODAY).complete).toBe(true);
    expect(kycCompleteness({ ...corporate, cinLlpin: null }, TODAY).missing).toEqual(["CIN"]);
    expect(kycCompleteness({ ...corporate, principalPersons: [] }, TODAY).missing).toEqual(["directors"]);
    expect(kycCompleteness({ ...corporate, principalPersons: [{ name: "A Director", address: "Bengaluru", pan: "ABCDE1234F" }] }, TODAY).missing).toEqual([
      "each director's name, address and DIN",
    ]);
  });

  it("a non-corporate entity needs each partner's or trustee's name, address and PAN or DIN", () => {
    const firm: KycRecord = { ...individual, entityCategory: "non_corporate", principalPersons: [{ name: "Partner A", address: "Mysuru", pan: "ABCDE1234F" }, { name: "Partner B", address: "Mysuru", din: "07654321" }] };
    expect(kycCompleteness(firm, TODAY).complete).toBe(true);
    expect(kycCompleteness({ ...firm, principalPersons: [{ name: "Partner A", address: "Mysuru" }] }, TODAY).missing).toEqual([
      "each partner's or trustee's name, address and PAN or DIN",
    ]);
  });

  it("is re-confirmed annually", () => {
    expect(kycCompleteness({ ...individual, nextReviewOn: "2026-10-21" }, TODAY)).toMatchObject({ complete: true, reviewDue: true, current: false });
    expect(kycCompleteness({ ...individual, nextReviewOn: "2026-10-22" }, TODAY).reviewDue).toBe(false);
    expect(kycCompleteness({ ...individual, nextReviewOn: null, verifiedOn: "2025-10-21" }, TODAY).reviewDue).toBe(true);
    expect(kycCompleteness({ ...individual, nextReviewOn: null, verifiedOn: "2025-10-22" }, TODAY).reviewDue).toBe(false);
    expect(kycCompleteness({ ...individual, nextReviewOn: null, verifiedOn: null }, TODAY).reviewDue).toBe(true);
    expect(kycCompleteness(null, TODAY)).toMatchObject({ complete: false, current: false });
    // The re-confirmation period is a parameter (kyc.reconfirm_months).
    expect(kycCompleteness({ ...individual, nextReviewOn: null, verifiedOn: "2026-03-22" }, TODAY, { ...CEILING_DEFAULTS, kycReconfirmMonths: 6 }).reviewDue).toBe(true);
    expect(kycCompleteness({ ...individual, nextReviewOn: null, verifiedOn: "2026-04-22" }, TODAY, { ...CEILING_DEFAULTS, kycReconfirmMonths: 6 }).reviewDue).toBe(false);
  });
});

describe("audit stage gates (§6.9, §6.8, §7.15.5)", () => {
  const ready: AuditStageMove = {
    from: "acceptance",
    to: "planning",
    actorIsEngagementPartner: true,
    kyc: kycCompleteness(individual, TODAY),
    previousAuditorRequired: true,
    previousAuditorCommunicated: true,
    engagementLetterStatus: "issued",
    peerReviewRequired: false,
    peerReviewValid: false,
    limitCheck: null,
  };

  it("lets a ready engagement leave Acceptance", () => {
    expect(checkAuditStageMove(ready)).toEqual({ ok: true });
    expect(checkAuditStageMove({ ...ready, engagementLetterStatus: "signed" })).toEqual({ ok: true });
  });

  it("blocks Planning without complete KYC, an Issued engagement letter, or the previous-auditor letter", () => {
    const r = checkAuditStageMove({
      ...ready,
      kyc: kycCompleteness({ ...individual, pan: null }, TODAY),
      engagementLetterStatus: "draft",
      previousAuditorCommunicated: false,
    });
    expect(r).toEqual({
      ok: false,
      error: "Before Planning: complete the client's KYC (PAN); issue the engagement letter (SA 210); record the letter to the previous auditor with proof of delivery.",
      missing: ["complete the client's KYC (PAN)", "issue the engagement letter (SA 210)", "record the letter to the previous auditor with proof of delivery"],
    });
    expect(checkAuditStageMove({ ...ready, engagementLetterStatus: null })).toMatchObject({ ok: false, missing: ["issue the engagement letter (SA 210)"] });
    expect(checkAuditStageMove({ ...ready, previousAuditorRequired: false, previousAuditorCommunicated: false })).toEqual({ ok: true });
  });

  it("blocks when the annual KYC review is due, the peer review isn't valid, or the ceiling blocks", () => {
    expect(checkAuditStageMove({ ...ready, kyc: kycCompleteness({ ...individual, nextReviewOn: "2026-01-01" }, TODAY) })).toMatchObject({
      ok: false,
      missing: ["re-confirm the client's KYC (the annual review is due)"],
    });
    expect(checkAuditStageMove({ ...ready, peerReviewRequired: true, peerReviewValid: false })).toMatchObject({ ok: false });
    expect(checkAuditStageMove({ ...ready, peerReviewRequired: true, peerReviewValid: true })).toEqual({ ok: true });
    const limit = checkCompanyAuditLimit(20);
    expect(checkAuditStageMove({ ...ready, limitCheck: limit })).toMatchObject({ ok: false, missing: [expect.stringContaining("company audit 21")] });
    expect(checkAuditStageMove({ ...ready, limitCheck: checkCompanyAuditLimit(18) })).toEqual({ ok: true });
    expect(checkAuditStageMove({ ...ready, limitCheck: checkNewTaxAudit({ currentTotal: 60, actorRole: "partner", confirmed: false }) })).toMatchObject({ ok: false });
  });

  it("needs the engagement partner's approval and moves forward one stage at a time", () => {
    expect(checkAuditStageMove({ ...ready, actorIsEngagementPartner: false })).toMatchObject({ ok: false, error: expect.stringContaining("engagement partner") });
    expect(checkAuditStageMove({ ...ready, to: "execution" })).toMatchObject({ ok: false, error: "Move one stage at a time: Planning comes next." });
    expect(checkAuditStageMove({ ...ready, from: "planning", to: "risk_assessment", kyc: kycCompleteness(null, TODAY) })).toEqual({ ok: true });
    expect(checkAuditStageMove({ ...ready, from: "execution", to: "planning" })).toEqual({ ok: true });
    expect(checkAuditStageMove({ ...ready, from: "planning", to: "planning" })).toMatchObject({ ok: false });
  });

  it("keeps an archived file read-only", () => {
    expect(checkAuditStageMove({ ...ready, from: "archived", to: "reporting" })).toEqual({ ok: false, error: "This audit file is archived and read-only.", missing: [] });
    expect(checkAuditStageMove({ ...ready, from: "reporting", to: "archived" })).toEqual({ ok: true });
  });
});

// -------------------------------------------------------------------------------------------------
// Parameters and the seed file (supabase/seed/42_params_practice.sql)
// -------------------------------------------------------------------------------------------------

describe("ICAI parameters (§5.12)", () => {
  it("resolves the seeded values, flagging the Form 26 mapping [verify]", () => {
    const r = resolveCeilingParams(CEILING_SEED_PARAMETERS, TODAY);
    expect(r.params).toEqual(CEILING_DEFAULTS);
    expect(r.missing).toEqual([]);
    expect(r.unverified).toEqual([CEILING_PARAM_KEYS.form26Categories]);
  });

  it("has no ceiling row before the 2025 Guidelines took effect, and falls back to the defaults", () => {
    const r = resolveCeilingParams(CEILING_SEED_PARAMETERS, "2026-03-31");
    expect(r.missing).toContain(CEILING_PARAM_KEYS.taxAuditCeiling);
    expect(r.params.taxAuditCeiling).toBe(60);
  });

  it("reads edited values, with the paid-up exclusion in rupees", () => {
    const rows = [
      { key: CEILING_PARAM_KEYS.taxAuditCeiling, value: { value: 50 }, effectiveFrom: "2027-04-01" },
      { key: CEILING_PARAM_KEYS.companyAuditPrivatePaidUpExclusion, value: { amount: 500000000 }, effectiveFrom: "2027-04-01" },
      ...CEILING_SEED_PARAMETERS,
    ];
    const r = resolveCeilingParams(rows, "2027-04-01").params;
    expect(r.taxAuditCeiling).toBe(50);
    expect(r.privateCompanyPaidUpExclusionPaise).toBe(50 * CRORE);
    expect(CEILING_DEFAULTS.privateCompanyPaidUpExclusionPaise).toBe(100 * CRORE);
  });
});

type SqlRow = { key: string; value: unknown; effectiveFrom: string; effectiveTo: string | null; verified: boolean; rest: string };

function readSeedRows(): { sql: string; rows: SqlRow[] } {
  const sql = readFileSync(join(process.cwd(), "supabase/seed/42_params_practice.sql"), "utf8");
  const ROW = /^\s*\('([^']+)', '((?:[^']|'')*)'::jsonb, '(\d{4}-\d{2}-\d{2})', (null|'\d{4}-\d{2}-\d{2}'), (.*), (true|false)\),?$/;
  const rows: SqlRow[] = [];
  for (const line of sql.split("\n")) {
    const m = ROW.exec(line);
    if (!m) continue;
    rows.push({
      key: m[1],
      value: JSON.parse(m[2].replace(/''/g, "'")),
      effectiveFrom: m[3],
      effectiveTo: m[4] === "null" ? null : m[4].slice(1, -1),
      verified: m[6] === "true",
      rest: m[5],
    });
  }
  return { sql, rows };
}

const sqlQuote = (v: string) => `'${v.replace(/'/g, "''")}'`;

describe("seed SQL 42_params_practice.sql (§16)", () => {
  const { sql, rows } = readSeedRows();
  const expected: readonly SeedParameterRow[] = [
    ...CEILING_SEED_PARAMETERS,
    ...RETENTION_SEED_PARAMETERS,
    ...CAPACITY_SEED_PARAMETERS,
    ...PRESENCE_SEED_PARAMETERS,
    ...ESCALATION_SEED_PARAMETERS,
  ];

  it("has exactly the TS seed rows, in order, with the same values, dates and verification", () => {
    expect(rows.length).toBe(expected.length);
    rows.forEach((row, i) => {
      const e = expected[i];
      expect({ key: row.key, value: row.value, effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo, verified: row.verified }).toEqual({
        key: e.key,
        value: e.value,
        effectiveFrom: e.effectiveFrom,
        effectiveTo: e.effectiveTo,
        verified: e.verified,
      });
      expect(row.rest).toBe([e.statute, e.sectionRef, e.sourceRef, e.notes].map(sqlQuote).join(", "));
    });
  });

  it("seeds the §6.8 and practice values the brief names", () => {
    const value = (key: string) => expected.find((r) => r.key === key && r.effectiveTo === null)?.value;
    expect(value("udin.generation_days")).toBe(60);
    expect(value("audit.tax_audit_ceiling")).toBe(60);
    expect(value("audit.tax_audit_ceiling_warn_at")).toEqual([50, 58]);
    expect(value("audit.company_audit_limit")).toBe(20);
    expect(value("audit.company_audit_limit_warn_from")).toBe(18);
    expect(value("peer_review.expiry_warning_days")).toBe(90);
    expect(value("kyc.reconfirm_months")).toBe(12);
    expect(value("capacity.bands")).toEqual({ busy: 1.5, tight: 2.5, over: 4 });
    expect(value("presence.thresholds")).toEqual({ heartbeatMinutes: 5, creditCapMinutes: 6, idleAfterMinutes: 20, staleAfterMinutes: 45 });
    expect(value("escalation.overdue_days")).toEqual({ level1: 3, level2: 7 });
    expect(value("quotation.follow_up_days")).toEqual([3, 7, 14]);
    expect(value("appeal.income_tax.first_appeal")).toEqual({ days: 30 });
    expect(value("appeal.income_tax.tribunal")).toEqual({ days: 60 });
    expect(value("appeal.gst.first_appeal")).toEqual({ months: 3 });
    expect(value("appeal.gst.tribunal")).toEqual({ months: 3 });
  });

  it("fills statute, section, source and notes on every row, and keeps (key, effective_from) unique", () => {
    for (const r of expected) {
      expect(r.statute.length).toBeGreaterThan(0);
      expect(r.sectionRef.length).toBeGreaterThan(0);
      expect(r.sourceRef.length).toBeGreaterThan(0);
      expect(r.notes.length).toBeGreaterThan(0);
      if (r.effectiveTo) expect(r.effectiveTo >= r.effectiveFrom).toBe(true);
    }
    const ids = expected.map((r) => `${r.key}@${r.effectiveFrom}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("flags every [verify] row unverified, and every unverified row says [verify]", () => {
    for (const r of expected) {
      const flagged = r.notes.includes("[verify]") || r.sectionRef.includes("[verify]");
      expect(r.verified).toBe(!flagged);
    }
    expect(expected.filter((r) => !r.verified).map((r) => r.key)).toEqual([
      "audit.tax_audit_form26_categories",
      "retention.income_tax_years_after_ay",
      "appeal.income_tax.first_appeal",
      "appeal.income_tax.tribunal",
      "appeal.gst.first_appeal",
      "appeal.gst.tribunal",
    ]);
  });

  it("documents every key, matches the SQL view's keys, and only inserts statutory_parameters idempotently", () => {
    const allKeys = [
      ...Object.values(CEILING_PARAM_KEYS),
      ...Object.values(RETENTION_PARAM_KEYS),
      ...Object.values(CAPACITY_PARAM_KEYS),
      ...Object.values(PRESENCE_PARAM_KEYS),
      ...Object.values(ESCALATION_PARAM_KEYS),
    ];
    for (const key of allKeys) {
      expect(sql).toContain(`--   ${key}`);
      expect(expected.some((r) => r.key === key)).toBe(true);
    }
    // tax_audit_ceiling_view (0016) reads these two keys.
    expect(CEILING_PARAM_KEYS.taxAuditCeiling).toBe("audit.tax_audit_ceiling");
    expect(CEILING_PARAM_KEYS.taxAuditWarnAt).toBe("audit.tax_audit_ceiling_warn_at");
    expect(sql.match(/insert into/gi)?.length).toBe(1);
    expect(sql).toContain("insert into public.statutory_parameters");
    expect(sql.trimEnd().endsWith("on conflict (key, effective_from) do nothing;")).toBe(true);
    // No other table is touched: no clients, users or demo data (§16).
    expect(Array.from(new Set(sql.match(/\b(public|auth)\.[a-z_]+/g)))).toEqual(["public.statutory_parameters"]);
  });
});
