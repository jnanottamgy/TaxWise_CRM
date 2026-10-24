import { z } from "zod";
import { SERVICE_TYPES, type ServiceType } from "@/lib/domain/enums";
import { addDays, compareDates, diffDays, financialYearOf, isDateString, isFinancialYear, parseFinancialYear, previousFinancialYear, toDateString, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { REPORT_FORMS, FORM_26_CATEGORIES, udinDatesWarning, CEILING_DEFAULTS, type CeilingParams, type ReportForm, type Form26Category } from "@/lib/domain/ceiling";
import { validateCin, validateDin, validateGstin, validateLlpin, validatePan, validateTan, validateUdin } from "@/lib/domain/india-validators";

/**
 * The registers (§7.15.1, §7.15.2): the portal credentials vault, statutory registrations, DSCs,
 * UDINs with the tax-audit ceiling, and filing history with the "Import prior filings" CSV.
 * Forms and server actions parse with the same schemas; the pure rules here are unit-tested
 * (tests/unit/registers-*.test.ts) and mirror migrations 0191–0194. Client-safe.
 */

// =================================================================================================
// Tabs (/registers?tab=…)
// =================================================================================================

export const REGISTER_TABS = ["vault", "registrations", "dsc", "udin", "filings"] as const;
export type RegisterTab = (typeof REGISTER_TABS)[number];

export const REGISTER_TAB_LABEL: Record<RegisterTab, string> = {
  vault: "Portal credentials",
  registrations: "Registrations",
  dsc: "DSCs",
  udin: "UDINs",
  filings: "Filing history",
};

/** A link to a register tab: registersHref("dsc", { client: id }) → /registers?tab=dsc&client=<id>. */
export function registersHref(tab: RegisterTab, params: Record<string, string | null | undefined> = {}): string {
  const p = new URLSearchParams();
  if (tab !== "vault") p.set("tab", tab);
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const qs = p.toString();
  return qs ? `/registers?${qs}` : "/registers";
}

export function parseRegisterTab(value: unknown): RegisterTab {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && (REGISTER_TABS as readonly string[]).includes(v) ? (v as RegisterTab) : "vault";
}

// =================================================================================================
// Shared field helpers
// =================================================================================================

const uuid = (what: string) => z.uuid({ error: `Choose ${what} from the list.` });

/** Trimmed text with a limit; "" becomes null. */
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep ${label} under ${max.toLocaleString("en-IN")} characters.` })
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const requiredText = (max: number, message: string, label: string) =>
  z
    .string({ error: message })
    .trim()
    .min(1, { error: message })
    .max(max, { error: `Keep ${label} under ${max.toLocaleString("en-IN")} characters.` });

/** A `YYYY-MM-DD` date or empty (null). */
const optionalDate = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === null || v === undefined || v.trim() === "") return null;
    if (!isDateString(v.trim())) {
      ctx.addIssue({ code: "custom", message: "Enter a valid date." });
      return z.NEVER;
    }
    return v.trim();
  });

const requiredDate = (message: string) =>
  z
    .string({ error: message })
    .trim()
    .refine((v) => isDateString(v), { error: message });

const optionalUuid = z
  .union([z.uuid({ error: "Choose one from the list." }), z.literal(""), z.literal("none"), z.null()])
  .optional()
  .transform((v) => (v && v !== "none" ? v : null));

const optionalFy = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    const s = (v ?? "").trim();
    if (s === "") return null;
    if (!isFinancialYear(s)) {
      ctx.addIssue({ code: "custom", message: "Enter the FY like 2025-26." });
      return z.NEVER;
    }
    return s;
  });

/** Optimistic concurrency (§13): edits carry the updated_at they loaded. */
const editKeys = { id: z.uuid(), updatedAt: z.string().min(1) };

export const RecordRefSchema = z.object({ id: z.uuid(), updatedAt: z.string().min(1) });
export const IdSchema = z.object({ id: z.uuid() });
export const ClientSearchSchema = z.object({ q: z.string().trim().max(100).default("") });

/** "in 12 days" / "today" / "3 days ago" relative to today, for expiry columns. */
export type ExpiryState = "expired" | "expiring" | "ok";

/**
 * Where an expiry date stands (§7.15.1): past it, within the warning window (the last day
 * included), or later. Null without a date.
 */
export function expiryState(expiry: DateString | null | undefined, today: DateString, windowDays: number): ExpiryState | null {
  if (!expiry) return null;
  const left = diffDays(expiry, today);
  if (left < 0) return "expired";
  return left <= windowDays ? "expiring" : "ok";
}

// =================================================================================================
// Portal credentials vault (§7.15.1)
// =================================================================================================

export const PORTALS = ["GST", "INCOME_TAX", "TRACES", "MCA", "EPFO", "ESIC", "ICEGATE", "PT", "OTHER"] as const;
export type Portal = (typeof PORTALS)[number];

export const PORTAL_LABEL: Record<Portal, string> = {
  GST: "GST",
  INCOME_TAX: "Income Tax",
  TRACES: "TRACES",
  MCA: "MCA",
  EPFO: "EPFO",
  ESIC: "ESIC",
  ICEGATE: "ICEGATE",
  PT: "Professional Tax",
  OTHER: "Other",
};

/** The official sign-in pages, offered as the login URL (the user can change it). */
export const PORTAL_SIGN_IN_URL: Partial<Record<Portal, string>> = {
  GST: "https://services.gst.gov.in/services/login",
  INCOME_TAX: "https://eportal.incometax.gov.in/iec/foservices/#/login",
  TRACES: "https://www.tdscpc.gov.in/app/login.xhtml",
  MCA: "https://www.mca.gov.in/",
  EPFO: "https://unifiedportal-emp.epfindia.gov.in/epfo/",
  ESIC: "https://www.esic.gov.in/",
  ICEGATE: "https://www.icegate.gov.in/",
};

export function isPortal(v: unknown): v is Portal {
  return typeof v === "string" && (PORTALS as readonly string[]).includes(v);
}

/** "GST", "Professional Tax", or the name given for Other. */
export function portalName(portal: string, label: string | null | undefined): string {
  if (portal === "OTHER") return label?.trim() || "Other portal";
  return isPortal(portal) ? PORTAL_LABEL[portal] : portal;
}

/** Seconds a revealed password stays on screen (§4.6, §7.15.1). */
export const REVEAL_SECONDS = 30;

/** The AES-GCM associated data for a client's stored passwords: a value copied to another client's row won't open. */
export function credentialContext(clientId: string): string {
  return `client_credential:${clientId}`;
}

export const CREDENTIAL_LIMITS = { username: 200, password: 500, label: 80, url: 500, notes: 2000 } as const;

const loginUrl = z
  .string()
  .trim()
  .max(CREDENTIAL_LIMITS.url, { error: "Keep the login URL under 500 characters." })
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (!v) return null;
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      ctx.addIssue({ code: "custom", message: "Enter the full address, starting with https://" });
      return z.NEVER;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      ctx.addIssue({ code: "custom", message: "The login URL starts with https://" });
      return z.NEVER;
    }
    return url.toString();
  });

const credentialFields = {
  portal: z.enum(PORTALS, { error: "Choose the portal." }),
  portalLabel: optionalText(CREDENTIAL_LIMITS.label, "the portal name"),
  username: requiredText(CREDENTIAL_LIMITS.username, "Enter the username or login ID.", "the username"),
  loginUrl,
  notes: optionalText(CREDENTIAL_LIMITS.notes, "the notes"),
};

function requireOtherLabel(v: { portal: Portal; portalLabel: string | null }, ctx: z.RefinementCtx) {
  if (v.portal === "OTHER" && !v.portalLabel) ctx.addIssue({ code: "custom", path: ["portalLabel"], message: "Name the portal." });
}

export const CreateCredentialSchema = z
  .object({
    clientId: uuid("the client"),
    ...credentialFields,
    // Never trimmed: spaces can be part of a password.
    password: z
      .string({ error: "Enter the password to store." })
      .min(1, { error: "Enter the password to store." })
      .max(CREDENTIAL_LIMITS.password, { error: "That password is too long to store." }),
  })
  .superRefine(requireOtherLabel);
export type CreateCredentialInput = z.input<typeof CreateCredentialSchema>;

export const UpdateCredentialSchema = z
  .object({
    ...editKeys,
    ...credentialFields,
    /** Empty keeps the stored password. */
    password: z
      .string()
      .max(CREDENTIAL_LIMITS.password, { error: "That password is too long to store." })
      .optional()
      .nullable()
      .transform((v) => (v ? v : null)),
  })
  .superRefine(requireOtherLabel);
export type UpdateCredentialInput = z.input<typeof UpdateCredentialSchema>;

export const CredentialListFilters = { portal: PORTALS, client: null, reveal: ["yes", "no"] } as const;
export const CREDENTIAL_SORTABLE = ["client_name", "portal", "username", "updated_at", "last_viewed_at"] as const;
export type CredentialSort = (typeof CREDENTIAL_SORTABLE)[number];

export const CREDENTIAL_ACTION_LABEL: Record<string, string> = {
  viewed: "Revealed the password",
  copied: "Copied the password",
  created: "Stored the login",
  updated: "Changed the login",
  deleted: "Deleted the login",
};

// =================================================================================================
// Statutory registrations (§7.15.1)
// =================================================================================================

export const REGISTRATION_TYPES = ["GST", "PT", "IEC", "MSME_UDYAM", "FSSAI", "SHOPS_ESTAB", "PF", "ESIC", "DIN", "LLPIN", "CIN", "TAN", "OTHER"] as const;
export type RegistrationType = (typeof REGISTRATION_TYPES)[number];

export const REGISTRATION_TYPE_LABEL: Record<RegistrationType, string> = {
  GST: "GST",
  PT: "Professional Tax",
  IEC: "IEC",
  MSME_UDYAM: "MSME / Udyam",
  FSSAI: "FSSAI",
  SHOPS_ESTAB: "Shops & Establishment",
  PF: "PF",
  ESIC: "ESIC",
  DIN: "DIN",
  LLPIN: "LLPIN",
  CIN: "CIN",
  TAN: "TAN",
  OTHER: "Other",
};

export const REGISTRATION_STATUS_VALUES = ["active", "expired", "surrendered", "cancelled"] as const;
export type RegistrationStatusValue = (typeof REGISTRATION_STATUS_VALUES)[number];

export function registrationTypeLabel(t: string): string {
  return (REGISTRATION_TYPES as readonly string[]).includes(t) ? REGISTRATION_TYPE_LABEL[t as RegistrationType] : t;
}

const UDYAM = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;
const FSSAI = /^[0-9]{14}$/;
const ESIC_CODE = /^[0-9]{17}$/;
const IEC = /^[A-Z0-9]{10}$/;

/**
 * A registration number checked for its type (§6.2): GSTIN, CIN, LLPIN, DIN and TAN must be valid
 * (they are refused otherwise); Udyam, FSSAI, ESIC and IEC numbers in an unusual shape only warn,
 * since older certificates differ. Returns the number as stored (upper-cased).
 */
export function checkRegistrationNumber(type: RegistrationType, input: string): { ok: true; value: string; warning: string | null } | { ok: false; error: string } {
  const raw = input.trim().toUpperCase().replace(/\s+/g, type === "SHOPS_ESTAB" || type === "PT" || type === "OTHER" || type === "PF" ? " " : "");
  if (!raw) return { ok: false, error: "Enter the registration number." };
  const strict = (r: { ok: true; value: string } | { ok: false; error: string }) => (r.ok ? { ok: true as const, value: r.value, warning: null } : r);
  switch (type) {
    case "GST":
      return strict(validateGstin(raw));
    case "CIN":
      return strict(validateCin(raw));
    case "LLPIN":
      return strict(validateLlpin(raw));
    case "DIN":
      return strict(validateDin(raw));
    case "TAN":
      return strict(validateTan(raw));
    case "MSME_UDYAM":
      return { ok: true, value: raw, warning: UDYAM.test(raw) ? null : "An Udyam number usually looks like UDYAM-KR-03-0012345." };
    case "FSSAI":
      return { ok: true, value: raw, warning: FSSAI.test(raw) ? null : "An FSSAI licence or registration number has 14 digits." };
    case "ESIC":
      return { ok: true, value: raw, warning: ESIC_CODE.test(raw) ? null : "An ESIC employer code has 17 digits." };
    case "IEC":
      return { ok: true, value: raw, warning: IEC.test(raw) ? null : "An IEC has 10 characters (usually the PAN)." };
    default:
      return { ok: true, value: raw.slice(0, 80), warning: null };
  }
}

const registrationFields = {
  registrationType: z.enum(REGISTRATION_TYPES, { error: "Choose the type." }),
  registrationNumber: requiredText(80, "Enter the registration number.", "the number"),
  jurisdiction: optionalText(160, "the jurisdiction"),
  issueDate: optionalDate,
  expiryDate: optionalDate,
  reminderDays: z.coerce
    .number({ error: "Enter the number of days." })
    .int({ error: "Use whole days." })
    .min(0, { error: "Use 0 days or more." })
    .max(365, { error: "Remind at most 365 days before." })
    .default(30),
  status: z.enum(REGISTRATION_STATUS_VALUES).default("active"),
  lastDir3KycFy: optionalFy,
  notes: optionalText(2000, "the notes"),
};

function refineRegistration(
  v: { registrationType: RegistrationType; registrationNumber: string; issueDate: string | null; expiryDate: string | null; lastDir3KycFy: string | null },
  ctx: z.RefinementCtx,
) {
  const n = checkRegistrationNumber(v.registrationType, v.registrationNumber);
  if (!n.ok) ctx.addIssue({ code: "custom", path: ["registrationNumber"], message: n.error });
  if (v.issueDate && v.expiryDate && compareDates(v.expiryDate, v.issueDate) < 0) {
    ctx.addIssue({ code: "custom", path: ["expiryDate"], message: "The expiry date is before the issue date." });
  }
  if (v.lastDir3KycFy && v.registrationType !== "DIN") {
    ctx.addIssue({ code: "custom", path: ["lastDir3KycFy"], message: "DIR-3 KYC is recorded on DIN rows only." });
  }
}

export const CreateRegistrationSchema = z.object({ clientId: uuid("the client"), ...registrationFields }).superRefine(refineRegistration);
export const UpdateRegistrationSchema = z.object({ ...editKeys, ...registrationFields }).superRefine(refineRegistration);
export type CreateRegistrationInput = z.input<typeof CreateRegistrationSchema>;
export type UpdateRegistrationInput = z.input<typeof UpdateRegistrationSchema>;

export const REGISTRATION_SORTABLE = ["client_name", "registration_type", "expiry_date", "next_dir3_kyc_due", "updated_at"] as const;
export const RegistrationListFilters = { type: REGISTRATION_TYPES, status: ["active", "expired", "surrendered", "cancelled"], expiring: ["30", "90"], client: null } as const;

/**
 * A registration's reminder is due (§8 "registration expiries per reminder_days"): Active, with an
 * expiry date from today up to `reminderDays` days ahead.
 */
export function registrationReminderDue(r: { status: string; expiryDate: DateString | null; reminderDays: number }, today: DateString): boolean {
  if (r.status !== "active" || !r.expiryDate) return false;
  const left = diffDays(r.expiryDate, today);
  return left >= 0 && left <= Math.max(0, r.reminderDays);
}

/** The DIR-3 KYC Web cycle as the DIR3_KYC_WEB rule seeds it (§6.7): every third FY, by 30 June. */
export const DIR3_KYC_DEFAULT = { everyNYears: 3, fixed: "06-30" } as const;

/** When DIR-3 KYC Web is next due after the FY it was last filed in (mirrors dir3_kyc_next_due, 0192). */
export function dir3KycNextDue(lastFiledFy: FinancialYear, cycle: { everyNYears: number; fixed: string } = DIR3_KYC_DEFAULT): { fy: FinancialYear; due: DateString } | null {
  const start = parseFinancialYear(lastFiledFy);
  if (start === null) return null;
  const nextStart = start + cycle.everyNYears;
  const [mm, dd] = cycle.fixed.split("-").map(Number);
  return { fy: `${nextStart}-${String((nextStart + 1) % 100).padStart(2, "0")}`, due: toDateString(nextStart, mm, dd) };
}

// =================================================================================================
// DSC register (§7.15.1)
// =================================================================================================

export const DSC_CLASSES = ["class_3", "class_3_dgft", "class_2"] as const;
export const DSC_CLASS_LABEL: Record<string, string> = { class_3: "Class 3", class_3_dgft: "Class 3 (DGFT)", class_2: "Class 2 (legacy)" };

export const DSC_ISSUERS = ["eMudhra", "Capricorn", "Sify", "(n)Code", "Other"] as const;

export const DSC_STATUS_VALUES = ["active", "expired", "revoked"] as const;

export const CUSTODY_KINDS = ["firm", "client", "person"] as const;
export type CustodyKind = (typeof CUSTODY_KINDS)[number];
export const CUSTODY_LABEL: Record<CustodyKind, string> = { firm: "With the firm", client: "With the client", person: "With a named person" };

/** Who holds the token, as stored in dsc_records.custody: "Firm", "Client", or the person's name. */
export function custodyValue(kind: CustodyKind | null | undefined, name: string | null | undefined): string | null {
  if (kind === "firm") return "Firm";
  if (kind === "client") return "Client";
  if (kind === "person") return name?.trim() ? name.trim().slice(0, 120) : null;
  return null;
}

export function parseCustody(value: string | null | undefined): { kind: CustodyKind | null; name: string } {
  const v = value?.trim() ?? "";
  if (!v) return { kind: null, name: "" };
  if (v.toLowerCase() === "firm") return { kind: "firm", name: "" };
  if (v.toLowerCase() === "client") return { kind: "client", name: "" };
  return { kind: "person", name: v };
}

export function custodyLabel(value: string | null | undefined): string | null {
  const c = parseCustody(value);
  if (c.kind === "firm") return "Firm";
  if (c.kind === "client") return "Client";
  return c.kind === "person" ? c.name : null;
}

/** DSC expiry alerts (§7.15.1 "Alerts at 30, 15 and 7 days"). */
export const DSC_ALERT_DAYS = [30, 15, 7] as const;

/**
 * The alert a DSC is due for (§8): the smallest of 30/15/7 that its days left fall within, so a run
 * that was missed still sends the next one once, and an alert never repeats (the dedupe key names
 * the threshold). Null when it is more than 30 days away or already expired.
 */
export function dscAlertThreshold(daysLeft: number): number | null {
  if (daysLeft < 0) return null;
  const hits = DSC_ALERT_DAYS.filter((d) => daysLeft <= d);
  return hits.length ? Math.min(...hits) : null;
}

const dscFields = {
  holderName: requiredText(160, "Enter the holder's name.", "the name"),
  holderPan: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((v, ctx) => {
      const s = (v ?? "").trim().toUpperCase();
      if (!s) return null;
      const r = validatePan(s);
      if (!r.ok) {
        ctx.addIssue({ code: "custom", message: r.error });
        return z.NEVER;
      }
      return r.value;
    }),
  dscClass: z.enum(DSC_CLASSES).default("class_3"),
  serialNumber: optionalText(80, "the serial number"),
  issuedBy: z
    .union([z.enum(DSC_ISSUERS), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
  issueDate: optionalDate,
  expiryDate: requiredDate("Enter the expiry date."),
  custodyKind: z
    .union([z.enum(CUSTODY_KINDS), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
  custodyName: optionalText(120, "the name"),
  status: z.enum(DSC_STATUS_VALUES).default("active"),
  notes: optionalText(2000, "the notes"),
};

function refineDsc(v: { issueDate: string | null; expiryDate: string; custodyKind: CustodyKind | null; custodyName: string | null }, ctx: z.RefinementCtx) {
  if (v.issueDate && compareDates(v.expiryDate, v.issueDate) <= 0) ctx.addIssue({ code: "custom", path: ["expiryDate"], message: "The expiry date is after the issue date." });
  if (v.custodyKind === "person" && !v.custodyName) ctx.addIssue({ code: "custom", path: ["custodyName"], message: "Name the person who holds the token." });
}

export const CreateDscSchema = z.object({ clientId: uuid("the client"), ...dscFields }).superRefine(refineDsc);
export const UpdateDscSchema = z.object({ ...editKeys, ...dscFields }).superRefine(refineDsc);
export type CreateDscInput = z.input<typeof CreateDscSchema>;
export type UpdateDscInput = z.input<typeof UpdateDscSchema>;

export const DSC_SORTABLE = ["client_name", "holder_name", "expiry_date", "updated_at"] as const;
export const DscListFilters = { status: ["active", "expired", "revoked"], expiring: ["month", "30", "90"], custody: ["firm", "client", "person"], client: null } as const;

// =================================================================================================
// UDIN register and the tax-audit ceiling (§7.15.1, §6.2, §6.8)
// =================================================================================================

export const UDIN_DOCUMENT_TYPES = ["Tax Audit Report", "Statutory Audit Report", "Certificate", "GST Audit", "Net-worth certificate", "Other"] as const;
export type UdinDocumentType = (typeof UDIN_DOCUMENT_TYPES)[number];

export const REPORT_FORM_LABEL: Record<ReportForm, string> = {
  "3CA": "Form 3CA (with 3CD)",
  "3CB_44AB_a": "Form 3CB, s.44AB(a)",
  "3CB_44AB_b": "Form 3CB, s.44AB(b)",
  "3CB_combined": "Form 3CB, combined",
  "3CB_44AB_c": "Form 3CB, s.44AB(c)",
  "3CB_44AB_d": "Form 3CB, s.44AB(d)",
  "3CB_44AB_e": "Form 3CB, s.44AB(e)",
  FORM_26: "Form 26 (Income-tax Act, 2025)",
  audit_report: "Audit report",
  certificate: "Certificate",
  gst_audit: "GST audit",
  other: "Other",
};

export const FORM_26_CATEGORY_LABEL: Record<Form26Category, string> = {
  a: "Like s.44AB(a): business turnover",
  b: "Like s.44AB(b): professional receipts",
  combined: "Like combined (a) and (b)",
  c: "Like s.44AB(c): presumptive, below the deemed rate",
  d: "Like s.44AB(d): presumptive profession",
  e: "Like s.44AB(e): presumptive business, lower income",
};

/** The report forms as filter options. */
export const REPORT_FORM_OPTIONS = REPORT_FORMS.map((f) => ({ value: f, label: REPORT_FORM_LABEL[f] }));

export function reportFormLabel(form: string | null | undefined): string | null {
  if (!form) return null;
  return (REPORT_FORMS as readonly string[]).includes(form) ? REPORT_FORM_LABEL[form as ReportForm] : form;
}

/** The report forms that fit a document type (the form offers these first). */
export function reportFormsFor(documentType: string): ReportForm[] {
  switch (documentType) {
    case "Tax Audit Report":
      return ["3CA", "3CB_44AB_a", "3CB_44AB_b", "3CB_combined", "3CB_44AB_c", "3CB_44AB_d", "3CB_44AB_e", "FORM_26"];
    case "Statutory Audit Report":
      return ["audit_report"];
    case "Certificate":
    case "Net-worth certificate":
      return ["certificate"];
    case "GST Audit":
      return ["gst_audit"];
    default:
      return ["other", "audit_report", "certificate"];
  }
}

/**
 * Whether a UDIN record counts towards the ICAI ceiling, as the database derives it (0017 trigger;
 * Form 26 by its category, counted when none is given).
 */
export function udinCounts(form: ReportForm | null, isRevised: boolean, form26Category: Form26Category | null, params: CeilingParams = CEILING_DEFAULTS): boolean | null {
  if (isRevised) return false;
  if (!form) return null;
  if (form === "3CA" || params.countedForm3cb.includes(form)) return true;
  if (form === "FORM_26") return form26Category ? params.form26CountedCategories.includes(form26Category) : true;
  return false;
}

const udinFields = {
  udin: z
    .string({ error: "Enter the UDIN." })
    .trim()
    .transform((v, ctx) => {
      const r = validateUdin(v);
      if (!r.ok) {
        ctx.addIssue({ code: "custom", message: r.error });
        return z.NEVER;
      }
      return r.value;
    }),
  clientId: optionalUuid,
  documentType: z.enum(UDIN_DOCUMENT_TYPES, { error: "Choose the document type." }),
  reportForm: z
    .union([z.enum(REPORT_FORMS), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
  form26Category: z
    .union([z.enum(FORM_26_CATEGORIES), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
  financialYear: optionalFy,
  signedOn: requiredDate("Enter the date the document was signed."),
  generatedOn: requiredDate("Enter the date the UDIN was generated."),
  signingPartnerId: uuid("the signing partner"),
  filingRecordId: optionalUuid,
  auditEngagementId: optionalUuid,
  isRevised: z.boolean().default(false),
  remarks: optionalText(1000, "the remarks"),
  /** A Partner confirming a tax audit past the ICAI ceiling (§6.8). */
  confirmOverCeiling: z.boolean().default(false),
};

function refineUdin(
  v: { documentType: string; reportForm: ReportForm | null; form26Category: Form26Category | null; signedOn: string; generatedOn: string; clientId: string | null; filingRecordId: string | null; auditEngagementId: string | null },
  ctx: z.RefinementCtx,
) {
  if (v.documentType === "Tax Audit Report" && !v.reportForm) ctx.addIssue({ code: "custom", path: ["reportForm"], message: "Choose the report form: it decides whether it counts towards the ceiling." });
  if (v.form26Category && v.reportForm !== "FORM_26") ctx.addIssue({ code: "custom", path: ["form26Category"], message: "A category is for Form 26 reports only." });
  if (v.reportForm === "FORM_26" && !v.form26Category) ctx.addIssue({ code: "custom", path: ["form26Category"], message: "Choose which s.44AB category the Form 26 report corresponds to." });
  if (isDateString(v.signedOn) && isDateString(v.generatedOn) && compareDates(v.generatedOn, v.signedOn) < 0) {
    ctx.addIssue({ code: "custom", path: ["generatedOn"], message: "The UDIN can't be generated before the document is signed." });
  }
  if (!v.clientId && (v.filingRecordId || v.auditEngagementId)) ctx.addIssue({ code: "custom", path: ["clientId"], message: "Choose the client to link a filing or an audit engagement." });
}

export const CreateUdinSchema = z.object(udinFields).superRefine(refineUdin);
export const UpdateUdinSchema = z.object({ ...editKeys, ...udinFields }).superRefine(refineUdin);
export type CreateUdinInput = z.input<typeof CreateUdinSchema>;
export type UpdateUdinInput = z.input<typeof UpdateUdinSchema>;

export const UdinCheckSchema = z.object({
  udin: z.string().trim().max(40).default(""),
  signingPartnerId: optionalUuid,
  signedOn: z.string().trim().max(10).default(""),
  generatedOn: z.string().trim().max(10).default(""),
  reportForm: z.string().trim().max(20).default(""),
  form26Category: z.string().trim().max(10).default(""),
  isRevised: z.boolean().default(false),
  clientId: optionalUuid,
  financialYear: z.string().trim().max(7).default(""),
  recordId: optionalUuid,
});

export const ExternalCountSchema = z.object({
  memberId: z.uuid(),
  financialYear: z.string().refine((v) => isFinancialYear(v), { error: "Choose the FY." }),
  auditsSignedElsewhere: z.coerce
    .number({ error: "Enter a number." })
    .int({ error: "Use a whole number." })
    .min(0, { error: "Use 0 or more." })
    .max(500, { error: "That is more tax audits than the ceiling allows in a year." }),
  notes: optionalText(500, "the notes"),
});
export type ExternalCountInput = z.input<typeof ExternalCountSchema>;

export const UDIN_SORTABLE = ["signed_on", "generated_on", "client_name", "udin", "signing_partner_name"] as const;
export const UdinListFilters = { partner: null, form: REPORT_FORMS, counted: ["yes", "no"], late: ["yes"], year: null, client: null } as const;

/**
 * The warnings a UDIN gets on save (§7.15.1, §6.2): the membership number in characters 3–8 isn't
 * the signing partner's [verify]; it was generated more than 60 days after signing; the year digits
 * don't match the year it was generated. None of these blocks the save.
 */
export function udinWarnings(
  input: { udin: string; membershipNo: string | null; signedOn: DateString; generatedOn: DateString },
  params: CeilingParams = CEILING_DEFAULTS,
): string[] {
  const out: string[] = [];
  const v = validateUdin(input.udin, { membershipNo: input.membershipNo });
  if (v.ok && v.warning) out.push(v.warning);
  if (isDateString(input.signedOn) && isDateString(input.generatedOn)) {
    const dates = udinDatesWarning(input.signedOn, input.generatedOn, params);
    if (dates && compareDates(input.generatedOn, input.signedOn) >= 0) out.push(dates);
    if (v.ok) {
      const year = input.generatedOn.slice(2, 4);
      if (v.yearDigits !== year) out.push(`This UDIN starts with ${v.yearDigits}, but it was generated in 20${year}. Check the UDIN or the generation date.`);
    }
  }
  return out;
}

/** The FY a report counts in for the ceiling: the FY of the date it was signed (§6.8). */
export function ceilingFyOf(signedOn: DateString): FinancialYear {
  return financialYearOf(signedOn);
}

// =================================================================================================
// Filing history (§7.15.2)
// =================================================================================================

export const FILING_ORIGINS = ["ours", "inherited"] as const;
export type FilingOrigin = (typeof FILING_ORIGINS)[number];
export const FILING_ORIGIN_LABEL: Record<FilingOrigin, string> = { ours: "Filed by us", inherited: "Inherited" };

export const FILING_SORTABLE = ["filed_on", "client_name", "financial_year", "filing_type"] as const;
export const FilingListFilters = { origin: FILING_ORIGINS, year: null, form: null, client: null } as const;

/** Clean form codes: "gstr3b" → "GSTR-3B", "ITR 6" → "ITR-6", "Form 24Q" → "24Q", "aoc4" → "AOC-4". */
export function normaliseFormCode(input: string): string {
  let v = input.trim().toUpperCase().replace(/\s+/g, " ");
  v = v.replace(/^FORM\s+/, "");
  const gstr = v.match(/^GSTR[\s-]?(\d{1,2}[A-Z]?)$/);
  if (gstr) return `GSTR-${gstr[1]}`;
  const itr = v.match(/^ITR[\s-]?(\d|U)$/);
  if (itr) return `ITR-${itr[1]}`;
  const roc = v.match(/^(AOC|MGT|DIR|ADT|DPT|INC|PAS|CHG|SH|MSME)[\s-]?(\d{1,2}[A-Z]?)(\s.*)?$/);
  if (roc) return `${roc[1]}-${roc[2]}${roc[3] ?? ""}`;
  const tds = v.match(/^(24Q|26Q|27Q|27EQ)$/);
  if (tds) return tds[1];
  return v.slice(0, 40);
}

/** The service a form belongs to, for the record's service_type (null when unsure). */
export function serviceTypeForForm(form: string): ServiceType | null {
  const f = normaliseFormCode(form);
  if (/^(GSTR-|GST|CMP-|ITC-04|PMT-06|IFF)/.test(f)) return "gst";
  if (/^ITR-/.test(f)) return "income_tax";
  if (/^(3CA|3CB|3CD|3CEB|26$|FORM 26$)/.test(f)) return "audit";
  if (/^(24Q|26Q|27Q|27EQ|TDS|TCS)/.test(f)) return "tds";
  if (/^(AOC-|MGT-|DIR-|ADT-|DPT-|INC-|PAS-|CHG-|SH-|MSME-|LLP)/.test(f)) return "company_law";
  if (/^(PF|EPF|ECR|ESIC|ESI|PT)/.test(f)) return "payroll";
  return null;
}

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 };

/**
 * An FY written any of the usual ways: "2024-25", "2024-2025", "FY 2024-25", "FY24-25", "24-25",
 * "2024/25". An assessment year ("AY 2025-26") is turned into its FY (2024-25). Null otherwise.
 */
export function parseFyInput(input: string): FinancialYear | null {
  const v = input.trim().toUpperCase().replace(/\s+/g, "");
  const ay = v.startsWith("AY");
  const body = v.replace(/^(FY|AY|F\.Y\.|A\.Y\.)/, "");
  const m = body.match(/^(\d{2}|\d{4})[-/](\d{2}|\d{4})$/);
  if (!m) return null;
  const start = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
  const endRaw = m[2].length === 2 ? Number(m[2]) : Number(m[2]) % 100;
  if ((start + 1) % 100 !== endRaw) return null;
  if (start < 1990 || start > 2100) return null;
  const fy = `${start}-${String(endRaw).padStart(2, "0")}`;
  return ay ? previousFinancialYear(fy) : fy;
}

/**
 * A date written the Indian way: "31/07/2025", "31-07-2025", "31.07.2025", "31 Jul 2025",
 * "31-Jul-2025", "31-Jul-25", or ISO "2025-07-31". Day first, never month first. Null otherwise.
 */
export function parseIndianDate(input: string): DateString | null {
  const v = input.trim();
  if (!v) return null;
  if (isDateString(v)) return v;
  // (isDateString narrows `v`; the other shapes are matched on a fresh copy.)
  const text: string = input.trim();
  let m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return safeDate(Number(m[3].length === 2 ? `20${m[3]}` : m[3]), Number(m[2]), Number(m[1]));
  m = text.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s,-]+(\d{2}|\d{4})$/);
  if (m) {
    const month = MONTHS[m[2].toUpperCase()];
    if (!month) return null;
    return safeDate(Number(m[3].length === 2 ? `20${m[3]}` : m[3]), month, Number(m[1]));
  }
  return null;
}

function safeDate(year: number, month: number, day: number): DateString | null {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const s = toDateString(year, month, day);
  return isDateString(s) ? s : null;
}

/** The import's columns, in the template's order, with the headings each one is recognised by. */
export const FILING_IMPORT_COLUMNS = [
  { key: "financial_year", label: "FY", required: true, aliases: ["fy", "financial year", "financial_year", "year", "ay", "assessment year"] },
  { key: "filing_type", label: "Form", required: true, aliases: ["form", "return", "form code", "filing type", "filing_type", "return type"] },
  { key: "period", label: "Period", required: false, aliases: ["period", "tax period", "month", "quarter", "return period"] },
  { key: "filed_on", label: "Filed on", required: false, aliases: ["filed on", "filed_on", "filing date", "date of filing", "date filed", "filed date"] },
  { key: "acknowledgement_no", label: "Acknowledgement no.", required: false, aliases: ["acknowledgement no", "acknowledgement no.", "acknowledgement number", "acknowledgement_no", "ack no", "ack no.", "ack", "arn", "srn"] },
  { key: "filed_by_external", label: "Previous firm", required: true, aliases: ["previous firm", "previous ca", "filed by", "filed_by_external", "firm", "previous auditor"] },
  { key: "notes", label: "Notes", required: false, aliases: ["notes", "remarks", "comments"] },
] as const;
export type FilingImportKey = (typeof FILING_IMPORT_COLUMNS)[number]["key"];

/** The template the import dialog offers for download. */
export const FILING_IMPORT_TEMPLATE_CSV = [
  "FY,Form,Period,Filed on,Acknowledgement no.,Previous firm,Notes",
  "2024-25,GSTR-3B,Mar 2025,20/04/2025,AA2903251234567,,",
  "2024-25,ITR-6,,31/10/2025,123456789012345,,",
].join("\n");

const normHeader = (h: string) => h.trim().toLowerCase().replace(/[_.]+/g, " ").replace(/\s+/g, " ").replace(/ no$/, " no");

/** Matches the file's headings to the import's columns (first match wins; unknown headings ignored). */
export function mapFilingHeaders(headers: readonly string[]): Partial<Record<FilingImportKey, string>> {
  const out: Partial<Record<FilingImportKey, string>> = {};
  for (const col of FILING_IMPORT_COLUMNS) {
    const aliases = col.aliases.map((a) => normHeader(a));
    const hit = headers.find((h) => aliases.includes(normHeader(h)));
    if (hit) out[col.key] = hit;
  }
  return out;
}

export type FilingImportRow = {
  financial_year: FinancialYear;
  filing_type: string;
  period: string | null;
  filed_on: DateString | null;
  acknowledgement_no: string | null;
  filed_by_external: string;
  service_type: ServiceType | null;
  notes: string | null;
};

export type FilingImportCheck = {
  /** 1-based line in the file, the heading being line 1. */
  line: number;
  row: FilingImportRow | null;
  errors: string[];
  warnings: string[];
};

export const FILING_IMPORT_MAX_ROWS = 2000;

/**
 * Checks each row of a prior-filings CSV (§7.15.2): FY (FY or AY, normalised), form (cleaned),
 * period, filed on (day first; not in the future), acknowledgement no., previous firm (the file's,
 * or the default typed in the dialog). Rows that repeat an earlier row are warned about and kept
 * once. Only rows without errors are imported.
 */
export function checkFilingImport(
  rows: ReadonlyArray<Record<string, string | null | undefined>>,
  opts: { mapping: Partial<Record<FilingImportKey, string>>; defaultFirm?: string | null; today: DateString },
): { checks: FilingImportCheck[]; valid: FilingImportRow[] } {
  const get = (r: Record<string, string | null | undefined>, key: FilingImportKey) => {
    const h = opts.mapping[key];
    return h ? String(r[h] ?? "").trim() : "";
  };
  const seen = new Map<string, number>();
  const checks: FilingImportCheck[] = [];
  const valid: FilingImportRow[] = [];
  rows.forEach((r, i) => {
    const line = i + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const fyRaw = get(r, "financial_year");
    const fy = fyRaw ? parseFyInput(fyRaw) : null;
    if (!fyRaw) errors.push("The FY is missing.");
    else if (!fy) errors.push(`"${fyRaw}" isn't an FY. Write it like 2024-25.`);
    else if (/^\s*A\.?Y/i.test(fyRaw)) warnings.push(`Read ${fyRaw} as FY ${fy}.`);
    const formRaw = get(r, "filing_type");
    const form = formRaw ? normaliseFormCode(formRaw) : "";
    if (!form) errors.push("The form is missing.");
    else if (form.length > 40) errors.push("The form is longer than 40 characters.");
    const period = get(r, "period").slice(0, 40) || null;
    const filedRaw = get(r, "filed_on");
    let filed: DateString | null = null;
    if (filedRaw) {
      filed = parseIndianDate(filedRaw);
      if (!filed) errors.push(`"${filedRaw}" isn't a date. Write it day first, like 31/07/2025.`);
      else if (compareDates(filed, opts.today) > 0) errors.push("The filing date is in the future.");
    } else warnings.push("No filing date.");
    const ack = get(r, "acknowledgement_no").slice(0, 80) || null;
    if (!ack) warnings.push("No acknowledgement number.");
    const firm = (get(r, "filed_by_external") || opts.defaultFirm?.trim() || "").slice(0, 160);
    if (!firm) errors.push("The previous firm is missing. Add a Previous firm column, or type the firm's name above.");
    const notes = get(r, "notes").slice(0, 1000) || null;

    let row: FilingImportRow | null = null;
    if (errors.length === 0 && fy && form) {
      const key = [fy, form, (period ?? "").toUpperCase(), (ack ?? "").toUpperCase()].join("|");
      const first = seen.get(key);
      if (first !== undefined) {
        warnings.push(`Same filing as line ${first}; it is imported once.`);
      } else {
        seen.set(key, line);
        row = { financial_year: fy, filing_type: form, period, filed_on: filed, acknowledgement_no: ack, filed_by_external: firm, service_type: serviceTypeForForm(form), notes };
        valid.push(row);
      }
    }
    checks.push({ line, row, errors, warnings });
  });
  return { checks, valid };
}

const importRow = z.object({
  financial_year: z.string().refine((v) => isFinancialYear(v), { error: "Each row needs an FY like 2024-25." }),
  filing_type: z.string().trim().min(1).max(40),
  period: z.string().trim().max(40).nullable(),
  filed_on: z
    .string()
    .nullable()
    .refine((v) => v === null || isDateString(v), { error: "A filing date isn't a date." }),
  acknowledgement_no: z.string().trim().max(80).nullable(),
  filed_by_external: z.string().trim().min(1, { error: "Each row needs the previous firm." }).max(160),
  service_type: z.enum(SERVICE_TYPES).nullable(),
  notes: z.string().trim().max(1000).nullable(),
});

export const ImportFilingsSchema = z.object({
  clientId: uuid("the client"),
  fileName: z.string().trim().max(200).default(""),
  rows: z.array(importRow).min(1, { error: "There are no valid rows to import." }).max(FILING_IMPORT_MAX_ROWS, { error: "Import at most 2,000 filings at a time." }),
});
export type ImportFilingsInput = z.input<typeof ImportFilingsSchema>;

export const UpdateFilingSchema = z.object({
  ...editKeys,
  financialYear: z.string().refine((v) => isFinancialYear(v), { error: "Enter the FY like 2024-25." }),
  filingType: requiredText(40, "Enter the form.", "the form").transform((v) => normaliseFormCode(v)),
  period: optionalText(40, "the period"),
  filedOn: optionalDate,
  acknowledgementNo: optionalText(80, "the acknowledgement number"),
  filedByExternal: requiredText(160, "Enter the previous firm.", "the firm"),
  notes: optionalText(1000, "the notes"),
});
export type UpdateFilingInput = z.input<typeof UpdateFilingSchema>;

/** Today plus `days`, for "expiring in" filters. */
export function windowEnd(today: DateString, days: number): DateString {
  return addDays(today, days);
}
