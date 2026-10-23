import { z } from "zod";
import { SERVICE_TYPES, type ServiceType } from "@/lib/domain/enums";
import { isWhatsAppNumber, validateIndianPhone } from "@/lib/schemas/clients";

/**
 * Client contacts (§5.3, §7.3.3 Profile & contacts → Contacts): name*, role, email, phone, WhatsApp,
 * the services they handle (so reminders go to the right person), primary (exactly one, kept by the
 * database guard in 0115), notes. Shared by the contact form (client) and server/actions/contacts.ts.
 * Phone and WhatsApp use the same validators as the client wizard (lib/schemas/clients.ts).
 * Client-safe.
 */

/**
 * The roles §7.3.3 lists, stored as these labels, plus Proprietor and Partner, which the client
 * wizard also offers (lib/schemas/onboarding.ts), so a contact created there edits cleanly here.
 */
export const CONTACT_ROLES = ["Director", "CFO", "Authorised signatory", "Accountant", "Promoter", "Proprietor", "Partner", "Other"] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

export const CONTACT_LIMITS = { name: 120, email: 254, notes: 1000, perClient: 50 } as const;

const uuid = (what: string) => z.uuid({ error: `That ${what} isn't valid.` });

const optionalText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, { error: tooLong })
    .nullish()
    .transform((v) => (v ? v : null));

const optionalEmail = z
  .string()
  .trim()
  .max(CONTACT_LIMITS.email, { error: "That email address is too long." })
  .nullish()
  .transform((v) => (v ? v.toLowerCase() : null))
  .refine((v) => v === null || z.email().safeParse(v).success, { error: "Enter a valid email address, like name@company.in." });

const optionalPhone = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null))
  .superRefine((v, ctx) => {
    if (v === null) return;
    const r = validateIndianPhone(v);
    if (!r.ok) ctx.addIssue({ code: "custom", message: r.error });
  });

const optionalWhatsApp = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isWhatsAppNumber(v), {
    error: "This number can't receive WhatsApp. Use a 10-digit mobile number (landlines aren't on WhatsApp).",
  });

const handles = z
  .array(z.enum(SERVICE_TYPES, { error: "Choose a service from the list." }))
  .max(SERVICE_TYPES.length)
  .default([])
  .transform((list) => SERVICE_TYPES.filter((s) => list.includes(s)) as ServiceType[]);

const role = z
  .union([z.enum(CONTACT_ROLES, { error: "Choose a role from the list." }), z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

const contactFields = {
  name: z
    .string()
    .trim()
    .min(1, { error: "Enter the contact's name." })
    .max(CONTACT_LIMITS.name, { error: `Keep the name under ${CONTACT_LIMITS.name} characters.` }),
  role,
  email: optionalEmail,
  phone: optionalPhone,
  whatsapp: optionalWhatsApp,
  handles,
  notes: optionalText(CONTACT_LIMITS.notes, `Keep the notes under ${CONTACT_LIMITS.notes.toLocaleString("en-IN")} characters.`),
};

export const CreateContactSchema = z.object({
  clientId: uuid("client"),
  ...contactFields,
  /** Make this the primary contact (the old primary is demoted in the same statement). */
  isPrimary: z.boolean().default(false),
});
export type CreateContactInput = z.input<typeof CreateContactSchema>;

export const UpdateContactSchema = z.object({
  id: uuid("contact"),
  clientId: uuid("client"),
  /** The row's updated_at when the form loaded (§13 optimistic concurrency). */
  updatedAt: z.string().min(1, { error: "Reload the page and try again." }),
  ...contactFields,
});
export type UpdateContactInput = z.input<typeof UpdateContactSchema>;

export const DeleteContactSchema = z.object({
  id: uuid("contact"),
  clientId: uuid("client"),
  updatedAt: z.string().min(1, { error: "Reload the page and try again." }),
});
export type DeleteContactInput = z.input<typeof DeleteContactSchema>;

export const SetPrimaryContactSchema = z.object({
  id: uuid("contact"),
  clientId: uuid("client"),
  updatedAt: z.string().min(1, { error: "Reload the page and try again." }),
});
export type SetPrimaryContactInput = z.input<typeof SetPrimaryContactSchema>;

/** Empty form values for a new contact. */
export function emptyContact(clientId: string, opts: { isPrimary?: boolean } = {}): CreateContactInput {
  return { clientId, name: "", role: "", email: "", phone: "", whatsapp: "", handles: [], notes: "", isPrimary: opts.isPrimary ?? false };
}

/** "Director · handles GST returns, TDS/TCS" for the contact row; null when there is nothing to say. */
export function contactSubline(c: { role: string | null; handles: readonly string[] }, serviceLabel: (s: string) => string): string | null {
  const parts: string[] = [];
  if (c.role) parts.push(c.role);
  if (c.handles.length > 0) parts.push(`handles ${c.handles.map(serviceLabel).join(", ")}`);
  return parts.length ? parts.join(" · ") : null;
}
