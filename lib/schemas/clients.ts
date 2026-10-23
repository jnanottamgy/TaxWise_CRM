import { z } from "zod";
import {
  CLIENT_PRIORITIES,
  CLIENT_STATUSES,
  ENTITY_TYPE_LABELS,
  ENTITY_TYPES,
  GST_REGISTRATIONS,
  GST_SCHEMES,
  SERVICE_TYPE_LABELS,
  SERVICE_TYPES,
  type ClientPriority,
  type ClientStatus,
  type EntityType,
  type GstRegistration,
  type GstScheme,
  type ServiceFrequency,
  type ServiceType,
} from "@/lib/domain/enums";
import {
  STATE_CODES,
  gstinPanMismatch,
  isValidStateCode,
  normaliseIdentifier,
  validateGstin,
  validatePan,
  validatePincode,
  validateTan,
} from "@/lib/domain/india-validators";
import { normalizeWhatsAppNumber } from "@/lib/domain/messaging";
import { parseAmount, paiseToDecimalString } from "@/lib/domain/money";
import { isFinancialYear } from "@/lib/domain/fy";

/**
 * The client list (§7.3.1), status changes, delete, bulk actions, CSV import and export (§7.3.4).
 * Shared by the forms (client) and the actions (server). Client-safe.
 */

// =================================================================================================
// Field validators shared with the onboarding wizard and the import
// =================================================================================================

/** Client codes: letters, digits, "-" and "/", 2–20 characters (TW-C-0042). Stored upper-case. */
export const CLIENT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9/-]{1,19}$/;

export type PhoneCheck = { ok: true; value: string; mobile: boolean } | { ok: false; error: string };

/**
 * An Indian mobile or landline number (§7.3.2 "Phone (Indian mobile/landline)"). Mobiles are 10
 * digits starting 6–9 (with or without +91 / 0); landlines are the STD code and number, 10 digits
 * with a leading 0 (080 2345 6789). The value is stored as typed, trimmed.
 */
export function validateIndianPhone(input: string): PhoneCheck {
  const value = input.trim().replace(/\s+/g, " ");
  if (value === "") return { ok: false, error: "Enter the phone number." };
  if (!/^\+?[0-9 ()-]+$/.test(value)) return { ok: false, error: "A phone number has only digits, spaces, brackets, + and -." };
  const mobile = normalizeWhatsAppNumber(value);
  if (mobile && mobile.startsWith("91") && mobile.length === 12) return { ok: true, value, mobile: true };
  let digits = value.replace(/\D/g, "");
  if (value.startsWith("+91") || (digits.startsWith("91") && digits.length === 12)) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0") && /^0[1-9]/.test(digits)) return { ok: true, value, mobile: false };
  if (digits.length === 10 && /^[2-5]/.test(digits)) return { ok: true, value, mobile: false };
  return { ok: false, error: "Enter a 10-digit mobile number, or a landline with its STD code (080 2345 6789)." };
}

/** True when the number can receive WhatsApp (an Indian mobile or another E.164 number, §7.13.2). */
export function isWhatsAppNumber(input: string | null | undefined): boolean {
  return normalizeWhatsAppNumber(input ?? "") !== null;
}

// =================================================================================================
// List (§7.3.1)
// =================================================================================================

export const CLIENT_LIST_SORTABLE = [
  "display_name",
  "client_code",
  "status",
  "priority",
  "owner_name",
  "group_name",
  "next_due_date",
  "open_tasks",
  "outstanding",
  "last_contact_at",
  "onboarded_at",
] as const;
export type ClientListSort = (typeof CLIENT_LIST_SORTABLE)[number];

export const GST_FILTER_VALUES = ["registered", "unregistered", "unknown", "missing_gstin"] as const;
export const ONBOARDED_FILTER_VALUES = ["30", "90", "365"] as const;
export const WHATSAPP_FILTER_VALUES = ["none", "to_create", "active", "closed"] as const;
export const FLAG_FILTER_VALUES = ["overdue_tasks", "overdue_invoices", "unreachable", "covered_now"] as const;
export type ClientFlag = (typeof FLAG_FILTER_VALUES)[number];

/** Filter params of the client list (parseTableParams `filters`). */
export const CLIENT_LIST_FILTERS = {
  status: CLIENT_STATUSES,
  priority: CLIENT_PRIORITIES,
  owner: null,
  service: SERVICE_TYPES,
  entity: ENTITY_TYPES,
  gst: GST_FILTER_VALUES,
  scheme: GST_SCHEMES,
  group: null,
  onboarded: ONBOARDED_FILTER_VALUES,
  whatsapp: WHATSAPP_FILTER_VALUES,
  flag: FLAG_FILTER_VALUES,
  /** `?covering=1`: the clients the signed-in person is covering for a colleague (§4.7; cover notices link here). */
  covering: ["1"],
} as const;
export type ClientListFilter = keyof typeof CLIENT_LIST_FILTERS;
export const CLIENT_LIST_FILTER_NAMES = Object.keys(CLIENT_LIST_FILTERS) as ClientListFilter[];

export const GST_FILTER_LABELS: Record<(typeof GST_FILTER_VALUES)[number], string> = {
  registered: "Registered",
  unregistered: "Not registered",
  unknown: "Not sure yet",
  missing_gstin: "Registered, GSTIN missing",
};

export const ONBOARDED_FILTER_LABELS: Record<(typeof ONBOARDED_FILTER_VALUES)[number], string> = {
  "30": "In the last 30 days",
  "90": "In the last 90 days",
  "365": "In the last year",
};

export const WHATSAPP_GROUP_LABELS: Record<(typeof WHATSAPP_FILTER_VALUES)[number], string> = {
  none: "No group yet",
  to_create: "To create",
  active: "Active",
  closed: "Closed",
};

export const FLAG_LABELS: Record<ClientFlag, string> = {
  overdue_tasks: "Has overdue tasks",
  overdue_invoices: "Has overdue invoices",
  unreachable: "Can't be reached (no email or phone)",
  covered_now: "Covered now",
};

/** The flags a role may filter by: overdue invoices are money (§4.1). */
export function flagOptionsFor(seesMoney: boolean): ClientFlag[] {
  return FLAG_FILTER_VALUES.filter((f) => seesMoney || f !== "overdue_invoices");
}

/** The banner's filter link (§7.3.1 "Opens that filter"). */
export const UNREACHABLE_HREF = "/clients?flag=unreachable";

/** "3 clients can't be reached: no email or phone" (§7.3.1). */
export function unreachableBanner(count: number): string | null {
  if (count <= 0) return null;
  return `${count.toLocaleString("en-IN")} ${count === 1 ? "client can't" : "clients can't"} be reached: no email or phone`;
}

// =================================================================================================
// Status, delete, bulk actions (§7.3.1, §7.3.4)
// =================================================================================================

const uuid = (what: string) => z.uuid({ error: `That ${what} isn't valid.` });

/** §7.3.4 / §3.6: what On hold and Inactive pause. */
export const STATUS_PAUSE_NOTE =
  "Reminders to the client and automatic invoicing pause until the client is Active again.";

/** The sentence the status confirm dialog shows for the new status (§7.3.4). */
export function statusChangeConsequence(to: ClientStatus): string {
  switch (to) {
    case "on_hold":
      return `On hold: no new work. ${STATUS_PAUSE_NOTE}`;
    case "inactive":
      return `Inactive: kept for history and left out of billing, reminders and work allocation. ${STATUS_PAUSE_NOTE}`;
    case "active":
      return "Active: included in billing runs, reminders and work allocation again.";
    case "pending":
      return "Pending: marked as not fully onboarded. Reminders and billing wait until it is Active.";
  }
}

export const reasonField = z
  .string()
  .trim()
  .min(3, { error: "Give a reason (at least 3 characters)." })
  .max(500, { error: "Keep the reason under 500 characters." });

export const ClientStatusChangeSchema = z.object({
  clientId: uuid("client"),
  to: z.enum(CLIENT_STATUSES, { error: "Choose the new status." }),
  reason: reasonField,
  updatedAt: z.string().nullish().transform((v) => v ?? null),
});
export type ClientStatusChangeInput = z.input<typeof ClientStatusChangeSchema>;

export const BULK_MAX = 200;
const clientIds = z
  .array(uuid("client"))
  .min(1, { error: "Select at least one client." })
  .max(BULK_MAX, { error: `Select at most ${BULK_MAX} clients at a time.` })
  .transform((ids) => [...new Set(ids)]);

export const BulkStatusSchema = z.object({
  clientIds,
  to: z.enum(CLIENT_STATUSES, { error: "Choose the new status." }),
  reason: reasonField,
});
export type BulkStatusInput = z.input<typeof BulkStatusSchema>;

export const BulkOwnerSchema = z.object({
  clientIds,
  ownerEmployeeId: uuid("owner"),
});
export type BulkOwnerInput = z.input<typeof BulkOwnerSchema>;

export const BulkGroupSchema = z.object({
  clientIds,
  /** null removes the clients from their group. */
  groupId: z.union([uuid("group"), z.null()]),
});
export type BulkGroupInput = z.input<typeof BulkGroupSchema>;

export const DeleteClientSchema = z.object({
  clientId: uuid("client"),
  updatedAt: z.string().nullish().transform((v) => v ?? null),
});
export type DeleteClientInput = z.input<typeof DeleteClientSchema>;

// =================================================================================================
// Saved views (§3.4) and export (§7.3.4)
// =================================================================================================

export const SaveClientViewSchema = z.object({
  name: z.string().trim().min(1, { error: "Name the view." }).max(60, { error: "Keep the name under 60 characters." }),
  query: z.string().max(2000),
  shared: z.boolean().default(false),
});
export const DeleteClientViewSchema = z.object({ id: uuid("view") });

export const EXPORT_MAX_ROWS = 5000;
export const ExportClientsSchema = z.object({
  /** The list's query string (search, filters, sort), without paging. */
  query: z.string().max(4000).default(""),
  format: z.enum(["csv", "xlsx"]).default("csv"),
  /** Only these clients (bulk export of a selection). */
  ids: z.array(uuid("client")).max(BULK_MAX).optional(),
});
export type ExportClientsInput = z.input<typeof ExportClientsSchema>;

/** One client as the export writes it. */
export type ClientExportRow = {
  client_code: string;
  display_name: string;
  legal_name: string | null;
  entity_type: EntityType | null;
  entity_type_other: string | null;
  pan: string | null;
  gstin: string | null;
  tan: string | null;
  gst_registration: GstRegistration;
  effective_gst_scheme: string | null;
  state_code: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  city: string | null;
  status: ClientStatus;
  priority: ClientPriority;
  owner_name: string | null;
  group_name: string | null;
  service_types: ServiceType[];
  next_due_title: string | null;
  next_due_date: string | null;
  open_tasks: number;
  overdue_tasks: number;
  outstanding: number | string | null;
  last_contact_at: string | null;
  has_portal: boolean;
  whatsapp_group_status: string;
  onboarded_at: string | null;
};

const STATUS_WORD: Record<ClientStatus, string> = { active: "Active", pending: "Pending", on_hold: "On hold", inactive: "Inactive" };
const PRIORITY_WORD: Record<ClientPriority, string> = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };

/**
 * The export's header and rows (§7.3.4 "CSV/Excel export of the current view; Employees can't export
 * fees"): the outstanding column only when `withMoney`. Dates are `YYYY-MM-DD` (sortable in a
 * spreadsheet); the date part of timestamps is in IST (the caller passes `istDate`).
 */
export function clientExportTable(
  rows: readonly ClientExportRow[],
  opts: { withMoney: boolean; istDate: (ts: string | null) => string },
): { header: string[]; rows: Array<Array<string | number>> } {
  const header = [
    "Client code",
    "Display name",
    "Legal name",
    "Entity type",
    "PAN",
    "GSTIN",
    "TAN",
    "GST registration",
    "GST scheme",
    "State",
    "Email",
    "Phone",
    "WhatsApp",
    "City",
    "Status",
    "Priority",
    "Owner",
    "Group",
    "Services",
    "Next deadline",
    "Next deadline date",
    "Open tasks",
    "Overdue tasks",
    ...(opts.withMoney ? ["Outstanding (₹)"] : []),
    "Last contact",
    "Portal",
    "WhatsApp group",
    "Onboarded on",
  ];
  const out = rows.map((r) => {
    const entity = r.entity_type ? (r.entity_type === "other" && r.entity_type_other ? r.entity_type_other : ENTITY_TYPE_LABELS[r.entity_type]) : "";
    const money = (() => {
      if (!opts.withMoney) return [];
      const parsed = r.outstanding === null || r.outstanding === undefined ? null : parseAmount(String(r.outstanding));
      return [parsed && parsed.ok ? paiseToDecimalString(parsed.paise) : "0.00"];
    })();
    return [
      r.client_code,
      r.display_name,
      r.legal_name ?? "",
      entity,
      r.pan ?? "",
      r.gstin ?? "",
      r.tan ?? "",
      { registered: "Registered", unregistered: "Not registered", unknown: "Not sure yet" }[r.gst_registration],
      r.effective_gst_scheme === "qrmp" ? "QRMP" : r.effective_gst_scheme === "monthly" ? "Monthly" : "",
      r.state_code ? `${STATE_CODES[r.state_code] ?? r.state_code} (${r.state_code})` : "",
      r.email ?? "",
      r.phone ?? "",
      r.whatsapp ?? "",
      r.city ?? "",
      STATUS_WORD[r.status],
      PRIORITY_WORD[r.priority],
      r.owner_name ?? "",
      r.group_name ?? "",
      r.service_types.map((s) => SERVICE_TYPE_LABELS[s]).join("; "),
      r.next_due_title ?? "",
      r.next_due_date ?? "",
      r.open_tasks,
      r.overdue_tasks,
      ...money,
      opts.istDate(r.last_contact_at),
      r.has_portal ? "Yes" : "No",
      WHATSAPP_GROUP_LABELS[r.whatsapp_group_status as keyof typeof WHATSAPP_GROUP_LABELS] ?? r.whatsapp_group_status,
      opts.istDate(r.onboarded_at),
    ];
  });
  return { header, rows: out };
}

/** RFC 4180 CSV with a BOM so Excel reads ₹ and Indian names correctly; formula-like cells are quoted with a leading ' (CSV injection). */
export function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  const cell = (v: string | number) => {
    let s = typeof v === "number" ? String(v) : v;
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

// =================================================================================================
// CSV import (§7.3.4)
// =================================================================================================

export const IMPORT_MAX_ROWS = 1000;
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

export type ImportColumn = {
  key: ImportKey;
  /** The template's header. */
  header: string;
  required?: boolean;
  /** Other headers that map to this column (lower-case, spaces and punctuation ignored). */
  aliases: string[];
  hint: string;
};

export const IMPORT_KEYS = [
  "client_code",
  "display_name",
  "legal_name",
  "entity_type",
  "pan",
  "gst_registration",
  "gstin",
  "state_code",
  "tan",
  "email",
  "phone",
  "whatsapp",
  "address",
  "city",
  "pincode",
  "owner_email",
  "priority",
  "status",
  "fy_end_month",
  "annual_turnover",
  "turnover_fy",
  "gst_scheme",
  "group",
  "services",
  "notes",
] as const;
export type ImportKey = (typeof IMPORT_KEYS)[number];

export const IMPORT_COLUMNS: readonly ImportColumn[] = [
  { key: "client_code", header: "client_code", aliases: ["code", "client code", "client id"], hint: "Leave blank for the next TW-C number." },
  { key: "display_name", header: "display_name", required: true, aliases: ["name", "client name", "client", "display name", "trade name"], hint: "2–120 characters." },
  { key: "legal_name", header: "legal_name", aliases: ["legal name", "registered name", "company name"], hint: "As registered." },
  { key: "entity_type", header: "entity_type", aliases: ["entity", "entity type", "constitution", "type"], hint: "Private limited company, LLP, Partnership firm, Individual …" },
  { key: "pan", header: "pan", aliases: ["pan no", "pan number"], hint: "10 characters." },
  { key: "gst_registration", header: "gst_registration", aliases: ["gst registered", "gst status", "gst registration"], hint: "Registered, Not registered or Not sure yet." },
  { key: "gstin", header: "gstin", aliases: ["gst no", "gst number", "gstin no"], hint: "15 characters; must contain the PAN." },
  { key: "state_code", header: "state_code", aliases: ["state", "state code", "place of supply"], hint: "Two digits (29) or the state's name." },
  { key: "tan", header: "tan", aliases: ["tan no", "tan number"], hint: "10 characters." },
  { key: "email", header: "email", aliases: ["email id", "e mail", "mail"], hint: "" },
  { key: "phone", header: "phone", aliases: ["mobile", "phone no", "contact number", "mobile number"], hint: "Mobile or landline with STD code." },
  { key: "whatsapp", header: "whatsapp", aliases: ["whatsapp no", "whatsapp number"], hint: "" },
  { key: "address", header: "address", aliases: ["registered address"], hint: "" },
  { key: "city", header: "city", aliases: ["town"], hint: "" },
  { key: "pincode", header: "pincode", aliases: ["pin", "pin code", "postal code", "zip"], hint: "6 digits." },
  { key: "owner_email", header: "owner_email", aliases: ["owner", "client owner", "assigned to", "owner email"], hint: "The email of a member of the team." },
  { key: "priority", header: "priority", aliases: [], hint: "Low, Medium, High or Critical." },
  { key: "status", header: "status", aliases: ["client status"], hint: "Active (default), Pending, On hold or Inactive." },
  { key: "fy_end_month", header: "fy_end_month", aliases: ["fy end", "financial year end", "year end month"], hint: "1–12 or the month's name; default March." },
  { key: "annual_turnover", header: "annual_turnover", aliases: ["turnover", "annual turnover"], hint: "In rupees." },
  { key: "turnover_fy", header: "turnover_fy", aliases: ["turnover year", "turnover fy"], hint: "e.g. 2025-26." },
  { key: "gst_scheme", header: "gst_scheme", aliases: ["gst scheme", "filing scheme", "scheme"], hint: "Monthly, QRMP, or blank to decide from turnover." },
  { key: "group", header: "group", aliases: ["client group", "group name"], hint: "The name of an existing client group." },
  { key: "services", header: "services", aliases: ["service", "services taken"], hint: "Separated by ; e.g. GST returns; Income tax." },
  { key: "notes", header: "notes", aliases: ["remarks", "note"], hint: "" },
];

const headerKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The import column a file's header maps to, or null (§7.3.4 "header mapping"). */
export function autoMapHeader(header: string): ImportKey | null {
  const k = headerKey(header);
  if (!k) return null;
  for (const c of IMPORT_COLUMNS) {
    if (headerKey(c.header) === k || c.aliases.some((a) => headerKey(a) === k)) return c.key;
  }
  return null;
}

/** A first mapping for every header of the file; a column is used once (the first header wins). */
export function autoMapHeaders(headers: readonly string[]): Record<string, ImportKey | null> {
  const used = new Set<ImportKey>();
  const out: Record<string, ImportKey | null> = {};
  for (const h of headers) {
    const key = autoMapHeader(h);
    out[h] = key && !used.has(key) ? key : null;
    if (key) used.add(key);
  }
  return out;
}

/** Required columns the mapping doesn't cover. */
export function missingImportKeys(mapping: Record<string, ImportKey | null>): ImportKey[] {
  const mapped = new Set(Object.values(mapping).filter((v): v is ImportKey => v !== null));
  return IMPORT_COLUMNS.filter((c) => c.required && !mapped.has(c.key)).map((c) => c.key);
}

/** The downloadable template (§7.3.4): the headers and one example row. */
export const IMPORT_TEMPLATE_CSV = `${IMPORT_COLUMNS.map((c) => c.header).join(",")}\r\n${[
  "",
  "Sharma Traders",
  "Sharma Traders Private Limited",
  "Private limited company",
  "AAECS1234K",
  "Registered",
  "29AAECS1234K1Z9",
  "29",
  "BLRS12345A",
  "accounts@sharmatraders.in",
  "98450 12345",
  "98450 12345",
  "12 MG Road",
  "Bengaluru",
  "560001",
  "",
  "Medium",
  "Active",
  "3",
  "45000000",
  "2025-26",
  "",
  "",
  "GST returns; Income tax",
  "",
]
  .map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
  .join(",")}\r\n`;

/** One row of the file after the header mapping: import key → the cell's text. */
export type RawImportRow = Partial<Record<ImportKey, string>>;

/** A row ready for `import_clients` (0113). */
export type ImportClientRow = {
  row: number;
  client_code: string | null;
  display_name: string;
  legal_name: string | null;
  entity_type: EntityType | null;
  entity_type_other: string | null;
  pan: string | null;
  gst_registration: GstRegistration;
  gstin: string | null;
  state_code: string | null;
  tan: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  owner_employee_id: string | null;
  group_id: string | null;
  priority: ClientPriority;
  status: ClientStatus;
  fy_end_month: number;
  annual_turnover: string | null;
  turnover_fy: string | null;
  gst_scheme: GstScheme | null;
  notes: string | null;
  services: Array<{ service_type: ServiceType; frequency: ServiceFrequency }>;
};

export type ImportRowCheck = {
  /** 1-based row number in the file, counting the header as row 1 (as a spreadsheet shows it). */
  row: number;
  name: string;
  /** Set when the row can be imported. */
  value: ImportClientRow | null;
  errors: string[];
  warnings: string[];
};

/** What the database already holds, for the duplicate and owner checks (§7.3.4). */
export type ImportContext = {
  /** Client codes in use (upper-case), recycled clients included. */
  existingCodes: ReadonlySet<string>;
  /** PAN → client code of the client that has it. */
  existingPans: ReadonlyMap<string, string>;
  existingGstins: ReadonlyMap<string, string>;
  /** Active team members by lower-case email. */
  owners: ReadonlyMap<string, { id: string; name: string }>;
  /** Client groups by lower-case name. */
  groups: ReadonlyMap<string, { id: string; name: string }>;
};

const word = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const ENTITY_ALIASES: Record<string, EntityType> = (() => {
  const out: Record<string, EntityType> = {};
  for (const t of ENTITY_TYPES) {
    out[word(t)] = t;
    out[word(ENTITY_TYPE_LABELS[t])] = t;
  }
  Object.assign(out, {
    proprietor: "proprietorship",
    "sole proprietor": "proprietorship",
    "proprietary concern": "proprietorship",
    partnership: "partnership",
    firm: "partnership",
    "partnership firm": "partnership",
    "limited liability partnership": "llp",
    "private limited": "pvt_ltd",
    "pvt ltd": "pvt_ltd",
    "private company": "pvt_ltd",
    "public limited": "public_ltd",
    "public limited company": "public_ltd",
    "public ltd": "public_ltd",
    "section 8": "section_8",
    "section 8 company": "section_8",
    "association of persons": "aop",
    "hindu undivided family": "huf",
    others: "other",
  } satisfies Record<string, EntityType>);
  return out;
})();

const SERVICE_ALIASES: Record<string, ServiceType> = (() => {
  const out: Record<string, ServiceType> = {};
  for (const s of SERVICE_TYPES) {
    out[word(s)] = s;
    out[word(SERVICE_TYPE_LABELS[s])] = s;
  }
  Object.assign(out, {
    gst: "gst",
    "gst return": "gst",
    "gst returns": "gst",
    "income tax return": "income_tax",
    itr: "income_tax",
    tds: "tds",
    tcs: "tds",
    "tds tcs": "tds",
    payroll: "payroll",
    pf: "payroll",
    esic: "payroll",
    accounting: "bookkeeping",
    accounts: "bookkeeping",
    audit: "audit",
    roc: "company_law",
    "company law": "company_law",
    mca: "company_law",
  } satisfies Record<string, ServiceType>);
  return out;
})();

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const DEFAULT_FREQUENCY: Record<ServiceType, ServiceFrequency> = {
  gst: "monthly",
  income_tax: "annual",
  tds: "quarterly",
  payroll: "monthly",
  bookkeeping: "monthly",
  audit: "annual",
  company_law: "annual",
  incorporation: "one_time",
  other: "annual",
};

function stateCodeFrom(v: string): string | null {
  const t = v.trim();
  if (/^\d{1,2}$/.test(t)) {
    const code = t.padStart(2, "0");
    return isValidStateCode(code) ? code : null;
  }
  const w = word(t);
  for (const [code, name] of Object.entries(STATE_CODES)) if (word(name) === w) return code;
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Checks every row of an import file before anything is saved (§7.3.4 "row-level validation
 * report (invalid PAN/GSTIN, duplicate code, unknown owner)"): values, duplicates within the file
 * and against the database (codes, PANs, GSTINs, recycled clients included), the owner and the
 * group. A row with any error is left out ("import valid rows only"); warnings don't stop it.
 */
export function checkImportRows(rows: readonly RawImportRow[], ctx: ImportContext): ImportRowCheck[] {
  const seenCodes = new Map<string, number>();
  const seenPans = new Map<string, number>();
  const seenGstins = new Map<string, number>();
  return rows.map((raw, i) => {
    const row = i + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const get = (k: ImportKey) => (raw[k] ?? "").trim();
    const name = get("display_name").replace(/\s+/g, " ");

    if (name.length < 2) errors.push("The display name is missing (2–120 characters).");
    else if (name.length > 120) errors.push("The display name is longer than 120 characters.");

    // Code
    let code: string | null = null;
    if (get("client_code")) {
      code = normaliseIdentifier(get("client_code"));
      if (!CLIENT_CODE_PATTERN.test(code)) errors.push(`Client code ${code} can use only letters, digits, - and / (2–20 characters).`);
      else if (ctx.existingCodes.has(code)) errors.push(`Client code ${code} is already in use.`);
      else if (seenCodes.has(code)) errors.push(`Client code ${code} is also on row ${seenCodes.get(code)}.`);
      else seenCodes.set(code, row);
    }

    // Entity
    let entity: EntityType | null = null;
    let entityOther: string | null = null;
    if (get("entity_type")) {
      entity = ENTITY_ALIASES[word(get("entity_type"))] ?? null;
      if (!entity) {
        entity = "other";
        entityOther = get("entity_type").slice(0, 80);
        warnings.push(`Entity type "${get("entity_type")}" isn't one of the app's types, so it's saved as Others: ${entityOther}.`);
      }
    }

    // PAN
    let pan: string | null = null;
    if (get("pan")) {
      const r = validatePan(get("pan"), { entityType: entity });
      if (!r.ok) errors.push(`PAN: ${r.error}`);
      else {
        pan = r.value;
        if (r.warning) warnings.push(r.warning);
        const other = ctx.existingPans.get(pan);
        if (other) errors.push(`PAN ${pan} already belongs to client ${other}.`);
        else if (seenPans.has(pan)) errors.push(`PAN ${pan} is also on row ${seenPans.get(pan)}.`);
        else seenPans.set(pan, row);
      }
    }

    // GSTIN and registration
    let gstin: string | null = null;
    let stateFromGstin: string | null = null;
    if (get("gstin")) {
      const r = validateGstin(get("gstin"));
      if (!r.ok) errors.push(`GSTIN: ${r.error}`);
      else {
        gstin = r.value;
        stateFromGstin = r.stateCode;
        const mismatch = gstinPanMismatch(gstin, pan);
        if (mismatch) errors.push(mismatch);
        if (!pan && !mismatch) {
          pan = r.pan;
          const other = ctx.existingPans.get(pan);
          if (other) errors.push(`The PAN in this GSTIN (${pan}) already belongs to client ${other}.`);
        }
        const other = ctx.existingGstins.get(gstin);
        if (other) errors.push(`GSTIN ${gstin} already belongs to client ${other}.`);
        else if (seenGstins.has(gstin)) errors.push(`GSTIN ${gstin} is also on row ${seenGstins.get(gstin)}.`);
        else seenGstins.set(gstin, row);
      }
    }
    let registration: GstRegistration = gstin ? "registered" : "unknown";
    if (get("gst_registration")) {
      const w = word(get("gst_registration"));
      if (["registered", "yes", "y", "regular"].includes(w)) registration = "registered";
      else if (["not registered", "unregistered", "no", "n"].includes(w)) registration = "unregistered";
      else if (["not sure yet", "not sure", "unknown", ""].includes(w)) registration = "unknown";
      else errors.push(`GST registration "${get("gst_registration")}" isn't Registered, Not registered or Not sure yet.`);
    }
    if (registration === "registered" && !gstin && !errors.some((e) => e.startsWith("GSTIN"))) errors.push("A registered client needs a GSTIN.");
    if (registration === "unregistered" && gstin) warnings.push("The row says Not registered but has a GSTIN, so it's saved as Registered.");
    if (gstin) registration = "registered";

    // State
    let state: string | null = stateFromGstin;
    if (get("state_code")) {
      const s = stateCodeFrom(get("state_code"));
      if (!s) errors.push(`State "${get("state_code")}" isn't a GST state code or state name.`);
      else if (stateFromGstin && s !== stateFromGstin) warnings.push(`The state is taken from the GSTIN (${stateFromGstin}), not ${s}.`);
      else state = s;
    }

    // TAN
    let tan: string | null = null;
    if (get("tan")) {
      const r = validateTan(get("tan"));
      if (!r.ok) errors.push(`TAN: ${r.error}`);
      else tan = r.value;
    }

    // Contact
    const email = get("email") || null;
    if (email && !EMAIL_RE.test(email)) errors.push(`Email ${email} isn't a valid address.`);
    let phone: string | null = null;
    if (get("phone")) {
      const r = validateIndianPhone(get("phone"));
      if (!r.ok) errors.push(`Phone: ${r.error}`);
      else phone = r.value;
    }
    let whatsapp: string | null = null;
    if (get("whatsapp")) {
      if (!isWhatsAppNumber(get("whatsapp"))) errors.push(`WhatsApp ${get("whatsapp")} isn't a mobile number WhatsApp can use.`);
      else whatsapp = get("whatsapp");
    }
    let pincode: string | null = null;
    if (get("pincode")) {
      const r = validatePincode(get("pincode"));
      if (!r.ok) errors.push(`Pincode: ${r.error}`);
      else pincode = r.value;
    }

    // Owner and group
    let owner: string | null = null;
    if (get("owner_email")) {
      const o = ctx.owners.get(get("owner_email").toLowerCase());
      if (!o) errors.push(`Unknown owner: ${get("owner_email")} isn't an active member of the team.`);
      else owner = o.id;
    } else {
      warnings.push("No owner: assign one after the import.");
    }
    let group: string | null = null;
    if (get("group")) {
      const g = ctx.groups.get(get("group").toLowerCase());
      if (!g) errors.push(`There's no client group called "${get("group")}". Create it first, or leave the column empty.`);
      else group = g.id;
    }

    // Work
    let priority: ClientPriority = "medium";
    if (get("priority")) {
      const p = word(get("priority")) as ClientPriority;
      if ((CLIENT_PRIORITIES as readonly string[]).includes(p)) priority = p;
      else errors.push(`Priority "${get("priority")}" isn't Low, Medium, High or Critical.`);
    }
    let status: ClientStatus = "active";
    if (get("status")) {
      const w = word(get("status")).replace(/ /g, "_") as ClientStatus;
      if ((CLIENT_STATUSES as readonly string[]).includes(w)) status = w;
      else errors.push(`Status "${get("status")}" isn't Active, Pending, On hold or Inactive.`);
    }

    // Scale
    let fyEnd = 3;
    if (get("fy_end_month")) {
      const t = get("fy_end_month");
      const n = /^\d{1,2}$/.test(t) ? Number(t) : MONTHS.findIndex((m) => m.startsWith(word(t).slice(0, 3)) && word(t).length >= 3) + 1;
      if (n >= 1 && n <= 12) fyEnd = n;
      else errors.push(`FY end month "${t}" isn't 1–12 or a month's name.`);
    }
    let turnover: string | null = null;
    if (get("annual_turnover")) {
      const r = parseAmount(get("annual_turnover"));
      if (!r.ok) errors.push(`Turnover: ${r.error}`);
      else turnover = paiseToDecimalString(r.paise);
    }
    let turnoverFy: string | null = null;
    if (get("turnover_fy")) {
      if (!isFinancialYear(get("turnover_fy"))) errors.push(`Turnover FY "${get("turnover_fy")}" should look like 2025-26.`);
      else turnoverFy = get("turnover_fy");
    }
    if (turnover && !turnoverFy) warnings.push("The turnover has no FY: add it on the client's profile.");
    let scheme: GstScheme | null = null;
    if (get("gst_scheme")) {
      const w = word(get("gst_scheme"));
      if (w === "monthly") scheme = "monthly";
      else if (w === "qrmp" || w === "quarterly") scheme = "qrmp";
      else if (w !== "auto") errors.push(`GST scheme "${get("gst_scheme")}" isn't Monthly or QRMP.`);
    }

    // Services
    const services: ImportClientRow["services"] = [];
    if (get("services")) {
      for (const part of get("services").split(/[;,|]/).map((p) => p.trim()).filter(Boolean)) {
        const s = SERVICE_ALIASES[word(part)];
        if (!s || s === "other") errors.push(`Service "${part}" isn't one the app knows (GST returns, Income tax, TDS/TCS, Payroll, Bookkeeping, Audit, ROC/Company law, Incorporation).`);
        else if (!services.some((x) => x.service_type === s)) {
          services.push({ service_type: s, frequency: s === "gst" && scheme === "qrmp" ? "quarterly" : DEFAULT_FREQUENCY[s] });
        }
      }
    }

    const value: ImportClientRow | null =
      errors.length > 0
        ? null
        : {
            row,
            client_code: code,
            display_name: name,
            legal_name: get("legal_name") || null,
            entity_type: entity,
            entity_type_other: entityOther,
            pan,
            gst_registration: registration,
            gstin,
            state_code: state,
            tan,
            email,
            phone,
            whatsapp,
            address: get("address") || null,
            city: get("city") || null,
            pincode,
            owner_employee_id: owner,
            group_id: group,
            priority,
            status,
            fy_end_month: fyEnd,
            annual_turnover: turnover,
            turnover_fy: turnoverFy,
            gst_scheme: scheme,
            notes: get("notes") ? get("notes").slice(0, 2000) : null,
            services,
          };
    return { row, name: name || `Row ${row}`, value, errors, warnings };
  });
}

/** The values each identifier column holds, for the server's duplicate lookups. */
export function importLookups(rows: readonly RawImportRow[]): { codes: string[]; pans: string[]; gstins: string[] } {
  const codes = new Set<string>();
  const pans = new Set<string>();
  const gstins = new Set<string>();
  for (const r of rows) {
    if (r.client_code?.trim()) codes.add(normaliseIdentifier(r.client_code));
    if (r.pan?.trim()) pans.add(normaliseIdentifier(r.pan));
    if (r.gstin?.trim()) {
      const g = normaliseIdentifier(r.gstin);
      gstins.add(g);
      if (g.length === 15) pans.add(g.slice(2, 12));
    }
  }
  return { codes: [...codes], pans: [...pans], gstins: [...gstins] };
}

const rawCell = z.string().max(2000).optional();
export const ImportRowsSchema = z.object({
  rows: z
    .array(z.object(Object.fromEntries(IMPORT_KEYS.map((k) => [k, rawCell])) as Record<ImportKey, typeof rawCell>))
    .min(1, { error: "The file has no rows to import." })
    .max(IMPORT_MAX_ROWS, { error: `Import at most ${IMPORT_MAX_ROWS.toLocaleString("en-IN")} clients at a time.` }),
  fileName: z.string().max(200).optional(),
});
export type ImportRowsInput = z.input<typeof ImportRowsSchema>;

export { GST_REGISTRATIONS };

// =================================================================================================
// Attaching a collected document to a checklist item (§7.3.2 step 4, §5.8 file rules, §12)
// =================================================================================================

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** The file types the vault takes (§5.8): extension → the MIME type stored. */
export const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  csv: "text/csv",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_TYPES)
  .map((e) => `.${e}`)
  .join(",");

export type AttachmentCheck = { ok: true; ext: string; mime: string } | { ok: false; error: string };

/** Name and size rules, checked in the browser before uploading and on the server again (§5.8). */
export function checkAttachment(file: { name: string; size: number }): AttachmentCheck {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const mime = ATTACHMENT_TYPES[ext];
  if (!file.name.includes(".") || !mime) {
    return { ok: false, error: `${file.name}: only PDF, JPG, PNG, HEIC, CSV, XLS/XLSX and DOC/DOCX files can be kept in the vault.` };
  }
  if (file.size <= 0) return { ok: false, error: `${file.name} is empty.` };
  if (file.size > ATTACHMENT_MAX_BYTES) return { ok: false, error: `${file.name} is larger than 25 MB.` };
  return { ok: true, ext, mime };
}

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);

/**
 * The file's real type from its first bytes (§12 "MIME type checked by magic bytes, not just
 * extension"). The extension must agree with the content; CSV must be text.
 */
export function sniffAttachment(bytes: Uint8Array, ext: string): AttachmentCheck {
  const e = ext.toLowerCase();
  const mime = ATTACHMENT_TYPES[e];
  if (!mime) return { ok: false, error: "This type of file can't be kept in the vault." };
  const isPdf = startsWith(bytes, [0x25, 0x50, 0x44, 0x46]);
  const isPng = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const isJpeg = startsWith(bytes, [0xff, 0xd8, 0xff]);
  const brand = String.fromCharCode(...bytes.slice(4, 12));
  const isHeic = /^ftyp(heic|heix|hevc|heim|heis|mif1|msf1)/.test(brand);
  const isZip = startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
  const isOle = startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const sample = bytes.slice(0, 4096);
  const isText = sample.length > 0 && !sample.includes(0);
  const ok =
    (e === "pdf" && isPdf) ||
    (e === "png" && isPng) ||
    ((e === "jpg" || e === "jpeg") && isJpeg) ||
    (e === "heic" && isHeic) ||
    ((e === "xlsx" || e === "docx") && isZip) ||
    ((e === "xls" || e === "doc") && isOle) ||
    (e === "csv" && isText);
  return ok ? { ok: true, ext: e, mime } : { ok: false, error: `The file's content isn't a real .${e} file, so it wasn't kept.` };
}

export const CHECKLIST_DOCUMENT_CATEGORIES = [
  "gst",
  "tds",
  "roc",
  "audit",
  "income_tax",
  "payroll",
  "bank_statements",
  "invoices",
  "agreements",
  "kyc",
  "engagement",
  "other",
] as const;

export const PrepareAttachmentSchema = z.object({
  clientId: uuid("client"),
  itemId: uuid("checklist item"),
  fileName: z.string().trim().min(1).max(200),
  size: z.number().int().positive(),
});

export const FinishAttachmentSchema = z.object({
  clientId: uuid("client"),
  itemId: uuid("checklist item"),
  path: z.string().min(10).max(200),
  fileName: z.string().trim().min(1).max(200),
  category: z.enum(CHECKLIST_DOCUMENT_CATEGORIES).default("other"),
});
