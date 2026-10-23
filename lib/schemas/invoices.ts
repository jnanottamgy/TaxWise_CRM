import { z } from "zod";
import {
  INVOICE_STATUSES,
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  type InvoiceStatus,
  type ServiceFrequency,
  type ServiceType,
} from "@/lib/domain/enums";
import {
  addDays,
  addMonths,
  compareDates,
  financialYearOf,
  isDateString,
  monthPeriodLabel,
  parsePeriodLabel,
  quarterLabel,
  type DateString,
} from "@/lib/domain/fy";
import { GST_DEFAULTS, invoiceTotals, rule47Warning, type GstParams, type InvoiceTotals, type Rule47Flag } from "@/lib/domain/gst";
import { agreedFeeNote, normalisePeriodLabel } from "@/lib/domain/invoice";
import { formatINR, multiplyPaise, paiseToDecimalString, parseAmount, sumPaise, toPaise, type Paise } from "@/lib/domain/money";

/**
 * Invoices (§7.9.1–§7.9.3): the editor's form values and the server actions' inputs (one zod schema
 * shared by both, CONVENTIONS §5), the list's filters and sorts, and the pure helpers the editor,
 * the detail page and the actions share: totals for the form (lib/domain/gst.ts invoiceTotals, the
 * same rounding as save_invoice_draft), lines from an engagement / unbilled time / a completed task,
 * the agreed-fee note and the Rule 47 warning. Client-safe; no I/O.
 *
 * Money in the form is the rupee string a MoneyInput holds ("12500", "12500.50", "" when empty) and
 * leaves as a decimal string; it is never a float (§0.1 rule 7).
 */

export const INVOICE_LIMITS = {
  lines: 100,
  description: 1000,
  notes: 2000,
  terms: 4000,
  reason: 1000,
  period: 60,
  /** numeric(14,2) */
  maxRupees: 999_999_999_999.99,
  maxQuantity: 99_999_999,
} as const;

/** How an issued invoice reaches the client (invoices.sent_channels). */
export const SEND_CHANNELS = ["email", "whatsapp", "gmail", "in_person"] as const;
export type SendChannel = (typeof SEND_CHANNELS)[number];

export const SEND_CHANNEL_LABEL: Record<SendChannel, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  gmail: "Gmail",
  in_person: "By hand",
};

/** "Email · WhatsApp", or null when it hasn't gone out yet. */
export function sentViaLabel(channels: readonly string[] | null | undefined): string | null {
  const known = (channels ?? []).filter((c): c is SendChannel => (SEND_CHANNELS as readonly string[]).includes(c));
  return known.length ? known.map((c) => SEND_CHANNEL_LABEL[c]).join(" · ") : null;
}

// -------------------------------------------------------------------------------------------------
// The list (§7.9.1)
// -------------------------------------------------------------------------------------------------

/** The status filter: the stored statuses plus the derived Overdue and Cancelled. */
export const INVOICE_STATUS_FILTER_VALUES = [...INVOICE_STATUSES, "overdue", "cancelled"] as const;
export type InvoiceStatusFilter = (typeof INVOICE_STATUS_FILTER_VALUES)[number];

export const INVOICE_LIST_SORTABLE = [
  "invoice_number",
  "issue_date",
  "client",
  "billing_period_label",
  "taxable_amount",
  "gst_amount",
  "total_amount",
  "amount_received",
  "tds_credited",
  "outstanding_amount",
  "due_date",
  "status",
] as const;
export type InvoiceListSort = (typeof INVOICE_LIST_SORTABLE)[number];

export const INVOICE_KINDS = ["tax_invoice", "debit_note"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];
export const INVOICE_KIND_LABEL: Record<InvoiceKind, string> = { tax_invoice: "Tax invoice", debit_note: "Debit note" };

/** Invoice-date presets for the list's date filter (§7.9.1 "date range"); `from` / `to` take exact dates. */
export const INVOICE_DATE_PRESETS = ["this_month", "last_month", "this_quarter", "last_quarter", "last_90_days"] as const;
export type InvoiceDatePreset = (typeof INVOICE_DATE_PRESETS)[number];
export const INVOICE_DATE_PRESET_LABEL: Record<InvoiceDatePreset, string> = {
  this_month: "This month",
  last_month: "Last month",
  this_quarter: "This quarter",
  last_quarter: "Last quarter",
  last_90_days: "Last 90 days",
};

/** The invoice-date range a preset means on a day (quarters are FY quarters: Apr–Jun …). */
export function datePresetRange(preset: InvoiceDatePreset, today: DateString): { from: DateString; to: DateString } {
  const month = today.slice(0, 7);
  const monthStart = `${month}-01`;
  switch (preset) {
    case "this_month":
      return { from: monthStart, to: today };
    case "last_month": {
      const start = addMonths(monthStart, -1);
      return { from: start, to: addDays(monthStart, -1) };
    }
    case "this_quarter":
    case "last_quarter": {
      const m = Number(today.slice(5, 7));
      const offset = (m - 4 + 12) % 3; // months since the quarter began
      const qStart = addMonths(monthStart, -offset);
      if (preset === "this_quarter") return { from: qStart, to: today };
      return { from: addMonths(qStart, -3), to: addDays(qStart, -1) };
    }
    case "last_90_days":
      return { from: addDays(today, -89), to: today };
  }
}

/** Filters read from the URL (parseTableParams). `fy=all` turns the FY filter off. */
export const INVOICE_LIST_FILTERS = {
  status: INVOICE_STATUS_FILTER_VALUES,
  client: null,
  from: null,
  to: null,
  period: INVOICE_DATE_PRESETS,
  fy: null,
  created_by: null,
  kind: INVOICE_KINDS,
} as const;

/** Statuses that are about money still to collect or to decide: a link with one of these shows every year. */
const OPEN_MONEY_FILTERS: readonly string[] = ["draft", "awaiting_approval", "sent", "partially_paid", "disputed", "overdue"];

/**
 * The FY the list is filtered by (§3.3 FY switcher): an explicit `?fy=` wins (`all` = every year);
 * otherwise the top bar's FY, except when the link asks for open money by status (the dashboards'
 * "Outstanding", "Overdue receivables" and "Awaiting approval" count every year, so their lists do).
 */
export function listFinancialYear(param: string | null | undefined, statuses: readonly string[] | undefined, selectedFy: string): string | null {
  if (param === "all") return null;
  if (param && /^\d{4}-\d{2}$/.test(param)) return param;
  if (statuses?.some((s) => OPEN_MONEY_FILTERS.includes(s))) return null;
  return selectedFy;
}

// -------------------------------------------------------------------------------------------------
// Form values
// -------------------------------------------------------------------------------------------------

const uuid = (what: string) => z.uuid({ error: `That ${what} isn't valid.` });
const optionalUuid = z
  .union([z.uuid(), z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));
const trimmed = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep the ${label} under ${max.toLocaleString("en-IN")} characters.` })
    .optional()
    .default("");

/** One invoice line as the editor holds it. */
export const InvoiceLineFormSchema = z.object({
  /** A stable React key; not sent to the database. */
  key: z.string().max(64).optional().default(""),
  description: trimmed(INVOICE_LIMITS.description, "description"),
  service_type: z.union([z.enum(SERVICE_TYPES), z.literal("")]).optional().default(""),
  sac_code: z.string().trim().max(8).optional().default(""),
  quantity: z.union([z.string(), z.number()]).optional().default("1").transform((v) => String(v).trim()),
  rate: z.union([z.string(), z.number()]).optional().default("").transform((v) => String(v).trim()),
  tax_rate: z.union([z.string(), z.number()]).optional().default("18").transform((v) => String(v).trim()),
  tax_rate_reason: trimmed(300, "reason for the rate"),
  is_reimbursement: z.boolean().optional().default(false),
  client_service_id: z.union([z.uuid(), z.literal("")]).optional().default(""),
  source_task_id: z.union([z.uuid(), z.literal("")]).optional().default(""),
  time_entry_ids: z.array(z.uuid()).max(500).optional().default([]),
  /** "From engagement: GST (monthly)" — shown under the line, never sent. */
  source_label: z.string().max(200).optional().default(""),
});
export type InvoiceLineForm = z.input<typeof InvoiceLineFormSchema>;
export type InvoiceLineValues = z.output<typeof InvoiceLineFormSchema>;

export const INVOICE_SAVE_INTENTS = ["autosave", "save", "submit"] as const;
export type InvoiceSaveIntent = (typeof INVOICE_SAVE_INTENTS)[number];

const dateField = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => isDateString(v), { error: `Enter the ${label}, for example 22 Oct 2026.` });

/** The editor's values (§7.9.2). */
export const InvoiceFormSchema = z.object({
  id: optionalUuid,
  updated_at: z.string().nullish().transform((v) => (v ? v : null)),
  client_id: z.string().trim().refine((v) => v === "" || z.uuid().safeParse(v).success, { error: "Choose the client to invoice." }),
  issue_date: dateField("invoice date"),
  due_date: dateField("due date"),
  place_of_supply_code: z.string().trim().max(2).optional().default(""),
  place_of_supply_reason: trimmed(300, "reason"),
  billing_period_label: trimmed(INVOICE_LIMITS.period, "billing period"),
  notes: trimmed(INVOICE_LIMITS.notes, "notes"),
  terms: trimmed(INVOICE_LIMITS.terms, "terms"),
  round_off: z.boolean().optional().default(false),
  lines: z.array(InvoiceLineFormSchema).max(INVOICE_LIMITS.lines, { error: `An invoice can have at most ${INVOICE_LIMITS.lines} lines.` }),
});
export type InvoiceFormInput = z.input<typeof InvoiceFormSchema>;
export type InvoiceFormValues = z.output<typeof InvoiceFormSchema>;

function decimalOk(value: string, maxDecimals: number): boolean {
  return new RegExp(`^\\d+(\\.\\d{0,${maxDecimals}})?$`).test(value);
}

/** True when a line has nothing typed in it yet (autosave leaves it out). */
export function isBlankLine(l: Pick<InvoiceLineValues, "description" | "rate">): boolean {
  return l.description.trim() === "" && (l.rate.trim() === "" || l.rate.trim() === "0");
}

/**
 * The per-line checks (§7.9.2): description, quantity above 0, a rate in rupees and paise (above 0
 * when saving for real), a GST rate as a percentage (0 for reimbursements), SAC 4 or 6 digits from
 * 99 when given. Blank lines are skipped (they aren't saved). Field errors use the form's names
 * ("lines.2.rate").
 */
export function lineIssues(lines: readonly InvoiceLineValues[], strict: boolean): Array<{ path: string; message: string }> {
  const out: Array<{ path: string; message: string }> = [];
  lines.forEach((l, i) => {
    const at = (f: string) => `lines.${i}.${f}`;
    if (isBlankLine(l)) return; // left out of the save (draftPayload)
    if (l.description.trim() === "") out.push({ path: at("description"), message: "Describe the service." });
    const qty = l.quantity === "" ? "1" : l.quantity;
    if (!decimalOk(qty, 2) || Number(qty) <= 0 || Number(qty) > INVOICE_LIMITS.maxQuantity) {
      out.push({ path: at("quantity"), message: "Enter a quantity above 0." });
    }
    const rate = l.rate === "" ? (strict ? null : "0") : l.rate;
    if (rate === null) out.push({ path: at("rate"), message: "Enter the rate." });
    else {
      const parsed = parseAmount(rate);
      if (!parsed.ok) out.push({ path: at("rate"), message: parsed.error });
      else if (parsed.paise > toPaise(INVOICE_LIMITS.maxRupees)) out.push({ path: at("rate"), message: "That rate is too large." });
      else if (strict && parsed.paise === 0) out.push({ path: at("rate"), message: "Enter the rate: a line can't be ₹0.00." });
    }
    if (!l.is_reimbursement && (!/^\d{1,3}(\.\d{1,2})?$/.test(l.tax_rate) || Number(l.tax_rate) > 100)) {
      out.push({ path: at("tax_rate"), message: "Enter the GST rate as a percentage, for example 18." });
    }
    const sac = l.sac_code.replace(/\s+/g, "");
    if (sac !== "" && !/^99\d{2}(\d{2})?$/.test(sac)) out.push({ path: at("sac_code"), message: "4 or 6 digits starting 99." });
  });
  return out;
}

/** The save action's input: the form values and what the person pressed. */
export const SaveInvoiceSchema = InvoiceFormSchema.extend({
  intent: z.enum(INVOICE_SAVE_INTENTS).default("save"),
}).superRefine((v, ctx) => {
  const strict = v.intent !== "autosave";
  if (v.client_id === "") ctx.addIssue({ code: "custom", path: ["client_id"], message: "Choose the client to invoice." });
  if (isDateString(v.issue_date) && isDateString(v.due_date) && compareDates(v.due_date, v.issue_date) < 0) {
    ctx.addIssue({ code: "custom", path: ["due_date"], message: "The due date can't be before the invoice date." });
  }
  if (strict && v.lines.filter((l) => !isBlankLine(l)).length === 0) {
    ctx.addIssue({ code: "custom", path: ["lines"], message: "Add at least one line." });
  }
  for (const issue of lineIssues(v.lines, strict)) {
    ctx.addIssue({ code: "custom", path: issue.path.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)), message: issue.message });
  }
});
export type SaveInvoiceInput = z.input<typeof SaveInvoiceSchema>;
export type SaveInvoiceValues = z.output<typeof SaveInvoiceSchema>;

/** The jsonb save_invoice_draft takes (0151): rupees as decimal strings, blanks left out on autosave. */
export function draftPayload(v: SaveInvoiceValues): Record<string, unknown> {
  const lines = v.lines.filter((l) => !isBlankLine(l));
  return {
    id: v.id,
    updated_at: v.updated_at,
    client_id: v.client_id,
    issue_date: v.issue_date,
    due_date: v.due_date,
    place_of_supply_code: v.place_of_supply_code || null,
    place_of_supply_reason: v.place_of_supply_reason || null,
    billing_period_label: v.billing_period_label || null,
    notes: v.notes || null,
    terms: v.terms || null,
    round_off: v.round_off,
    submit: v.intent === "submit",
    lines: lines.map((l) => ({
      description: l.description,
      service_type: l.service_type || null,
      sac_code: l.sac_code.replace(/\s+/g, "") || null,
      quantity: l.quantity === "" ? "1" : l.quantity,
      rate: l.rate === "" ? "0" : paiseToDecimalString(toPaise(l.rate)),
      tax_rate: l.is_reimbursement ? "0" : l.tax_rate || "18",
      tax_rate_reason: l.tax_rate_reason || null,
      is_reimbursement: l.is_reimbursement,
      client_service_id: l.client_service_id || null,
      source_task_id: l.source_task_id || null,
      time_entry_ids: l.time_entry_ids,
    })),
  };
}

/**
 * The totals of the form as the database will compute them (§6.3, §6.4; the same rounding as
 * save_invoice_draft). Lines that can't be read yet count as ₹0.
 */
export function formTotals(
  lines: ReadonlyArray<Pick<InvoiceLineValues, "quantity" | "rate" | "tax_rate" | "is_reimbursement">>,
  placeOfSupplyCode: string,
  firmStateCode: string,
  roundOff: boolean,
): InvoiceTotals & { linePaise: Paise[] } {
  const inputs = lines.map((l) => {
    const qty = decimalOk(l.quantity || "1", 2) && Number(l.quantity || "1") > 0 ? l.quantity || "1" : "1";
    const rate = parseAmount(l.rate || "0");
    const taxRate = /^\d{1,3}(\.\d{1,2})?$/.test(l.tax_rate) && Number(l.tax_rate) <= 100 ? l.tax_rate : "0";
    return { quantity: qty, ratePaise: rate.ok && rate.paise >= 0 ? rate.paise : 0, taxRate, isReimbursement: l.is_reimbursement };
  });
  const totals = invoiceTotals(inputs, placeOfSupplyCode || firmStateCode, firmStateCode, { roundOff });
  return { ...totals, linePaise: totals.lines.map((l) => l.amountPaise) };
}

/** The due date from the invoice date and the firm's payment terms (§7.9.2 "date + payment terms"). */
export function defaultDueDate(issueDate: DateString, paymentTermsDays: number): DateString {
  return addDays(issueDate, Math.max(0, paymentTermsDays));
}

// -------------------------------------------------------------------------------------------------
// Add from: Engagement · Unbilled time · Completed task (§7.9.2)
// -------------------------------------------------------------------------------------------------

export type EngagementOption = {
  id: string;
  service_type: ServiceType;
  custom_name: string | null;
  frequency: ServiceFrequency;
  billing_frequency: ServiceFrequency | null;
  agreed_fee: number | string | null;
  sac_code: string | null;
  is_active: boolean;
};

export function engagementName(e: Pick<EngagementOption, "service_type" | "custom_name">): string {
  return e.service_type === "other" && e.custom_name ? e.custom_name : SERVICE_TYPE_LABELS[e.service_type];
}

/**
 * The billing periods to offer for an engagement, newest first (§5.5 period labels): the last 6
 * months, the last 4 quarters, or this FY and the last; a one-time service bills for its FY.
 */
export function periodChoices(frequency: ServiceFrequency, today: DateString): string[] {
  const out: string[] = [];
  if (frequency === "monthly") {
    for (let i = 0; i < 6; i += 1) out.push(monthPeriodLabel(addMonths(today, -i)));
  } else if (frequency === "quarterly") {
    for (let i = 0; i < 4; i += 1) out.push(quarterLabel(addMonths(today, -3 * i)));
  } else {
    out.push(`FY ${financialYearOf(today)}`, `FY ${financialYearOf(addMonths(today, -12))}`);
  }
  return [...new Set(out)];
}

/** One line for an engagement's agreed fee for a period (§7.9.2 "Add from: Engagement"). */
export function engagementLine(e: EngagementOption, period: string, sacFallback: string): InvoiceLineValues {
  const fee = e.agreed_fee === null || e.agreed_fee === "" ? "" : paiseToDecimalString(toPaise(e.agreed_fee));
  return {
    key: `eng-${e.id}-${period}`,
    description: `${engagementName(e)} for ${period}`,
    service_type: e.service_type,
    sac_code: e.sac_code ?? sacFallback,
    quantity: "1",
    rate: fee,
    tax_rate: String(GST_DEFAULTS.defaultRateServices),
    tax_rate_reason: "",
    is_reimbursement: false,
    client_service_id: e.id,
    source_task_id: "",
    time_entry_ids: [],
    source_label: `From the engagement: ${engagementName(e)} (agreed fee)`,
  };
}

export type UnbilledEntry = {
  id: string;
  task_id: string | null;
  task_number: string | null;
  task_title: string | null;
  employee_name: string;
  started_at: string;
  minutes: number;
  billing_rate_per_hour: number | string | null;
  amount: number | string | null;
};

/** "3 h 30 min", "45 min" */
export function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * Lines from picked unbilled time (§7.9.2 "billed at each employee's rate, grouped by task"): one
 * line per task (time without a task together), its amount the sum of each entry's value (minutes ×
 * the person's billing rate ÷ 60, half-up per entry, as unbilled_time_entries computes it). Entries
 * without a billing rate can't be priced and are returned separately.
 */
export function unbilledTimeLines(
  entries: readonly UnbilledEntry[],
  opts: { serviceType?: ServiceType | null; sac: string },
): { lines: InvoiceLineValues[]; unrated: UnbilledEntry[] } {
  const rated = entries.filter((e) => e.amount !== null && e.amount !== "" && e.billing_rate_per_hour !== null);
  const unrated = entries.filter((e) => !rated.includes(e));
  const groups = new Map<string, UnbilledEntry[]>();
  for (const e of rated) {
    const k = e.task_id ?? "none";
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const lines: InvoiceLineValues[] = [];
  for (const [k, list] of groups) {
    const minutes = list.reduce((n, e) => n + e.minutes, 0);
    const amountPaise = sumPaise(list.map((e) => toPaise(e.amount as number | string)));
    const first = list[0];
    const what = k === "none" ? "other work" : (first.task_title ?? "a task");
    lines.push({
      key: `time-${k}`,
      description: `Professional time: ${what} (${hoursLabel(minutes)})`,
      service_type: opts.serviceType ?? "",
      sac_code: opts.sac,
      quantity: "1",
      rate: paiseToDecimalString(amountPaise),
      tax_rate: String(GST_DEFAULTS.defaultRateServices),
      tax_rate_reason: "",
      is_reimbursement: false,
      client_service_id: "",
      source_task_id: k === "none" ? "" : k,
      time_entry_ids: list.map((e) => e.id),
      source_label: `From unbilled time: ${list.length} ${list.length === 1 ? "entry" : "entries"}, ${[...new Set(list.map((e) => e.employee_name))].join(", ")}`,
    });
  }
  return { lines, unrated };
}

export type CompletedTaskOption = {
  id: string;
  task_number: string;
  title: string;
  service_type: ServiceType | null;
  period_label: string | null;
  completion_date: string | null;
};

/** One line for a completed task (§7.9.2 "Add from: Completed task"): the rate is left to type. */
export function completedTaskLine(t: CompletedTaskOption, sac: string): InvoiceLineValues {
  return {
    key: `task-${t.id}`,
    description: t.period_label ? `${t.title} (${t.period_label})` : t.title,
    service_type: t.service_type ?? "",
    sac_code: sac,
    quantity: "1",
    rate: "",
    tax_rate: String(GST_DEFAULTS.defaultRateServices),
    tax_rate_reason: "",
    is_reimbursement: false,
    client_service_id: "",
    source_task_id: t.id,
    time_entry_ids: [],
    source_label: `From the completed task ${t.task_number}`,
  };
}

/** The SAC for a service from the firm's map (§6.4 "SAC auto from the service map"). */
export function sacForService(serviceType: string | null | undefined, sacByService: Record<string, string> | null | undefined, defaultSac: string): string {
  const mapped = serviceType ? sacByService?.[serviceType] : undefined;
  return (mapped && /^99\d{2}(\d{2})?$/.test(mapped) ? mapped : defaultSac) || "9982";
}

// -------------------------------------------------------------------------------------------------
// Checks the editor shows (§7.9.2)
// -------------------------------------------------------------------------------------------------

/** "Agreed ₹X; invoicing ₹Y" for each engagement line whose amount differs from the agreed fee. */
export function agreedFeeNotes(
  lines: ReadonlyArray<Pick<InvoiceLineValues, "client_service_id" | "quantity" | "rate">>,
  engagements: ReadonlyArray<Pick<EngagementOption, "id" | "agreed_fee" | "service_type" | "custom_name">>,
): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (!l.client_service_id) continue;
    const e = engagements.find((x) => x.id === l.client_service_id);
    if (!e || e.agreed_fee === null || e.agreed_fee === "") continue;
    const rate = parseAmount(l.rate || "0");
    if (!rate.ok) continue;
    const qty = l.quantity || "1";
    const invoiced = decimalOk(qty, 2) && Number(qty) > 0 ? multiplyPaise(rate.paise, qty) : rate.paise;
    const note = agreedFeeNote(toPaise(e.agreed_fee), invoiced);
    if (note) out.push(`${engagementName(e)}: ${note}`);
  }
  return out;
}

/** The last day of a billing period label ("Sep 2026" → 30 Sep 2026), or null. */
export function periodEnd(label: string | null | undefined): DateString | null {
  if (!label) return null;
  return parsePeriodLabel(label.replace(/^\s+|\s+$/g, "").replace(/\s+/g, " "))?.end ?? null;
}

/**
 * The Rule 47 warning for the work on the invoice (§6.4, §7.9.2 "work completed more than 30 days
 * ago"): the oldest completion among the completed tasks on it and the end of its billing period,
 * against the invoice date. Null when there's nothing to warn about.
 */
export function workRule47Warning(
  input: { periodLabel?: string | null; taskCompletionDates?: ReadonlyArray<string | null>; invoiceDate: DateString },
  params: Pick<GstParams, "invoiceIssueDays" | "unbilledFlagDays"> = GST_DEFAULTS,
): Rule47Flag | null {
  const dates: DateString[] = [];
  const end = periodEnd(input.periodLabel);
  if (end) dates.push(end);
  for (const d of input.taskCompletionDates ?? []) if (d) dates.push(d.slice(0, 10));
  const valid = dates.filter((d) => isDateString(d) && compareDates(d, input.invoiceDate) <= 0).sort(compareDates);
  if (!valid.length) return null;
  const flag = rule47Warning(valid[0], input.invoiceDate, params);
  return flag && flag.level === "late" ? flag : null;
}

export type BilledPeriod = { client_service_id: string; billing_period_label: string; invoice_id: string; invoice_number: string | null };

/**
 * The invoice that already bills an engagement on the form for the form's period (§7.9.2 "block with
 * a link"), or null. Normalised labels ("sep 2026" = "Sep 2026").
 */
export function duplicatePeriodOnForm(
  form: { id: string | null; billing_period_label: string; lines: ReadonlyArray<Pick<InvoiceLineValues, "client_service_id">> },
  billed: readonly BilledPeriod[],
): BilledPeriod | null {
  const label = form.billing_period_label.trim();
  if (!label) return null;
  const ids = new Set(form.lines.map((l) => l.client_service_id).filter(Boolean));
  if (!ids.size) return null;
  const key = normalisePeriodLabel(label);
  return billed.find((b) => b.invoice_id !== form.id && ids.has(b.client_service_id) && normalisePeriodLabel(b.billing_period_label) === key) ?? null;
}

// -------------------------------------------------------------------------------------------------
// Lifecycle actions (§7.9.2, §7.9.3)
// -------------------------------------------------------------------------------------------------

const updatedAt = z.string().min(1, { error: "Reload the invoice and try again." });
const reason = (label: string) =>
  z
    .string()
    .trim()
    .min(1, { error: label })
    .max(INVOICE_LIMITS.reason, { error: `Keep it under ${INVOICE_LIMITS.reason.toLocaleString("en-IN")} characters.` });

export const InvoiceRefSchema = z.object({ invoiceId: uuid("invoice"), updatedAt });
export type InvoiceRefInput = z.input<typeof InvoiceRefSchema>;

export const ReturnInvoiceSchema = InvoiceRefSchema.extend({ note: reason("Write a note for the person who raised it: what should change?") });
export const CancelReissueSchema = InvoiceRefSchema.extend({ reason: reason("Say why the invoice is being cancelled.") });
export const DisputeSchema = InvoiceRefSchema.extend({ reason: reason("Say what the client disputes.") });
export const WaiveSchema = InvoiceRefSchema.extend({ reason: reason("Say why the invoice is being waived.") });
export const DebitNoteSchema = z.object({ invoiceId: uuid("invoice"), reason: reason("Say what the debit note is for.") });

const emailList = z
  .array(z.email({ error: "Enter a valid email address." }))
  .min(1, { error: "Choose at least one email address." })
  .max(10, { error: "Send to at most 10 addresses." });

/** The email part of Issue / Send again: who it goes to, a covering note, and a one-time key. */
export const InvoiceEmailSchema = z.object({
  to: emailList,
  cc: z
    .string()
    .trim()
    .max(320)
    .optional()
    .default("")
    .refine((v) => v === "" || z.email().safeParse(v).success, { error: "Enter a valid email address." }),
  contactId: optionalUuid,
  note: trimmed(1000, "note"),
  /** One per dialog: the same click never sends twice (§13 idempotency). */
  nonce: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, { error: "Reload the page and try again." }),
});

export const IssueInvoiceSchema = InvoiceRefSchema.extend({
  channel: z.enum(SEND_CHANNELS),
  email: InvoiceEmailSchema.nullish().transform((v) => v ?? null),
}).superRefine((v, ctx) => {
  if (v.channel === "email" && !v.email) ctx.addIssue({ code: "custom", path: ["email", "to"], message: "Choose who the invoice goes to." });
});
export type IssueInvoiceInput = z.input<typeof IssueInvoiceSchema>;

export const SendInvoiceEmailSchema = InvoiceEmailSchema.extend({ invoiceId: uuid("invoice") });
export type SendInvoiceEmailInput = z.input<typeof SendInvoiceEmailSchema>;

export const InvoiceHandoffSchema = z.object({
  invoiceId: uuid("invoice"),
  channel: z.enum(["whatsapp_handoff", "gmail_handoff"]),
  contactId: optionalUuid,
  recipient: z.string().trim().min(1, { error: "There's no recipient." }).max(320),
  subject: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .transform((v) => (v ? v : null)),
  body: z.string().trim().min(1, { error: "The message is empty." }).max(10_000),
});
export type InvoiceHandoffInput = z.input<typeof InvoiceHandoffSchema>;

export const EInvoiceSchema = InvoiceRefSchema.extend({
  irn: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .default("")
    .refine((v) => v === "" || /^[0-9a-f]{64}$/.test(v), { error: "The IRN is the 64-character code the IRP returns." }),
  ackNo: z
    .string()
    .trim()
    .optional()
    .default("")
    .refine((v) => v === "" || /^\d{10,20}$/.test(v), { error: "The acknowledgement number has 10 to 20 digits." }),
  ackDate: z
    .string()
    .trim()
    .optional()
    .default("")
    .refine((v) => v === "" || isDateString(v), { error: "Enter the acknowledgement date." }),
  signedQr: z.string().trim().max(4000, { error: "The signed QR text is too long." }).optional().default(""),
});
export type EInvoiceInput = z.input<typeof EInvoiceSchema>;

export const ClientSearchSchema = z.object({ q: z.string().trim().max(100).default("") });
export const ClientContextSchema = z.object({ clientId: uuid("client"), invoiceId: optionalUuid });

/** Which actions an invoice offers, by its state and the viewer's role (§4.1, §7.9.3). */
export type InvoiceActionState = {
  status: InvoiceStatus;
  cancelled: boolean;
  invoiceKind: InvoiceKind;
  requiresApproval: boolean;
  approved: boolean;
  outstandingPaise: Paise;
  /** The invoice's month is already in TaxWise's filed GSTR-1. */
  reported: boolean;
  hasLiveReceipts: boolean;
  hasCreditNotes: boolean;
  hasDebitNotes: boolean;
};

export type InvoiceActions = {
  edit: boolean;
  deleteDraft: boolean;
  submitForApproval: boolean;
  approve: boolean;
  returnToRaiser: boolean;
  issue: boolean;
  sendAgain: boolean;
  recordReceipt: boolean;
  creditNote: boolean;
  debitNote: boolean;
  cancelReissue: boolean;
  /** Why cancel & reissue isn't offered for an issued invoice, when it isn't. */
  cancelReissueBlocked: string | null;
  dispute: boolean;
  resolveDispute: boolean;
  waive: boolean;
};

export function invoiceActions(s: InvoiceActionState, role: "partner" | "manager"): InvoiceActions {
  const unissued = s.status === "draft" || s.status === "awaiting_approval";
  const issued = !unissued && !s.cancelled;
  const isPartner = role === "partner";
  const gated = s.requiresApproval && !s.approved;
  const open = issued && (s.status === "sent" || s.status === "partially_paid" || s.status === "disputed");
  let cancelReissueBlocked: string | null = null;
  if (issued && s.status !== "waived") {
    if (s.reported) cancelReissueBlocked = "Its month is already reported in TaxWise's GSTR-1. Use a credit note or a debit note.";
    else if (s.hasLiveReceipts) cancelReissueBlocked = "Payments are recorded against it. Reverse them first.";
    else if (s.hasCreditNotes) cancelReissueBlocked = "A credit note has been issued against it.";
    else if (s.hasDebitNotes) cancelReissueBlocked = "A debit note has been raised against it.";
  }
  return {
    edit: unissued && !s.cancelled,
    deleteDraft: unissued && !s.cancelled,
    submitForApproval: s.status === "draft" && gated && !isPartner,
    approve: isPartner && s.status === "awaiting_approval",
    returnToRaiser: isPartner && s.status === "awaiting_approval",
    issue: s.status === "draft" && !s.cancelled && (!gated || isPartner),
    sendAgain: issued && s.status !== "waived",
    recordReceipt: open && s.outstandingPaise > 0,
    creditNote: isPartner && issued && s.status !== "waived",
    debitNote: issued && s.invoiceKind === "tax_invoice" && s.status !== "waived",
    cancelReissue: issued && s.status !== "waived" && cancelReissueBlocked === null,
    cancelReissueBlocked,
    dispute: issued && (s.status === "sent" || s.status === "partially_paid"),
    resolveDispute: issued && s.status === "disputed",
    waive: isPartner && open && s.outstandingPaise > 0,
  };
}

/** True when the invoice's month is in TaxWise's filed GSTR-1 (firm_settings.last_gstr1_reported_month, 'YYYY-MM'). */
export function isReportedInGstr1(issueDate: DateString, lastReportedMonth: string | null | undefined): boolean {
  const m = lastReportedMonth?.trim() ?? "";
  if (!/^\d{4}-\d{2}$/.test(m)) return false;
  return issueDate.slice(0, 7) <= m;
}

// -------------------------------------------------------------------------------------------------
// Export of the current view (§3.4 "CSV export of the current view", §11)
// -------------------------------------------------------------------------------------------------

export const ExportInvoicesSchema = z.object({
  /** The list's search params (search, filters, sort), without paging. */
  query: z.string().max(4000).default(""),
  format: z.enum(["csv", "xlsx"]).default("csv"),
});
export type ExportInvoicesInput = z.input<typeof ExportInvoicesSchema>;

/** At most this many rows per export; narrow the filters for more. */
export const INVOICE_EXPORT_MAX_ROWS = 5000;

export type InvoiceExportRow = {
  invoice_number: string | null;
  invoice_kind: string;
  issue_date: string;
  due_date: string;
  client_code: string;
  client_name: string;
  billing_period_label: string | null;
  taxable_amount: number | string;
  cgst_amount: number | string;
  sgst_amount: number | string;
  igst_amount: number | string;
  reimbursement_amount: number | string;
  round_off: number | string;
  total_amount: number | string;
  amount_received: number | string;
  tds_credited: number | string;
  credit_noted: number | string;
  outstanding_amount: number | string;
  status: string;
  display_status: string;
  sent_channels: string[] | null;
  created_by_name: string | null;
};

const EXPORT_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  awaiting_approval: "Awaiting approval",
  sent: "Sent",
  partially_paid: "Partially paid",
  paid: "Paid",
  overdue: "Overdue",
  disputed: "Disputed",
  waived: "Waived",
  cancelled: "Cancelled",
};

/** The export's header and rows: amounts as plain decimals (₹, two places), dates as YYYY-MM-DD. */
export function invoiceExportTable(rows: readonly InvoiceExportRow[]): { header: string[]; rows: string[][] } {
  const amount = (v: number | string) => paiseToDecimalString(toPaise(v));
  const header = [
    "Number",
    "Type",
    "Invoice date",
    "Due date",
    "Client code",
    "Client",
    "Period",
    "Taxable value (₹)",
    "CGST (₹)",
    "SGST (₹)",
    "IGST (₹)",
    "Reimbursements (₹)",
    "Round-off (₹)",
    "Total (₹)",
    "Received (₹)",
    "TDS (₹)",
    "Credit notes (₹)",
    "Outstanding (₹)",
    "Status",
    "Sent via",
    "Created by",
  ];
  return {
    header,
    rows: rows.map((r) => [
      r.invoice_number ?? "Draft",
      INVOICE_KIND_LABEL[r.invoice_kind as InvoiceKind] ?? r.invoice_kind,
      r.issue_date,
      r.due_date,
      r.client_code,
      r.client_name,
      r.billing_period_label ?? "",
      amount(r.taxable_amount),
      amount(r.cgst_amount),
      amount(r.sgst_amount),
      amount(r.igst_amount),
      amount(r.reimbursement_amount),
      amount(r.round_off),
      amount(r.total_amount),
      amount(r.amount_received),
      amount(r.tds_credited),
      amount(r.credit_noted),
      r.display_status === "cancelled" || r.status === "draft" || r.status === "awaiting_approval" ? "" : amount(r.outstanding_amount),
      EXPORT_STATUS_LABEL[r.display_status] ?? r.display_status,
      sentViaLabel(r.sent_channels) ?? "",
      r.created_by_name ?? "",
    ]),
  };
}

/** RFC 4180 CSV with a BOM so Excel reads ₹ and Indian names correctly. Formula-like cells are quoted with a leading apostrophe. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const cell = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return `﻿${[header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

// -------------------------------------------------------------------------------------------------
// The WhatsApp and Gmail hand-off drafts (§7.13.2 "Invoice: amount, due date, portal link, UPI pay
// link"; §7.13.3 a link in the body, never an attachment; §10 subject "TaxWise Consultants | Invoice …")
// -------------------------------------------------------------------------------------------------

export type InvoiceShareInput = {
  contactName: string | null;
  clientName: string;
  invoiceNumber: string;
  periodLabel: string | null;
  totalPaise: Paise;
  /** What is still to pay; the total when nothing is received yet. */
  duePaise: Paise;
  dueDate: DateString;
  portalUrl: string;
  /** upi://pay… with the amount due, or null without a UPI ID. */
  upiUrl: string | null;
  firmName: string;
  senderName: string | null;
  bank?: { accountName: string | null; accountNumber: string | null; ifsc: string | null; bankName: string | null } | null;
};

function day(date: DateString): string {
  const [y, m, d] = date.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d).padStart(2, "0")} ${months[m - 1]} ${y}`;
}

export function invoiceShareText(i: InvoiceShareInput): { whatsapp: string; subject: string; emailBody: string } {
  const hi = i.contactName?.trim() ? `Hi ${i.contactName.trim().split(/\s+/)[0]}` : "Hello";
  const what = `invoice ${i.invoiceNumber}${i.periodLabel ? ` for ${i.periodLabel}` : ""}`;
  const amount = formatINR(i.duePaise);
  const partly = i.duePaise !== i.totalPaise;
  const lines = [
    `${hi}, please find ${what} from ${i.firmName}: ${amount}${partly ? " still to pay" : ""}, due by ${day(i.dueDate)}.`,
    "",
    `View and pay: ${i.portalUrl}`,
    ...(i.upiUrl ? [`Pay by UPI: ${i.upiUrl}`] : []),
    "",
    "Please quote the invoice number with your payment. Thank you.",
  ];
  const bank = i.bank && (i.bank.accountNumber || i.bank.ifsc)
    ? [
        "",
        "Bank transfer:",
        ...(i.bank.accountName ? [`Account name: ${i.bank.accountName}`] : []),
        ...(i.bank.accountNumber ? [`Account number: ${i.bank.accountNumber}`] : []),
        ...(i.bank.ifsc ? [`IFSC: ${i.bank.ifsc}`] : []),
        ...(i.bank.bankName ? [`Bank: ${i.bank.bankName}`] : []),
      ]
    : [];
  const greeting = i.contactName?.trim() ? `Dear ${i.contactName.trim().split(/\s+/)[0]},` : "Hello,";
  const emailBody = [
    greeting,
    "",
    `Please find our ${what} to ${i.clientName}: ${amount}${partly ? " still to pay" : ""}, due by ${day(i.dueDate)}.`,
    "",
    `You can view the invoice, download the PDF and pay here: ${i.portalUrl}`,
    ...bank,
    "",
    "Please quote the invoice number with your payment. If you deduct TDS, kindly send us the TDS certificate when it is issued.",
    "",
    "Regards,",
    ...(i.senderName ? [i.senderName] : []),
    i.firmName,
  ].join("\n");
  return {
    whatsapp: lines.join("\n"),
    subject: `${i.firmName} | Invoice ${i.invoiceNumber}${i.periodLabel ? ` for ${i.periodLabel}` : ""}`,
    emailBody,
  };
}
