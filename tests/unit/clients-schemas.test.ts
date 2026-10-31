import { describe, expect, it } from "vitest";
import {
  autoMapHeaders,
  checkAttachment,
  checkImportRows,
  importLookups,
  missingImportKeys,
  sniffAttachment,
  statusChangeConsequence,
  toCsv,
  unreachableBanner,
  validateIndianPhone,
  type ImportContext,
} from "@/lib/schemas/clients";
import {
  allIssues,
  calendarProfileFor,
  customChecklistItem,
  emptyOnboardingValues,
  groupPreviewByMonth,
  gstFrequencyLock,
  initialTasks,
  kycCategoryFor,
  mergeChecklist,
  newServiceEntry,
  onboardingSchema,
  prefillFromLead,
  prefillFromQuotation,
  quotationConversionProblem,
  schemeDecisionFor,
  stepIssues,
  stepOfPath,
  suggestedChecklist,
  taxAuditFor,
  turnoverFyOptions,
  type OnboardingData,
  type OnboardingValues,
  type PreviewEvent,
  type QuotationForOnboarding,
  isPresumptiveNature,
  welcomeWhatsApp,
} from "@/lib/schemas/onboarding";

const TODAY = "2026-10-23";
const base = (): OnboardingValues => emptyOnboardingValues({ clientCode: "TW-C-0042", reminderDays: 7, notifyChannels: ["whatsapp"] });

/** A wizard filled in enough to pass every step. */
function complete(over: Partial<OnboardingValues> = {}): OnboardingValues {
  const services = [newServiceEntry("gst", "monthly"), newServiceEntry("income_tax", "monthly")];
  return {
    ...base(),
    display_name: "Sharma Steel Traders",
    entity_type: "pvt_ltd",
    pan: "AAECS1234K",
    gst_registration: "registered",
    gstin: "29AAECS1234K1Z9",
    email: "accounts@sharmasteel.in",
    phone: "98450 12345",
    services,
    checklist: mergeChecklist(
      [],
      services.map((s) => s.service_type),
    ),
    checklist_reviewed: true,
    owner_employee_id: "6f1c1f0e-3f7a-4c1b-9a51-1d2f4b9c7e10",
    ...over,
  };
}

const asData = (v: OnboardingValues) => onboardingSchema(TODAY).parse(v) as OnboardingData;

describe("onboarding checklist (§7.3.2 step 4)", () => {
  it("always suggests the engagement and authorisation letters, plus portal credentials for GST/IT/TDS", () => {
    expect(suggestedChecklist([]).map((i) => i.label)).toEqual(["Engagement letter", "Client authorisation letter"]);
    expect(suggestedChecklist(["payroll"]).map((i) => i.label)).not.toContain("Portal credentials authorisation");
    expect(suggestedChecklist(["tds"]).map((i) => i.label)).toContain("Portal credentials authorisation");
  });

  it("lists a shared item once and locks the audit acceptance steps", () => {
    const list = suggestedChecklist(["income_tax", "bookkeeping", "audit"]);
    expect(list.filter((i) => i.label === "Bank statements")).toHaveLength(1);
    expect(list.find((i) => i.label === "Bank statements")?.services).toEqual(["income_tax", "bookkeeping"]);
    const acceptance = list.filter((i) => i.origin === "acceptance");
    expect(acceptance).toHaveLength(2);
    expect(acceptance.every((i) => i.locked)).toBe(true);
  });

  it("keeps what the person did when the services change", () => {
    const first = mergeChecklist([], ["gst"]).map((i) =>
      i.label === "Last 3 GST returns" ? { ...i, included: false } : i.label === "Engagement letter" ? { ...i, collected: true } : i,
    );
    const custom = customChecklistItem("Partnership deed", first)!;
    const next = mergeChecklist([...first, custom], ["gst", "tds"]);
    expect(next.find((i) => i.label === "Last 3 GST returns")?.included).toBe(false);
    expect(next.find((i) => i.label === "Engagement letter")?.collected).toBe(true);
    expect(next.find((i) => i.label === "TAN allotment letter")?.included).toBe(true);
    expect(next.at(-1)?.label).toBe("Partnership deed");
    const without = mergeChecklist(next, ["tds"]);
    expect(without.some((i) => i.label === "GST registration certificate")).toBe(false);
    expect(without.some((i) => i.label === "Partnership deed")).toBe(true);
  });

  it("gives custom items unique keys and ignores blank ones", () => {
    const a = customChecklistItem("Board resolution", [])!;
    const b = customChecklistItem("Board resolution", [a])!;
    expect(a.key).not.toBe(b.key);
    expect(customChecklistItem("   ", [])).toBeNull();
  });
});

describe("onboarding step rules (§7.3.2)", () => {
  it("passes a complete wizard", () => {
    const r = onboardingSchema(TODAY).safeParse(complete());
    expect(r.success).toBe(true);
  });

  it("needs a GSTIN for a registered client, and the GSTIN must contain the PAN", () => {
    const missing = stepIssues("basics", asDataLoose(complete({ gstin: "" })), TODAY);
    expect(missing.map((i) => i.path)).toContain("gstin");
    const mismatch = stepIssues("basics", asDataLoose(complete({ pan: "AAKFS1234C" })), TODAY);
    expect(mismatch.find((i) => i.path === "gstin")?.message).toMatch(/PAN/);
  });

  it("refuses a landline as the WhatsApp number when 'same as phone' is on", () => {
    const issues = stepIssues("basics", asDataLoose(complete({ phone: "011 2345 6789" })), TODAY);
    expect(issues.map((i) => i.path)).toContain("whatsapp_same_as_phone");
  });

  it("asks which audit, and the fee and first date for automatic invoicing", () => {
    const audit = complete({ services: [newServiceEntry("audit", "monthly")] });
    expect(stepIssues("services", asDataLoose(audit), TODAY).map((i) => i.path)).toContain("audit_kinds");
    const auto = complete({ services: [newServiceEntry("gst", "monthly", { auto_invoice: true })] });
    const paths = stepIssues("configure", asDataLoose(auto), TODAY).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["services.0.agreed_fee", "services.0.first_billing_date"]));
  });

  it("needs an email address to sign in with for the portal invite; the welcome message goes on WhatsApp", () => {
    const paths = stepIssues("review", asDataLoose(complete({ email: "", invite_portal: true, send_welcome: true })), TODAY).map((i) => i.path);
    expect(paths).toContain("invite_portal");
    expect(paths).not.toContain("send_welcome");
    expect(paths).not.toContain("notify_channels");
    expect(stepIssues("review", asDataLoose(complete({ notify_channels: ["portal"], invite_portal: false })), TODAY).map((i) => i.path)).toContain("notify_channels");
  });

  it("writes the welcome message for WhatsApp, with the portal when they have a login", () => {
    const d = { contactName: "Mr Rakesh Sharma", clientName: "Sharma Steel", firmName: "TaxWise Consultants", ownerName: "Anita Rao", ownerPhone: "+91 98450 12345", services: ["GST returns (monthly)", "Income tax return (yearly)"], portalUrl: "https://app.twchartered.com/portal" };
    const withPortal = welcomeWhatsApp(d);
    expect(withPortal.startsWith("Hi Rakesh, welcome to TaxWise Consultants. We're glad to be working with Sharma Steel.")).toBe(true);
    expect(withPortal).toContain("Anita Rao looks after you (+91 98450 12345).");
    expect(withPortal).toContain("What we'll do for you: GST returns (monthly), Income tax return (yearly).");
    expect(withPortal).toContain("https://app.twchartered.com/portal");
    const noPortal = welcomeWhatsApp({ ...d, contactName: null, ownerPhone: null, services: [], portalUrl: null });
    expect(noPortal.startsWith("Hello, welcome")).toBe(true);
    expect(noPortal).toContain("Anita Rao looks after you.");
    expect(noPortal).toContain("Send your documents here on WhatsApp");
    expect(noPortal).not.toContain("What we'll do");
  });

  it("puts each field in its step", () => {
    expect(stepOfPath("display_name")).toBe("basics");
    expect(stepOfPath("services")).toBe("services");
    expect(stepOfPath("services.2.custom_name")).toBe("services");
    expect(stepOfPath("services.2.agreed_fee")).toBe("configure");
    expect(stepOfPath("checklist_reviewed")).toBe("checklist");
    expect(stepOfPath("invite_portal")).toBe("review");
    expect(stepOfPath("acceptance_id")).toBe("basics");
  });

  it("collects every step's rules for Complete", () => {
    const paths = allIssues(asDataLoose({ ...complete(), owner_employee_id: "", checklist_reviewed: false }), TODAY).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["owner_employee_id", "checklist_reviewed"]));
  });
});

/** The step rules read output values; tests build them from input values without failing the parse. */
function asDataLoose(v: OnboardingValues): OnboardingData {
  return { ...base(), ...v } as unknown as OnboardingData;
}

describe("scale and the GST lock (§6.6)", () => {
  it("locks GST to the scheme decided from turnover", () => {
    const small = schemeDecisionFor({ annual_turnover: "4,00,00,000", gst_scheme_choice: "auto" });
    expect(small.scheme).toBe("qrmp");
    expect(gstFrequencyLock(small).frequency).toBe("quarterly");
    const big = schemeDecisionFor({ annual_turnover: "6,00,00,000", gst_scheme_choice: "qrmp" });
    expect(big.scheme).toBe("monthly");
    expect(gstFrequencyLock(big).explanation).toMatch(/Change the scheme in step 1/);
  });

  it("doesn't throw on a percentage outside 0–100 while the person is typing", () => {
    expect(() =>
      taxAuditFor({
        annual_turnover: "2,00,00,000",
        turnover_fy: "",
        income_nature: "business",
        cash_receipts_pct: "150",
        cash_payments_pct: "",
        declared_profit_pct: "",
        income_above_basic_exemption: "",
      }),
    ).not.toThrow();
    expect(
      taxAuditFor({
        annual_turnover: "",
        turnover_fy: "",
        income_nature: "",
        cash_receipts_pct: "",
        cash_payments_pct: "",
        declared_profit_pct: "",
        income_above_basic_exemption: "",
      }),
    ).toBeNull();
  });

  it("offers the last three financial years", () => {
    expect(turnoverFyOptions(TODAY)).toEqual(["2025-26", "2024-25", "2023-24"]);
  });
});

describe("what Complete builds", () => {
  it("plans GST returns only for a registered client with a valid GSTIN", () => {
    const inputs = {
      entity_type: "pvt_ltd" as const,
      gst_registration: "unknown" as const,
      gstin: "",
      state_code: "29",
      annual_turnover: "",
      gst_scheme_choice: "auto" as const,
      tax_audit_decision: "review" as const,
      income_nature: "" as const,
      services: [{ service_type: "gst" as const }, { service_type: "income_tax" as const }],
    };
    expect(calendarProfileFor(inputs, "c1").serviceTypes).toEqual(["income_tax"]);
    expect(calendarProfileFor({ ...inputs, gst_registration: "registered", gstin: "29AAECS1234K1Z9" }, "c1").serviceTypes).toEqual(["gst", "income_tax"]);
  });

  it("creates one 'Collect documents' task per service, due in 14 days, listing what's still to collect", () => {
    const tasks = initialTasks(asData(complete()), TODAY);
    expect(tasks.map((t) => t.title)).toEqual(["Collect documents for GST returns", "Collect documents for Income tax"]);
    expect(tasks[0].due_date).toBe("2026-11-06");
    expect(tasks[0].description).toMatch(/GST registration certificate/);
    expect(tasks[0].description).toMatch(/Engagement letter/);
    expect(tasks[1].description).not.toMatch(/Engagement letter/);
  });

  it("maps entity types to the ICAI KYC categories", () => {
    expect(kycCategoryFor("proprietorship")).toBe("individual_proprietor");
    expect(kycCategoryFor("pvt_ltd")).toBe("corporate");
    expect(kycCategoryFor("llp")).toBe("non_corporate");
  });
});

describe("the deadline preview (§7.3.2 step 5)", () => {
  const ev = (dueDate: string, title: string): PreviewEvent => ({
    dedupeKey: `${title}:${dueDate}`,
    title,
    formCode: null,
    filingPeriod: "",
    dueDate,
    sourceRef: null,
    overrideRef: null,
    originalDueDate: null,
    provisional: false,
    fallsOnSunday: false,
    serviceType: null,
    notes: null,
  });

  it("groups 12 months by the month due, in date order, and counts the later ones", () => {
    const g = groupPreviewByMonth([ev("2026-11-20", "GSTR-3B"), ev("2026-11-11", "GSTR-1"), ev("2027-07-31", "ITR"), ev("2027-11-30", "Annual return")], TODAY, 12);
    expect(g.months.map((m) => m.label)).toEqual(["November 2026", "July 2027"]);
    expect(g.months[0].events.map((e) => e.title)).toEqual(["GSTR-1", "GSTR-3B"]);
    expect(g.later).toBe(1);
    expect(g.lastLater).toBe("2027-11-30");
  });
});

describe("pre-fill (§7.3.2 'From a quotation', §7.5.1)", () => {
  const quotation: QuotationForOnboarding = {
    id: "q1",
    quotation_number: "TW/Q/2026-27/0007",
    status: "accepted",
    lead_id: null,
    client_id: null,
    converted_client_id: null,
    client_name: "Ravi Sharma",
    client_email: "ravi@sharmasteel.in",
    client_phone: "98450 12345",
    client_company: "Sharma Steel Traders Private Limited",
    client_gstin: "29AAECS1234K1Z9",
    place_of_supply_code: "29",
    items: [
      { id: "i1", description: "GST returns", service_type: "gst", frequency: "monthly", quantity: 1, unit_price: "3500" },
      { id: "i2", description: "GST reconciliation", service_type: "gst", frequency: "monthly", quantity: 1, unit_price: "1500.50" },
      { id: "i3", description: "FEMA filings", service_type: null, frequency: "annual", quantity: 2, unit_price: "5000" },
    ],
  };

  it("adds lines of the same service together and turns an untyped line into a named Other", () => {
    const v = prefillFromQuotation(base(), quotation, null);
    expect(v.display_name).toBe("Sharma Steel Traders Private Limited");
    expect(v.pan).toBe("AAECS1234K");
    expect(v.state_code).toBe("29");
    expect(v.gst_registration).toBe("registered");
    expect(v.services).toHaveLength(2);
    expect(v.services?.[0].agreed_fee).toBe("5000.50");
    expect(v.services?.[1]).toMatchObject({ service_type: "other", custom_name: "FEMA filings", agreed_fee: "10000.00", source_quotation_item_id: "i3" });
    expect(v.source_quotation_id).toBe("q1");
  });

  it("refuses a quotation that isn't accepted, or was converted already", () => {
    expect(quotationConversionProblem(quotation)).toBeNull();
    expect(quotationConversionProblem({ ...quotation, status: "sent" })).toMatch(/isn't accepted/);
    expect(quotationConversionProblem({ ...quotation, converted_client_id: "c1" })).toMatch(/already been converted/);
  });

  it("pre-fills from a lead with its services unlocked", () => {
    const v = prefillFromLead(base(), {
      id: "l1",
      lead_number: "TW-L-0003",
      status: "qualified",
      name: "Anita Rao",
      company: null,
      email: "anita@example.in",
      phone: null,
      whatsapp: "98860 12345",
      services_required: ["income_tax", "other"],
      requirement_notes: "Capital gains on a flat sale",
      converted_client_id: null,
    });
    expect(v.display_name).toBe("Anita Rao");
    expect(v.whatsapp_same_as_phone).toBe(false);
    expect(v.services?.map((s) => s.service_type)).toEqual(["income_tax"]);
    expect(v.source_lead_id).toBe("l1");
  });
});

describe("client list helpers (§7.3.1, §7.3.4)", () => {
  it("validates Indian mobiles and landlines", () => {
    expect(validateIndianPhone("+91 98450 12345")).toMatchObject({ ok: true, mobile: true });
    expect(validateIndianPhone("011 2345 6789")).toMatchObject({ ok: true, mobile: false });
    // 080 (Bengaluru) has the shape of 0 + a mobile starting 80, so it counts as a possible mobile.
    expect(validateIndianPhone("080 2345 6789").ok).toBe(true);
    expect(validateIndianPhone("12345").ok).toBe(false);
  });

  it("says what a status change pauses", () => {
    expect(statusChangeConsequence("on_hold")).toMatch(/automatic invoicing pause/);
    expect(statusChangeConsequence("inactive")).toMatch(/Reminders to the client/);
    expect(statusChangeConsequence("active")).not.toMatch(/pause/);
  });

  it("words the unreachable banner, and hides it at zero", () => {
    expect(unreachableBanner(0)).toBeNull();
    expect(unreachableBanner(1)).toBe("1 client can't be reached: no email or phone");
    expect(unreachableBanner(1200)).toMatch(/^1,200 clients/);
  });

  it("quotes formula-like CSV cells and keeps negative numbers", () => {
    const csv = toCsv(
      ["name", "amount"],
      [
        ['=HYPERLINK("x")', "-1250.50"],
        ["Sharma, Ravi", 0],
      ],
    );
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(",-1250.50");
    expect(csv).toContain(`"Sharma, Ravi",0`);
  });
});

describe("CSV import (§7.3.4)", () => {
  const ctx: ImportContext = {
    existingCodes: new Set(["TW-C-0001"]),
    existingPans: new Map([["AAKFS1234C", "TW-C-0001"]]),
    existingGstins: new Map(),
    owners: new Map([["meera@twchartered.com", { id: "e1", name: "Meera Iyer" }]]),
    groups: new Map([["sharma family", { id: "g1", name: "Sharma family" }]]),
  };

  it("maps common headers and reports the missing required column", () => {
    const m = autoMapHeaders(["Client Name", "PAN No", "GST Number", "Mobile", "Owner", "Remarks", "Unrelated"]);
    expect(m).toMatchObject({ "Client Name": "display_name", "PAN No": "pan", "GST Number": "gstin", Mobile: "phone", Owner: "owner_email", Remarks: "notes", Unrelated: null });
    expect(missingImportKeys({ PAN: "pan" })).toEqual(["display_name"]);
  });

  it("accepts a clean row and derives the PAN and state from the GSTIN", () => {
    const [r] = checkImportRows(
      [
        {
          display_name: "Sharma Steel Traders",
          gstin: "29AAECS1234K1Z9",
          entity_type: "Pvt Ltd",
          owner_email: "Meera@twchartered.com",
          group: "Sharma Family",
          services: "GST returns; ITR",
        },
      ],
      ctx,
    );
    expect(r.errors).toEqual([]);
    expect(r.row).toBe(2);
    expect(r.value).toMatchObject({ pan: "AAECS1234K", state_code: "29", gst_registration: "registered", entity_type: "pvt_ltd", owner_employee_id: "e1", group_id: "g1" });
    expect(r.value?.services.map((s) => s.service_type)).toEqual(["gst", "income_tax"]);
  });

  it("reports invalid identifiers, duplicates and an unknown owner, row by row", () => {
    const rows = checkImportRows(
      [
        { display_name: "One", client_code: "TW-C-0001", owner_email: "nobody@example.in" },
        { display_name: "Two", pan: "AAKFS1234C" },
        { display_name: "Three", pan: "AAPFR12" },
        { display_name: "Four", client_code: "TW-C-0100" },
        { display_name: "Five", client_code: "tw-c-0100" },
      ],
      ctx,
    );
    expect(rows[0].errors.join(" ")).toMatch(/already in use/);
    expect(rows[0].errors.join(" ")).toMatch(/Unknown owner/);
    expect(rows[1].errors.join(" ")).toMatch(/already belongs to client TW-C-0001/);
    expect(rows[2].errors[0]).toMatch(/^PAN:/);
    expect(rows[3].errors).toEqual([]);
    expect(rows[4].errors.join(" ")).toMatch(/also on row 5/);
    expect(rows.filter((r) => r.value).map((r) => r.name)).toEqual(["Four"]);
  });

  it("lists the identifiers to look up, the PAN inside each GSTIN included", () => {
    expect(importLookups([{ gstin: "29aaecs1234k1z9", client_code: " tw-c-0009 " }])).toEqual({ codes: ["TW-C-0009"], pans: ["AAECS1234K"], gstins: ["29AAECS1234K1Z9"] });
  });
});

describe("checklist attachments (§5.8, §12)", () => {
  it("checks the name and size, then the real type from the first bytes", () => {
    expect(checkAttachment({ name: "deed.exe", size: 10 }).ok).toBe(false);
    expect(checkAttachment({ name: "deed.pdf", size: 26 * 1024 * 1024 }).ok).toBe(false);
    expect(checkAttachment({ name: "deed.pdf", size: 2048 })).toMatchObject({ ok: true, ext: "pdf" });
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    expect(sniffAttachment(pdf, "pdf").ok).toBe(true);
    expect(sniffAttachment(pdf, "png").ok).toBe(false);
    expect(sniffAttachment(new Uint8Array([0x41, 0x2c, 0x42, 0x0a]), "csv").ok).toBe(true);
    expect(sniffAttachment(new Uint8Array([0x41, 0x00, 0x42]), "csv").ok).toBe(false);
  });
});

describe("isPresumptiveNature (§6.6, §6.7; clients.income_nature)", () => {
  it("is true for s.44AD and s.44ADA only", () => {
    expect(isPresumptiveNature("presumptive_44ad")).toBe(true);
    expect(isPresumptiveNature("presumptive_44ada")).toBe(true);
    expect(isPresumptiveNature("business")).toBe(false);
    expect(isPresumptiveNature("profession")).toBe(false);
    expect(isPresumptiveNature("")).toBe(false);
    expect(isPresumptiveNature(null)).toBe(false);
    expect(isPresumptiveNature(undefined)).toBe(false);
  });
});
