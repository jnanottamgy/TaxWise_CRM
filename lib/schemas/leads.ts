import { z } from "zod";
import { LEAD_SOURCES, LEAD_STATUSES, SERVICE_TYPES, SERVICE_TYPE_LABELS, type LeadStatus, type ServiceType } from "@/lib/domain/enums";
import { normalizeWhatsAppNumber } from "@/lib/domain/messaging";
import { parseAmount } from "@/lib/domain/money";
import { CALL_KINDS } from "@/lib/handoff";

/**
 * Leads (§7.5.1): the lead form, stage moves (a reason is required for Lost), calls and notes,
 * hand-offs, the list's filters and sorts, and the pure rules the board and the jobs share.
 * Client-safe: forms and server actions parse with the same schemas.
 */

// =================================================================================================
// Vocabulary
// =================================================================================================

/** Stages a lead is still being worked in (Won and Lost close it). */
export const OPEN_LEAD_STATUSES = LEAD_STATUSES.filter((s): s is Exclude<LeadStatus, "won" | "lost"> => s !== "won" && s !== "lost");

export function isClosedLeadStatus(s: LeadStatus): s is "won" | "lost" {
  return s === "won" || s === "lost";
}

/** Why a lead was lost (leads.lost_category, 0142): the win/loss analysis groups by these. */
export const LOST_CATEGORIES = ["fees", "competitor", "no_response", "not_a_fit", "timing", "in_house", "other"] as const;
export type LostCategory = (typeof LOST_CATEGORIES)[number];

export const LOST_CATEGORY_LABELS: Record<LostCategory, string> = {
  fees: "Fees too high",
  competitor: "Chose another firm",
  no_response: "Stopped responding",
  not_a_fit: "Not work we take on",
  timing: "Not now (timing)",
  in_house: "Doing it in-house",
  other: "Other reason",
};

export function lostCategoryLabel(c: string | null | undefined): string {
  return c && (LOST_CATEGORIES as readonly string[]).includes(c) ? LOST_CATEGORY_LABELS[c as LostCategory] : "Other reason";
}

/** Days without a call, note, stage change or quotation before an open lead counts as untouched (§7.5.1, §7.2). */
export const STALE_LEAD_DAYS = 14;

// =================================================================================================
// Field helpers
// =================================================================================================

const text = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep ${label} under ${max.toLocaleString("en-IN")} characters.` })
    .default("");

const PHONE = /^\+?[0-9][0-9 ()-]{5,22}$/;

/** True for something that looks like a phone number: 8–15 digits, with spaces, dashes or brackets allowed. */
export function isPlausiblePhone(value: string): boolean {
  const v = value.trim();
  if (!PHONE.test(v)) return false;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15;
}

/** A person picked from a list, or nobody ("" / "none" / null). */
const optionalUuid = z
  .union([z.uuid({ error: "Choose someone from the list." }), z.literal(""), z.literal("none"), z.null()])
  .optional()
  .transform((v) => (v && v !== "none" ? v : null));

/** An ISO date-time (with offset) or empty: the next follow-up. */
const optionalDateTime = z
  .union([z.iso.datetime({ offset: true, error: "Enter a valid date and time." }), z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

/** A rupee amount typed into the form ("1,20,000"), or empty. Kept as the decimal string a numeric column takes. */
const optionalAmount = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === null || v === undefined) return null;
    const raw = String(v).trim();
    if (raw === "") return null;
    const parsed = parseAmount(raw);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: parsed.error });
      return z.NEVER;
    }
    if (parsed.paise > 99_99_99_99_999_99) {
      ctx.addIssue({ code: "custom", message: "That amount is too large." });
      return z.NEVER;
    }
    return (parsed.paise / 100).toFixed(2);
  });

// =================================================================================================
// The lead form
// =================================================================================================

export const CONTACT_METHOD_MESSAGE = "Add an email, phone or WhatsApp number: at least one way to reach them.";

const LeadFields = z.object({
  name: z.string().trim().min(2, { error: "Enter the person's name." }).max(120, { error: "Keep the name under 120 characters." }),
  company: text(160, "the company name"),
  email: z
    .string()
    .trim()
    .max(254)
    .default("")
    .refine((v) => v === "" || z.email().safeParse(v).success, { error: "Enter a valid email address, like name@company.in." }),
  phone: z
    .string()
    .trim()
    .max(24)
    .default("")
    .refine((v) => v === "" || isPlausiblePhone(v), { error: "Enter a phone number with 10 digits (or the full number with its code)." }),
  whatsapp: z
    .string()
    .trim()
    .max(24)
    .default("")
    .refine((v) => v === "" || normalizeWhatsAppNumber(v) !== null, { error: "That isn't a WhatsApp number: use a 10-digit mobile, or +country code and number." }),
  services_required: z
    .array(z.enum(SERVICE_TYPES))
    .max(SERVICE_TYPES.length)
    .default([])
    .transform((v) => [...new Set(v)]),
  requirement_notes: text(4000, "the notes"),
  source: z.enum(LEAD_SOURCES, { error: "Choose where the lead came from." }),
  source_detail: text(200, "the referral detail"),
  estimated_value: optionalAmount,
  assigned_to: optionalUuid,
  next_follow_up_at: optionalDateTime,
  status: z.enum(OPEN_LEAD_STATUSES, { error: "Choose a stage. Won and Lost are set from the board or the lead's page." }).default("new_lead"),
});

function contactRule<T extends { email: string; phone: string; whatsapp: string }>(v: T, ctx: z.RefinementCtx) {
  if (!v.email && !v.phone && !v.whatsapp) {
    for (const path of ["email", "phone", "whatsapp"] as const) ctx.addIssue({ code: "custom", path: [path], message: CONTACT_METHOD_MESSAGE });
  }
}

export const LeadFormSchema = LeadFields.superRefine(contactRule);
export type LeadFormValues = z.input<typeof LeadFormSchema>;
export type LeadFormData = z.output<typeof LeadFormSchema>;

export const UpdateLeadSchema = LeadFields.extend({
  id: z.uuid({ error: "That lead isn't valid." }),
  /** The row's updated_at when the form opened (§13). */
  updatedAt: z.string().min(1),
}).superRefine(contactRule);
export type UpdateLeadInput = z.input<typeof UpdateLeadSchema>;

export function emptyLeadValues(over: Partial<LeadFormValues> = {}): LeadFormValues {
  return {
    name: "",
    company: "",
    email: "",
    phone: "",
    whatsapp: "",
    services_required: [],
    requirement_notes: "",
    source: "referral",
    source_detail: "",
    estimated_value: "",
    assigned_to: "",
    next_follow_up_at: "",
    status: "new_lead",
    ...over,
  };
}

// =================================================================================================
// Stage moves (board drag, Mark lost, reopen)
// =================================================================================================

export const MoveLeadSchema = z
  .object({
    id: z.uuid({ error: "That lead isn't valid." }),
    to: z.enum(LEAD_STATUSES),
    updatedAt: z.string().min(1),
    lostCategory: z.union([z.enum(LOST_CATEGORIES), z.literal(""), z.null()]).optional().transform((v) => (v ? v : null)),
    lostReason: z.string().trim().max(1000, { error: "Keep the reason under 1,000 characters." }).default(""),
  })
  .superRefine((v, ctx) => {
    if (v.to !== "lost") return;
    if (!v.lostCategory) ctx.addIssue({ code: "custom", path: ["lostCategory"], message: "Choose why the lead was lost." });
    if (v.lostReason.length < 3) ctx.addIssue({ code: "custom", path: ["lostReason"], message: "Say briefly what happened, for the win/loss review." });
  });
export type MoveLeadInput = z.input<typeof MoveLeadSchema>;

export type LeadMoveCheck = { ok: true; requiresReason: boolean } | { ok: false; error: string };

/**
 * Whether a lead may move to a stage from the board or its page (§7.5.1): any stage to any other,
 * a reason required for Lost; a lead converted to a client stays Won.
 */
export function leadMoveCheck(lead: { status: LeadStatus; converted_client_id: string | null }, to: LeadStatus): LeadMoveCheck {
  if (lead.status === to) return { ok: false, error: "It's already at that stage." };
  if (lead.converted_client_id && to !== "won") return { ok: false, error: "This lead has become a client, so it stays Won." };
  return { ok: true, requiresReason: to === "lost" };
}

/** "Stage: Contacted → Proposal sent" style label pieces for history. */
export function stageMoveTitle(fromLabel: string, toLabel: string): string {
  return `Stage moved from ${fromLabel} to ${toLabel}`;
}

// =================================================================================================
// Calls, notes and hand-offs on a lead (its timeline: §7.5.1 "timeline (calls, notes, stage changes, quotations)")
// =================================================================================================

export const LeadNoteSchema = z.object({
  leadId: z.uuid({ error: "That lead isn't valid." }),
  kind: z.enum(CALL_KINDS).default("call_out"),
  occurredAt: z
    .union([z.iso.datetime({ offset: true, error: "Enter a valid date and time." }), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || Date.parse(v) <= Date.now() + 5 * 60_000, { error: "A call can't be logged in the future." }),
  subject: z.string().trim().max(200, { error: "Keep the summary under 200 characters." }).default(""),
  body: z.string().trim().min(1, { error: "Write what was discussed." }).max(5000, { error: "Keep the note under 5,000 characters." }),
  /** Also set the next follow-up while logging the call. */
  nextFollowUpAt: optionalDateTime,
});
export type LeadNoteInput = z.input<typeof LeadNoteSchema>;

export const LeadHandoffSchema = z.object({
  leadId: z.uuid({ error: "That lead isn't valid." }),
  channel: z.enum(["whatsapp_handoff", "gmail_handoff"]),
  recipient: z.string().trim().min(1, { error: "There's no recipient." }).max(320),
  subject: z.string().trim().max(300).default(""),
  body: z.string().trim().min(1, { error: "The message is empty." }).max(10_000, { error: "The message is too long to log." }),
});
export type LeadHandoffInput = z.input<typeof LeadHandoffSchema>;

export const LeadRefSchema = z.object({ id: z.uuid({ error: "That lead isn't valid." }), updatedAt: z.string().min(1) });

export const LeadFollowUpSchema = z.object({
  id: z.uuid({ error: "That lead isn't valid." }),
  updatedAt: z.string().min(1),
  nextFollowUpAt: optionalDateTime,
});

// =================================================================================================
// The list (§2.3: filters, sort and search in SQL; table state in the URL)
// =================================================================================================

export const LEAD_VIEWS = ["board", "table", "analytics"] as const;
export type LeadView = (typeof LEAD_VIEWS)[number];

export function parseLeadView(v: string | string[] | undefined): LeadView {
  const one = Array.isArray(v) ? v[0] : v;
  return (LEAD_VIEWS as readonly string[]).includes(one ?? "") ? (one as LeadView) : "board";
}

export const LEAD_SORTABLE = ["name", "lead_number", "status", "source", "estimated_value", "next_follow_up_at", "last_activity_at", "created_at", "assigned_name"] as const;
export type LeadSort = (typeof LEAD_SORTABLE)[number];

export const LEAD_FLAGS = ["stale", "follow_up_due", "unassigned", "with_quotation"] as const;
export type LeadFlag = (typeof LEAD_FLAGS)[number];

export const LEAD_FLAG_LABELS: Record<LeadFlag, string> = {
  stale: `Untouched for ${STALE_LEAD_DAYS}+ days`,
  follow_up_due: "Follow-up due",
  unassigned: "Not assigned",
  with_quotation: "Has an open quotation",
};

export const LEAD_FILTERS = {
  status: LEAD_STATUSES,
  source: LEAD_SOURCES,
  service: SERVICE_TYPES,
  assigned: null,
  flag: LEAD_FLAGS,
} as const;
export type LeadFilter = keyof typeof LEAD_FILTERS;

/** Cards per board column; the rest are a "View all" link into the table. */
export const BOARD_COLUMN_LIMIT = 40;

// =================================================================================================
// Pure rules shared by the pages and the jobs
// =================================================================================================

/** True when an open lead has had no call, note, stage change or quotation for `days` days. */
export function isLeadStale(lead: { status: LeadStatus; last_activity_at: string | null }, now: Date, days = STALE_LEAD_DAYS): boolean {
  if (isClosedLeadStatus(lead.status) || !lead.last_activity_at) return false;
  const t = Date.parse(lead.last_activity_at);
  return Number.isFinite(t) && now.getTime() - t > days * 86_400_000;
}

/** True when an open lead's next follow-up time has come. */
export function isFollowUpDue(lead: { status: LeadStatus; next_follow_up_at: string | null }, now: Date): boolean {
  if (isClosedLeadStatus(lead.status) || !lead.next_follow_up_at) return false;
  const t = Date.parse(lead.next_follow_up_at);
  return Number.isFinite(t) && t <= now.getTime();
}

/** The services as words ("GST returns and Income tax"; "your requirements" when none). */
export function servicesPhrase(services: readonly ServiceType[] | null | undefined): string {
  const names = (services ?? []).filter((s) => s !== "other").map((s) => SERVICE_TYPE_LABELS[s]);
  if (names.length === 0) return "accounting and tax";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The lead's display name: the company when there is one, with the person after it. */
export function leadTitle(lead: { name: string; company: string | null }): string {
  const company = lead.company?.trim();
  return company ? `${company} · ${lead.name}` : lead.name;
}

export type LeadConversion = { won: number; lost: number; rate: number | null };

/** Conversion = won ÷ closed (§7.5.1); null when nothing has closed. */
export function conversionRate(won: number, lost: number): LeadConversion {
  const closed = won + lost;
  return { won, lost, rate: closed > 0 ? Math.round((won / closed) * 1000) / 10 : null };
}

// =================================================================================================
// The analytics period (§7.5.1 analytics)
// =================================================================================================

export const ANALYTICS_PRESETS = ["fy", "prev_fy", "90d", "30d", "custom"] as const;
export type AnalyticsPreset = (typeof ANALYTICS_PRESETS)[number];

export const ANALYTICS_PRESET_LABELS: Record<AnalyticsPreset, string> = {
  fy: "This FY",
  prev_fy: "Last FY",
  "90d": "Last 90 days",
  "30d": "Last 30 days",
  custom: "Custom",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The analytics period from the URL (`?period=fy|prev_fy|90d|30d` or `?from=&to=`), defaulting to
 * the financial year chosen in the top bar. `fy` is like "2026-27"; dates are IST `YYYY-MM-DD`.
 * A custom range that is reversed or longer than ten years falls back to the FY.
 */
export function analyticsPeriod(
  params: { period?: string | null; from?: string | null; to?: string | null },
  today: string,
  fy: string,
): { preset: AnalyticsPreset; from: string; to: string } {
  const start = Number(fy.slice(0, 4));
  const fyFrom = `${start}-04-01`;
  const fyTo = `${start + 1}-03-31`;
  const from = params.from?.trim() ?? "";
  const to = params.to?.trim() ?? "";
  if (ISO_DATE.test(from) && ISO_DATE.test(to) && from <= to && Date.parse(to) - Date.parse(from) <= 3660 * 86_400_000) {
    return { preset: "custom", from, to };
  }
  switch (params.period) {
    case "prev_fy":
      return { preset: "prev_fy", from: `${start - 1}-04-01`, to: `${start}-03-31` };
    case "90d":
      return { preset: "90d", from: addDaysIso(today, -89), to: today };
    case "30d":
      return { preset: "30d", from: addDaysIso(today, -29), to: today };
    default:
      return { preset: "fy", from: fyFrom, to: fyTo };
  }
}
