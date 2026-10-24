/**
 * Data protection (§6.10 DPDP Act 2023 / DPDP Rules 2025): the zod schemas behind the privacy notice
 * editor (Settings → Data), data requests, incidents and consent records, shared by the forms and
 * server/actions/{privacy-notices,data-requests,data-incidents}.ts. Client-safe: pure.
 */

import { z } from "zod";
import { isDateString } from "@/lib/domain/fy";
import {
  DATA_REQUEST_CHANNELS,
  DATA_REQUEST_STATUSES,
  DATA_REQUEST_TYPES,
  DATA_SUBJECT_TYPES,
  INCIDENT_SEVERITIES,
  INCIDENT_STEPS,
  STATUTORY_RETENTION_REASONS,
  closeRequirements,
} from "@/lib/domain/dpdp";

export const DPDP_LIMITS = { body: 50000, summary: 1000, subject: 200, contact: 200, details: 4000, response: 8000, retained: 4000, title: 200, description: 8000, action: 1000 } as const;

const uuid = (what: string) => z.uuid({ error: `Choose ${what}.` });
const concurrency = z.string({ error: "Reload the page and try again." }).min(1, { error: "Reload the page and try again." });

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep it under ${max.toLocaleString("en-IN")} characters.` })
    .nullish()
    .transform((v) => (v ? v : null));

const requiredText = (what: string, min: number, max: number) =>
  z
    .string({ error: `Enter ${what}.` })
    .trim()
    .min(min, { error: `Enter ${what}.` })
    .max(max, { error: `Keep it under ${max.toLocaleString("en-IN")} characters.` });

const optionalUuid = z
  .string()
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || z.uuid().safeParse(v).success, { error: "That choice isn't valid." });

/** "2026-10-22T14:05" (a datetime-local input, IST) → ISO with the +05:30 offset. */
export function istLocalToIso(local: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO → "2026-10-22T14:05" in IST, for a datetime-local input. */
export function isoToIstLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const ist = new Date(d.getTime() + 330 * 60_000);
  return ist.toISOString().slice(0, 16);
}

const istDateTime = (what: string) =>
  z
    .string({ error: `Enter ${what}.` })
    .transform((v, ctx) => {
      const iso = istLocalToIso(v);
      if (!iso) {
        ctx.addIssue({ code: "custom", message: `Enter ${what} as a date and time.` });
        return z.NEVER;
      }
      return iso;
    });

// -------------------------------------------------------------------------------------------------
// Privacy notices (Settings → Data)
// -------------------------------------------------------------------------------------------------

export const NoticeDraftSchema = z.object({
  id: optionalUuid,
  updatedAt: z.string().nullish(),
  body: requiredText("the notice", 200, DPDP_LIMITS.body),
  changeSummary: text(DPDP_LIMITS.summary),
});
export type NoticeDraftInput = z.input<typeof NoticeDraftSchema>;

export const PublishNoticeSchema = z.object({
  id: uuid("the version"),
  updatedAt: concurrency,
  confirm: z.literal(true, { error: "Confirm that the Partners approved this text." }),
});

export const NewNoticeVersionSchema = z.object({ fromId: optionalUuid });
export const DeleteNoticeSchema = z.object({ id: uuid("the draft") });

// -------------------------------------------------------------------------------------------------
// Data requests
// -------------------------------------------------------------------------------------------------

export const DATA_REQUEST_SORTABLE = ["received_at", "due_by", "status", "type", "subject"] as const;
export const DATA_REQUEST_FILTERS = { status: [...DATA_REQUEST_STATUSES, "open_all", "overdue"], type: DATA_REQUEST_TYPES } as const;

export const DataRequestSchema = z.object({
  id: optionalUuid,
  updatedAt: z.string().nullish(),
  subject: requiredText("who the request is from", 2, DPDP_LIMITS.subject),
  subjectType: z.enum(DATA_SUBJECT_TYPES, { error: "Choose who they are to us." }),
  contact: text(DPDP_LIMITS.contact),
  clientId: optionalUuid,
  type: z.enum(DATA_REQUEST_TYPES, { error: "Choose the type of request." }),
  receivedOn: z
    .string({ error: "Enter the date received." })
    .refine((v) => isDateString(v), { error: "Enter the date received." }),
  channel: z.enum(DATA_REQUEST_CHANNELS, { error: "Choose how it reached us." }),
  details: text(DPDP_LIMITS.details),
  handledBy: optionalUuid,
});
export type DataRequestInput = z.input<typeof DataRequestSchema>;

export const DataRequestStatusSchema = z
  .object({
    id: uuid("the request"),
    updatedAt: concurrency,
    type: z.enum(DATA_REQUEST_TYPES),
    status: z.enum(DATA_REQUEST_STATUSES, { error: "Choose the status." }),
    response: text(DPDP_LIMITS.response),
    retainedExplanation: text(DPDP_LIMITS.retained),
  })
  .superRefine((v, ctx) => {
    const missing = closeRequirements({ type: v.type, toStatus: v.status, response: v.response, retainedExplanation: v.retainedExplanation });
    if (missing.includes("the response given to the requester")) ctx.addIssue({ code: "custom", path: ["response"], message: "Record the response given to the requester." });
    if (missing.some((m) => m.startsWith("what is retained"))) ctx.addIssue({ code: "custom", path: ["retainedExplanation"], message: "Say what is retained and why, or that nothing is retained." });
  });
export type DataRequestStatusInput = z.input<typeof DataRequestStatusSchema>;

export const RETENTION_REASON_KEYS = STATUTORY_RETENTION_REASONS.map((r) => r.key);

// -------------------------------------------------------------------------------------------------
// Incidents (breach response)
// -------------------------------------------------------------------------------------------------

export const DATA_CATEGORIES = ["identity", "contact", "financial", "tax_records", "credentials", "employee_records", "documents", "other"] as const;
export type DataCategory = (typeof DATA_CATEGORIES)[number];
export const DATA_CATEGORY_LABELS: Record<DataCategory, string> = {
  identity: "Identity (name, PAN, Aadhaar last 4)",
  contact: "Contact details",
  financial: "Financial and bank details",
  tax_records: "Tax returns and computations",
  credentials: "Portal logins",
  employee_records: "Staff records",
  documents: "Client documents",
  other: "Other",
};

export const IncidentSchema = z.object({
  id: optionalUuid,
  updatedAt: z.string().nullish(),
  title: requiredText("a short title", 3, DPDP_LIMITS.title),
  detectedAt: istDateTime("when it was detected"),
  description: requiredText("what happened", 5, DPDP_LIMITS.description),
  dataCategories: z.array(z.enum(DATA_CATEGORIES)).max(DATA_CATEGORIES.length).default([]),
  peopleAffectedEstimate: z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((v) => (v === null || v === undefined || (typeof v === "string" && v.trim() === "") ? null : typeof v === "number" ? v : Number(v.trim())))
    .refine((v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 10_000_000), { error: "Enter the number of people as a whole number." }),
  severity: z.enum(INCIDENT_SEVERITIES, { error: "Choose the severity." }),
});
export type IncidentInput = z.input<typeof IncidentSchema>;

export const IncidentStepSchema = z
  .object({
    id: uuid("the incident"),
    updatedAt: concurrency,
    step: z.enum(INCIDENT_STEPS),
    /** When the step was done (datetime-local, IST); not used for root cause. */
    at: z.string().nullish(),
    /** The assessment, the Board's reference, or the root cause. */
    text: text(DPDP_LIMITS.description),
    undo: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.undo) return;
    if (v.step !== "root_cause" && !(v.at && istLocalToIso(v.at))) ctx.addIssue({ code: "custom", path: ["at"], message: "Enter when it was done." });
    if ((v.step === "assess" || v.step === "root_cause") && !v.text) {
      ctx.addIssue({ code: "custom", path: ["text"], message: v.step === "assess" ? "Record the assessment." : "Record the root cause and what changes." });
    }
  });
export type IncidentStepInput = z.input<typeof IncidentStepSchema>;

export const IncidentActionSchema = z.object({ id: uuid("the incident"), updatedAt: concurrency, text: requiredText("what was done", 3, DPDP_LIMITS.action) });
export const IncidentCloseSchema = z.object({ id: uuid("the incident"), updatedAt: concurrency, reopen: z.boolean().default(false) });

/** One entry of `data_incidents.actions`. */
export type IncidentAction = { at: string; by: string | null; by_name: string | null; text: string };

export function readIncidentActions(value: unknown): IncidentAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object" && !Array.isArray(a) && typeof (a as Record<string, unknown>).text === "string")
    .map((a) => ({
      at: typeof a.at === "string" ? a.at : "",
      by: typeof a.by === "string" ? a.by : null,
      by_name: typeof a.by_name === "string" ? a.by_name : null,
      text: a.text as string,
    }));
}

// -------------------------------------------------------------------------------------------------
// Consent records
// -------------------------------------------------------------------------------------------------

export const CONSENT_SUBJECT_LABELS: Record<string, string> = {
  client_contact: "Client contact",
  portal_user: "Portal user",
  employee: "Staff",
  lead: "Lead",
};

export const ConsentWithdrawSchema = z.object({ id: uuid("the consent record"), note: text(500) });
