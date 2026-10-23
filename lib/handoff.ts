import { z } from "zod";

/**
 * Hand-offs and logged contact (§7.13.1–§7.13.3): the shared schemas for logHandoff and
 * logCallNote (server/actions/messages.ts), the words the app uses for each channel and status,
 * and the banners shown when automatic email can't be used. Client-safe.
 *
 * What the app may claim (§7.13.1): an email is Sent / Delivered / Opened / Bounced (Resend
 * webhooks); a WhatsApp or Gmail hand-off is only ever "Handed off", never delivered; a call or a
 * note is "Logged".
 *
 *   <WhatsAppButton … onHandedOff={({ number, text, templateId }) =>
 *     logHandoff({ clientId, contactId, channel: "whatsapp_handoff", recipient: number, body: text, templateId })} />
 *   <GmailButton … onHandedOff={(f) =>
 *     logHandoff({ clientId, contactId, channel: "gmail_handoff", recipient: f.to, subject: f.subject, body: f.body,
 *       related: { type: "invoice", id } })} />
 */

export const HANDOFF_CHANNELS = ["whatsapp_handoff", "gmail_handoff"] as const;
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
  /** The normalised WhatsApp number (digits) or the email address it was handed to. */
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

/** The Communication tab's name for each channel (§5.1 message_channel). */
export const MESSAGE_CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  whatsapp_handoff: "WhatsApp",
  gmail_handoff: "Gmail",
  portal: "Portal",
  internal_note: "Note",
  call_log: "Call",
};

export type MessageTone = "success" | "warning" | "danger" | "info" | "muted" | "neutral";

/**
 * What a message's status may be called on screen (§7.13.1): hand-offs are "Handed off" and never
 * "Delivered"; calls and notes are "Logged".
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
      return { label: "Queued", tone: "muted", meaning: "Queued: being sent now." };
    case "sent":
      return { label: "Sent", tone: "info", meaning: channel === "portal" ? "Sent: it's in the client's portal." : "Sent: Resend accepted it; it changes to Delivered when the client's mail server takes it." };
    case "delivered":
      return { label: "Delivered", tone: "success", meaning: "Delivered: the client's mail server accepted it." };
    case "read":
      return { label: channel === "portal" ? "Read" : "Opened", tone: "success", meaning: channel === "portal" ? "Read: the client opened it in the portal." : "Opened: the client opened it (where their mail app lets us tell)." };
    case "failed":
      return { label: "Failed", tone: "danger", meaning: "Failed: it didn't reach the client. Send it from your own mailbox or WhatsApp instead." };
    case "handed_off":
      return { label: "Handed off", tone: "info", meaning: "Handed off to another app; the app can't confirm delivery." };
    default:
      return { label: status.replace(/_/g, " "), tone: "neutral", meaning: "" };
  }
}

/** §7.13.5: shown wherever an automatic email would go while the domain isn't verified. */
export const EMAIL_NOT_SET_UP_MESSAGE = "Email isn't set up yet. Use WhatsApp or Gmail, or finish email setup.";

/** §7.13.3: shown prominently when an automatic send failed. */
export function deliveryFailedMessage(clientName: string): string {
  return `Delivery failed, so ${clientName} hasn't received this. Send it from your own mailbox instead; the note and link are filled in.`;
}

/** The outcome of sendEmail as the UI shows it (server/email/send.ts SendEmailResult). */
export interface EmailSendOutcome {
  status: "sent" | "not_configured" | "failed";
  error?: string;
}

/**
 * What to tell the person after an automatic send, and whether to put the WhatsApp / Gmail
 * hand-off in front of them (§7.13.3 "prominently whenever an automatic send failed").
 */
export function emailOutcomeNotice(
  outcome: EmailSendOutcome,
  recipientName: string,
): { tone: "success" | "warning" | "danger"; message: string; detail: string | null; offerHandoff: boolean } {
  switch (outcome.status) {
    case "sent":
      return { tone: "success", message: `Emailed to ${recipientName}.`, detail: null, offerHandoff: false };
    case "not_configured":
      return { tone: "warning", message: EMAIL_NOT_SET_UP_MESSAGE, detail: outcome.error ?? null, offerHandoff: true };
    case "failed":
      return { tone: "danger", message: deliveryFailedMessage(recipientName), detail: outcome.error ?? null, offerHandoff: true };
  }
}
