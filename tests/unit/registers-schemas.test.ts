import { describe, expect, it } from "vitest";
import {
  CreateCredentialSchema,
  CreateDscSchema,
  CreateRegistrationSchema,
  CreateUdinSchema,
  UpdateCredentialSchema,
  checkRegistrationNumber,
  credentialContext,
  custodyLabel,
  custodyValue,
  dir3KycNextDue,
  dscAlertThreshold,
  expiryState,
  parseCustody,
  parseRegisterTab,
  portalName,
  registrationReminderDue,
  reportFormsFor,
  udinCounts,
  udinWarnings,
} from "@/lib/schemas/registers";

const CLIENT = "6d2f1f0e-0d3a-4b8e-9a51-8f0f1d2c3b4a";
const PARTNER = "0f4e3c2b-1a09-4d8e-8b7a-6c5d4e3f2a1b";

describe("register tabs", () => {
  it("reads ?tab= and falls back to the vault", () => {
    expect(parseRegisterTab("udin")).toBe("udin");
    expect(parseRegisterTab(["dsc", "vault"])).toBe("dsc");
    expect(parseRegisterTab("passwords")).toBe("vault");
    expect(parseRegisterTab(undefined)).toBe("vault");
  });
});

describe("the vault (§7.15.1)", () => {
  it("names the portal, with Other's own name", () => {
    expect(portalName("PT", null)).toBe("Professional Tax");
    expect(portalName("OTHER", "  Karnataka e-Procurement ")).toBe("Karnataka e-Procurement");
    expect(portalName("OTHER", "")).toBe("Other portal");
  });

  it("needs the password on create, keeps the stored one when an edit leaves it empty", () => {
    const base = { clientId: CLIENT, portal: "GST", username: "abc_traders", loginUrl: "", notes: "" };
    expect(CreateCredentialSchema.safeParse(base).success).toBe(false);
    const created = CreateCredentialSchema.parse({ ...base, password: " p@ss with spaces " });
    expect(created.password).toBe(" p@ss with spaces ");
    expect(created.loginUrl).toBeNull();
    const edit = UpdateCredentialSchema.parse({ id: CLIENT, updatedAt: "2026-10-01T10:00:00Z", portal: "GST", username: "abc", password: "" });
    expect(edit.password).toBeNull();
  });

  it("names Other portals and checks the login URL", () => {
    const r = CreateCredentialSchema.safeParse({ clientId: CLIENT, portal: "OTHER", username: "u", password: "x" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path.join("."))).toContain("portalLabel");
    const bad = CreateCredentialSchema.safeParse({ clientId: CLIENT, portal: "GST", username: "u", password: "x", loginUrl: "javascript:alert(1)" });
    expect(bad.success).toBe(false);
    const ok = CreateCredentialSchema.parse({ clientId: CLIENT, portal: "GST", username: "u", password: "x", loginUrl: "https://services.gst.gov.in/services/login" });
    expect(ok.loginUrl).toBe("https://services.gst.gov.in/services/login");
  });

  it("binds sealed passwords to the client", () => {
    expect(credentialContext(CLIENT)).toBe(`client_credential:${CLIENT}`);
  });
});

describe("registrations (§7.15.1, §6.2, §6.7)", () => {
  it("refuses an invalid GSTIN, CIN, LLPIN, DIN or TAN and only warns for other shapes", () => {
    expect(checkRegistrationNumber("GST", "29AAXFT1811B1Z3")).toEqual({ ok: true, value: "29AAXFT1811B1Z3", warning: null });
    expect(checkRegistrationNumber("GST", "29AAXFT1811B1Z4").ok).toBe(false);
    expect(checkRegistrationNumber("DIN", "0123456").ok).toBe(false);
    expect(checkRegistrationNumber("DIN", "01234567").ok).toBe(true);
    expect(checkRegistrationNumber("LLPIN", "aab-1234")).toMatchObject({ ok: true, value: "AAB-1234" });
    const udyam = checkRegistrationNumber("MSME_UDYAM", "udyam-kr-03-0012345");
    expect(udyam).toEqual({ ok: true, value: "UDYAM-KR-03-0012345", warning: null });
    expect(checkRegistrationNumber("FSSAI", "1234")).toMatchObject({ ok: true, warning: expect.stringMatching(/14 digits/) });
    expect(checkRegistrationNumber("PT", "  ").ok).toBe(false);
  });

  it("validates the form: dates in order, DIR-3 KYC only on DINs", () => {
    const base = { clientId: CLIENT, registrationType: "DIN", registrationNumber: "01234567", lastDir3KycFy: "2025-26" };
    expect(CreateRegistrationSchema.parse(base)).toMatchObject({ reminderDays: 30, status: "active", lastDir3KycFy: "2025-26" });
    const wrongType = CreateRegistrationSchema.safeParse({ ...base, registrationType: "PT", registrationNumber: "PT123" });
    expect(wrongType.success).toBe(false);
    const dates = CreateRegistrationSchema.safeParse({ clientId: CLIENT, registrationType: "FSSAI", registrationNumber: "12345678901234", issueDate: "2026-05-01", expiryDate: "2026-04-01" });
    expect(dates.success).toBe(false);
  });

  it("is due for its reminder within reminder_days of an active expiry", () => {
    const today = "2026-10-23";
    expect(registrationReminderDue({ status: "active", expiryDate: "2026-11-20", reminderDays: 30 }, today)).toBe(true);
    expect(registrationReminderDue({ status: "active", expiryDate: "2026-11-23", reminderDays: 30 }, today)).toBe(false);
    expect(registrationReminderDue({ status: "active", expiryDate: "2026-10-22", reminderDays: 30 }, today)).toBe(false);
    expect(registrationReminderDue({ status: "surrendered", expiryDate: "2026-11-01", reminderDays: 30 }, today)).toBe(false);
    expect(registrationReminderDue({ status: "active", expiryDate: "2026-10-23", reminderDays: 0 }, today)).toBe(true);
  });

  it("puts the next DIR-3 KYC Web three FYs on, by 30 June", () => {
    expect(dir3KycNextDue("2025-26")).toEqual({ fy: "2028-29", due: "2028-06-30" });
    expect(dir3KycNextDue("1999-00")).toEqual({ fy: "2002-03", due: "2002-06-30" });
    expect(dir3KycNextDue("2025-27")).toBeNull();
  });

  it("states where an expiry stands", () => {
    expect(expiryState("2026-10-22", "2026-10-23", 30)).toBe("expired");
    expect(expiryState("2026-11-22", "2026-10-23", 30)).toBe("expiring");
    expect(expiryState("2026-11-23", "2026-10-23", 30)).toBe("ok");
    expect(expiryState(null, "2026-10-23", 30)).toBeNull();
  });
});

describe("DSCs (§7.15.1)", () => {
  it("alerts at 30, 15 and 7 days, the nearest threshold once", () => {
    expect(dscAlertThreshold(31)).toBeNull();
    expect(dscAlertThreshold(30)).toBe(30);
    expect(dscAlertThreshold(16)).toBe(30);
    expect(dscAlertThreshold(15)).toBe(15);
    expect(dscAlertThreshold(8)).toBe(15);
    expect(dscAlertThreshold(7)).toBe(7);
    expect(dscAlertThreshold(0)).toBe(7);
    expect(dscAlertThreshold(-1)).toBeNull();
  });

  it("stores custody as Firm, Client or the person's name", () => {
    expect(custodyValue("firm", "x")).toBe("Firm");
    expect(custodyValue("person", "  Ramesh (accountant) ")).toBe("Ramesh (accountant)");
    expect(custodyValue("person", "")).toBeNull();
    expect(parseCustody("client")).toEqual({ kind: "client", name: "" });
    expect(parseCustody("Ramesh")).toEqual({ kind: "person", name: "Ramesh" });
    expect(custodyLabel("Firm")).toBe("Firm");
    expect(custodyLabel(null)).toBeNull();
  });

  it("checks the holder PAN, the dates and a named custodian", () => {
    const base = { clientId: CLIENT, holderName: "Anita Rao", expiryDate: "2027-06-30" };
    expect(CreateDscSchema.parse({ ...base, holderPan: "abcpr1234f" })).toMatchObject({ holderPan: "ABCPR1234F", dscClass: "class_3", status: "active" });
    expect(CreateDscSchema.safeParse({ ...base, holderPan: "ABC" }).success).toBe(false);
    expect(CreateDscSchema.safeParse({ ...base, issueDate: "2027-07-01" }).success).toBe(false);
    expect(CreateDscSchema.safeParse({ ...base, custodyKind: "person" }).success).toBe(false);
  });
});

describe("UDINs (§6.2, §6.8, §7.15.1)", () => {
  const base = {
    udin: "26123456abcdefghij",
    clientId: CLIENT,
    documentType: "Tax Audit Report",
    reportForm: "3CA",
    signedOn: "2026-09-30",
    generatedOn: "2026-10-05",
    signingPartnerId: PARTNER,
  };

  it("validates the UDIN, upper-cases it, and needs the report form for a tax audit report", () => {
    expect(CreateUdinSchema.parse(base)).toMatchObject({ udin: "26123456ABCDEFGHIJ", isRevised: false, confirmOverCeiling: false });
    expect(CreateUdinSchema.safeParse({ ...base, udin: "2612345" }).success).toBe(false);
    expect(CreateUdinSchema.safeParse({ ...base, reportForm: "" }).success).toBe(false);
    expect(CreateUdinSchema.safeParse({ ...base, reportForm: "FORM_26" }).success).toBe(false);
    expect(CreateUdinSchema.safeParse({ ...base, reportForm: "FORM_26", form26Category: "a" }).success).toBe(true);
    expect(CreateUdinSchema.safeParse({ ...base, generatedOn: "2026-09-29" }).success).toBe(false);
  });

  it("warns about the membership number, the 60 days and the year digits, without blocking", () => {
    expect(udinWarnings({ udin: base.udin, membershipNo: "123456", signedOn: "2026-09-30", generatedOn: "2026-10-05" })).toEqual([]);
    const w = udinWarnings({ udin: base.udin, membershipNo: "654321", signedOn: "2026-06-01", generatedOn: "2026-08-15" });
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/membership number 123456, but the signing partner's is 654321/);
    expect(w[1]).toMatch(/75 days after signing/);
    expect(udinWarnings({ udin: base.udin, membershipNo: null, signedOn: "2025-12-01", generatedOn: "2025-12-02" })[0]).toMatch(/starts with 26, but it was generated in 2025/);
  });

  it("counts as the database derives it", () => {
    expect(udinCounts("3CA", false, null)).toBe(true);
    expect(udinCounts("3CB_44AB_b", false, null)).toBe(true);
    expect(udinCounts("3CB_44AB_c", false, null)).toBe(false);
    expect(udinCounts("3CA", true, null)).toBe(false);
    expect(udinCounts("FORM_26", false, "combined")).toBe(true);
    expect(udinCounts("FORM_26", false, "d")).toBe(false);
    expect(udinCounts(null, false, null)).toBeNull();
    expect(reportFormsFor("Tax Audit Report")).toContain("FORM_26");
    expect(reportFormsFor("GST Audit")).toEqual(["gst_audit"]);
  });
});
