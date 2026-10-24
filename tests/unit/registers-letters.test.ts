import { describe, expect, it } from "vitest";
import {
  addresseeHeading,
  closingParagraphs,
  letterFileName,
  letterReference,
  letterSubject,
  nonAuditOpening,
  CreateLetterSchema,
  canMoveLetter,
  defaultLetterExpiry,
  defaultReportForm,
  defaultReportingFramework,
  feeParagraph,
  isExpiringLetter,
  letterDisplayStatus,
  parseLetterView,
  parseSchedule,
  renewalOf,
  sa210Sections,
  scheduleAnnualPaise,
  scheduleFromServices,
  servicesSummary,
} from "@/lib/schemas/engagement-letters";

const CLIENT = "6d2f1f0e-0d3a-4b8e-9a51-8f0f1d2c3b4a";

describe("engagement letter status (§7.15.3)", () => {
  it("moves Draft → Issued → Signed / Declined / Expired, as the database allows", () => {
    expect(canMoveLetter("draft", "issued")).toBe(true);
    expect(canMoveLetter("draft", "signed")).toBe(false);
    expect(canMoveLetter("issued", "signed")).toBe(true);
    expect(canMoveLetter("issued", "draft")).toBe(true);
    expect(canMoveLetter("signed", "expired")).toBe(true);
    expect(canMoveLetter("signed", "declined")).toBe(false);
    expect(canMoveLetter("declined", "draft")).toBe(true);
    expect(canMoveLetter("expired", "issued")).toBe(false);
  });

  it("derives Expired past the expiry date for issued and signed letters only", () => {
    expect(letterDisplayStatus("signed", "2026-10-22", "2026-10-23")).toBe("expired");
    expect(letterDisplayStatus("signed", "2026-10-23", "2026-10-23")).toBe("signed");
    expect(letterDisplayStatus("draft", "2026-01-01", "2026-10-23")).toBe("draft");
    expect(letterDisplayStatus("issued", null, "2026-10-23")).toBe("issued");
  });

  it("lists letters expiring in 30 days that aren't renewed", () => {
    const today = "2026-10-23";
    expect(isExpiringLetter({ status: "signed", expiresAt: "2026-11-22", renewed: false }, today)).toBe(true);
    expect(isExpiringLetter({ status: "signed", expiresAt: "2026-11-23", renewed: false }, today)).toBe(false);
    expect(isExpiringLetter({ status: "signed", expiresAt: "2026-11-01", renewed: true }, today)).toBe(false);
    expect(isExpiringLetter({ status: "draft", expiresAt: "2026-11-01", renewed: false }, today)).toBe(false);
  });

  it("reads the view, honouring the jobs' ?missing=1", () => {
    expect(parseLetterView("expiring", null)).toBe("expiring");
    expect(parseLetterView(undefined, "1")).toBe("missing");
    expect(parseLetterView("nope", undefined)).toBe("letters");
  });
});

describe("audit letters (SA 210)", () => {
  it("cites the Act in force for a tax audit (§6.1)", () => {
    expect(defaultReportForm("tax_audit", "2025-26")).toMatch(/Form 3CA .* Form 3CB, with the statement of particulars in Form 3CD, for AY 2026-27/);
    expect(defaultReportForm("tax_audit", "2026-27")).toMatch(/Form 26 under the Income-tax Act, 2025.*for Tax year 2026-27/);
    expect(defaultReportingFramework("statutory_companies_act", "pvt_ltd", "2025-26")).toMatch(/section 133 of the Companies Act, 2013/);
    expect(defaultReportingFramework(null, "llp", "2025-26")).toMatch(/Limited Liability Partnership Act, 2008/);
  });

  it("prints every SA 210 para 10 element, with scope and exclusions", () => {
    const sections = sa210Sections({
      auditType: "statutory_companies_act",
      fy: "2025-26",
      clientName: "Beta Industries Private Limited",
      framework: "Ind AS",
      reportForm: "An independent auditor's report under section 143.",
      scope: "Standalone financial statements.",
      exclusions: "Consolidated financial statements.",
    });
    expect(sections.map((s) => s.title)).toEqual([
      "Objective and scope",
      "Our responsibilities",
      "Responsibilities of management",
      "Applicable financial reporting framework",
      "Expected form and content of our report",
    ]);
    const text = sections.flatMap((s) => s.paragraphs).join(" ");
    expect(text).toMatch(/year ended 31 March 2026/);
    expect(text).toMatch(/inherent limitations/);
    expect(text).toMatch(/written confirmation of the representations .*SA 580/);
    expect(text).toMatch(/may need to be amended/);
    expect(text).toMatch(/It does not cover: Consolidated financial statements\./);
  });

  it("says the fee is fixed and never contingent", () => {
    expect(feeParagraph("₹72,000.00 (Rupees Seventy-Two Thousand Only)")[0]).toMatch(/₹72,000\.00 .*excluding GST/);
    expect(feeParagraph(null).join(" ")).toMatch(/do not depend on the findings or results/);
  });
});

describe("services schedule, defaults and renewals", () => {
  it("builds the schedule from the client's services and adds up the year in paise", () => {
    const rows = scheduleFromServices([
      { service_type: "gst", custom_name: null, frequency: "monthly", billing_frequency: null, agreed_fee: "5000.00" },
      { service_type: "income_tax", custom_name: null, frequency: "annual", billing_frequency: null, agreed_fee: 12000 },
      { service_type: "other", custom_name: "MSME registration", frequency: "one_time", billing_frequency: null, agreed_fee: null },
    ]);
    expect(rows).toEqual([
      { service_type: "gst", description: "GST returns", frequency: "monthly", fee: "5000.00" },
      { service_type: "income_tax", description: "Income tax", frequency: "annual", fee: "12000.00" },
      { service_type: "other", description: "MSME registration", frequency: "one_time", fee: null },
    ]);
    expect(scheduleAnnualPaise(rows)).toBe(72_000_00);
    expect(parseSchedule([{ service_type: "gst", description: "", frequency: "weekly", fee: "1.005" }, { nope: true }])).toEqual([
      { service_type: "gst", description: "GST returns", frequency: "annual", fee: null },
    ]);
  });

  it("expires at the FY end, or a year later for an audit", () => {
    expect(defaultLetterExpiry("2026-27", false)).toBe("2027-03-31");
    expect(defaultLetterExpiry("2025-26", true)).toBe("2027-03-31");
  });

  it("renews for the next FY, copying scope and services, with a tax audit's form for the new statute", () => {
    const r = renewalOf({
      client_id: CLIENT,
      financial_year: "2025-26",
      service_types: ["audit", "income_tax"],
      scope: "Tax audit and return",
      exclusions: null,
      fee_agreed: 45000,
      services_schedule: [{ service_type: "income_tax", description: "ITR-3", frequency: "annual", fee: "15000" }],
      audit_type: "tax_audit",
      reporting_framework: "old",
      report_form: "old",
      signatory_id: null,
      expires_at: "2027-03-31",
    });
    expect(r).toMatchObject({
      client_id: CLIENT,
      financial_year: "2026-27",
      service_types: ["audit", "income_tax"],
      scope: "Tax audit and return",
      fee_agreed: "45000.00",
      expires_at: "2028-03-31",
      services_schedule: [{ service_type: "income_tax", description: "ITR-3", frequency: "annual", fee: "15000.00" }],
    });
    expect(r.report_form).toMatch(/Form 26/);
  });

  it("needs the SA 210 terms for an audit letter", () => {
    const base = { clientId: CLIENT, financialYear: "2025-26", serviceTypes: ["audit"] };
    const r = CreateLetterSchema.safeParse(base);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path.join(".")).sort()).toEqual(["auditType", "reportForm", "reportingFramework"]);
    const ok = CreateLetterSchema.parse({ ...base, auditType: "tax_audit", reportingFramework: "x", reportForm: "y", feeAgreed: "45,000" });
    expect(ok.feeAgreed).toBe("45000.00");
    expect(CreateLetterSchema.safeParse({ clientId: CLIENT, financialYear: "2025-26", serviceTypes: [] }).success).toBe(false);
  });
});


describe("the letter as printed (§7.15.3, SA 210)", () => {
  it("addresses those charged with governance by the client's constitution", () => {
    expect(addresseeHeading("pvt_ltd")).toBe("The Board of Directors");
    expect(addresseeHeading("llp")).toBe("The Designated Partners");
    expect(addresseeHeading("partnership")).toBe("The Partners");
    expect(addresseeHeading("trust")).toBe("The Trustees");
    expect(addresseeHeading("individual")).toBeNull();
    expect(addresseeHeading(null)).toBeNull();
  });

  it("gives the letter a reference and a safe file name", () => {
    expect(letterReference("2026-27", "TW-C-0042")).toBe("EL/2026-27/TW-C-0042");
    expect(letterFileName("2026-27", "TW-C-0042", false)).toBe("Engagement-letter-2026-27-TW-C-0042.pdf");
    expect(letterFileName("2026-27", "TW C/0042", true)).toBe("Engagement-letter-2026-27-TW-C-0042-draft.pdf");
  });

  it("names the audit and the statute in the subject; non-audit letters name the FY", () => {
    expect(letterSubject({ fy: "2025-26", clientName: "Sharma Traders Pvt Ltd", auditType: "tax_audit", audit: true, serviceCount: 1 })).toContain("AY 2026-27");
    expect(letterSubject({ fy: "2026-27", clientName: "Sharma Traders Pvt Ltd", auditType: "tax_audit", audit: true, serviceCount: 1 })).toContain("Tax year 2026-27");
    expect(letterSubject({ fy: "2025-26", clientName: "Sharma Traders Pvt Ltd", auditType: "statutory_companies_act", audit: true, serviceCount: 2 })).toContain("and the other services in the schedule");
    expect(letterSubject({ fy: "2026-27", clientName: "Rao & Co", auditType: null, audit: false, serviceCount: 3 })).toBe("Engagement letter for professional services to Rao & Co, FY 2026-27");
  });

  it("opens with the FY's dates and closes with how long the terms run", () => {
    expect(nonAuditOpening("Rao & Co", "2026-27")).toContain("1 April 2026 to 31 March 2027");
    const close = closingParagraphs({ expiresAt: "2027-03-31", renewedFromFy: "2025-26", formatDate: (d) => d });
    expect(close[0]).toContain("replaces our engagement letter for FY 2025-26");
    expect(close[1]).toContain("until 2027-03-31");
    expect(close).toHaveLength(3);
    expect(closingParagraphs({ expiresAt: null, renewedFromFy: null, formatDate: (d) => d })).toHaveLength(2);
  });
});

describe("servicesSummary (letters table and the letter page, server and client alike)", () => {
  it("names each service, an audit by its audit type", () => {
    expect(servicesSummary({ service_types: ["gst", "income_tax"], audit_type: null })).toBe("GST returns, Income tax");
    expect(servicesSummary({ service_types: ["audit"], audit_type: "statutory_companies_act" })).toBe("Statutory audit (Companies Act)");
    expect(servicesSummary({ service_types: ["audit"], audit_type: null })).toBe("Audit");
    expect(servicesSummary({ service_types: [], audit_type: null })).toBe("");
  });
});
