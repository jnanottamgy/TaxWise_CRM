import { z } from "zod";
import { TEMPLATE_TYPES, type TemplateType } from "@/lib/domain/enums";
import {
  SAMPLE_TEMPLATE_VALUES,
  TEMPLATE_VARIABLE_GROUPS,
  extractVariables,
  isTemplateVariable,
  renderTemplate,
  validateTemplate,
  type TemplateValues,
  type TemplateVariable,
} from "@/lib/domain/templates";
import type { AppRole } from "@/lib/auth/roles";

/**
 * Message templates (§5.9, §7.13.4): the form schema shared by the editor and the save action, the
 * words the screens use for each type and channel, the list's filters, and the small pure helpers
 * the editor needs (inserting a variable at the cursor, the preview values, a copy's name).
 *
 * Unknown variables are rejected on save (validateTemplate, lib/domain/templates.ts); the database
 * refuses them too (message_templates_guard, 0170). Payment-reminder and quotation templates are on
 * the money side: Employees never see them (§4.1, RLS 0170). Client-safe.
 */

export const TEMPLATE_TYPE_LABELS: Record<TemplateType, string> = {
  document_reminder: "Document reminder",
  compliance_reminder: "Compliance reminder",
  payment_reminder: "Payment reminder",
  task_assignment: "Task assignment",
  overdue_notification: "Overdue notice",
  quotation: "Quotation",
  welcome: "Welcome",
  custom: "Custom",
};

/** What each type is for, shown under the type picker. */
export const TEMPLATE_TYPE_HINTS: Record<TemplateType, string> = {
  document_reminder: "Asking a client for documents or data: data awaited tasks and document requests.",
  compliance_reminder: "A return or filing that is due, sent to the contact who handles that service.",
  payment_reminder: "An invoice before or after its due date. Partners and Managers only.",
  task_assignment: "Telling a client who is working on their job and when it is due.",
  overdue_notification: "A deadline that has passed and what happens next.",
  quotation: "Covering note for a quotation, with its public link. Partners and Managers only.",
  welcome: "A new client: who looks after them and how to share documents.",
  custom: "Anything else.",
};

export const TEMPLATE_CHANNELS = ["email", "whatsapp", "any"] as const;
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number];

export const TEMPLATE_CHANNEL_LABELS: Record<TemplateChannel, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  any: "Any",
};

/** Types on the money side (is_money_message, 0043): never offered to Employees. */
export const MONEY_TEMPLATE_TYPES: readonly TemplateType[] = ["payment_reminder", "quotation"];

export function isMoneyTemplateType(type: string | null | undefined): boolean {
  return (MONEY_TEMPLATE_TYPES as readonly string[]).includes(type ?? "");
}

/** The types a role may see and pick (§4.1). */
export function templateTypesFor(role: AppRole): TemplateType[] {
  const seesMoney = role === "partner" || role === "manager";
  return TEMPLATE_TYPES.filter((t) => seesMoney || !isMoneyTemplateType(t));
}

export function isTemplateChannel(v: unknown): v is TemplateChannel {
  return typeof v === "string" && (TEMPLATE_CHANNELS as readonly string[]).includes(v);
}

/** Where a draft is going: a WhatsApp or a portal text (the app sends no email). */
export type TemplateUse = "whatsapp" | "portal";

/**
 * True when a template's channel fits a use: Any fits everything; an old Email template is offered
 * for portal messages but never for WhatsApp.
 */
export function channelFits(channel: string, use: TemplateUse): boolean {
  if (channel === "any") return true;
  if (use === "whatsapp") return channel === "whatsapp";
  return channel === "whatsapp" || channel === "email";
}

/**
 * The firm's templates offered beside a WhatsApp draft (§7.13.4): the WhatsApp and Any ones (only
 * those of `types`, when given), each filled in for this recipient. A variable the screen can't fill
 * stays as [period] for the person to complete; `sign` ends each with the sender's signature.
 *
 *   templates={whatsAppTemplateOptions(m.templates, { client_name, contact_name, firm_name }, { types: ["custom"], sign })}
 */
export function whatsAppTemplateOptions(
  templates: ReadonlyArray<{ id: string; name: string; type?: string | null; channel: string; body: string }>,
  values: TemplateValues,
  opts: { types?: readonly string[]; sign?: (text: string) => string } = {},
): Array<{ id: string; name: string; body: string }> {
  return templates
    .filter((t) => channelFits(t.channel, "whatsapp") && (!opts.types || opts.types.includes(t.type ?? "")))
    .map((t) => {
      const body = renderTemplate(t.body, values, { missing: "mark" });
      return { id: t.id, name: t.name, body: opts.sign ? opts.sign(body) : body };
    });
}

// -------------------------------------------------------------------------------------------------
// The form
// -------------------------------------------------------------------------------------------------

export const TEMPLATE_NAME_MAX = 120;
export const TEMPLATE_SUBJECT_MAX = 300;
export const TEMPLATE_BODY_MAX = 5000;

const optionalId = z.union([z.uuid(), z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));

export const MessageTemplateSchema = z
  .object({
    id: optionalId,
    /** The row's updated_at when the editor opened (optimistic concurrency, §13). */
    expected_updated_at: z.string().nullish().transform((v) => v || null),
    name: z.string().trim().min(1, { error: "Give the template a name." }).max(TEMPLATE_NAME_MAX, { error: `Keep the name under ${TEMPLATE_NAME_MAX} characters.` }),
    type: z.enum(TEMPLATE_TYPES, { error: "Choose the type." }),
    channel: z.enum(TEMPLATE_CHANNELS, { error: "Choose the channel." }),
    subject: z
      .string()
      .trim()
      .max(TEMPLATE_SUBJECT_MAX, { error: `Keep the subject under ${TEMPLATE_SUBJECT_MAX} characters.` })
      .nullish()
      .transform((v) => (v ? v : null)),
    body: z.string().max(TEMPLATE_BODY_MAX, { error: `Keep the message under ${TEMPLATE_BODY_MAX.toLocaleString("en-IN")} characters.` }),
    is_active: z.boolean().default(true),
  })
  .transform((v) => ({ ...v, subject: v.channel === "whatsapp" ? null : v.subject, body: v.body.replace(/\r\n?/g, "\n").replace(/\s+$/, "") }))
  .superRefine((v, ctx) => {
    const check = validateTemplate(v.body, v.subject);
    if (check.ok) return;
    for (const [field, messages] of Object.entries(check.fieldErrors)) {
      for (const message of messages) ctx.addIssue({ code: "custom", path: [field], message });
    }
  });
export type MessageTemplateInput = z.input<typeof MessageTemplateSchema>;
export type MessageTemplateValues = z.output<typeof MessageTemplateSchema>;

export const SetTemplateActiveSchema = z.object({
  id: z.uuid(),
  is_active: z.boolean(),
  expected_updated_at: z.string().min(1),
});

export const TemplateIdSchema = z.object({ id: z.uuid({ error: "That template id isn't valid." }) });

// -------------------------------------------------------------------------------------------------
// The list (§2.3: filters, sort and paging in SQL)
// -------------------------------------------------------------------------------------------------

export const TEMPLATE_STATES = ["active", "inactive"] as const;

export const TEMPLATE_FILTERS = {
  type: TEMPLATE_TYPES as readonly string[],
  channel: TEMPLATE_CHANNELS as readonly string[],
  state: TEMPLATE_STATES as readonly string[],
};
export const TEMPLATE_FILTER_NAMES = Object.keys(TEMPLATE_FILTERS);
export const TEMPLATE_SORTABLE = ["name", "type", "channel", "updated_at"] as const;
export type TemplateSort = (typeof TEMPLATE_SORTABLE)[number];

// -------------------------------------------------------------------------------------------------
// Editor helpers
// -------------------------------------------------------------------------------------------------

/** What each variable means, for the picker's hover text. */
export const TEMPLATE_VARIABLE_HINTS: Record<TemplateVariable, string> = {
  client_name: "The client's name",
  client_code: "The client code, e.g. TW-C-0001",
  contact_name: "The first name of the contact the message goes to",
  service_type: "The service: GST, Income tax, TDS …",
  compliance_type: "The return or filing: GSTR-3B, 24Q, ITR …",
  period: "The period: Sep 2026, Q2 2026-27",
  due_date: "The due date, e.g. 20 Oct 2026",
  days_until_due: "Days left until the due date",
  days_overdue: "Days since the due date",
  task_title: "The task's title",
  missing_items: "What is still needed, one per line",
  priority: "The task's priority",
  invoice_number: "The invoice number",
  amount: "The amount, e.g. ₹11,800.00",
  payment_link: "The portal page where the client pays",
  upi_link: "The UPI pay link",
  portal_link: "The client portal",
  quotation_link: "The quotation's public page",
  firm_name: "TaxWise Consultants",
  firm_phone: "The firm's phone number",
  sender_name: "Your name",
};

/** The picker's groups; Employees don't get the Money group (§4.1). */
export function variableGroupsFor(role: AppRole): Array<{ group: string; variables: readonly TemplateVariable[] }> {
  const seesMoney = role === "partner" || role === "manager";
  return TEMPLATE_VARIABLE_GROUPS.filter((g) => seesMoney || g.group !== "Money").map((g) => ({ group: g.group, variables: g.variables }));
}

/**
 * Inserts `{{name}}` into `text` at the selection [start, end) (replacing any selected text) and
 * returns the new text and where the cursor goes (just after the token).
 */
export function insertVariable(text: string, name: TemplateVariable, start: number | null | undefined, end?: number | null): { text: string; cursor: number } {
  const token = `{{${name}}}`;
  const from = Math.max(0, Math.min(text.length, start ?? text.length));
  const to = Math.max(from, Math.min(text.length, end ?? from));
  const next = text.slice(0, from) + token + text.slice(to);
  return { text: next, cursor: from + token.length };
}

/** The variables a template uses that are allowed, in order of first use (subject first). */
export function usedVariables(body: string, subject?: string | null): TemplateVariable[] {
  return extractVariables(`${subject ?? ""}\n${body}`).filter(isTemplateVariable);
}

/**
 * The preview's values (§7.13.4 "Preview renders with a sample client"): the sample client from
 * lib/domain/templates.ts, with the firm's real name and phone, the signed-in person as the
 * sender, and the real portal address.
 */
export function previewValues(ctx: { firmName?: string | null; firmPhone?: string | null; senderName?: string | null; portalLink?: string | null }): TemplateValues {
  return {
    ...SAMPLE_TEMPLATE_VALUES,
    ...(ctx.firmName ? { firm_name: ctx.firmName } : {}),
    ...(ctx.firmPhone ? { firm_phone: ctx.firmPhone } : {}),
    ...(ctx.senderName ? { sender_name: ctx.senderName } : {}),
    ...(ctx.portalLink ? { portal_link: ctx.portalLink } : {}),
  };
}

/** "Payment reminder (copy)", then "(copy 2)", "(copy 3)" … avoiding names already taken (case-insensitive, like citext). */
export function copyName(name: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((t) => t.trim().toLowerCase()));
  const base = name.trim().replace(/\s+\(copy(?: \d+)?\)$/i, "");
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? " (copy)" : ` (copy ${n})`;
    const candidate = `${base.slice(0, TEMPLATE_NAME_MAX - suffix.length)}${suffix}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  return `${base.slice(0, TEMPLATE_NAME_MAX - 20)} (copy ${Date.now() % 100000})`;
}

/** "Dear {{contact_name}}," alone on its line: every email template starts that way, so it says nothing in a list. */
const SALUTATION_LINE = /^(dear|hi|hello|namaste|namaskara|respected|greetings)\b[^.!?]{0,60},$/i;

/**
 * The first line of a body that says something, for the list: a salutation on its own line is
 * skipped when more follows. Variables kept as written, trimmed to `max` characters.
 */
export function bodySnippet(body: string, max = 110): string {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const line = (lines.length > 1 && SALUTATION_LINE.test(lines[0]) ? lines[1] : lines[0]) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
