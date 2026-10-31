import { z } from "zod";
import { addDays, isDateString, istDateOf, todayIST, type DateString } from "@/lib/domain/fy";
import type { RequestItemStatus, RequestStatus } from "@/lib/domain/enums";

/**
 * Document requests: PBC lists sent to clients (§5.8, §7.14, §7.22, §10.11). The form schemas shared
 * by the request dialog and server/actions/document-requests.ts, the progress rule the database also
 * applies (document_request_is_complete, 0122), the status words, and the hand-off drafts that carry
 * the portal link. Client-safe.
 *
 * Fields (§7.14): Title* · Due date · Items* (title*, help text, required) · Notes · Reminder every N
 * days (default 3, from Settings → Reminders).
 */

export const REQUEST_LIMITS = { title: 200, itemTitle: 200, helpText: 1000, notes: 2000, items: 50, reason: 500, everyDaysMin: 1, everyDaysMax: 60 } as const;

const uuid = (what: string) => z.uuid({ error: `That ${what} isn't valid.` });

const optionalText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, { error: tooLong })
    .nullish()
    .transform((v) => (v ? v : null));

const requestTitle = z
  .string()
  .trim()
  .min(1, { error: "Give the request a title, like “Audit PBC FY 2026-27”." })
  .max(REQUEST_LIMITS.title, { error: `Keep the title under ${REQUEST_LIMITS.title} characters.` });

const dueDate = z
  .union([z.string().trim(), z.null()])
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isDateString(v), { error: "Enter the due date as a date, for example 22 Oct 2026." });

const everyDays = z.coerce
  .number({ error: "Enter a number of days." })
  .int({ error: "Enter a whole number of days." })
  .min(REQUEST_LIMITS.everyDaysMin, { error: "Remind at least every day." })
  .max(REQUEST_LIMITS.everyDaysMax, { error: `Remind at least every ${REQUEST_LIMITS.everyDaysMax} days.` });

const contactId = z
  .union([uuid("contact"), z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

export const RequestItemInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, { error: "Name the document you need." })
    .max(REQUEST_LIMITS.itemTitle, { error: `Keep it under ${REQUEST_LIMITS.itemTitle} characters.` }),
  helpText: optionalText(REQUEST_LIMITS.helpText, "Keep the help text under 1,000 characters."),
  isRequired: z.boolean().default(true),
});
export type RequestItemInput = z.input<typeof RequestItemInputSchema>;

export const CreateDocumentRequestSchema = z
  .object({
    clientId: uuid("client"),
    title: requestTitle,
    dueDate,
    items: z
      .array(RequestItemInputSchema)
      .min(1, { error: "Add at least one item to request." })
      .max(REQUEST_LIMITS.items, { error: `A request can have at most ${REQUEST_LIMITS.items} items. Split it into two.` }),
    notes: optionalText(REQUEST_LIMITS.notes, "Keep the notes under 2,000 characters."),
    reminderEveryDays: everyDays.default(3),
    /** Who the WhatsApp message goes to; the primary contact by default. */
    contactId,
  })
  .superRefine((v, ctx) => {
    if (v.dueDate && v.dueDate < todayIST()) ctx.addIssue({ code: "custom", path: ["dueDate"], message: "Choose a due date from today on." });
  });
export type CreateDocumentRequestInput = z.input<typeof CreateDocumentRequestSchema>;

export const UpdateDocumentRequestSchema = z.object({
  id: uuid("request"),
  clientId: uuid("client"),
  updatedAt: z.string().min(1),
  title: requestTitle,
  dueDate,
  notes: optionalText(REQUEST_LIMITS.notes, "Keep the notes under 2,000 characters."),
  reminderEveryDays: everyDays,
  contactId,
});
export type UpdateDocumentRequestInput = z.input<typeof UpdateDocumentRequestSchema>;

export const AddRequestItemSchema = RequestItemInputSchema.extend({ requestId: uuid("request"), clientId: uuid("client") });
export type AddRequestItemInput = z.input<typeof AddRequestItemSchema>;

export const UpdateRequestItemSchema = RequestItemInputSchema.extend({
  id: uuid("item"),
  requestId: uuid("request"),
  clientId: uuid("client"),
  updatedAt: z.string().min(1),
});
export type UpdateRequestItemInput = z.input<typeof UpdateRequestItemSchema>;

export const RemoveRequestItemSchema = z.object({ id: uuid("item"), requestId: uuid("request"), clientId: uuid("client") });

export const ReviewRequestItemSchema = z
  .object({
    id: uuid("item"),
    requestId: uuid("request"),
    clientId: uuid("client"),
    decision: z.enum(["accept", "reject"]),
    reason: optionalText(REQUEST_LIMITS.reason, "Keep the reason under 500 characters."),
    /** Accept with a document already in the vault (staff linking one on the client's behalf). */
    documentId: uuid("document").nullish().transform((v) => v ?? null),
    updatedAt: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "reject" && !v.reason) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Say why it's rejected, so the client knows what to send instead." });
    }
  });
export type ReviewRequestItemInput = z.input<typeof ReviewRequestItemSchema>;

export const CancelDocumentRequestSchema = z.object({
  id: uuid("request"),
  clientId: uuid("client"),
  updatedAt: z.string().min(1),
  reason: optionalText(REQUEST_LIMITS.reason, "Keep the reason under 500 characters."),
});

export const ReopenDocumentRequestSchema = z.object({ id: uuid("request"), clientId: uuid("client"), updatedAt: z.string().min(1) });

/** Records a WhatsApp hand-off of a request as contact made (counts towards the cadence). */
export const RecordRequestHandoffSchema = z.object({ id: uuid("request"), clientId: uuid("client") });

// -------------------------------------------------------------------------------------------------
// Progress (mirrors document_request_is_complete, 0122)
// -------------------------------------------------------------------------------------------------

export interface ItemLike {
  is_required: boolean;
  status: RequestItemStatus;
}

export interface RequestProgress {
  total: number;
  required: number;
  accepted: number;
  requiredAccepted: number;
  /** Uploaded by the client, waiting for staff to accept or reject. */
  toReview: number;
  pending: number;
  rejected: number;
  /** Still needed from the client: pending + rejected. */
  outstanding: number;
  /** At least one item, and every required item accepted (every item, when none is required). */
  complete: boolean;
}

export function requestProgress(items: readonly ItemLike[]): RequestProgress {
  const required = items.filter((i) => i.is_required);
  const counted = required.length > 0 ? required : items;
  const count = (s: RequestItemStatus) => items.filter((i) => i.status === s).length;
  const pending = count("pending");
  const rejected = count("rejected");
  return {
    total: items.length,
    required: required.length,
    accepted: count("accepted"),
    requiredAccepted: required.filter((i) => i.status === "accepted").length,
    toReview: count("uploaded"),
    pending,
    rejected,
    outstanding: pending + rejected,
    complete: items.length > 0 && counted.every((i) => i.status === "accepted"),
  };
}

/** "3 of 5 accepted", the progress line under a request's title. */
export function progressLabel(p: RequestProgress): string {
  if (p.total === 0) return "No items";
  const base = `${p.accepted} of ${p.total} accepted`;
  const extra: string[] = [];
  if (p.toReview > 0) extra.push(`${p.toReview} to review`);
  if (p.rejected > 0) extra.push(`${p.rejected} sent back`);
  return extra.length ? `${base} · ${extra.join(" · ")}` : base;
}

/**
 * The day the next reminder is due (§7.14 "Reminder every N days"; the 09:00 reminders job sends it):
 * N days after the last reminder, or after the request was created when none has gone. Null once the
 * request is closed or nothing is outstanding ("Reminders stop when nothing is pending").
 */
export function nextReminderOn(r: {
  status: RequestStatus;
  lastRemindedAt: string | null;
  createdAt: string;
  everyDays: number;
  outstanding: number;
}): DateString | null {
  if (r.status !== "open" || r.outstanding === 0) return null;
  const from = istDateOf(r.lastRemindedAt ?? r.createdAt);
  return addDays(from, Math.max(1, r.everyDays));
}

// -------------------------------------------------------------------------------------------------
// Hand-off drafts (§7.13.2 "Document request: the list of pending items + portal link")
// -------------------------------------------------------------------------------------------------

/** The portal page for one request (§7.22 Documents: requests with per-item upload). */
export function requestPortalPath(requestId: string): string {
  return `/portal/documents?request=${requestId}`;
}

export interface DraftItem {
  title: string;
  status: RequestItemStatus;
  is_required: boolean;
  rejection_reason?: string | null;
}

/** The items the client still has to send, as bullet lines (rejected ones with the reason). */
export function outstandingLines(items: readonly DraftItem[]): string[] {
  return items
    .filter((i) => i.status === "pending" || i.status === "rejected")
    .map((i) => {
      const optional = i.is_required ? "" : " (if you have it)";
      return i.status === "rejected" && i.rejection_reason ? `• ${i.title}${optional}: please send again (${i.rejection_reason})` : `• ${i.title}${optional}`;
    });
}

/**
 * The WhatsApp draft for a request: greeting, what's needed (and by when), the portal link.
 * The signature is added by the WhatsApp button's caller when the person's preference says so.
 */
export function requestHandoffDraft(d: {
  contactName: string | null;
  clientName: string;
  title: string;
  items: readonly DraftItem[];
  dueDateText: string | null;
  portalLink: string;
  reminder?: boolean;
}): string {
  const lines = outstandingLines(d.items);
  const hello = d.contactName ? `Hi ${d.contactName},` : "Hello,";
  const by = d.dueDateText ? ` by ${d.dueDateText}` : "";
  const intro = d.reminder
    ? `A reminder about "${d.title}" for ${d.clientName}: we still need${by}:`
    : `For "${d.title}" (${d.clientName}) we need the following${by}:`;
  return [hello, "", intro, ...(lines.length ? lines : ["• Nothing is pending right now."]), "", `You can upload them here: ${d.portalLink}`].join("\n");
}

