/**
 * WhatsApp groups, Settings → WhatsApp and the desktop API (§7.25, §7.21, docs/DESKTOP-API.md): zod
 * schemas shared by the forms (react-hook-form + zodResolver) and the server (defineAction and the
 * route handlers parse again). Inputs are what a form holds; outputs are what the server writes.
 *
 * Client-safe: pure, no server imports.
 */

import { z } from "zod";
import { isDateString, todayIST } from "@/lib/domain/fy";
import { normalizeWhatsAppNumber } from "@/lib/domain/messaging";
import {
  CHECKLIST_STEP_IDS,
  DESKTOP_ROLES,
  DEVICE_KEY_PATTERN,
  DEVICE_LIMIT_OPTIONS,
  GROUP_NAME_MAX,
  REGISTER_STATUSES,
  WHATSAPP_MEMBER_KINDS,
  WHATSAPP_NUMBER_KINDS,
  normaliseInviteLink,
  validateGroupNameFormat,
  type ChecklistStepId,
} from "@/lib/domain/whatsapp";

const RELOAD = "Reload the page and try again.";

const id = z.uuid({ error: RELOAD });
const token = z.string({ error: RELOAD }).min(1, { error: RELOAD });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Use ${max} characters or fewer.` })
    .nullish()
    .transform((v) => (v ? v : null));

/** A date (YYYY-MM-DD) that isn't after today in IST. */
const pastDate = (label: string) =>
  z
    .string({ error: `Enter ${label}.` })
    .trim()
    .min(1, { error: `Enter ${label}.` })
    .refine((v) => isDateString(v), { error: `Enter ${label} as a date.` })
    .refine((v) => !isDateString(v) || v <= todayIST(), { error: `${label[0].toUpperCase()}${label.slice(1)} can't be in the future.` });

const groupName = z
  .string({ error: "Enter the group's name." })
  .transform((v) => v.replace(/\s+/g, " ").trim())
  .pipe(
    z
      .string()
      .min(3, { error: "Enter the group's name." })
      .max(GROUP_NAME_MAX, { error: `WhatsApp group names are at most ${GROUP_NAME_MAX} characters.` }),
  );

// -------------------------------------------------------------------------------------------------
// Groups (§7.25.1–§7.25.2)
// -------------------------------------------------------------------------------------------------

/** "Set up the WhatsApp group" (the name comes from the Settings format) or "Add another group". */
export const StartGroupSchema = z.object({
  clientId: id,
  /** Only for another group: the first group's name always follows the format. */
  name: z
    .string()
    .transform((v) => v.replace(/\s+/g, " ").trim())
    .pipe(z.string().max(GROUP_NAME_MAX, { error: `WhatsApp group names are at most ${GROUP_NAME_MAX} characters.` }))
    .optional(),
  purpose: optionalText(120),
});
export type StartGroupInput = z.input<typeof StartGroupSchema>;

export const UpdateGroupSchema = z.object({
  groupId: id,
  updatedAt: token,
  name: groupName,
  purpose: optionalText(120),
  notes: optionalText(2000),
});
export type UpdateGroupInput = z.input<typeof UpdateGroupSchema>;

/** Steps 1–6 are ticked by hand; step 7 is Mark created. */
export const TICKABLE_STEPS = CHECKLIST_STEP_IDS.filter((s) => s !== "mark_created") as Exclude<ChecklistStepId, "mark_created">[];

export const TickStepSchema = z.object({
  groupId: id,
  updatedAt: token,
  step: z.enum(TICKABLE_STEPS as [Exclude<ChecklistStepId, "mark_created">, ...Exclude<ChecklistStepId, "mark_created">[]], { error: RELOAD }),
  done: z.boolean(),
});
export type TickStepInput = z.input<typeof TickStepSchema>;

/** Step 3: the client contacts to add. */
export const SelectContactsSchema = z.object({
  groupId: id,
  updatedAt: token,
  contactIds: z.array(id).max(50, { error: "Choose at most 50 contacts." }),
});
export type SelectContactsInput = z.input<typeof SelectContactsSchema>;

const inviteLink = z
  .string()
  .trim()
  .max(300, { error: "That isn't a WhatsApp invite link." })
  .nullish()
  .transform((v) => (v ? v : null))
  .superRefine((v, ctx) => {
    if (v && !normaliseInviteLink(v)) ctx.addIssue({ code: "custom", message: "Paste the link from WhatsApp → Group info → Invite via link. It starts https://chat.whatsapp.com/." });
  })
  .transform((v) => (v ? normaliseInviteLink(v) : null));

/** Step 7 (§7.25.2): date (default today), the firm number that created it, the invite link (optional). */
export const MarkCreatedSchema = z.object({
  groupId: id,
  updatedAt: token,
  createdOn: pastDate("the date the group was created"),
  createdByNumberId: z.uuid({ error: "Choose the firm number that created the group." }),
  inviteLink,
});
export type MarkCreatedInput = z.input<typeof MarkCreatedSchema>;

/** Close group (§7.25.2): a reason and a closing date. */
export const CloseGroupSchema = z.object({
  groupId: id,
  updatedAt: token,
  closedOn: pastDate("the closing date"),
  reason: z
    .string({ error: "Say why the group is being closed." })
    .trim()
    .min(3, { error: "Say why the group is being closed." })
    .max(500, { error: "Use 500 characters or fewer." }),
});
export type CloseGroupInput = z.input<typeof CloseGroupSchema>;

export const GroupIdSchema = z.object({ groupId: id });
export type GroupIdInput = z.input<typeof GroupIdSchema>;

/**
 * Open chat from a page (§7.25.1, §7.25.8): a browser window, the phone app, or TaxWise Desktop for
 * a group other than the client's primary one (the app's own Open chat opens the primary group and
 * makes this check itself through /api/desktop/whatsapp/open).
 */
export const OpenChatSchema = z.object({
  clientId: id,
  groupId: id.nullish().transform((v) => v ?? null),
  via: z.enum(["browser", "phone", "desktop"], { error: RELOAD }),
});
export type OpenChatInput = z.input<typeof OpenChatSchema>;

/** A member added by hand (`source = 'manual'`). */
export const AddMemberSchema = z
  .object({
    groupId: id,
    kind: z.enum(WHATSAPP_MEMBER_KINDS, { error: "Choose who to add." }),
    firmNumberId: id.nullish().transform((v) => v ?? null),
    contactId: id.nullish().transform((v) => v ?? null),
    displayName: optionalText(200),
    number: optionalText(40),
    isAdmin: z.boolean().default(false),
    addedOn: pastDate("the date they were added"),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "firm_number" && !v.firmNumberId) ctx.addIssue({ code: "custom", path: ["firmNumberId"], message: "Choose the firm number." });
    if (v.kind === "client_contact" && !v.contactId) ctx.addIssue({ code: "custom", path: ["contactId"], message: "Choose the contact." });
    if (v.kind === "other_person") {
      if (!v.displayName) ctx.addIssue({ code: "custom", path: ["displayName"], message: "Enter their name." });
      if (!normalizeWhatsAppNumber(v.number ?? "")) ctx.addIssue({ code: "custom", path: ["number"], message: "Enter a mobile number WhatsApp can use, like +91 98765 43210." });
    }
  });
export type AddMemberInput = z.input<typeof AddMemberSchema>;

export const UpdateMemberSchema = z.object({
  memberId: id,
  updatedAt: token,
  isAdmin: z.boolean().optional(),
  /** Set to record that the member left the group. */
  removedOn: z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || isDateString(v), { error: "Enter the date as a date." })
    .refine((v) => v === null || v <= todayIST(), { error: "The date can't be in the future." }),
});
export type UpdateMemberInput = z.input<typeof UpdateMemberSchema>;

/** House rule 7: record a firm number as removed from the selected groups. */
export const RemoveNumberFromGroupsSchema = z.object({
  numberId: id,
  groupIds: z.array(id).min(1, { error: "Choose the groups first." }).max(500, { error: "Record at most 500 groups at a time." }),
});
export type RemoveNumberFromGroupsInput = z.input<typeof RemoveNumberFromGroupsSchema>;

// -------------------------------------------------------------------------------------------------
// The WhatsApp groups page (§7.25.1)
// -------------------------------------------------------------------------------------------------

export const REGISTER_SORTABLE = ["client_name", "status_rank", "group_name", "member_count", "last_opened_at", "created_on"] as const;
export type RegisterSort = (typeof REGISTER_SORTABLE)[number];
export const REGISTER_FILTERS = { status: REGISTER_STATUSES, number: null, primary: ["1"] } as const;

// -------------------------------------------------------------------------------------------------
// Settings → WhatsApp (§7.21)
// -------------------------------------------------------------------------------------------------

const SIGNATURE_TOKEN = /\{([^{}]*)\}/g;

function signatureError(v: string): string | null {
  if (!v) return "Enter the signature, for example – {first_name}.";
  const unknown = [...v.matchAll(SIGNATURE_TOKEN)].map((m) => m[1].trim()).filter((n) => n !== "first_name");
  if (unknown.length) return `{${unknown[0]}} isn't a placeholder the signature can use. Use {first_name}.`;
  if (v.replace(SIGNATURE_TOKEN, "").match(/[{}]/)) return "A brace is left unmatched. The placeholder is {first_name}.";
  if (!/\{\s*first_name\s*\}/.test(v)) return "Include {first_name}, so the client knows who wrote the message.";
  return null;
}

const httpsUrl = z
  .string()
  .trim()
  .max(500, { error: "Use 500 characters or fewer." })
  .nullish()
  .transform((v) => (v ? v : null))
  .refine(
    (v) => {
      if (v === null) return true;
      try {
        const u = new URL(v);
        return u.protocol === "https:" && !u.username && !u.password;
      } catch {
        return false;
      }
    },
    { error: "Enter the installer's full https:// address." },
  );

export const WhatsAppSettingsSchema = z.object({
  updated_at: token,
  whatsapp_country_code: z
    .string({ error: "Enter the country code." })
    .trim()
    .transform((v) => v.replace(/^\+/, ""))
    .pipe(z.string().regex(/^[1-9][0-9]{0,3}$/, { error: "Enter the country code as 1 to 4 digits, like 91." })),
  whatsapp_group_name_format: z
    .string({ error: "Enter the group name format." })
    .transform((v) => v.replace(/\s+/g, " ").trim())
    .superRefine((v, ctx) => {
      const r = validateGroupNameFormat(v);
      if (!r.ok) ctx.addIssue({ code: "custom", message: r.error });
    }),
  whatsapp_signature: z
    .string({ error: "Enter the signature." })
    .transform((v) => v.replace(/\s+/g, " ").trim())
    .pipe(z.string().max(40, { error: "Use 40 characters or fewer." }))
    .superRefine((v, ctx) => {
      const e = signatureError(v);
      if (e) ctx.addIssue({ code: "custom", message: e });
    }),
  whatsapp_client_mode: z.boolean(),
  whatsapp_employee_notifications: z.boolean(),
  whatsapp_employee_browser_window: z.boolean(),
  whatsapp_linked_device_limit: z
    .union([z.string(), z.number()], { error: "Choose the linked device limit." })
    .transform((v) => Number(v))
    .refine((v) => (DEVICE_LIMIT_OPTIONS as readonly number[]).includes(v), { error: "Choose 4, or 10 with Meta Verified multi-agent." }),
  desktop_download_url: httpsUrl,
  /** House rules (§7.25.10), shown to staff. */
  whatsapp_house_rules: z
    .string({ error: "Enter the house rules." })
    .transform((v) => v.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim())
    .pipe(z.string().min(20, { error: "Enter the house rules staff should follow." }).max(8000, { error: "Use 8,000 characters or fewer." })),
});
export type WhatsAppSettingsInput = z.input<typeof WhatsAppSettingsSchema>;
export type WhatsAppSettingsValues = z.output<typeof WhatsAppSettingsSchema>;


/** An optional id from a select; "" or "none" (the select's "Nobody" choice) is null. */
const optionalId = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v && v !== "none" ? v : null))
  .pipe(z.uuid({ error: RELOAD }).nullable());

/** One firm WhatsApp number (§5.13, §7.21). `country_code` is the firm's default, for normalising. */
export const FirmNumberSchema = z
  .object({
    id: optionalId,
    updated_at: z
      .string()
      .nullish()
      .transform((v) => (v ? v : null)),
    country_code: z
      .string()
      .trim()
      .regex(/^[1-9][0-9]{0,3}$/)
      .default("91"),
    label: z
      .string({ error: "Enter a label, such as Staff office." })
      .transform((v) => v.replace(/\s+/g, " ").trim())
      .pipe(z.string().min(2, { error: "Enter a label, such as Staff office." }).max(80, { error: "Use 80 characters or fewer." })),
    number: z
      .string()
      .trim()
      .max(30, { error: "That doesn't look like a phone number." })
      .nullish()
      .transform((v) => (v ? v : null)),
    kind: z.enum(WHATSAPP_NUMBER_KINDS, { error: "Choose what kind of number this is." }),
    employee_id: optionalId,
    custodian_employee_id: optionalId,
    in_every_client_group: z.boolean(),
    group_admin: z.boolean(),
    shared: z.boolean(),
    usable_by: z.array(z.enum(DESKTOP_ROLES, { error: "Choose Partners, Managers or Employees." })).transform((v) => DESKTOP_ROLES.filter((r) => v.includes(r))),
    two_step_verification_on: z.boolean(),
    is_active: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.number && !normalizeWhatsAppNumber(v.number, { countryCode: v.country_code })) {
      ctx.addIssue({ code: "custom", path: ["number"], message: "Enter a mobile number WhatsApp can use, like +91 98765 43210." });
    }
    if (v.is_active && !v.number) ctx.addIssue({ code: "custom", path: ["number"], message: "Enter the number before switching it on." });
    if (v.kind === "partner") {
      if (v.is_active && !v.employee_id) ctx.addIssue({ code: "custom", path: ["employee_id"], message: "Choose the Partner whose number this is." });
      if (v.usable_by.join(",") !== "partner") ctx.addIssue({ code: "custom", path: ["usable_by"], message: "A Partner's own number is used by that Partner only: choose Partners only." });
    } else if (v.employee_id) {
      ctx.addIssue({ code: "custom", path: ["employee_id"], message: "Only a Partner's own number has an owner." });
    }
    if (v.usable_by.length === 0) ctx.addIssue({ code: "custom", path: ["usable_by"], message: "Choose who may use this number in TaxWise Desktop." });
  })
  .transform((v) => ({ ...v, number: v.number ? normalizeWhatsAppNumber(v.number, { countryCode: v.country_code }) : null }));
export type FirmNumberInput = z.input<typeof FirmNumberSchema>;
export type FirmNumberValues = z.output<typeof FirmNumberSchema>;

export const NumberIdSchema = z.object({ numberId: id });
export type NumberIdInput = z.input<typeof NumberIdSchema>;

export const DeviceIdSchema = z.object({ deviceId: id });
export type DeviceIdInput = z.input<typeof DeviceIdSchema>;

export const RenameDeviceSchema = z.object({
  deviceId: id,
  name: z
    .string({ error: "Enter the PC's name." })
    .transform((v) => v.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(2, { error: "Enter a name of at least 2 characters, such as FRONTDESK-2." }).max(100, { error: "Use 100 characters or fewer." })),
});
export type RenameDeviceInput = z.input<typeof RenameDeviceSchema>;

// -------------------------------------------------------------------------------------------------
// Desktop API bodies (docs/DESKTOP-API.md)
// -------------------------------------------------------------------------------------------------

const deviceKey = z.string({ error: "This PC's key is missing." }).regex(DEVICE_KEY_PATTERN, { error: "This PC's key isn't valid." });

export const DesktopOpenBodySchema = z.object({ clientId: z.uuid({ error: "That client doesn't exist." }) });

export const DesktopCheckinBodySchema = z.object({
  deviceKey,
  deviceName: z.string().transform((v) => v.replace(/\s+/g, " ").trim().slice(0, 100)),
  os: z
    .string()
    .max(200)
    .nullish()
    .transform((v) => (v ? v.trim().slice(0, 100) : null)),
  appVersion: z
    .string()
    .max(80)
    .nullish()
    .transform((v) => (v ? v.trim().slice(0, 40) : null)),
});

export const DesktopLinkBodySchema = z.object({
  deviceKey,
  numberId: z.uuid({ error: "That firm number doesn't exist." }),
  linked: z.boolean({ error: "Say whether the number was linked or unlinked." }),
});

export const DesktopHealthBodySchema = z.object({
  deviceKey,
  failing: z.array(z.string().max(120)).max(100),
});

export const DesktopAccessDeniedBodySchema = z.object({
  deviceKey,
  numberId: z.string().max(64),
  chatTitle: z.string().max(1000),
});
