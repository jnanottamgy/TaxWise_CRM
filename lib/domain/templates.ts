/**
 * Message templates and their `{{variables}}` (§5.9, §7.13.4).
 *
 * The variables are a fixed list, inserted from a picker; a template that uses anything else is
 * rejected on save, and the save names the offending variables. Rendering is plain text (WhatsApp
 * drafts, Gmail bodies, the text part of emails): no HTML escaping here; the email renderer escapes
 * when it builds HTML.
 *
 * Pure and client-safe.
 */

import type { FieldErrors } from "@/lib/result";

/** The allowed variables, grouped as the picker shows them (§7.13.4). */
export const TEMPLATE_VARIABLE_GROUPS = [
  { group: "Client", variables: ["client_name", "client_code", "contact_name"] },
  {
    group: "Work",
    variables: [
      "service_type",
      "compliance_type",
      "period",
      "due_date",
      "days_until_due",
      "days_overdue",
      "task_title",
      "missing_items",
      "priority",
    ],
  },
  { group: "Money", variables: ["invoice_number", "amount", "payment_link", "upi_link"] },
  { group: "Links", variables: ["portal_link", "quotation_link"] },
  { group: "Firm", variables: ["firm_name", "firm_phone", "sender_name"] },
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLE_GROUPS)[number]["variables"][number];

/** Every allowed variable name, in picker order (§7.13.4). */
export const TEMPLATE_VARIABLES: readonly TemplateVariable[] = TEMPLATE_VARIABLE_GROUPS.flatMap((g) => g.variables);

/** True for an allowed variable name (without braces). */
export function isTemplateVariable(name: string): name is TemplateVariable {
  return (TEMPLATE_VARIABLES as readonly string[]).includes(name);
}

/** `{{client_name}}`: how a variable is written in a template. */
export function variableToken(name: TemplateVariable): string {
  return `{{${name}}}`;
}

const TOKEN = /\{\{([^{}]*)\}\}/g;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Token = { raw: string; name: string; wellFormed: boolean };

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const name = m[1].trim();
    out.push({ raw: m[0], name, wellFormed: NAME.test(name) });
  }
  return out;
}

/**
 * The variable names a text uses, in order of first use, without duplicates (`{{ client_name }}`
 * counts as `client_name`). Unknown names are included; malformed tokens are not.
 */
export function extractVariables(text: string): string[] {
  const seen: string[] = [];
  for (const t of tokens(text)) if (t.wellFormed && !seen.includes(t.name)) seen.push(t.name);
  return seen;
}

/** Placeholders that aren't a `{{name}}`: `{{client name}}`, `{{}}`, or a stray `{{` / `}}`. */
function malformedTokens(text: string): string[] {
  const bad = tokens(text).filter((t) => !t.wellFormed).map((t) => t.raw);
  const rest = text.replace(TOKEN, "");
  if (rest.includes("{{")) bad.push("{{");
  if (rest.includes("}}")) bad.push("}}");
  return Array.from(new Set(bad));
}

export type TemplateValidation =
  | { ok: true; variables: TemplateVariable[] }
  | {
      ok: false;
      error: string;
      fieldErrors: FieldErrors;
      /** Variable names that aren't in the list (e.g. `client_email`). */
      unknown: string[];
      /** Placeholders that aren't well formed. */
      malformed: string[];
    };

function describeProblems(unknown: string[], malformed: string[]): string {
  const parts: string[] = [];
  if (unknown.length > 0) {
    const hints = unknown.map((name) => {
      const lower = name.toLowerCase();
      return isTemplateVariable(lower) ? `{{${name}}} (did you mean {{${lower}}}?)` : `{{${name}}}`;
    });
    parts.push(`${unknown.length === 1 ? "This variable isn't" : "These variables aren't"} available: ${hints.join(", ")}. Pick variables from the list.`);
  }
  if (malformed.length > 0) parts.push(`Fix the placeholder${malformed.length === 1 ? "" : "s"} ${malformed.join(", ")}: write variables as {{name}}.`);
  return parts.join(" ");
}

/**
 * Validates a template before it is saved (§7.13.4): the body is required; the body and subject may
 * use only the allowed variables, written `{{name}}`. Unknown or malformed variables are rejected,
 * and the result says which (per field).
 */
export function validateTemplate(body: string, subject?: string | null): TemplateValidation {
  const fieldErrors: FieldErrors = {};
  const unknownAll: string[] = [];
  const malformedAll: string[] = [];
  const check = (field: "body" | "subject", text: string) => {
    const unknown = extractVariables(text).filter((n) => !isTemplateVariable(n));
    const malformed = malformedTokens(text);
    if (unknown.length > 0 || malformed.length > 0) fieldErrors[field] = [describeProblems(unknown, malformed)];
    for (const n of unknown) if (!unknownAll.includes(n)) unknownAll.push(n);
    for (const m of malformed) if (!malformedAll.includes(m)) malformedAll.push(m);
  };

  if (body.trim() === "") fieldErrors.body = ["Write the message."];
  else check("body", body);
  if (subject) check("subject", subject);

  if (Object.keys(fieldErrors).length > 0) {
    const error = fieldErrors.body?.[0] ?? fieldErrors.subject?.[0] ?? "Check the template.";
    return { ok: false, error, fieldErrors, unknown: unknownAll, malformed: malformedAll };
  }
  const variables = extractVariables(`${subject ?? ""}\n${body}`).filter(isTemplateVariable);
  return { ok: true, variables };
}

export type TemplateValues = Partial<Record<TemplateVariable, string | number | null | undefined>>;

/** How a variable with no value renders: `empty` (sending) or `mark` (`[client_name]`, previews). */
export type MissingMode = "empty" | "mark";

/** The marker for a variable with no value in `mark` mode: `[client_name]`. */
export function missingMarker(name: string): string {
  return `[${name}]`;
}

/**
 * Renders a template as plain text (§7.13.4): each `{{name}}` (spaces inside the braces allowed)
 * becomes its value. A variable with no value (null, undefined or empty), or one not in the list,
 * renders as an empty string, or as `[name]` with `missing: 'mark'`. Malformed placeholders are
 * left as written.
 */
export function renderTemplate(text: string, values: TemplateValues, opts: { missing?: MissingMode } = {}): string {
  const mode = opts.missing ?? "empty";
  return text.replace(TOKEN, (raw: string, inner: string) => {
    const name = inner.trim();
    if (!NAME.test(name)) return raw;
    const value = isTemplateVariable(name) ? values[name] : undefined;
    if (value === null || value === undefined || value === "") return mode === "mark" ? missingMarker(name) : "";
    return String(value);
  });
}

/** The variables a text uses that have no value: what a preview should point out before sending. */
export function missingVariables(text: string, values: TemplateValues): string[] {
  return extractVariables(text).filter((name) => {
    if (!isTemplateVariable(name)) return true;
    const v = values[name];
    return v === null || v === undefined || v === "";
  });
}

/**
 * Values for the template preview, which renders with a sample client (§7.13.4). Display only:
 * never saved and never sent.
 */
export const SAMPLE_TEMPLATE_VALUES: Readonly<Record<TemplateVariable, string>> = {
  client_name: "Sample Traders Pvt Ltd",
  client_code: "TW-C-0001",
  contact_name: "Priya",
  service_type: "GST returns", // as live drafts name it (SERVICE_TYPE_LABELS.gst)
  compliance_type: "GSTR-3B",
  period: "Sep 2026",
  due_date: "20 Oct 2026",
  days_until_due: "5",
  days_overdue: "3",
  task_title: "GSTR-3B for Sep 2026",
  missing_items: "Sales register, Purchase register",
  priority: "High",
  invoice_number: "TW/26-27/0042",
  amount: "₹11,800.00",
  payment_link: "https://example.com/portal/invoices/sample",
  upi_link: "upi://pay?pa=sample@bank&pn=TaxWise%20Consultants&am=11800.00&tn=TW%2F26-27%2F0042&cu=INR",
  portal_link: "https://example.com/portal",
  quotation_link: "https://example.com/q/sample",
  firm_name: "TaxWise Consultants",
  firm_phone: "+91 80 0000 0000",
  sender_name: "Ravi",
};
