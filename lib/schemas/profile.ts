/**
 * Profile (§7.1, §7.17): your name and phone, photo, theme and density, notification preferences
 * per event and channel (in-app always on; email optional), and for Partners the ICAI membership
 * number and signature image. Client-safe.
 *
 * Notification preferences are stored in `profiles.preferences.notifications`:
 *   { "email": { "task_assigned": true, "leave_decided": false, … } }
 * A type that isn't listed uses its default (NOTIFICATION_EVENTS[].emailDefault). In-app is always on.
 */

import { z } from "zod";
import type { AppRole } from "@/lib/auth/roles";
import type { NotificationType } from "@/lib/domain/enums";
import { NOTIFICATION_TYPES } from "@/lib/domain/enums";
import { normaliseMembershipNo } from "@/lib/domain/india-validators";
import { phoneProblem } from "@/lib/schemas/people";

// -------------------------------------------------------------------------------------------------
// Name and phone
// -------------------------------------------------------------------------------------------------

/**
 * Each Profile form carries the values it showed (`was_*`) as its concurrency check (§13): the
 * profile row is also written by theme, density, favourites and notification choices, so its
 * updated_at would report conflicts that aren't there.
 */
const wasText = z
  .string()
  .max(500)
  .nullish()
  .transform((v) => (v ? v : null))

export const ProfileDetailsSchema = z.object({
  was_full_name: z.string({ error: "Reload the page and try again." }).max(500),
  was_phone: wasText,
  full_name: z
    .string({ error: "Enter your name." })
    .trim()
    .min(2, { error: "Enter your full name." })
    .max(120, { error: "Use 120 characters or fewer." }),
  phone: z
    .string()
    .trim()
    .max(30, { error: "That number is too long." })
    .nullish()
    .transform((v) => (v ? v : null))
    .superRefine((v, ctx) => {
      if (!v) return;
      const p = phoneProblem(v);
      if (p) ctx.addIssue({ code: "custom", message: p });
    }),
});
export type ProfileDetailsInput = z.input<typeof ProfileDetailsSchema>;

export const MembershipSchema = z.object({
  was_icai_membership_no: wasText,
  icai_membership_no: z
    .string()
    .trim()
    .nullish()
    .transform((v, ctx) => {
      if (!v) return null;
      const n = normaliseMembershipNo(v);
      if (!n) {
        ctx.addIssue({ code: "custom", message: "An ICAI membership number has 6 digits." });
        return z.NEVER;
      }
      return n;
    }),
});
export type MembershipInput = z.input<typeof MembershipSchema>;

// -------------------------------------------------------------------------------------------------
// Photo and signature (two steps, like the firm logo: signed upload, then a server check)
// -------------------------------------------------------------------------------------------------

export type ProfileImageKind = "avatar" | "signature";
export type ImageFormat = "png" | "jpeg" | "webp";

export const PROFILE_IMAGE_LIMITS: Record<ProfileImageKind, { maxBytes: number; formats: readonly ImageFormat[]; accept: string }> = {
  avatar: { maxBytes: 2 * 1024 * 1024, formats: ["png", "jpeg", "webp"], accept: "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" },
  signature: { maxBytes: 1024 * 1024, formats: ["png", "jpeg"], accept: "image/png,image/jpeg,.png,.jpg,.jpeg" },
};

export const IMAGE_CONTENT_TYPE: Record<ImageFormat, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
export const IMAGE_EXTENSION: Record<ImageFormat, string> = { png: "png", jpeg: "jpg", webp: "webp" };

/** What an image really is, from its first bytes (§12: by magic bytes, not the extension). */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  ) {
    return "webp";
  }
  return null;
}

export type ImageCheck = { ok: true; format: ImageFormat } | { ok: false; error: string };

/** The full check for a photo or signature (in the browser before upload, and on the server after). */
export function checkProfileImage(kind: ProfileImageKind, bytes: Uint8Array, size: number = bytes.length): ImageCheck {
  const limits = PROFILE_IMAGE_LIMITS[kind];
  const what = kind === "avatar" ? "photo" : "signature";
  if (size === 0) return { ok: false, error: "The file is empty." };
  if (size > limits.maxBytes) {
    return { ok: false, error: `The ${what} is ${(size / (1024 * 1024)).toFixed(1)} MB. Use a file of at most ${limits.maxBytes / (1024 * 1024)} MB.` };
  }
  const format = sniffImageFormat(bytes);
  if (!format || !limits.formats.includes(format)) {
    return { ok: false, error: kind === "avatar" ? "Upload a PNG, JPG or WebP image." : "Upload a PNG or JPG image of your signature." };
  }
  return { ok: true, format };
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** `<user_id>/avatar-<uuid>.<ext>` or `<user_id>/signature-<uuid>.<ext>` (the 0105 storage rules). */
export function profileImagePathPattern(kind: ProfileImageKind): RegExp {
  return kind === "avatar" ? new RegExp(`^${UUID}/avatar-${UUID}\\.(png|jpg|webp)$`) : new RegExp(`^${UUID}/signature-${UUID}\\.(png|jpg)$`);
}

export const ImageUploadRequestSchema = z.object({
  kind: z.enum(["avatar", "signature"]),
  format: z.enum(["png", "jpeg", "webp"], { error: "Upload a PNG, JPG or WebP image." }),
  size: z.number({ error: "Choose a file." }).int().min(1, { error: "The file is empty." }).max(2 * 1024 * 1024, { error: "Use a file of at most 2 MB." }),
});
export type ImageUploadRequestInput = z.input<typeof ImageUploadRequestSchema>;

export const ImageConfirmSchema = z.object({
  kind: z.enum(["avatar", "signature"]),
  path: z.string().min(1, { error: "Upload the file again." }).max(200, { error: "Upload the file again." }),
  /** The image path the page showed (null for none). */
  was_path: wasText,
});
export type ImageConfirmInput = z.input<typeof ImageConfirmSchema>;

export const ImageRemoveSchema = z.object({ kind: z.enum(["avatar", "signature"]), was_path: wasText });
export type ImageRemoveInput = z.input<typeof ImageRemoveSchema>;

// -------------------------------------------------------------------------------------------------
// Notification preferences (§7.17: in-app always; email optional, per event type)
// -------------------------------------------------------------------------------------------------

export type NotificationEvent = {
  type: NotificationType;
  label: string;
  group: "Work" | "Clients and compliance" | "Money" | "Team" | "WhatsApp and security" | "General";
  /** Email on by default. */
  emailDefault: boolean;
  /** Who can receive it at all. Money notices never reach Employees (§4.1). */
  roles: readonly AppRole[];
};

const STAFF: readonly AppRole[] = ["partner", "manager", "employee"];
const PM: readonly AppRole[] = ["partner", "manager"];

export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = [
  { type: "task_assigned", label: "A task is assigned to you", group: "Work", emailDefault: true, roles: STAFF },
  { type: "task_declined", label: "A task is declined", group: "Work", emailDefault: false, roles: PM },
  { type: "review_requested", label: "A task is submitted for your review", group: "Work", emailDefault: true, roles: STAFF },
  { type: "task_sent_back", label: "A task is sent back to you", group: "Work", emailDefault: true, roles: STAFF },
  { type: "task_approved", label: "A task is filed or approved", group: "Work", emailDefault: false, roles: STAFF },
  { type: "task_overdue", label: "A task is overdue or escalated", group: "Work", emailDefault: true, roles: STAFF },
  { type: "compliance_due", label: "A compliance deadline is coming up", group: "Clients and compliance", emailDefault: true, roles: STAFF },
  { type: "document_uploaded", label: "A client uploads a document or sends a message", group: "Clients and compliance", emailDefault: false, roles: STAFF },
  { type: "expiry_alert", label: "A DSC, registration or engagement letter is expiring", group: "Clients and compliance", emailDefault: true, roles: STAFF },
  { type: "invoice_awaiting_approval", label: "An invoice is waiting for approval", group: "Money", emailDefault: true, roles: ["partner"] },
  { type: "invoice_overdue", label: "An invoice becomes overdue", group: "Money", emailDefault: false, roles: PM },
  { type: "payment_received", label: "A payment is received, or a client says they've paid", group: "Money", emailDefault: false, roles: PM },
  { type: "quotation_viewed", label: "A client views a quotation", group: "Money", emailDefault: false, roles: PM },
  { type: "quotation_responded", label: "A client accepts or declines a quotation", group: "Money", emailDefault: true, roles: PM },
  { type: "leave_requested", label: "Someone asks for leave", group: "Team", emailDefault: true, roles: PM },
  { type: "leave_decided", label: "Your leave is approved or declined", group: "Team", emailDefault: true, roles: STAFF },
  { type: "cover_started", label: "A cover starts for you or your clients", group: "Team", emailDefault: true, roles: STAFF },
  { type: "cover_ending", label: "A cover you granted ends tomorrow", group: "Team", emailDefault: false, roles: PM },
  { type: "cover_ended", label: "A cover for you or by you ends", group: "Team", emailDefault: false, roles: STAFF },
  { type: "whatsapp_group_missing", label: "A client has no WhatsApp group yet", group: "WhatsApp and security", emailDefault: false, roles: PM },
  { type: "whatsapp_device_linked", label: "A PC links a firm WhatsApp number", group: "WhatsApp and security", emailDefault: true, roles: ["partner"] },
  { type: "whatsapp_client_mode_down", label: "Client mode stops working on a PC", group: "WhatsApp and security", emailDefault: true, roles: ["partner"] },
  { type: "security_alert", label: "A security alert", group: "WhatsApp and security", emailDefault: true, roles: ["partner"] },
  { type: "info", label: "General updates", group: "General", emailDefault: false, roles: STAFF },
  { type: "warning", label: "Warnings that need a look", group: "General", emailDefault: false, roles: STAFF },
];

/** The events a role can receive, in display order. */
export function notificationEventsFor(role: AppRole): NotificationEvent[] {
  return NOTIFICATION_EVENTS.filter((e) => e.roles.includes(role));
}

export const NOTIFICATION_PREFS_KEY = "notifications";

/** The email choice per event for a role, from `profiles.preferences` (defaults filled in). */
export function readEmailPreferences(preferences: unknown, role: AppRole): Record<string, boolean> {
  const p = preferences && typeof preferences === "object" && !Array.isArray(preferences) ? (preferences as Record<string, unknown>) : {};
  const n = p[NOTIFICATION_PREFS_KEY];
  const email = n && typeof n === "object" && !Array.isArray(n) ? (n as Record<string, unknown>).email : null;
  const stored = email && typeof email === "object" && !Array.isArray(email) ? (email as Record<string, unknown>) : {};
  const out: Record<string, boolean> = {};
  for (const e of notificationEventsFor(role)) out[e.type] = typeof stored[e.type] === "boolean" ? (stored[e.type] as boolean) : e.emailDefault;
  return out;
}

/**
 * Whether a Partner gets the 08:00 daily digest email (§7.17, §8), stored at
 * `profiles.preferences.notifications.digest`. On by default for Partners (the firm-wide switch is
 * Settings → Reminders); nobody else receives it, since it carries receivables (§4.1).
 */
export function readDigestPreference(preferences: unknown, role: AppRole): boolean {
  if (role !== "partner") return false;
  const p = preferences && typeof preferences === "object" && !Array.isArray(preferences) ? (preferences as Record<string, unknown>) : {};
  const n = p[NOTIFICATION_PREFS_KEY];
  const digest = n && typeof n === "object" && !Array.isArray(n) ? (n as Record<string, unknown>).digest : undefined;
  return typeof digest === "boolean" ? digest : true;
}

export const NotificationPrefsSchema = z.object({
  email: z.partialRecord(z.enum(NOTIFICATION_TYPES), z.boolean()),
  /** Partners only: the daily digest email. */
  digest: z.boolean().optional(),
});
export type NotificationPrefsInput = z.input<typeof NotificationPrefsSchema>;

// -------------------------------------------------------------------------------------------------
// Messaging (§7.13.2, §7.25.10): "Add my signature to WhatsApp drafts"
// -------------------------------------------------------------------------------------------------

/** Stored at `profiles.preferences.messaging.whatsapp_signature`. */
export const MESSAGING_PREFS_KEY = "messaging";

/**
 * Whether WhatsApp drafts end with the firm's signature ("– Ravi") for this person. On by default
 * for Managers and Employees, who send from the shared office numbers; off by default for Partners.
 */
export function readWhatsAppSignaturePreference(preferences: unknown, role: AppRole): boolean {
  const p = preferences && typeof preferences === "object" && !Array.isArray(preferences) ? (preferences as Record<string, unknown>) : {};
  const m = p[MESSAGING_PREFS_KEY];
  const v = m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>).whatsapp_signature : undefined;
  return typeof v === "boolean" ? v : role === "manager" || role === "employee";
}

export const MessagingPrefsSchema = z.object({ whatsapp_signature: z.boolean() });
export type MessagingPrefsInput = z.input<typeof MessagingPrefsSchema>;

export const SignOutOthersSchema = z.object({});
