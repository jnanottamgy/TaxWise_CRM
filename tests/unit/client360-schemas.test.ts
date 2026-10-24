import { describe, expect, it } from "vitest";
import { CreateContactSchema, UpdateContactSchema, contactSubline } from "@/lib/schemas/contacts";
import { AddServiceSchema, RepriceServiceSchema, UpdateServiceSchema, billingCycle, perCycleLabel, serviceName } from "@/lib/schemas/client-services";
import { SaveKycSchema, VerifyKycSchema, defaultNextReview, kycCategoryFor, principalPersonsLabel, readEngagementTypes, readPrincipalPersons, toStoredPersons } from "@/lib/schemas/client-kyc";
import {
  CALENDAR_FIELDS,
  MasterDataSchema,
  changedMasterFields,
  describeChanges,
  incomeNatureChoices,
  incomeNatureError,
  incomeNatureLabel,
  masterDataDefaults,
  masterDataToRow,
  masterDataWarnings,
} from "@/components/client360/logic/master-data";
import { ClientGroupSchema, ClientTeamSchema, TaxAuditDecisionSchema } from "@/components/client360/logic/profile-schemas";

const CLIENT = "4b0b8f0e-7c51-4a3e-9d64-1d3f0f6b2a11";
const errorsOf = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
  Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join("."), i.message]));

// -------------------------------------------------------------------------------------------------
// Contacts (§5.3, §7.3.3)
// -------------------------------------------------------------------------------------------------

describe("contact schemas", () => {
  it("accepts a contact with the wizard's phone and WhatsApp rules, and keeps handles in service order", () => {
    const r = CreateContactSchema.safeParse({ clientId: CLIENT, name: " Ramesh Sharma ", role: "Director", email: "Ramesh@Sharma.IN", phone: "98450 12345", whatsapp: "+91 98450 12345", handles: ["tds", "gst", "gst"] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toMatchObject({ name: "Ramesh Sharma", email: "ramesh@sharma.in", handles: ["gst", "tds"], isPrimary: false, notes: null });
  });

  it("refuses a number WhatsApp can't use, a bad email and a missing name", () => {
    const r = CreateContactSchema.safeParse({ clientId: CLIENT, name: "", email: "nope", whatsapp: "12345" });
    expect(r.success).toBe(false);
    const e = errorsOf(r);
    expect(e.name).toMatch(/Enter the contact's name/);
    expect(e.email).toMatch(/valid email/);
    expect(e.whatsapp).toMatch(/can't receive WhatsApp/);
  });

  it("needs the loaded updated_at to edit", () => {
    expect(UpdateContactSchema.safeParse({ id: CLIENT, clientId: CLIENT, updatedAt: "", name: "A" }).success).toBe(false);
  });

  it("describes a contact for its row", () => {
    expect(contactSubline({ role: "CFO", handles: ["gst"] }, (s) => s.toUpperCase())).toBe("CFO · handles GST");
    expect(contactSubline({ role: null, handles: [] }, (s) => s)).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------
// Services & fees (§7.3.3 tab 3)
// -------------------------------------------------------------------------------------------------

describe("service schemas", () => {
  const add = (over: Record<string, unknown> = {}) => AddServiceSchema.safeParse({ clientId: CLIENT, serviceType: "gst", frequency: "monthly", agreedFee: "12,500.50", feeAgreedOn: "2026-10-01", ...over });

  it("keeps money as an exact decimal string and 'Same as filing' as null", () => {
    const r = add({ billingFrequency: "same" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.agreedFee).toBe("12500.50");
    expect(r.data.billingFrequency).toBeNull();
    expect(add({ agreedFee: "" }).success && (add({ agreedFee: "" }) as { data: { agreedFee: unknown } }).data.agreedFee).toBeNull();
    expect(errorsOf(add({ agreedFee: "12.345" })).agreedFee).toMatch(/2 decimal places/);
  });

  it("needs a name for Other, and a fee, a recurring cycle and a first date for automatic invoices", () => {
    expect(errorsOf(add({ serviceType: "other" })).customName).toBe("Name the service.");
    const noDate = errorsOf(add({ autoInvoice: true }));
    expect(noDate.nextBillingDate).toMatch(/first automatic invoice/);
    const noFee = errorsOf(add({ autoInvoice: true, agreedFee: "", nextBillingDate: "2026-11-01" }));
    expect(noFee.autoInvoice).toMatch(/Agree a fee first/);
    const once = errorsOf(add({ autoInvoice: true, frequency: "one_time", nextBillingDate: "2026-11-01" }));
    expect(once.autoInvoice).toMatch(/one-time service/);
    expect(add({ autoInvoice: true, nextBillingDate: "2026-11-01", sacCode: "998231" }).success).toBe(true);
    expect(errorsOf(add({ sacCode: "12345" })).sacCode).toMatch(/starting 99/);
  });

  it("checks the fee as loaded when terms change, and requires a fee and date to re-price", () => {
    const base = { id: CLIENT, clientId: CLIENT, updatedAt: "2026-10-23T00:00:00Z", frequency: "monthly", autoInvoice: true, nextBillingDate: "2026-11-01" };
    expect(errorsOf(UpdateServiceSchema.safeParse({ ...base, hasAgreedFee: false })).autoInvoice).toMatch(/Agree a fee first/);
    expect(UpdateServiceSchema.safeParse({ ...base, hasAgreedFee: true }).success).toBe(true);
    const rp = RepriceServiceSchema.safeParse({ id: CLIENT, clientId: CLIENT, updatedAt: "x", agreedFee: "", feeAgreedOn: "" });
    expect(errorsOf(rp)).toMatchObject({ agreedFee: expect.stringMatching(/agreed fee/), feeAgreedOn: expect.stringMatching(/date the new fee/) });
  });

  it("names services and cycles the way the screens do", () => {
    expect(serviceName("gst", null)).toBe("GST returns");
    expect(serviceName("other", "Trademark filing")).toBe("Trademark filing");
    expect(billingCycle("monthly", null)).toBe("monthly");
    expect(billingCycle("monthly", "quarterly")).toBe("quarterly");
    expect(perCycleLabel("annual")).toBe("per year");
    expect(perCycleLabel("one_time")).toBe("once");
  });
});

// -------------------------------------------------------------------------------------------------
// KYC (§6.8, §6.10)
// -------------------------------------------------------------------------------------------------

describe("KYC schemas", () => {
  const save = (over: Record<string, unknown> = {}) =>
    SaveKycSchema.safeParse({ clientId: CLIENT, entityCategory: "corporate", pan: "aabcb1234c", cinLlpin: "u74999ka2020ptc123456", engagementTypes: ["tax_audit", "statutory_companies_act"], principalPersons: [{ name: "R Sharma", din: "01234567", address: "Bengaluru", aadhaarLast4: "4321" }], ...over });

  it("normalises identifiers and keeps engagement types in list order", () => {
    const r = save();
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.pan).toBe("AABCB1234C");
    expect(r.data.cinLlpin).toBe("U74999KA2020PTC123456");
    expect(r.data.engagementTypes).toEqual(["statutory_companies_act", "tax_audit"]);
    expect(save({ cinLlpin: "aab1234" }).success && (save({ cinLlpin: "aab1234" }) as { data: { cinLlpin: string } }).data.cinLlpin).toBe("AAB-1234");
  });

  it("refuses a full Aadhaar number in any field, and a bad CIN, PAN or DIN", () => {
    expect(errorsOf(save({ principalPersons: [{ name: "R Sharma", aadhaarLast4: "2345 6789 0123" }] }))["principalPersons.0.aadhaarLast4"]).toMatch(/full Aadhaar/);
    expect(errorsOf(save({ businessDescription: "Proprietor Aadhaar 2345-6789-0123" })).businessDescription).toMatch(/full Aadhaar/);
    expect(errorsOf(save({ cinLlpin: "123" })).cinLlpin).toMatch(/valid CIN/);
    expect(errorsOf(save({ pan: "ABC" })).pan).toMatch(/10 characters/);
    expect(errorsOf(save({ principalPersons: [{ name: "X", din: "123" }] }))["principalPersons.0.din"]).toMatch(/8 digits/);
  });

  it("reads the engagement types the wizard stores as labels", () => {
    expect(readEngagementTypes(["Tax audit", "Statutory audit", "tax_audit", "GST audit", "Something else"])).toEqual(["statutory_companies_act", "tax_audit", "gst_audit", "other"]);
    expect(readEngagementTypes(null)).toEqual([]);
  });

  it("verification needs a date; the review defaults to a year later", () => {
    expect(VerifyKycSchema.safeParse({ clientId: CLIENT, updatedAt: "x", verifiedOn: "" }).success).toBe(false);
    expect(defaultNextReview("2026-10-23")).toBe("2027-10-23");
  });

  it("maps entity types to KYC categories and names the people asked for", () => {
    expect(kycCategoryFor("pvt_ltd")).toBe("corporate");
    expect(kycCategoryFor("llp")).toBe("corporate");
    expect(kycCategoryFor("individual")).toBe("individual_proprietor");
    expect(kycCategoryFor("partnership")).toBe("non_corporate");
    expect(kycCategoryFor(null)).toBe("non_corporate");
    expect(principalPersonsLabel("corporate", "llp")).toBe("Designated partners");
    expect(principalPersonsLabel("non_corporate", "trust")).toBe("Trustees");
  });

  it("round-trips principal persons through the stored jsonb shape", () => {
    const stored = toStoredPersons([{ name: "R Sharma", role: "Director", address: null, pan: null, din: "01234567", aadhaarLast4: "4321" }]);
    expect(stored).toEqual([{ name: "R Sharma", role: "Director", din: "01234567", aadhaar_last4: "4321" }]);
    expect(readPrincipalPersons(stored)).toEqual([{ name: "R Sharma", role: "Director", address: null, pan: null, din: "01234567", aadhaarLast4: "4321" }]);
    expect(readPrincipalPersons({ not: "a list" })).toEqual([]);
    expect(readPrincipalPersons([null, { address: "no name" }, "x"])).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// Master data (§7.3.2 step 1 fields on Client 360)
// -------------------------------------------------------------------------------------------------

const stored = {
  id: CLIENT,
  updated_at: "2026-10-23T05:00:00.123456+00:00",
  display_name: "TaxWise Consultants",
  legal_name: null,
  client_code: "TW-C-0042",
  entity_type: "partnership" as const,
  entity_type_other: null,
  is_incorporated: true,
  date_of_birth_or_incorporation: null,
  pan: null,
  gst_registration: "registered" as const,
  gstin: "29AAXFT1811B1Z3",
  state_code: "29",
  tan: null,
  email: "info@twchartered.com",
  phone: "080 2345 6789",
  whatsapp: null,
  address: null,
  city: "Bengaluru",
  pincode: "560001",
  fy_end_month: 3,
  annual_turnover: 25000000,
  turnover_fy: "2025-26",
  gst_scheme: null,
  priority: "medium" as const,
  notes: null,
};

describe("master data", () => {
  it("round-trips a stored client and fills the PAN and state from the GSTIN", () => {
    const r = MasterDataSchema.safeParse(masterDataDefaults(stored));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toMatchObject({ pan: "AAXFT1811B", stateCode: "29", fyEndMonth: 3, annualTurnover: "25000000.00", gstScheme: "auto" });
    const row = masterDataToRow(r.data);
    expect(row.gst_scheme).toBeNull();
    // Only the PAN changed (filled from the GSTIN); the turnover compares by value, not by format.
    expect(changedMasterFields(stored, row)).toEqual(["pan"]);
    expect(describeChanges(["pan", "phone", "gstin"])).toBe("PAN, phone and GSTIN");
  });

  it("needs a GSTIN when registered, one that contains the PAN, and an FY for the turnover", () => {
    const base = masterDataDefaults(stored);
    expect(errorsOf(MasterDataSchema.safeParse({ ...base, gstin: "" })).gstin).toMatch(/GST-registered/);
    expect(errorsOf(MasterDataSchema.safeParse({ ...base, pan: "AABCB1234C" })).gstin).toMatch(/doesn't match the PAN/);
    expect(errorsOf(MasterDataSchema.safeParse({ ...base, turnoverFy: "" })).turnoverFy).toMatch(/financial year/);
    expect(errorsOf(MasterDataSchema.safeParse({ ...base, gstin: "29AAXFT1811B1Z4" })).gstin).toBeTruthy();
    expect(errorsOf(MasterDataSchema.safeParse({ ...base, clientCode: "tw c 42" })).clientCode).toMatch(/2–20 letters/);
    expect(errorsOf(MasterDataSchema.safeParse({ ...base, entityType: "other", entityTypeOther: "" })).entityTypeOther).toBe("Specify the entity type.");
  });

  it("edits how the income is earned (§6.6), keeping presumptive schemes to the entities that may use them", () => {
    const base = masterDataDefaults({ ...stored, income_nature: "presumptive_44ad" });
    expect(base.incomeNature).toBe("presumptive_44ad");
    const r = MasterDataSchema.safeParse(base);
    expect(r.success && masterDataToRow(r.data).income_nature).toBe("presumptive_44ad");
    expect(r.success && changedMasterFields({ ...stored, income_nature: "business" }, masterDataToRow(r.data))).toContain("income_nature");
    expect(CALENDAR_FIELDS).toContain("income_nature");
    expect(describeChanges(["income_nature"])).toBe("how the income is earned");
    // Not recorded stays null; an unknown stored value reads as not recorded.
    const blank = MasterDataSchema.safeParse({ ...masterDataDefaults({ ...stored, income_nature: "farming" }) });
    expect(blank.success && blank.data.incomeNature).toBeNull();
    // s.44AD: individuals, HUFs and firms; s.44ADA: individuals and firms; never companies or LLPs.
    expect(errorsOf(MasterDataSchema.safeParse({ ...base, entityType: "pvt_ltd" })).incomeNature).toMatch(/s\.44AD is for individuals, HUFs and partnership firms/);
    expect(errorsOf(MasterDataSchema.safeParse({ ...base, entityType: "huf", incomeNature: "presumptive_44ada" })).incomeNature).toMatch(/s\.44ADA/);
    expect(incomeNatureError("llp", "presumptive_44ad")).toMatch(/not LLPs/);
    expect(incomeNatureError("pvt_ltd", "business")).toBeNull();
    expect(incomeNatureChoices("pvt_ltd")).toEqual(["business", "profession"]);
    expect(incomeNatureChoices("huf")).toEqual(["business", "profession", "presumptive_44ad"]);
    expect(incomeNatureChoices("individual")).toEqual(["business", "profession", "presumptive_44ad", "presumptive_44ada"]);
    expect(incomeNatureLabel("presumptive_44ada")).toBe("Presumptive profession (s.44ADA)");
    expect(incomeNatureLabel(null)).toBeNull();
  });

  it("drops the GSTIN of an unregistered client and warns (never blocks) on a PAN holder mismatch", () => {
    const r = MasterDataSchema.safeParse({ ...masterDataDefaults(stored), gstRegistration: "unregistered", gstin: "29AAXFT1811B1Z3", pan: "AAXFT1811B" });
    expect(r.success && r.data.gstin).toBeNull();
    expect(masterDataWarnings({ pan: "AAXFT1811B", entityType: "pvt_ltd" })[0]).toMatch(/Firm\/LLP/);
    expect(masterDataWarnings({ pan: "AAXFT1811B", entityType: "partnership" })).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// Small forms (§6.6, §7.4, §5.3)
// -------------------------------------------------------------------------------------------------

describe("profile forms", () => {
  it("asks for a note when the tax-audit decision is Under review", () => {
    expect(errorsOf(TaxAuditDecisionSchema.safeParse({ clientId: CLIENT, updatedAt: "x", decision: "review" })).note).toMatch(/still needs checking/);
    expect(TaxAuditDecisionSchema.safeParse({ clientId: CLIENT, updatedAt: "x", decision: "yes" }).success).toBe(true);
  });

  it("chooses an existing group or a new one, not both", () => {
    expect(errorsOf(ClientGroupSchema.safeParse({ clientId: CLIENT, updatedAt: "x", groupId: CLIENT, newGroupName: "Sharma family" })).newGroupName).toMatch(/not both/);
    expect(ClientGroupSchema.safeParse({ clientId: CLIENT, updatedAt: "x", groupId: "", newGroupName: "Sharma family" }).success).toBe(true);
    expect(ClientGroupSchema.safeParse({ clientId: CLIENT, updatedAt: "x", groupId: null }).success).toBe(true);
  });

  it("needs an owner and de-duplicates preparers", () => {
    expect(errorsOf(ClientTeamSchema.safeParse({ clientId: CLIENT, signature: "owner:;", owner: "" })).owner).toMatch(/client owner/);
    const r = ClientTeamSchema.safeParse({ clientId: CLIENT, signature: "owner:;", owner: CLIENT, engagementPartner: "", preparers: [CLIENT, CLIENT] });
    expect(r.success && r.data).toMatchObject({ engagementPartner: null, reviewManager: null, preparers: [CLIENT] });
  });
});
