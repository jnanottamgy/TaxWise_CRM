import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  approvalLimitsFromForm,
  approvalModesFromRow,
  BankSchema,
  BillingSchema,
  checkLogoBytes,
  FirmDetailsSchema,
  LOGO_MAX_BYTES,
  LogoConfirmSchema,
  LogoUploadRequestSchema,
  NumberingSchema,
  RemindersSchema,
  sacMapFromJson,
  sacMapToJson,
  SAC_MAP_KEYS,
  sniffLogoKind,
  svgSafetyProblem,
  WorkingHoursSchema,
} from "@/lib/schemas/settings";
import {
  ConcordanceSchema,
  describeParameterValue,
  DueDateRuleChangeSchema,
  formatParameterValue,
  OverrideSchema,
  ParameterAddSchema,
  ParameterChangeSchema,
  parseParameterValue,
  planSupersede,
  suggestVersionCode,
} from "@/lib/schemas/law";
import { financialYearOf, todayIST } from "@/lib/domain/fy";

const TOKEN = "2026-10-22T09:12:33.123456+00:00";

/** The field paths a failed parse reports (`series.0.next_value`). */
function errorPaths(result: { success: boolean; error?: z.ZodError }): string[] {
  return result.success ? [] : (result.error?.issues ?? []).map((i) => i.path.join("."));
}

function messageAt(result: { success: boolean; error?: z.ZodError }, path: string): string | undefined {
  return result.success ? undefined : result.error?.issues.find((i) => i.path.join(".") === path)?.message;
}

// -------------------------------------------------------------------------------------------------
// Firm details (§1, §7.21)
// -------------------------------------------------------------------------------------------------

const FIRM = {
  updated_at: TOKEN,
  firm_name: "TaxWise Consultants",
  legal_name: "",
  tagline: "Chartered Accountants · Bengaluru",
  address: "307, 14th Main Rd, Raj Mahal Vilas Extension, Sadashiva Nagar",
  city: "Bengaluru",
  state_code: "29",
  pincode: "560080",
  phone: "+91 97405 40239",
  email: "info@twchartered.com",
  website: "https://www.twchartered.com/",
  gstin: "29aaxft1811b1z3",
  pan: "",
  tan: "",
  icai_frn: "",
  partners: [],
};

describe("FirmDetailsSchema", () => {
  it("accepts the firm's own §1 details and normalises identifiers", () => {
    const r = FirmDetailsSchema.safeParse(FIRM);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.gstin).toBe("29AAXFT1811B1Z3");
    expect(r.data.legal_name).toBeNull(); // empty optional text clears the column
    expect(r.data.pan).toBeNull();
    expect(r.data.email).toBe("info@twchartered.com");
  });

  it("refuses a PAN that isn't the one inside the GSTIN", () => {
    const r = FirmDetailsSchema.safeParse({ ...FIRM, pan: "AAKFS1234C" });
    expect(errorPaths(r)).toContain("pan");
  });

  it("refuses a state that disagrees with the GSTIN's state code", () => {
    const r = FirmDetailsSchema.safeParse({ ...FIRM, state_code: "27" });
    expect(messageAt(r, "state_code")).toMatch(/registered in state 29/);
  });

  it("checks the GSTIN checksum, pincode, FRN and website", () => {
    const r = FirmDetailsSchema.safeParse({ ...FIRM, gstin: "29AAXFT1811B1Z4", pincode: "060080", icai_frn: "12345", website: "twchartered" });
    expect(errorPaths(r)).toEqual(expect.arrayContaining(["gstin", "pincode", "icai_frn", "website"]));
  });

  it("accepts both FRN shapes and six-digit membership numbers", () => {
    const id = "6f1c2a8e-5b0d-4c1e-9a3f-2d7b8e9c0a11";
    expect(FirmDetailsSchema.safeParse({ ...FIRM, icai_frn: "012345s", partners: [{ id, icai_membership_no: "212345" }] }).success).toBe(true);
    expect(FirmDetailsSchema.safeParse({ ...FIRM, icai_frn: "S100123" }).success).toBe(true);
    const bad = FirmDetailsSchema.safeParse({ ...FIRM, partners: [{ id, icai_membership_no: "21234" }] });
    expect(errorPaths(bad)).toContain("partners.0.icai_membership_no");
  });

  it("needs the concurrency token", () => {
    expect(errorPaths(FirmDetailsSchema.safeParse({ ...FIRM, updated_at: "" }))).toContain("updated_at");
  });
});

// -------------------------------------------------------------------------------------------------
// Logo (§1: PNG/SVG/JPG ≤ 1 MB, checked by magic bytes, §12)
// -------------------------------------------------------------------------------------------------

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const enc = (s: string) => new TextEncoder().encode(s);

describe("logo checks", () => {
  it("sniffs PNG, JPEG and SVG from the bytes, not the name", () => {
    expect(sniffLogoKind(PNG)).toBe("png");
    expect(sniffLogoKind(JPEG)).toBe("jpeg");
    expect(sniffLogoKind(enc('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe("svg");
    expect(sniffLogoKind(enc("GIF89a"))).toBeNull();
    expect(sniffLogoKind(enc("<html><svg></svg></html>"))).toBeNull();
  });

  it("refuses SVGs that could run code or fetch things", () => {
    expect(svgSafetyProblem('<svg><script>alert(1)</script></svg>')).toMatch(/script/);
    expect(svgSafetyProblem('<svg onload="x()"></svg>')).toMatch(/event handlers/);
    expect(svgSafetyProblem('<svg><a href="javascript:x()"></a></svg>')).toMatch(/javascript/);
    expect(svgSafetyProblem('<svg><image href="https://evil.example/x.png"/></svg>')).toMatch(/internet/);
    expect(svgSafetyProblem('<svg><foreignObject></foreignObject></svg>')).toMatch(/HTML/);
    expect(svgSafetyProblem('<svg viewBox="0 0 10 10"><path d="M0 0h10v10z" fill="#14284B"/></svg>')).toBeNull();
  });

  it("enforces the 1 MB limit and refuses empty or unknown files", () => {
    expect(checkLogoBytes(PNG, LOGO_MAX_BYTES)).toEqual({ ok: true, kind: "png" });
    const big = checkLogoBytes(PNG, LOGO_MAX_BYTES + 1);
    expect(big.ok).toBe(false);
    expect(checkLogoBytes(new Uint8Array(0)).ok).toBe(false);
    expect(checkLogoBytes(enc("not an image")).ok).toBe(false);
    expect(checkLogoBytes(enc("<svg><script></script></svg>")).ok).toBe(false);
  });

  it("only confirms paths the upload step hands out", () => {
    expect(LogoUploadRequestSchema.safeParse({ kind: "png", size: 2048 }).success).toBe(true);
    expect(LogoUploadRequestSchema.safeParse({ kind: "gif", size: 2048 }).success).toBe(false);
    expect(LogoUploadRequestSchema.safeParse({ kind: "png", size: LOGO_MAX_BYTES + 1 }).success).toBe(false);
    expect(LogoConfirmSchema.safeParse({ path: "logo/6f1c2a8e-5b0d-4c1e-9a3f-2d7b8e9c0a11.png", updated_at: TOKEN }).success).toBe(true);
    expect(LogoConfirmSchema.safeParse({ path: "../client-documents/x.png", updated_at: TOKEN }).success).toBe(false);
    expect(LogoConfirmSchema.safeParse({ path: "logo/6f1c2a8e-5b0d-4c1e-9a3f-2d7b8e9c0a11.html", updated_at: TOKEN }).success).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// Bank & UPI
// -------------------------------------------------------------------------------------------------

const BANK = {
  updated_at: TOKEN,
  bank_name: "HDFC Bank",
  bank_account_name: "TaxWise Consultants",
  bank_account_number: "5020 0012 3456 78",
  bank_account_number_confirm: "50200012345678",
  bank_ifsc: "hdfc0001234",
  bank_branch: "Sadashiva Nagar",
  upi_id: "taxwise@okhdfcbank",
  upi_payee_name: "TaxWise Consultants",
};

describe("BankSchema", () => {
  it("accepts a complete account and normalises the number and IFSC", () => {
    const r = BankSchema.safeParse(BANK);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.bank_account_number).toBe("50200012345678");
    expect(r.data.bank_ifsc).toBe("HDFC0001234");
  });

  it("needs the account number typed twice the same", () => {
    expect(errorPaths(BankSchema.safeParse({ ...BANK, bank_account_number_confirm: "50200012345679" }))).toContain("bank_account_number_confirm");
  });

  it("asks for the rest of the account once any part is entered", () => {
    const r = BankSchema.safeParse({ ...BANK, bank_account_name: "", bank_account_number: "", bank_account_number_confirm: "", bank_ifsc: "" });
    expect(errorPaths(r)).toEqual(expect.arrayContaining(["bank_account_name", "bank_account_number", "bank_ifsc"]));
  });

  it("allows no bank details at all, and needs a payee name for a UPI ID", () => {
    const empty = { updated_at: TOKEN, bank_name: "", bank_account_name: "", bank_account_number: "", bank_account_number_confirm: "", bank_ifsc: "", bank_branch: "", upi_id: "", upi_payee_name: "" };
    expect(BankSchema.safeParse(empty).success).toBe(true);
    expect(errorPaths(BankSchema.safeParse({ ...empty, upi_id: "taxwise@okhdfcbank" }))).toContain("upi_payee_name");
    expect(errorPaths(BankSchema.safeParse({ ...BANK, upi_id: "not a upi id" }))).toContain("upi_id");
  });
});

// -------------------------------------------------------------------------------------------------
// Numbering (≤ 16 characters, §0.1 rule 6)
// -------------------------------------------------------------------------------------------------

const NUMBERING = {
  updated_at: TOKEN,
  invoice_prefix: "TW",
  credit_note_prefix: "TW-CN",
  quotation_prefix: "TW-Q",
  receipt_prefix: "TW-R",
  client_code_prefix: "TW-C",
  series: [
    { key: "invoice", next_value: "43", updated_at: TOKEN, loaded_next_value: 43 },
    { key: "client_code", next_value: "1", updated_at: null, loaded_next_value: 1 },
  ],
};

describe("NumberingSchema", () => {
  it("accepts the default prefixes", () => {
    const r = NumberingSchema.safeParse(NUMBERING);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.series[0].next_value).toBe(43);
  });

  it("refuses a prefix that pushes numbers past 16 characters and says what fits", () => {
    const r = NumberingSchema.safeParse({ ...NUMBERING, invoice_prefix: "TAXWISE-INV" });
    const msg = messageAt(r, "invoice_prefix");
    expect(msg).toMatch(/at most 16/);
    expect(msg).toMatch(/at most \d+ characters/);
  });

  it("refuses characters GST doesn't allow in a prefix", () => {
    expect(errorPaths(NumberingSchema.safeParse({ ...NUMBERING, quotation_prefix: "TW Q" }))).toContain("quotation_prefix");
    expect(errorPaths(NumberingSchema.safeParse({ ...NUMBERING, receipt_prefix: "TW-" }))).toContain("receipt_prefix");
  });

  it("refuses a next number that would make the document number too long", () => {
    const r = NumberingSchema.safeParse({ ...NUMBERING, credit_note_prefix: "TW-CN", series: [{ key: "credit_note", next_value: "123456", updated_at: TOKEN, loaded_next_value: 1 }] });
    expect(messageAt(r, "series.0.next_value")).toMatch(/characters/);
  });

  it("needs a whole number of at least 1", () => {
    expect(errorPaths(NumberingSchema.safeParse({ ...NUMBERING, series: [{ key: "invoice", next_value: "0", updated_at: TOKEN }] }))).toContain("series.0.next_value");
    expect(errorPaths(NumberingSchema.safeParse({ ...NUMBERING, series: [{ key: "invoice", next_value: "4.5", updated_at: TOKEN }] }))).toContain("series.0.next_value");
  });

  it("measures FY-scoped numbers in the current financial year", () => {
    // TW/26-27/0043 is 13 characters in FY 2026-27; the check uses today's FY.
    expect(financialYearOf(todayIST())).toMatch(/^\d{4}-\d{2}$/);
  });
});

// -------------------------------------------------------------------------------------------------
// Billing (§7.21, §5.2 null/0 semantics)
// -------------------------------------------------------------------------------------------------

const BILLING = {
  updated_at: TOKEN,
  default_tax_rate: "18",
  default_sac: "9982",
  sac_map: [
    { service: "audit", sac: "998221" },
    { service: "bookkeeping", sac: "998222" },
    { service: "gst", sac: "" },
  ],
  payment_terms_days: "15",
  invoice_terms: "",
  invoice_footer_note: "",
  round_off_enabled: false,
  invoice_approval_mode: "none",
  invoice_approval_limit: "",
  quotation_approval_mode: "always",
  quotation_approval_limit: "",
  quotation_validity_days: "30",
  quotation_terms: "",
  e_invoicing_applies: false,
  last_gstr1_reported_month: "none",
};

describe("BillingSchema", () => {
  it("accepts the seeded defaults, reading 'none' as no GSTR-1 month", () => {
    const r = BillingSchema.safeParse(BILLING);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.default_tax_rate).toBe(18);
    expect(r.data.last_gstr1_reported_month).toBeNull();
    expect(sacMapToJson(r.data.sac_map)).toEqual({ audit: "998221", bookkeeping: "998222" });
  });

  it("checks SAC codes and refuses a service listed twice", () => {
    expect(errorPaths(BillingSchema.safeParse({ ...BILLING, default_sac: "8982" }))).toContain("default_sac");
    expect(errorPaths(BillingSchema.safeParse({ ...BILLING, sac_map: [{ service: "audit", sac: "99822" }] }))).toContain("sac_map.0.sac");
    expect(errorPaths(BillingSchema.safeParse({ ...BILLING, sac_map: [{ service: "audit", sac: "998221" }, { service: "audit", sac: "9982" }] }))).toContain("sac_map.1.service");
  });

  it("needs an amount only when a limit applies, and above ₹0 for quotations", () => {
    expect(errorPaths(BillingSchema.safeParse({ ...BILLING, invoice_approval_mode: "above", invoice_approval_limit: "" }))).toContain("invoice_approval_limit");
    expect(BillingSchema.safeParse({ ...BILLING, invoice_approval_mode: "above", invoice_approval_limit: "1,00,000" }).success).toBe(true);
    expect(messageAt(BillingSchema.safeParse({ ...BILLING, quotation_approval_mode: "above", quotation_approval_limit: "0" }), "quotation_approval_limit")).toMatch(/Never/);
  });

  it("refuses a GSTR-1 month that hasn't happened yet", () => {
    const [y, m] = todayIST().split("-").map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    expect(errorPaths(BillingSchema.safeParse({ ...BILLING, last_gstr1_reported_month: next }))).toContain("last_gstr1_reported_month");
    expect(BillingSchema.safeParse({ ...BILLING, last_gstr1_reported_month: todayIST().slice(0, 7) }).success).toBe(true);
  });
});

describe("approval limits: null and 0 (§5.2)", () => {
  it("invoice: no approvals is null; an amount is stored to the paisa", () => {
    expect(approvalLimitsFromForm({ invoice_approval_mode: "none", invoice_approval_limit: "50000", quotation_approval_mode: "always", quotation_approval_limit: "" }).invoice_approval_limit).toBeNull();
    expect(approvalLimitsFromForm({ invoice_approval_mode: "above", invoice_approval_limit: "1,23,456.5", quotation_approval_mode: "always", quotation_approval_limit: "" }).invoice_approval_limit).toBe("123456.50");
  });

  it("quotation: always is null, never is 0, above is the amount", () => {
    const base = { invoice_approval_mode: "none" as const, invoice_approval_limit: "" };
    expect(approvalLimitsFromForm({ ...base, quotation_approval_mode: "always", quotation_approval_limit: "" }).quotation_approval_limit).toBeNull();
    expect(approvalLimitsFromForm({ ...base, quotation_approval_mode: "never", quotation_approval_limit: "" }).quotation_approval_limit).toBe("0.00");
    expect(approvalLimitsFromForm({ ...base, quotation_approval_mode: "above", quotation_approval_limit: "75000" }).quotation_approval_limit).toBe("75000.00");
  });

  it("reads the stored columns back into the same modes", () => {
    expect(approvalModesFromRow({ invoice_approval_limit: null, quotation_approval_limit: null })).toMatchObject({ invoice_approval_mode: "none", quotation_approval_mode: "always" });
    expect(approvalModesFromRow({ invoice_approval_limit: 0, quotation_approval_limit: "0.00" })).toMatchObject({ invoice_approval_mode: "above", invoice_approval_limit: "0", quotation_approval_mode: "never" });
    expect(approvalModesFromRow({ invoice_approval_limit: "50000.00", quotation_approval_limit: 75000 })).toMatchObject({
      invoice_approval_mode: "above",
      invoice_approval_limit: "50000.00",
      quotation_approval_mode: "above",
      quotation_approval_limit: "75000",
    });
  });
});

describe("SAC map editor rows", () => {
  it("has one row per service in a fixed order and drops unknown keys", () => {
    const rows = sacMapFromJson({ audit: "998221", nonsense: "1234", gst: 9982 });
    expect(rows.map((r) => r.service)).toEqual([...SAC_MAP_KEYS]);
    expect(rows.find((r) => r.service === "audit")?.sac).toBe("998221");
    expect(rows.find((r) => r.service === "gst")?.sac).toBe(""); // not a string: ignored
    expect(sacMapFromJson(null).every((r) => r.sac === "")).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// Working hours and reminders
// -------------------------------------------------------------------------------------------------

const HOURS = {
  updated_at: TOKEN,
  work_day_start: "09:30:00",
  late_grace_minutes: "15",
  half_day_minutes: "240",
  working_weekdays: ["6", "1", "2", "3", "4", "5", "1"],
  weekly_hours_target: "48",
  capacity_thresholds: { busy: "1.5", tight: "2.5", over: "4" },
};

describe("WorkingHoursSchema", () => {
  it("reads the database's time, de-duplicates and sorts the weekdays", () => {
    const r = WorkingHoursSchema.safeParse(HOURS);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.work_day_start).toBe("09:30");
    expect(r.data.working_weekdays).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.data.capacity_thresholds).toEqual({ busy: 1.5, tight: 2.5, over: 4 });
  });

  it("keeps the capacity bands in order", () => {
    const r = WorkingHoursSchema.safeParse({ ...HOURS, capacity_thresholds: { busy: "3", tight: "2.5", over: "2" } });
    expect(errorPaths(r)).toEqual(expect.arrayContaining(["capacity_thresholds.tight", "capacity_thresholds.over"]));
  });

  it("refuses an impossible weekly target and an empty week", () => {
    expect(errorPaths(WorkingHoursSchema.safeParse({ ...HOURS, working_weekdays: ["1"], weekly_hours_target: "30" }))).toContain("weekly_hours_target");
    expect(errorPaths(WorkingHoursSchema.safeParse({ ...HOURS, working_weekdays: [] }))).toContain("working_weekdays");
    expect(errorPaths(WorkingHoursSchema.safeParse({ ...HOURS, work_day_start: "25:00" }))).toContain("work_day_start");
  });
});

describe("RemindersSchema", () => {
  const base = {
    updated_at: TOKEN,
    compliance_reminder_days: "7",
    invoice_reminder_before_days: "3",
    invoice_reminder_after_days: "15, 1, 7, 7",
    document_request_reminder_every_days: "3",
    quotation_follow_up_days: "",
    client_notify_channels: ["whatsapp", "portal"],
  };

  it("reads day lists typed with commas into sorted unique days", () => {
    const r = RemindersSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.invoice_reminder_after_days).toEqual([1, 7, 15]);
    expect(r.data.quotation_follow_up_days).toEqual([]);
  });

  it("refuses words, too many reminders and an empty overdue schedule", () => {
    expect(errorPaths(RemindersSchema.safeParse({ ...base, invoice_reminder_after_days: "1, a week" }))).toContain("invoice_reminder_after_days");
    expect(errorPaths(RemindersSchema.safeParse({ ...base, invoice_reminder_after_days: "1,2,3,4,5,6,7" }))).toContain("invoice_reminder_after_days");
    expect(errorPaths(RemindersSchema.safeParse({ ...base, invoice_reminder_after_days: "" }))).toContain("invoice_reminder_after_days");
    expect(errorPaths(RemindersSchema.safeParse({ ...base, document_request_reminder_every_days: "0" }))).toContain("document_request_reminder_every_days");
  });

  it("keeps the new-client notify channels in a fixed order and needs at least one", () => {
    const r = RemindersSchema.safeParse({ ...base, client_notify_channels: ["portal", "whatsapp", "whatsapp"] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.client_notify_channels).toEqual(["whatsapp", "portal"]);
    expect(errorPaths(RemindersSchema.safeParse({ ...base, client_notify_channels: [] }))).toContain("client_notify_channels");
    expect(errorPaths(RemindersSchema.safeParse({ ...base, client_notify_channels: ["sms"] }))).toContain("client_notify_channels");
  });

  it("offers no email: the app sends none, so there is no email channel and no digest switch", () => {
    expect(errorPaths(RemindersSchema.safeParse({ ...base, client_notify_channels: ["email"] }))).toContain("client_notify_channels");
    const r = RemindersSchema.safeParse({ ...base, digest_enabled: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).not.toHaveProperty("digest_enabled");
  });
});

// -------------------------------------------------------------------------------------------------
// Law & rules (§5.12): values, effective dating, extensions, concordance
// -------------------------------------------------------------------------------------------------

describe("statutory parameter values", () => {
  it("reads numbers, JSON and text, and refuses empty or broken JSON", () => {
    expect(parseParameterValue("18")).toEqual({ ok: true, value: 18 });
    expect(parseParameterValue(' {"rate": 10, "threshold": 50000} ')).toEqual({ ok: true, value: { rate: 10, threshold: 50000 } });
    expect(parseParameterValue("[0, 5, 18, 40]")).toEqual({ ok: true, value: [0, 5, 18, 40] });
    expect(parseParameterValue("s.393 table entry 6")).toEqual({ ok: true, value: "s.393 table entry 6" });
    expect(parseParameterValue("").ok).toBe(false);
    expect(parseParameterValue("{rate: 10}").ok).toBe(false);
    expect(parseParameterValue("null").ok).toBe(false);
  });

  it("formats a value back to text that parses to the same value", () => {
    for (const v of [18, 0.5, { rate: 10 }, [1, 2], "Income-tax Act, 2025", "18", true]) {
      const text = formatParameterValue(v);
      expect(parseParameterValue(text)).toEqual({ ok: true, value: v });
    }
  });
});

describe("planSupersede: history is never overwritten", () => {
  const row = { effective_from: "2026-04-01", effective_to: null };

  it("closes the row in force the day before the change", () => {
    expect(planSupersede(row, "2027-04-01")).toEqual({ ok: true, closeOldOn: "2027-03-31" });
  });

  it("refuses a change on or before the day the row started", () => {
    expect(planSupersede(row, "2026-04-01").ok).toBe(false);
    expect(planSupersede(row, "2025-04-01").ok).toBe(false);
  });

  it("refuses a change after a row has already ended, but allows the day after its end", () => {
    const ended = { effective_from: "2025-04-01", effective_to: "2026-03-31" };
    expect(planSupersede(ended, "2026-04-02").ok).toBe(false);
    expect(planSupersede(ended, "2026-04-01")).toEqual({ ok: true, closeOldOn: "2026-03-31" });
    expect(planSupersede(ended, "2025-10-01")).toEqual({ ok: true, closeOldOn: "2025-09-30" });
  });
});

describe("law schemas", () => {
  const id = "6f1c2a8e-5b0d-4c1e-9a3f-2d7b8e9c0a11";

  it("a parameter change needs its date, value and legal source, and defaults to verified", () => {
    const r = ParameterChangeSchema.safeParse({ id, updated_at: TOKEN, effective_from: "2027-04-01", value: "12", source_ref: "Finance Act 2027, s.12" });
    expect(r.success).toBe(true);
    if (r.success) expect(r).toMatchObject({ data: { value: 12, verified: true } });
    expect(errorPaths(ParameterChangeSchema.safeParse({ id, updated_at: TOKEN, effective_from: "", value: "", source_ref: "" }))).toEqual(
      expect.arrayContaining(["effective_from", "value", "source_ref"]),
    );
  });

  it("a new parameter key is dotted lower case and its end is after its start", () => {
    const base = { key: "TDS.Professional_Fees.Rate", value: "10", effective_from: "2026-04-01", source_ref: "Income-tax Act, 2025, s.393" };
    const r = ParameterAddSchema.safeParse(base);
    expect(r.success && r.data.key).toBe("tds.professional_fees.rate");
    expect(errorPaths(ParameterAddSchema.safeParse({ ...base, key: "rate" }))).toContain("key");
    expect(errorPaths(ParameterAddSchema.safeParse({ ...base, effective_to: "2026-03-31" }))).toContain("effective_to");
  });

  it("a rule change checks its JSON against the rule shapes", () => {
    const base = {
      id,
      updated_at: TOKEN,
      effective_from: "2027-04-01",
      new_code: "gstr3b_monthly_2027",
      title: "GSTR-3B (monthly)",
      form_code: "GSTR-3B",
      frequency: "monthly",
      rule: '{"monthOffset": 1, "day": 20}',
      applies_to: '{"serviceTypes": ["gst"], "gstScheme": "monthly"}',
      reminder_days: "5",
      source_ref: "CBIC Notification 12/2027-CT",
    };
    const r = DueDateRuleChangeSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.new_code).toBe("GSTR3B_MONTHLY_2027");
    expect(errorPaths(DueDateRuleChangeSchema.safeParse({ ...base, rule: '{"monthOffset": 1, "day": 20' }))).toContain("rule");
    expect(errorPaths(DueDateRuleChangeSchema.safeParse({ ...base, rule: '{"monthOffset": 1, "dya": 20}' }))).toContain("rule");
  });

  it("suggests a version code from the start year, avoiding codes in use", () => {
    expect(suggestVersionCode("GSTR3B_MONTHLY", "2027-04-01")).toBe("GSTR3B_MONTHLY_2027");
    expect(suggestVersionCode("GSTR3B_MONTHLY_2027", "2028-04-01")).toBe("GSTR3B_MONTHLY_2028");
    expect(suggestVersionCode("GSTR3B_MONTHLY", "2027-04-01", new Set(["GSTR3B_MONTHLY_2027"]))).toBe("GSTR3B_MONTHLY_2027_2");
  });

  it("an extension must move the date later and name its circular", () => {
    const base = { rule_code: "TAX_AUDIT_REPORT", period_label: "AY 2026-27", original_due: "2026-09-30", extended_due: "2026-10-21", source_ref: "CBDT Circular 07/2026 dated 28 Sep 2026" };
    expect(OverrideSchema.safeParse(base).success).toBe(true);
    expect(errorPaths(OverrideSchema.safeParse({ ...base, extended_due: "2026-09-30" }))).toContain("extended_due");
    expect(errorPaths(OverrideSchema.safeParse({ ...base, source_ref: "" }))).toContain("source_ref");
  });

  it("a concordance row needs a section or form on at least one side", () => {
    expect(ConcordanceSchema.safeParse({ topic: "Tax audit", old_section: "s.44AB", new_section: "s.63" }).success).toBe(true);
    expect(errorPaths(ConcordanceSchema.safeParse({ topic: "Tax audit" }))).toContain("new_section");
    expect(errorPaths(ConcordanceSchema.safeParse({ id, topic: "Tax audit", old_section: "s.44AB" }))).toContain("topic"); // an edit needs its token
  });
});

describe("describeParameterValue (the parameters table, in words)", () => {
  it("reads objects as labelled parts, numbers in Indian grouping", () => {
    expect(describeParameterValue({ months: 3 })).toBe("months 3");
    expect(describeParameterValue({ amount: 50000, inclusive: false })).toBe("amount 50,000 · inclusive no");
    expect(describeParameterValue({ turnover: 1000000000, paid_up_capital: 100000000 })).toBe("turnover 1,00,00,00,000 · paid up capital 10,00,00,000");
    expect(describeParameterValue({ counted: ["a", "b"], notCounted: [] })).toBe("counted a, b · notCounted none");
    expect(describeParameterValue({ access: { days: 90 } })).toBe("access (days 90)");
  });

  it("reads plain values as they are, and cuts long ones", () => {
    expect(describeParameterValue(18)).toBe("18");
    expect(describeParameterValue("44AB")).toBe("44AB");
    expect(describeParameterValue(null)).toBe("—");
    expect(describeParameterValue(true)).toBe("yes");
    const long = describeParameterValue({ text: "x".repeat(200) }, 40);
    expect(long).toHaveLength(40);
    expect(long.endsWith("…")).toBe(true);
  });
});
