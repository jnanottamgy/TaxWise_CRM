import { z } from "zod";

/**
 * Hand-offs and logged contact (§7.13.1–§7.13.3): the shared schemas for logHandoff and
 * logCallNote (server/actions/messages.ts), and the words the app uses for each channel and status.
 * Client-safe.
 *
 * The firm talks to clients on WhatsApp; the app sends no email. What it may claim (§7.13.1): a
 * WhatsApp hand-off is only ever "Handed off", never delivered; a call or a note is "Logged".
 * Older history can still hold emails and Gmail hand-offs from before, so their labels stay.
 *
 *   <WhatsAppButton … onHandedOff={({ number, text, templateId }) =>
 *     logHandoff({ clientId, contactId, channel: "whatsapp_handoff", recipient: number, body: text, templateId,
 *       related: { type: "invoice", id } })} />
 */

export const HANDOFF_CHANNELS = ["whatsapp_handoff"] as const;
export type HandoffChannel = (typeof HANDOFF_CHANNELS)[number];

const RelatedSchema = z.object({
  type: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, { error: "That isn't a record type the app knows." }),
  id: z.uuid({ error: "That record id isn't valid." }),
});

const optionalUuid = z.union([z.uuid(), z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep it under ${max} characters.` })
    .nullish()
    .transform((v) => (v ? v : null));

export const HandoffSchema = z.object({
  clientId: z.uuid({ error: "Choose the client." }),
  contactId: optionalUuid,
  channel: z.enum(HANDOFF_CHANNELS),
  /** The normalised WhatsApp number (digits) it was handed to. */
  recipient: z.string().trim().min(1, { error: "There's no recipient." }).max(320),
  subject: optionalText(300),
  body: z.string().trim().min(1, { error: "The message is empty." }).max(10_000, { error: "The message is too long to log." }),
  templateId: optionalUuid,
  related: RelatedSchema.nullish().transform((v) => v ?? null),
});
export type HandoffInput = z.input<typeof HandoffSchema>;

export const CALL_KINDS = ["call_out", "call_in", "meeting", "note"] as const;
export type CallKind = (typeof CALL_KINDS)[number];

export const CALL_KIND_LABEL: Record<CallKind, string> = {
  call_out: "We called them",
  call_in: "They called us",
  meeting: "Meeting",
  note: "Note",
};

export const CallNoteSchema = z.object({
  clientId: z.uuid({ error: "Choose the client." }),
  contactId: optionalUuid,
  kind: z.enum(CALL_KINDS).default("call_out"),
  /** When it happened (ISO timestamp); now when empty. Not in the future. */
  occurredAt: z
    .union([z.iso.datetime({ offset: true, error: "Enter a valid date and time." }), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || Date.parse(v) <= Date.now() + 5 * 60_000, { error: "A call can't be logged in the future." }),
  /** A one-line summary ("Asked for September purchase invoices"). */
  subject: optionalText(200),
  body: z.string().trim().min(1, { error: "Write what was discussed." }).max(5000, { error: "Keep the note under 5,000 characters." }),
  related: RelatedSchema.nullish().transform((v) => v ?? null),
});
export type CallNoteInput = z.input<typeof CallNoteSchema>;

const MONEY_SIDE_KIND = /^(lead|quotation|invoice|payment|receipt|credit_note|engagement_letter|fee|tds_credit|portal_payment_claim)/;

/**
 * Mirrors money_side_kind() in the database (0043): lead, quotation, invoice, payment, receipt,
 * credit note, engagement letter, fee, TDS credit and portal payment claim records. History of
 * these kinds is never shown to Employees (§4.1).
 */
export function isMoneySideKind(kind: string | null | undefined): boolean {
  if (!kind) return false;
  return MONEY_SIDE_KIND.test(kind.trim().toLowerCase());
}

/**
 * Whether a hand-off or a logged note is about money, and the money-side prefix its timeline event
 * gets (§4.1; mirrors is_money_message, 0043): the record it is about is on the money side
 * (`invoice` → "invoice"), or it was written from a payment-reminder or quotation template
 * ("payment", "quotation"). Null when it isn't about money. A money-side timeline event
 * ("invoice_message_sent", "payment_message_sent") is never shown to Employees; a plain
 * "message_sent" is, so a payment reminder logged without a related invoice must not use it: its
 * subject names the invoice.
 */
export function handoffMoneyKind(relatedType: string | null | undefined, templateType: string | null | undefined): string | null {
  const related = relatedType?.trim().toLowerCase() ?? "";
  if (related && isMoneySideKind(related)) return related;
  if (templateType === "payment_reminder") return "payment";
  if (templateType === "quotation") return "quotation";
  return null;
}

/**
 * The Communication tab's name for each channel (§5.1 message_channel). Email and Gmail aren't used
 * any more, but older messages can carry them.
 */
export const MESSAGE_CHANNEL_LABEL: Record<string, string> = {
  whatsapp_handoff: "WhatsApp",
  portal: "Portal",
  internal_note: "Note",
  call_log: "Call",
  email: "Email",
  gmail_handoff: "Gmail",
};

export type MessageTone = "success" | "warning" | "danger" | "info" | "muted" | "neutral";

/**
 * What a message's status may be called on screen (§7.13.1): hand-offs are "Handed off" and never
 * "Delivered"; calls and notes are "Logged". The delivery statuses describe portal messages and
 * older emails.
 */
export function messageStatusInfo(channel: string, status: string): { label: string; tone: MessageTone; meaning: string } {
  if (channel === "whatsapp_handoff" || channel === "gmail_handoff") {
    const app = channel === "whatsapp_handoff" ? "WhatsApp" : "Gmail";
    return {
      label: "Handed off",
      tone: "info",
      meaning: `Handed off: ${app} opened with this message filled in. The app can't see whether it was sent or delivered.`,
    };
  }
  if (channel === "call_log" || channel === "internal_note") {
    return { label: "Logged", tone: "muted", meaning: "Logged: a record of a conversation or a note for the team. Nothing was sent." };
  }
  switch (status) {
    case "pending":
    case "queued":
      return { label: "Queued", tone: "muted", meaning: "Queued: it hadn't gone yet." };
    case "sent":
      return { label: "Sent", tone: "info", meaning: channel === "portal" ? "Sent: it's in the client's portal." : "Sent: the email was accepted for delivery." };
    case "delivered":
      return { label: "Delivered", tone: "success", meaning: "Delivered: the client's mail server accepted it." };
    case "read":
      return { label: channel === "portal" ? "Read" : "Opened", tone: "success", meaning: channel === "portal" ? "Read: the client opened it in the portal." : "Opened: the client opened it (where their mail app let us tell)." };
    case "failed":
      return { label: "Failed", tone: "danger", meaning: "Failed: it didn't reach the client. Send it on WhatsApp instead." };
    case "handed_off":
      return { label: "Handed off", tone: "info", meaning: "Handed off to another app; the app can't confirm delivery." };
    default:
      return { label: status.replace(/_/g, " "), tone: "neutral", meaning: "" };
  }
}
