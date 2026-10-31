import { z } from "zod";
import {
  CLIENT_PRIORITIES,
  ENTITY_TYPES,
  GST_REGISTRATIONS,
  SERVICE_FREQUENCIES,
  SERVICE_TYPE_LABELS,
  SERVICE_TYPES,
  type ClientPriority,
  type EntityType,
  type GstScheme,
  type ServiceFrequency,
  type ServiceType,
} from "@/lib/domain/enums";
import {
  deriveFromGstin,
  gstinPanMismatch,
  isValidStateCode,
  validateGstin,
  validatePan,
  validatePincode,
  validateTan,
} from "@/lib/domain/india-validators";
import { addDays, compareDates, financialYearOf, fyStart, isDateString, isFinancialYear, MONTH_ABBR, parseDateString, type DateString } from "@/lib/domain/fy";
import { multiplyPaise, parseAmount, paiseToDecimalString, type Paise } from "@/lib/domain/money";
import { gstSchemeDecision, taxAuditIndication, SCALE_DEFAULTS, type GstSchemeDecision, type IncomeNature, type TaxAuditIndication, type TaxAuditParams } from "@/lib/domain/scale";
import type { CalendarClientProfile } from "@/lib/domain/statutory-calendar";
import { firstNameOf } from "@/lib/domain/messaging";
import { CLIENT_CODE_PATTERN, isWhatsAppNumber, validateIndianPhone } from "@/lib/schemas/clients";
import type { KycCategory } from "@/lib/domain/ceiling";

/**
 * The add-client wizard (§7.3.2): every field of the five steps, their validation, and the pure
 * pieces the steps share with the server (service defaults, the GST frequency lock, checklist
 * suggestions, the calendar profile, initial tasks, the KYC shell, pre-fill from a lead or
 * quotation). One schema is used by the form (zodResolver) and by the server action, which parses
 * the same values again before building the onboard_client payload. Client-safe.
 */

// =================================================================================================
// Steps
// =================================================================================================

export const ONBOARDING_STEPS = [
  { id: "basics", title: "Basic information", description: "Identity, tax registrations, contact and scale" },
  { id: "services", title: "Services", description: "What the firm will do for this client" },
  { id: "configure", title: "Configure services and team", description: "Frequency, fees, billing, owner and team" },
  { id: "checklist", title: "Document checklist", description: "What to collect from the client" },
  { id: "review", title: "Compliance setup and review", description: "Reminders, deadlines, portal and summary" },
] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]["id"];

// =================================================================================================
// Services (§7.3.2 steps 2–3)
// =================================================================================================

/** One line under each service card (§7.3.2 step 2 "selectable cards with a one-line description each"). */
export const SERVICE_DESCRIPTIONS: Record<ServiceType, string> = {
  gst: "GSTR-1, GSTR-3B and the annual return, with reconciliation against GSTR-2B.",
  income_tax: "The income-tax return, computation and advance tax.",
  tds: "TDS/TCS deposits, quarterly statements and certificates.",
  payroll: "PF, ESIC and professional tax for the client's staff.",
  bookkeeping: "Books of account kept from bank statements, invoices and bills.",
  audit: "Statutory, tax, GST or internal audit, to the Standards on Auditing.",
  company_law: "Annual ROC filings, AGM, director KYC and statutory registers.",
  incorporation: "Registering the company, LLP or firm.",
  other: "Any other engagement. Give it a name.",
};

/** The card titles (§7.3.2 step 2). */
export const SERVICE_CARD_TITLES: Record<ServiceType, string> = {
  ...SERVICE_TYPE_LABELS,
  audit: "Audit (statutory/tax/GST/internal)",
};

export const AUDIT_KINDS = ["statutory", "tax", "gst", "internal"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
export const AUDIT_KIND_LABELS: Record<AuditKind, string> = {
  statutory: "Statutory audit",
  tax: "Tax audit",
  gst: "GST audit",
  internal: "Internal audit",
};

/** The filing frequency a new service starts with (§7.3.2 step 3); GST follows the scheme. */
export function defaultFrequency(service: ServiceType, scheme: GstScheme): ServiceFrequency {
  switch (service) {
    case "gst":
      return scheme === "qrmp" ? "quarterly" : "monthly";
    case "tds":
      return "quarterly";
    case "payroll":
    case "bookkeeping":
      return "monthly";
    case "incorporation":
      return "one_time";
    case "income_tax":
    case "audit":
    case "company_law":
    case "other":
      return "annual";
  }
}

/** "GST follows the scheme and is locked with an explanation" (§7.3.2 step 3). */
export function gstFrequencyLock(decision: GstSchemeDecision): { frequency: ServiceFrequency; explanation: string } {
  const frequency: ServiceFrequency = decision.scheme === "qrmp" ? "quarterly" : "monthly";
  const how = decision.scheme === "qrmp" ? "QRMP: returns are filed quarterly" : "monthly filing";
  return {
    frequency,
    explanation: `Set by the GST scheme (${how}). ${decision.explanation} Change the scheme in step 1 to change it.`,
  };
}

// =================================================================================================
// Document checklist (§7.3.2 step 4)
// =================================================================================================

export type ChecklistOrigin = "always" | "service" | "acceptance" | "custom";

export type ChecklistSuggestion = {
  key: string;
  label: string;
  origin: Exclude<ChecklistOrigin, "custom">;
  services: ServiceType[];
  /** Can't be removed (acceptance steps for audit). */
  locked: boolean;
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** The per-service suggestions, exactly as §7.3.2 step 4 lists them. */
export const CHECKLIST_BY_SERVICE: Partial<Record<ServiceType, readonly string[]>> = {
  gst: ["GST registration certificate", "Last 3 GST returns", "Sales and purchase registers"],
  income_tax: ["PAN copy", "Last ITR and computation", "Form 26AS / AIS access", "Bank statements"],
  tds: ["TAN allotment letter", "TDS challans", "Deductee master"],
  audit: [
    "Previous audited financial statements",
    "Trial balance",
    "Fixed asset register",
    "Bank confirmations",
    "Previous auditor's NOC",
  ],
  company_law: ["Certificate of incorporation", "MOA and AOA", "Directors' KYC", "Statutory registers"],
  payroll: ["Employee master", "PF and ESIC registrations", "PT registration"],
  bookkeeping: ["Bank statements", "Invoices and bills", "Opening balances"],
};

/** "Selecting Audit adds the KYC and previous-auditor steps to the client's acceptance checklist" (§7.3.2 step 2, §6.8). */
export const AUDIT_ACCEPTANCE_ITEMS: readonly string[] = [
  "KYC under the ICAI KYC Norms (identity, PAN, business, principal persons)",
  "Letter to the previous auditor, with proof of delivery (Clause 8)",
];

const PORTAL_CREDENTIAL_SERVICES: readonly ServiceType[] = ["gst", "income_tax", "tds"];

/**
 * The suggested checklist for the selected services (§7.3.2 step 4): always the engagement letter
 * and the client authorisation letter (plus portal credentials authorisation when GST, income tax
 * or TDS is selected), then each service's items (one item per label: Bank statements appears once
 * for income tax and bookkeeping), then the audit acceptance steps.
 */
export function suggestedChecklist(services: readonly ServiceType[]): ChecklistSuggestion[] {
  const out: ChecklistSuggestion[] = [];
  const add = (label: string, origin: ChecklistSuggestion["origin"], service: ServiceType | null, locked = false) => {
    const key = slug(label);
    const existing = out.find((i) => i.key === key);
    if (existing) {
      if (service && !existing.services.includes(service)) existing.services.push(service);
      return;
    }
    out.push({ key, label, origin, services: service ? [service] : [], locked });
  };
  add("Engagement letter", "always", null);
  add("Client authorisation letter", "always", null);
  if (services.some((s) => PORTAL_CREDENTIAL_SERVICES.includes(s))) add("Portal credentials authorisation", "always", null);
  for (const s of SERVICE_TYPES) {
    if (!services.includes(s)) continue;
    for (const label of CHECKLIST_BY_SERVICE[s] ?? []) add(label, "service", s);
  }
  if (services.includes("audit")) for (const label of AUDIT_ACCEPTANCE_ITEMS) add(label, "acceptance", "audit", true);
  return out;
}

export type ChecklistItemValue = {
  key: string;
  label: string;
  origin: ChecklistOrigin;
  /** Pre-ticked suggestions are included; unticking removes one (§7.3.2 "pre-ticked, removable"). */
  included: boolean;
  collected: boolean;
  required: boolean;
  locked: boolean;
};

/**
 * The checklist after the services change: suggestions for services no longer selected go, new
 * ones arrive ticked, and what the person already did is kept (an unticked suggestion stays
 * unticked, collected stays collected, custom items stay).
 */
export function mergeChecklist(current: readonly ChecklistItemValue[], services: readonly ServiceType[]): ChecklistItemValue[] {
  const suggestions = suggestedChecklist(services);
  const byKey = new Map(current.map((i) => [i.key, i]));
  const merged: ChecklistItemValue[] = suggestions.map((s) => {
    const was = byKey.get(s.key);
    return {
      key: s.key,
      label: s.label,
      origin: s.origin,
      included: s.locked ? true : (was?.included ?? true),
      collected: was?.collected ?? false,
      required: true,
      locked: s.locked,
    };
  });
  for (const item of current) if (item.origin === "custom") merged.push(item);
  return merged;
}

/** A custom checklist item (§7.3.2 "Add custom item"); its key is unique within the list. */
export function customChecklistItem(label: string, existing: readonly ChecklistItemValue[]): ChecklistItemValue | null {
  const clean = label.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!clean) return null;
  let key = `custom-${slug(clean) || "item"}`;
  let n = 2;
  while (existing.some((i) => i.key === key)) key = `custom-${slug(clean) || "item"}-${n++}`;
  return { key, label: clean, origin: "custom", included: true, collected: false, required: true, locked: false };
}

// =================================================================================================
// Field helpers
// =================================================================================================

const text = (max: number, what = "This") =>
  z
    .string()
    .trim()
    .max(max, { error: `${what} can be at most ${max} characters.` })
    .default("");
const dateOrEmpty = z.union([z.literal(""), z.string().refine(isDateString, { error: "Enter a valid date." })]).default("");
const uuidOrEmpty = z.union([z.literal(""), z.uuid({ error: "That choice isn't valid." })]).default("");
/** A searchable select's value: clearing it gives null, read as "" (nothing chosen). */
const comboUuid = z
  .union([z.literal(""), z.null(), z.uuid({ error: "That choice isn't valid." })])
  .default("")
  .transform((v) => v ?? "");
const moneyOrEmpty = z.string().trim().default("");
const pctOrEmpty = z.string().trim().default("");

/** How a client hears about deadlines and requests. There is no email: the app sends none. */
export const NOTIFY_CHANNELS = ["whatsapp", "portal"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];
export const NOTIFY_CHANNEL_LABELS: Record<NotifyChannel, string> = {
  whatsapp: "WhatsApp (hand-off)",
  portal: "Portal",
};

export const CONTACT_ROLES = ["Director", "CFO", "Authorised signatory", "Accountant", "Promoter", "Proprietor", "Partner", "Other"] as const;

export const INCOME_NATURES = ["business", "profession", "presumptive_44ad", "presumptive_44ada"] as const;
export const INCOME_NATURE_LABELS: Record<IncomeNature, string> = {
  business: "Business",
  profession: "Profession",
  presumptive_44ad: "Presumptive business (s.44AD)",
  presumptive_44ada: "Presumptive profession (s.44ADA)",
};

export const TAX_AUDIT_DECISIONS = ["review", "yes", "no"] as const;
export type TaxAuditDecision = (typeof TAX_AUDIT_DECISIONS)[number];
export const TAX_AUDIT_DECISION_LABELS: Record<TaxAuditDecision, string> = {
  review: "Partner to review",
  yes: "Tax audit applies",
  no: "No tax audit",
};

export const MONTH_OPTIONS = MONTH_ABBR.map((_, i) => ({
  value: String(i + 1),
  label: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][i],
}));

/** A rupee amount typed in a MoneyInput, as paise; null when empty or unreadable. */
export function moneyToPaise(value: string | null | undefined): Paise | null {
  if (!value || !value.trim()) return null;
  const r = parseAmount(value);
  return r.ok ? r.paise : null;
}

/** A percentage typed in a PercentInput; null when empty, unreadable or outside 0–100. */
function pct(value: string | null | undefined): number | null {
  if (!value || !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/** A turnover the §6.6 rules can read: whole, non-negative paise, else null. */
function turnoverPaise(value: string | null | undefined): Paise | null {
  const p = moneyToPaise(value);
  return p !== null && Number.isSafeInteger(p) && p >= 0 ? p : null;
}

// =================================================================================================
// The schema
// =================================================================================================

export const ServiceEntrySchema = z.object({
  service_type: z.enum(SERVICE_TYPES),
  custom_name: text(80, "The service name"),
  frequency: z.enum(SERVICE_FREQUENCIES, { error: "Choose the filing frequency." }),
  /** Blank = the statutory calendar's next date for this service (§7.3.2 step 3, "auto … editable"). */
  next_due_date: dateOrEmpty,
  agreed_fee: moneyOrEmpty,
  /** "" = same as the filing frequency. */
  billing_frequency: z.union([z.literal(""), z.enum(SERVICE_FREQUENCIES)]).default(""),
  auto_invoice: z.boolean().default(false),
  first_billing_date: dateOrEmpty,
  sac_code: z.union([z.literal(""), z.string().trim().regex(/^\d{4,8}$/, { error: "A SAC has 4 to 8 digits." })]).default(""),
  /** Set when the service came from an accepted quotation line. */
  source_quotation_item_id: uuidOrEmpty,
});
export type ServiceEntry = z.output<typeof ServiceEntrySchema>;

export const ChecklistItemSchema = z.object({
  key: z.string().min(1).max(220),
  label: z.string().trim().min(1, { error: "Name the item." }).max(200),
  origin: z.enum(["always", "service", "acceptance", "custom"]),
  included: z.boolean(),
  collected: z.boolean(),
  required: z.boolean(),
  locked: z.boolean(),
});

const OnboardingObject = z.object({
  // ---- Step 1: identity
  display_name: z.string().trim().min(2, { error: "Enter the display name (at least 2 characters)." }).max(120, { error: "Keep the display name under 120 characters." }),
  legal_name: text(200, "The legal name"),
  client_code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(CLIENT_CODE_PATTERN, { error: "Use letters, digits, - and / (2–20 characters), like TW-C-0042." })),
  /** The code is the suggestion (take the next free number at Complete). */
  client_code_auto: z.boolean().default(true),
  entity_type: z.union([z.literal(""), z.enum(ENTITY_TYPES)]).default(""),
  entity_type_other: text(80, "The entity type"),
  is_incorporated: z.boolean().default(true),
  date_of_birth_or_incorporation: dateOrEmpty,
  // ---- tax registrations
  pan: text(10, "A PAN"),
  gst_registration: z.union([z.literal(""), z.enum(GST_REGISTRATIONS)]).default(""),
  gstin: text(15, "A GSTIN"),
  state_code: z
    .string()
    .trim()
    .nullable()
    .default("")
    .transform((v) => v ?? ""),
  show_tan: z.boolean().default(false),
  tan: text(10, "A TAN"),
  // ---- contact
  contact_name: text(120, "The contact's name"),
  contact_role: text(60, "The role"),
  email: z.union([z.literal(""), z.email({ error: "Enter a valid email address." })]).default(""),
  phone: text(30, "The phone number"),
  whatsapp: text(30, "The WhatsApp number"),
  whatsapp_same_as_phone: z.boolean().default(true),
  address: text(500, "The address"),
  city: text(80, "The city"),
  pincode: text(6, "A pincode"),
  // ---- scale
  fy_end_month: z.string().regex(/^(?:[1-9]|1[0-2])$/, { error: "Choose the month the financial year ends in." }).default("3"),
  annual_turnover: moneyOrEmpty,
  turnover_fy: z.string().default(""),
  /** "auto" = from turnover (§6.6). */
  gst_scheme_choice: z.enum(["auto", "monthly", "qrmp"]).default("auto"),
  // ---- tax audit indication (§6.6)
  income_nature: z.union([z.literal(""), z.enum(INCOME_NATURES)]).default(""),
  cash_receipts_pct: pctOrEmpty,
  cash_payments_pct: pctOrEmpty,
  declared_profit_pct: pctOrEmpty,
  income_above_basic_exemption: z.enum(["", "yes", "no"]).default(""),
  tax_audit_decision: z.enum(TAX_AUDIT_DECISIONS).default("review"),
  tax_audit_note: text(500, "The note"),
  notes: text(2000, "The notes"),
  // ---- duplicate guard and conflict check
  duplicate_reason: text(500, "The reason"),
  acceptance_id: uuidOrEmpty,
  /** What the wizard shows about that check (the server reads the record itself). */
  acceptance_outcome: z.enum(["", "accepted", "declined", "pending"]).default(""),
  acceptance_summary: text(300, "The summary"),
  // ---- Step 2
  services: z.array(ServiceEntrySchema).default([]),
  audit_kinds: z.array(z.enum(AUDIT_KINDS)).default([]),
  // ---- Step 3
  owner_employee_id: comboUuid,
  engagement_partner_id: comboUuid,
  review_manager_id: comboUuid,
  preparer_ids: z.array(z.uuid()).max(10, { error: "At most 10 preparers." }).default([]),
  priority: z.enum(CLIENT_PRIORITIES).default("medium"),
  // ---- Step 4
  checklist: z.array(ChecklistItemSchema).default([]),
  checklist_reviewed: z.boolean().default(false),
  // ---- Step 5
  reminder_days: z.string().trim().default("7"),
  notify_channels: z.array(z.enum(NOTIFY_CHANNELS)).default([]),
  invite_portal: z.boolean().default(false),
  send_welcome: z.boolean().default(true),
  // ---- origin (pre-fill, §7.3.2 "From a quotation")
  source_lead_id: uuidOrEmpty,
  source_quotation_id: uuidOrEmpty,
});

type Raw = z.output<typeof OnboardingObject>;

/** A field-level problem: the path the form shows it on, and the sentence. */
export type FieldIssue = { path: string; message: string };

/** Step 1's rules beyond each field's own shape (§7.3.2, §6.2, §6.6). */
export function basicsIssues(v: Raw, today: DateString): FieldIssue[] {
  const out: FieldIssue[] = [];
  if (!v.entity_type) out.push({ path: "entity_type", message: "Choose the entity type." });
  if (v.entity_type === "other" && !v.entity_type_other) out.push({ path: "entity_type_other", message: "Specify the entity type." });
  if (v.date_of_birth_or_incorporation && compareDates(v.date_of_birth_or_incorporation, today) > 0) {
    out.push({ path: "date_of_birth_or_incorporation", message: "This date can't be in the future." });
  }
  if (v.pan) {
    const r = validatePan(v.pan, { entityType: v.entity_type || null });
    if (!r.ok) out.push({ path: "pan", message: r.error });
  }
  if (!v.gst_registration) out.push({ path: "gst_registration", message: "Choose the GST registration." });
  if (v.gst_registration === "registered" && !v.gstin) out.push({ path: "gstin", message: "A registered client needs its GSTIN." });
  if (v.gstin) {
    const r = validateGstin(v.gstin);
    if (!r.ok) out.push({ path: "gstin", message: r.error });
    else {
      const mismatch = gstinPanMismatch(r.value, v.pan || null);
      if (mismatch) out.push({ path: "gstin", message: mismatch });
    }
  }
  if (v.state_code && !isValidStateCode(v.state_code)) out.push({ path: "state_code", message: "Choose a state from the list." });
  if (v.tan) {
    const r = validateTan(v.tan);
    if (!r.ok) out.push({ path: "tan", message: r.error });
  }
  if (v.phone) {
    const r = validateIndianPhone(v.phone);
    if (!r.ok) out.push({ path: "phone", message: r.error });
  }
  if (v.whatsapp_same_as_phone) {
    if (v.phone && !isWhatsAppNumber(v.phone)) out.push({ path: "whatsapp_same_as_phone", message: "This phone number isn't a mobile, so it can't be the WhatsApp number. Turn this off and enter one." });
  } else if (v.whatsapp && !isWhatsAppNumber(v.whatsapp)) {
    out.push({ path: "whatsapp", message: "This isn't a mobile number WhatsApp can use." });
  }
  if (v.pincode) {
    const r = validatePincode(v.pincode);
    if (!r.ok) out.push({ path: "pincode", message: r.error });
  }
  if (v.annual_turnover) {
    const r = parseAmount(v.annual_turnover);
    if (!r.ok) out.push({ path: "annual_turnover", message: r.error });
    if (!v.turnover_fy) out.push({ path: "turnover_fy", message: "Choose the financial year this turnover is for." });
  }
  if (v.turnover_fy && !isFinancialYear(v.turnover_fy)) out.push({ path: "turnover_fy", message: "Choose a financial year from the list." });
  for (const f of ["cash_receipts_pct", "cash_payments_pct", "declared_profit_pct"] as const) {
    const n = pct(v[f]);
    if (v[f] && (n === null || n < 0 || n > 100)) out.push({ path: f, message: "Enter a percentage from 0 to 100." });
  }
  return out;
}

/** Step 2's rules (§7.3.2). */
export function servicesIssues(v: Raw): FieldIssue[] {
  const out: FieldIssue[] = [];
  if (v.services.length === 0) out.push({ path: "services", message: "Choose at least one service." });
  v.services.forEach((s, i) => {
    if (s.service_type === "other" && !s.custom_name) out.push({ path: `services.${i}.custom_name`, message: "Name the service." });
  });
  const seen = new Set<string>();
  v.services.forEach((s, i) => {
    const k = `${s.service_type}|${s.service_type === "other" ? s.custom_name.toLowerCase() : ""}`;
    if (seen.has(k)) out.push({ path: `services.${i}.service_type`, message: "This service is already selected." });
    seen.add(k);
  });
  if (v.services.some((s) => s.service_type === "audit") && v.audit_kinds.length === 0) {
    out.push({ path: "audit_kinds", message: "Choose which audit (statutory, tax, GST or internal)." });
  }
  return out;
}

/** Step 3's rules (§7.3.2). */
export function configureIssues(v: Raw): FieldIssue[] {
  const out: FieldIssue[] = [];
  v.services.forEach((s, i) => {
    if (s.agreed_fee) {
      const r = parseAmount(s.agreed_fee);
      if (!r.ok) out.push({ path: `services.${i}.agreed_fee`, message: r.error });
    }
    if (s.auto_invoice) {
      if (!s.agreed_fee) out.push({ path: `services.${i}.agreed_fee`, message: "Automatic invoicing needs the agreed fee." });
      if (!s.first_billing_date) out.push({ path: `services.${i}.first_billing_date`, message: "Automatic invoicing needs the first billing date." });
    }
    if (s.frequency === "one_time" && s.auto_invoice) out.push({ path: `services.${i}.auto_invoice`, message: "A one-time service is invoiced by hand." });
  });
  if (!v.owner_employee_id) out.push({ path: "owner_employee_id", message: "Choose the client owner." });
  if (v.review_manager_id && v.review_manager_id === v.engagement_partner_id) {
    out.push({ path: "review_manager_id", message: "The review manager can't also be the engagement partner." });
  }
  return out;
}

/** Step 4's rules (§7.3.2). */
export function checklistIssues(v: Raw): FieldIssue[] {
  return v.checklist_reviewed ? [] : [{ path: "checklist_reviewed", message: "Tick this once you've reviewed the checklist." }];
}

/** Step 5's rules (§7.3.2). */
export function reviewIssues(v: Raw): FieldIssue[] {
  const out: FieldIssue[] = [];
  const days = Number(v.reminder_days);
  if (!/^\d{1,2}$/.test(v.reminder_days) || days < 1 || days > 60) out.push({ path: "reminder_days", message: "Enter a lead time from 1 to 60 days." });
  if (v.invite_portal && !v.email) out.push({ path: "invite_portal", message: "A portal invite needs the client's email address to sign in with (step 1)." });
  if (v.notify_channels.includes("portal") && !v.invite_portal) out.push({ path: "notify_channels", message: "Portal reminders need the portal invite turned on." });
  return out;
}

const STEP_RULES: Record<OnboardingStepId, (v: Raw, today: DateString) => FieldIssue[]> = {
  basics: basicsIssues,
  services: (v) => servicesIssues(v),
  configure: (v) => configureIssues(v),
  checklist: (v) => checklistIssues(v),
  review: (v) => reviewIssues(v),
};

/** Every rule of every step (what Complete checks, on the client and the server). */
export function allIssues(v: Raw, today: DateString): FieldIssue[] {
  return ONBOARDING_STEPS.flatMap((s) => STEP_RULES[s.id](v, today));
}

/** The issues of one step. */
export function stepIssues(step: OnboardingStepId, v: Raw, today: DateString): FieldIssue[] {
  return STEP_RULES[step](v, today);
}

/**
 * The whole wizard, field shapes plus every step's rules. `today` comes from the caller (IST) so the
 * "not in the future" check matches the server's day.
 */
export function onboardingSchema(today: DateString) {
  return OnboardingObject.superRefine((v, ctx) => {
    for (const issue of allIssues(v, today)) ctx.addIssue({ code: "custom", path: issue.path.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)), message: issue.message });
  });
}

/** The field shapes only (the server action's input schema; it applies `allIssues` itself). */
export const OnboardingInputSchema = OnboardingObject;
export type OnboardingValues = z.input<typeof OnboardingObject>;
export type OnboardingData = z.output<typeof OnboardingObject>;

const SERVICE_STEP_FIELDS = new Set(["service_type", "custom_name"]);

/**
 * The step a field (or an issue's path) belongs to: `services.2.custom_name` is step 2,
 * `services.2.agreed_fee` step 3. Used to open the step that holds an error.
 */
export function stepOfPath(path: string): OnboardingStepId {
  const parts = path.split(".");
  if (parts[0] === "services") {
    if (parts.length < 3) return "services";
    return SERVICE_STEP_FIELDS.has(parts[2]) ? "services" : "configure";
  }
  if (parts[0] === "acceptance_id") return "basics";
  for (const s of ONBOARDING_STEPS) if ((STEP_FIELDS[s.id] as readonly string[]).includes(parts[0])) return s.id;
  return "basics";
}

/** Which top-level fields each step owns (for the wizard's "Continue" validation). */
export const STEP_FIELDS: Record<OnboardingStepId, readonly (keyof OnboardingData)[]> = {
  basics: [
    "display_name", "legal_name", "client_code", "entity_type", "entity_type_other", "is_incorporated", "date_of_birth_or_incorporation",
    "pan", "gst_registration", "gstin", "state_code", "tan", "contact_name", "contact_role", "email", "phone", "whatsapp",
    "whatsapp_same_as_phone", "address", "city", "pincode", "fy_end_month", "annual_turnover", "turnover_fy", "gst_scheme_choice",
    "income_nature", "cash_receipts_pct", "cash_payments_pct", "declared_profit_pct", "income_above_basic_exemption",
    "tax_audit_decision", "tax_audit_note", "notes", "duplicate_reason",
  ],
  services: ["services", "audit_kinds"],
  configure: ["services", "owner_employee_id", "engagement_partner_id", "review_manager_id", "preparer_ids", "priority"],
  checklist: ["checklist", "checklist_reviewed"],
  review: ["reminder_days", "notify_channels", "invite_portal", "send_welcome"],
};

// =================================================================================================
// Derived facts the steps show (§6.6)
// =================================================================================================

export type ScaleContext = {
  /** QRMP limit in force today (paise). */
  qrmpMaxTurnoverPaise: Paise;
  /** Tax audit thresholds in force on the first day of each offered turnover FY. */
  taxAuditByFy: Readonly<Record<string, TaxAuditParams>>;
};

export const DEFAULT_SCALE_CONTEXT: ScaleContext = { qrmpMaxTurnoverPaise: SCALE_DEFAULTS.qrmpMaxTurnoverPaise, taxAuditByFy: {} };

/** The GST scheme decision with its live explanation (§6.6, §7.3.2 "a live line explaining the decision"). */
export function schemeDecisionFor(v: Pick<OnboardingValues, "annual_turnover" | "gst_scheme_choice">, ctx: ScaleContext = DEFAULT_SCALE_CONTEXT): GstSchemeDecision {
  const choice = v.gst_scheme_choice && v.gst_scheme_choice !== "auto" ? v.gst_scheme_choice : null;
  return gstSchemeDecision(turnoverPaise(v.annual_turnover), choice, { qrmpMaxTurnoverPaise: ctx.qrmpMaxTurnoverPaise });
}

/**
 * The tax audit indication (§6.6) once turnover is entered, or null before. The nature defaults
 * from the entity type: companies and firms are a business; individuals choose.
 */
export function taxAuditFor(
  v: Pick<OnboardingValues, "annual_turnover" | "turnover_fy" | "income_nature" | "cash_receipts_pct" | "cash_payments_pct" | "declared_profit_pct" | "income_above_basic_exemption">,
  ctx: ScaleContext = DEFAULT_SCALE_CONTEXT,
): TaxAuditIndication | null {
  const turnover = turnoverPaise(v.annual_turnover);
  if (turnover === null) return null;
  const params = (v.turnover_fy && ctx.taxAuditByFy[v.turnover_fy]) || SCALE_DEFAULTS.taxAudit;
  return taxAuditIndication(
    {
      nature: (v.income_nature || "business") as IncomeNature,
      turnover,
      cashReceiptsPct: pct(v.cash_receipts_pct),
      cashPaymentsPct: pct(v.cash_payments_pct),
      declaredProfitPct: pct(v.declared_profit_pct),
      incomeAboveBasicExemption: v.income_above_basic_exemption === "yes" ? true : v.income_above_basic_exemption === "no" ? false : null,
    },
    params,
  );
}

/** The state of supply: from a valid GSTIN, else the chosen state. */
export function effectiveStateCode(v: Pick<OnboardingValues, "gstin" | "state_code">): string | null {
  const parts = v.gstin ? deriveFromGstin(v.gstin) : null;
  if (parts) return parts.stateCode;
  return v.state_code && isValidStateCode(v.state_code) ? v.state_code : null;
}

/** Turnover FYs offered (§7.3.2 "select from the last 3 FYs"), newest first. */
export function turnoverFyOptions(today: DateString): string[] {
  const current = financialYearOf(today);
  const start = Number(current.slice(0, 4));
  return [1, 2, 3].map((back) => `${start - back}-${String((start - back + 1) % 100).padStart(2, "0")}`);
}

/** The first day of each offered FY (for resolving the tax audit parameters in force). */
export function turnoverFyStarts(today: DateString): Record<string, DateString> {
  return Object.fromEntries(turnoverFyOptions(today).map((fy) => [fy, fyStart(fy)]));
}

// =================================================================================================
// Calendar profile, initial tasks, KYC shell (what Complete builds)
// =================================================================================================

/** The wizard fields the statutory engine reads (the deadline preview sends only these). */
export const CalendarInputsSchema = z.object({
  entity_type: z.union([z.literal(""), z.enum(ENTITY_TYPES)]).default(""),
  gst_registration: z.union([z.literal(""), z.enum(GST_REGISTRATIONS)]).default(""),
  gstin: z.string().trim().max(15).default(""),
  state_code: z.string().trim().max(2).default(""),
  annual_turnover: z.string().trim().max(30).default(""),
  gst_scheme_choice: z.enum(["auto", "monthly", "qrmp"]).default("auto"),
  tax_audit_decision: z.enum(TAX_AUDIT_DECISIONS).default("review"),
  income_nature: z.union([z.literal(""), z.enum(INCOME_NATURES)]).default(""),
  services: z.array(z.object({ service_type: z.enum(SERVICE_TYPES) })).max(20).default([]),
});
export type CalendarInputs = z.output<typeof CalendarInputsSchema>;

/**
 * What the statutory engine needs about the new client (§6.7). GST returns are planned only for a
 * registered client with a valid GSTIN; until then the GST service has no statutory dates. A tax
 * audit counts only once a Partner has confirmed it ("review" is not yet an audit case).
 */
/**
 * Presumptive taxation (s.44AD / s.44ADA) from "Income is earned from" (§6.6). The statutory
 * calendar plans a single 15 March advance-tax instalment for these (§6.7). The onboarding preview
 * and every later generation (clients.income_nature, server/compliance/generate.ts) both use this.
 */
export function isPresumptiveNature(nature: string | null | undefined): boolean {
  return nature === "presumptive_44ad" || nature === "presumptive_44ada";
}

export function calendarProfileFor(v: CalendarInputs, clientId: string): CalendarClientProfile {
  const gstReady = v.gst_registration === "registered" && !!v.gstin && validateGstin(v.gstin).ok;
  const services = [...new Set(v.services.map((s) => s.service_type))].filter((s) => s !== "gst" || gstReady);
  return {
    id: clientId,
    serviceTypes: services,
    entityType: v.entity_type || null,
    gstScheme: v.gst_scheme_choice === "auto" ? null : v.gst_scheme_choice,
    stateCode: effectiveStateCode(v),
    turnover: turnoverPaise(v.annual_turnover),
    taxAuditApplicable: v.tax_audit_decision,
    isPresumptive: isPresumptiveNature(v.income_nature),
    isOpc: false,
  };
}

/** A service's name in sentences ("GST returns", or the custom name for Other). */
export function serviceName(s: Pick<ServiceEntry, "service_type" | "custom_name">): string {
  return s.service_type === "other" && s.custom_name ? s.custom_name : SERVICE_TYPE_LABELS[s.service_type];
}

export type InitialTask = { title: string; description: string; service_type: ServiceType; due_date: DateString; financial_year: string };

/**
 * The initial tasks (§7.3.2): "Collect documents for <service>" for each service, due in 14 days,
 * listing the checklist items still to collect for it.
 */
export function initialTasks(v: OnboardingData, today: DateString): InitialTask[] {
  const due = addDays(today, 14);
  const fy = financialYearOf(today);
  const items = v.checklist.filter((i) => i.included && !i.collected);
  return v.services.map((s) => {
    const own = suggestedChecklist([s.service_type])
      .filter((x) => x.origin !== "always")
      .map((x) => x.key);
    const pending = items.filter((i) => own.includes(i.key)).map((i) => `- ${i.label}`);
    const general = items.filter((i) => i.origin === "always" || i.origin === "custom").map((i) => `- ${i.label}`);
    const lines = [...pending, ...(s === v.services[0] ? general : [])];
    return {
      title: `Collect documents for ${serviceName(s)}`,
      description: lines.length ? `Still to collect:\n${lines.join("\n")}` : "Collect the documents this engagement needs from the client.",
      service_type: s.service_type,
      due_date: due,
      financial_year: fy,
    };
  });
}

/**
 * The welcome message for a new client, sent on WhatsApp from the screen after onboarding
 * (§7.3.2, §7.13.2): who looks after them, what the firm will do, and how to share documents
 * (the portal when they have a login, else this chat). `services` come in words
 * ("GST returns (monthly)").
 */
export function welcomeWhatsApp(d: {
  contactName: string | null;
  clientName: string;
  firmName: string;
  ownerName: string;
  ownerPhone: string | null;
  services: readonly string[];
  portalUrl: string | null;
}): string {
  const first = firstNameOf(d.contactName);
  const lines = [
    `${first ? `Hi ${first}` : "Hello"}, welcome to ${d.firmName}. We're glad to be working with ${d.clientName}.`,
    "",
    `${d.ownerName} looks after you${d.ownerPhone ? ` (${d.ownerPhone})` : ""}.`,
    ...(d.services.length ? [`What we'll do for you: ${d.services.join(", ")}.`] : []),
    "",
    d.portalUrl
      ? `Share your documents in your client portal, against each request we send: ${d.portalUrl}`
      : "Send your documents here on WhatsApp, and we'll confirm when we have everything.",
    "Before each deadline we'll remind you what's due and what we need from you.",
  ];
  return lines.join("\n");
}

/** The ICAI KYC category for an entity type (§6.8): individuals and proprietors, companies, everyone else. */
export function kycCategoryFor(entity: EntityType | "" | null | undefined): KycCategory {
  switch (entity) {
    case "individual":
    case "proprietorship":
      return "individual_proprietor";
    case "pvt_ltd":
    case "public_ltd":
    case "section_8":
      return "corporate";
    default:
      return "non_corporate";
  }
}

// =================================================================================================
// The deadline preview (§7.3.2 step 5 "list grouped by month, with the source of each date")
// =================================================================================================

export type PreviewEvent = {
  dedupeKey: string;
  title: string;
  formCode: string | null;
  filingPeriod: string;
  dueDate: DateString;
  sourceRef: string | null;
  overrideRef: string | null;
  originalDueDate: DateString | null;
  provisional: boolean;
  fallsOnSunday: boolean;
  serviceType: ServiceType | null;
  notes: string | null;
};

export type PreviewMonth = { key: string; label: string; events: PreviewEvent[] };

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Events in the next `months` months (from today), grouped by the month they fall due in, in date
 * order; plus how many later ones there are (annual returns of the next FY).
 */
export function groupPreviewByMonth(events: readonly PreviewEvent[], today: DateString, months = 12): { months: PreviewMonth[]; later: number; lastLater: DateString | null } {
  const { year, month } = parseDateString(today);
  const endIndex = year * 12 + (month - 1) + months;
  const groups = new Map<string, PreviewMonth>();
  let later = 0;
  let lastLater: DateString | null = null;
  for (const e of [...events].sort((a, b) => compareDates(a.dueDate, b.dueDate) || a.title.localeCompare(b.title))) {
    const p = parseDateString(e.dueDate);
    const idx = p.year * 12 + (p.month - 1);
    if (idx >= endIndex) {
      later++;
      lastLater = e.dueDate;
      continue;
    }
    const key = `${p.year}-${String(p.month).padStart(2, "0")}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, label: `${MONTH_NAMES[p.month - 1]} ${p.year}`, events: [] };
      groups.set(key, g);
    }
    g.events.push(e);
  }
  return { months: [...groups.values()], later, lastLater };
}

// =================================================================================================
// Defaults and pre-fill (§7.3.2 "From a quotation", §7.5.1 "Convert to client")
// =================================================================================================

export type WizardDefaults = {
  clientCode: string;
  reminderDays: number;
  notifyChannels: NotifyChannel[];
};

/** A blank wizard (step 1 open). */
export function emptyOnboardingValues(d: WizardDefaults): OnboardingValues {
  return {
    display_name: "",
    legal_name: "",
    client_code: d.clientCode,
    client_code_auto: true,
    entity_type: "",
    entity_type_other: "",
    is_incorporated: true,
    date_of_birth_or_incorporation: "",
    pan: "",
    gst_registration: "",
    gstin: "",
    state_code: "",
    show_tan: false,
    tan: "",
    contact_name: "",
    contact_role: "",
    email: "",
    phone: "",
    whatsapp: "",
    whatsapp_same_as_phone: true,
    address: "",
    city: "",
    pincode: "",
    fy_end_month: "3",
    annual_turnover: "",
    turnover_fy: "",
    gst_scheme_choice: "auto",
    income_nature: "",
    cash_receipts_pct: "",
    cash_payments_pct: "",
    declared_profit_pct: "",
    income_above_basic_exemption: "",
    tax_audit_decision: "review",
    tax_audit_note: "",
    notes: "",
    duplicate_reason: "",
    acceptance_id: "",
    acceptance_outcome: "",
    acceptance_summary: "",
    services: [],
    audit_kinds: [],
    owner_employee_id: "",
    engagement_partner_id: "",
    review_manager_id: "",
    preparer_ids: [],
    priority: "medium",
    checklist: mergeChecklist([], []),
    checklist_reviewed: false,
    reminder_days: String(d.reminderDays),
    notify_channels: [...d.notifyChannels],
    invite_portal: false,
    send_welcome: true,
    source_lead_id: "",
    source_quotation_id: "",
  };
}

/** A new service entry with its defaults (§7.3.2 step 3). */
export function newServiceEntry(service: ServiceType, scheme: GstScheme, extra: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    service_type: service,
    custom_name: "",
    frequency: defaultFrequency(service, scheme),
    next_due_date: "",
    agreed_fee: "",
    billing_frequency: "",
    auto_invoice: false,
    first_billing_date: "",
    sac_code: "",
    source_quotation_item_id: "",
    ...extra,
  };
}

export type QuotationForOnboarding = {
  id: string;
  quotation_number: string;
  status: string;
  lead_id: string | null;
  client_id: string | null;
  converted_client_id: string | null;
  client_name: string;
  client_email: string | null;
  client_phone: string | null;
  client_company: string | null;
  client_gstin: string | null;
  place_of_supply_code: string | null;
  items: Array<{ id: string; description: string; service_type: ServiceType | null; frequency: ServiceFrequency | null; quantity: number | string; unit_price: number | string }>;
};

export type LeadForOnboarding = {
  id: string;
  lead_number: string | null;
  status: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  services_required: ServiceType[];
  requirement_notes: string | null;
  converted_client_id: string | null;
};

function lineFee(qty: number | string, price: number | string): Paise | null {
  const p = parseAmount(String(price));
  if (!p.ok) return null;
  try {
    return multiplyPaise(p.paise, qty);
  } catch {
    return null;
  }
}

/**
 * The wizard pre-filled from an accepted quotation (§7.3.2): name, email, phone, company, GSTIN, and
 * the services with frequency and the agreed fee per line (lines of the same service and frequency
 * are added together; a line without a service type becomes an Other service named after it).
 */
export function prefillFromQuotation(base: OnboardingValues, q: QuotationForOnboarding, lead: LeadForOnboarding | null): OnboardingValues {
  const gst = q.client_gstin ? deriveFromGstin(q.client_gstin) : null;
  const display = (q.client_company || q.client_name).trim();
  const services: ServiceEntry[] = [];
  for (const item of q.items) {
    const type: ServiceType = item.service_type ?? "other";
    const name = type === "other" ? item.description.trim().slice(0, 80) : "";
    const fee = lineFee(item.quantity, item.unit_price);
    const existing = services.find((s) => s.service_type === type && (type !== "other" || s.custom_name.toLowerCase() === name.toLowerCase()));
    if (existing) {
      const prior = moneyToPaise(existing.agreed_fee) ?? 0;
      existing.agreed_fee = fee === null ? existing.agreed_fee : paiseToDecimalString(prior + fee);
      continue;
    }
    services.push(
      newServiceEntry(type, "monthly", {
        custom_name: name,
        frequency: item.frequency ?? defaultFrequency(type, "monthly"),
        agreed_fee: fee === null ? "" : paiseToDecimalString(fee),
        source_quotation_item_id: item.id,
      }),
    );
  }
  const types = services.map((s) => s.service_type);
  return {
    ...base,
    display_name: display,
    legal_name: q.client_company ?? "",
    contact_name: q.client_name,
    email: q.client_email ?? "",
    phone: q.client_phone ?? lead?.phone ?? "",
    whatsapp: lead?.whatsapp ?? "",
    whatsapp_same_as_phone: !lead?.whatsapp,
    gstin: q.client_gstin ?? "",
    pan: gst?.pan ?? "",
    gst_registration: q.client_gstin ? "registered" : "",
    state_code: gst?.stateCode ?? q.place_of_supply_code ?? "",
    notes: lead?.requirement_notes ?? "",
    services,
    checklist: mergeChecklist([], types),
    source_quotation_id: q.id,
    source_lead_id: q.lead_id ?? "",
  };
}

/** The wizard pre-filled from a lead (§7.5.1 "Convert to client": services unlocked). */
export function prefillFromLead(base: OnboardingValues, lead: LeadForOnboarding): OnboardingValues {
  const services = lead.services_required.filter((s) => s !== "other").map((s) => newServiceEntry(s, "monthly"));
  return {
    ...base,
    display_name: (lead.company || lead.name).trim(),
    legal_name: lead.company ?? "",
    contact_name: lead.name,
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    whatsapp: lead.whatsapp ?? "",
    whatsapp_same_as_phone: !lead.whatsapp,
    notes: lead.requirement_notes ?? "",
    services,
    checklist: mergeChecklist([], services.map((s) => s.service_type)),
    source_lead_id: lead.id,
  };
}

/** Why a quotation can't be converted, or null when it can (§7.5.3 "Converting stamps converted_client_id so it can't happen twice"). */
export function quotationConversionProblem(q: Pick<QuotationForOnboarding, "status" | "converted_client_id" | "quotation_number">): string | null {
  if (q.converted_client_id) return `Quotation ${q.quotation_number} has already been converted to a client.`;
  if (q.status !== "accepted") return `Only an accepted quotation can be converted to a client. Quotation ${q.quotation_number} isn't accepted yet.`;
  return null;
}

/** The lock note on the services step for a quotation (§7.3.2). */
export const QUOTATION_SERVICES_LOCK =
  "These are the services the client accepted. Raise a revised quotation to change them.";

/** The priority labels in order (step 3). */
export const PRIORITY_OPTIONS: ReadonlyArray<{ value: ClientPriority; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

// =================================================================================================
// Client acceptance and conflict check (§7.5.4, §6.8) — used by the wizard's step 1 and by leads
// =================================================================================================

export const INDEPENDENCE_QUESTIONS = [
  { key: "financial_interest", question: "Does anyone in the firm, or their close family, hold a financial interest in this client?" },
  { key: "relationships", question: "Does anyone in the firm have a family, business or employment relationship with this client or its management?" },
  { key: "other_services", question: "Would the firm provide services to this client that it can't provide to an audit client (for example, keeping its books)?" },
  { key: "fee_dependence", question: "Would the fees from this client be a large share of the firm's or a partner's total fees?" },
] as const;
export type IndependenceKey = (typeof INDEPENDENCE_QUESTIONS)[number]["key"];

const yesNo = z.enum(["yes", "no"], { error: "Answer yes or no." });

export const IndependenceAnswersSchema = z.object({
  financial_interest: yesNo,
  relationships: yesNo,
  other_services: yesNo,
  fee_dependence: yesNo,
});
export type IndependenceAnswers = z.output<typeof IndependenceAnswersSchema>;

/** True when any independence answer is "yes" (a threat the rationale must address, §6.8). */
export function independenceThreat(a: IndependenceAnswers | null | undefined): boolean {
  return !!a && Object.values(a).some((v) => v === "yes");
}

export const AcceptanceCheckSchema = z.object({
  /** Re-run an existing pending check instead of starting a new one. */
  acceptanceId: z.union([z.uuid(), z.literal(""), z.null()]).optional().transform((v) => v || null),
  prospectName: z.string().trim().min(2, { error: "Enter the prospect's name." }).max(200),
  pan: z.string().trim().max(10).default(""),
  gstin: z.string().trim().max(15).default(""),
  relatedParties: z.array(z.string().trim().max(120)).max(50, { error: "At most 50 related parties." }).default([]),
  leadId: z.union([z.uuid(), z.literal(""), z.null()]).optional().transform((v) => v || null),
  clientId: z.union([z.uuid(), z.literal(""), z.null()]).optional().transform((v) => v || null),
});
export type AcceptanceCheckInput = z.input<typeof AcceptanceCheckSchema>;

export const AcceptanceDecisionSchema = z.object({
  acceptanceId: z.uuid({ error: "Run the conflict check first." }),
  outcome: z.enum(["accepted", "declined", "pending"], { error: "Choose Accept, Decline or Pending." }),
  rationale: z.string().trim().max(2000, { error: "Keep the rationale under 2,000 characters." }).default(""),
  /** Required for attest work (§6.8). */
  independence: IndependenceAnswersSchema.nullish().transform((v) => v ?? null),
  attest: z.boolean().default(false),
  updatedAt: z.string().min(1),
});
export type AcceptanceDecisionInput = z.input<typeof AcceptanceDecisionSchema>;
