/**
 * Settings forms (§7.21, §5.2 firm_settings): one zod schema per panel, shared by the form
 * (react-hook-form + zodResolver) and the server action (defineAction parses again).
 *
 * Inputs are what the form holds (strings for typed numbers); outputs are what the database takes.
 * Every panel carries `updated_at`, the firm_settings row's timestamp when it was loaded, for the
 * optimistic concurrency check (§13).
 *
 * Client-safe: pure, no server imports.
 */

import { z } from "zod";
import { SERVICE_TYPES, type ServiceType } from "@/lib/domain/enums";
import { financialYearOf, isDateString, todayIST } from "@/lib/domain/fy";
import {
  gstinPanMismatch,
  isValidGstin,
  isValidStateCode,
  normaliseIdentifier,
  validateGstin,
  validateIfsc,
  validatePan,
  validatePincode,
  validateTan,
} from "@/lib/domain/india-validators";
import { isValidUpiId } from "@/lib/domain/messaging";
import { parseAmount } from "@/lib/domain/money";
import { checkSeriesPrefix, formatSeriesNumber, NUMBERING_DEFAULTS, SERIES, SERIES_KEYS, type SeriesKey } from "@/lib/domain/numbering";

// -------------------------------------------------------------------------------------------------
// Building blocks
// -------------------------------------------------------------------------------------------------

/** The loaded row's updated_at (§13). */
export const concurrencyToken = z
  .string({ error: "Reload the page and try again." })
  .min(1, { error: "Reload the page and try again." });

/** Optional text: trimmed; empty becomes null (the column is cleared). */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `Use ${max} characters or fewer.` })
    .nullish()
    .transform((v) => (v ? v : null));

const requiredText = (label: string, min: number, max: number) =>
  z
    .string({ error: `Enter ${label}.` })
    .trim()
    .min(min, { error: `Enter ${label}.` })
    .max(max, { error: `Use ${max} characters or fewer.` });

/** A whole number typed into a field (string or number in, number out). */
export const intField = (label: string, min: number, max: number) =>
  z
    .union([z.string(), z.number()], { error: `Enter ${label}.` })
    .transform((v) => (typeof v === "number" ? String(v) : v.trim()))
    .pipe(z.string().min(1, { error: `Enter ${label}.` }).regex(/^-?\d+$/, { error: `Enter ${label} as a whole number.` }))
    .transform((v) => Number(v))
    .pipe(
      z
        .number()
        .int()
        .min(min, { error: `${capitalise(label)} must be at least ${min}.` })
        .max(max, { error: `${capitalise(label)} can be at most ${max}.` }),
    );

/** A decimal typed into a field, at most `decimals` places. */
const decimalField = (label: string, min: number, max: number, decimals = 1) =>
  z
    .union([z.string(), z.number()], { error: `Enter ${label}.` })
    .transform((v) => (typeof v === "number" ? String(v) : v.trim()))
    .pipe(
      z
        .string()
        .min(1, { error: `Enter ${label}.` })
        .regex(new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`), { error: `Enter ${label} as a number with up to ${decimals} decimal place${decimals === 1 ? "" : "s"}.` }),
    )
    .transform((v) => Number(v))
    .pipe(
      z
        .number()
        .min(min, { error: `${capitalise(label)} must be at least ${min}.` })
        .max(max, { error: `${capitalise(label)} can be at most ${max}.` }),
    );

function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const optionalEmail = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v.toLowerCase() : null))
  .refine((v) => v === null || /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v), { error: "Enter an email address, like info@twchartered.com." });

const optionalIdentifier = (validate: (v: string) => { ok: true } | { ok: false; error: string }) =>
  z
    .string()
    .nullish()
    .transform((v) => (v ? normaliseIdentifier(v) : null))
    .superRefine((v, ctx) => {
      if (!v) return;
      const r = validate(v);
      if (!r.ok) ctx.addIssue({ code: "custom", message: r.error });
    });

// -------------------------------------------------------------------------------------------------
// Firm details (§1, §7.21)
// -------------------------------------------------------------------------------------------------

/**
 * ICAI firm registration number: six digits and the region letter (`012345S`), or the LLP form with
 * the letter first (`S100123`).
 */
export const FRN_PATTERN = /^(?:[0-9]{6}[A-Z]|[A-Z][0-9]{6})$/;
/** ICAI membership number: six digits. */
export const MEMBERSHIP_NO_PATTERN = /^[0-9]{6}$/;

export const PartnerMembershipSchema = z.object({
  id: z.uuid({ error: "Reload the page and try again." }),
  full_name: z.string().optional(),
  icai_membership_no: z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v ? v.replace(/\s+/g, "") : null))
    .refine((v) => v === null || MEMBERSHIP_NO_PATTERN.test(v), { error: "An ICAI membership number has 6 digits." }),
});

export const FirmDetailsSchema = z
  .object({
    updated_at: concurrencyToken,
    firm_name: requiredText("the firm's name", 2, 120),
    legal_name: optionalText(160),
    tagline: optionalText(120),
    address: requiredText("the registered address", 5, 300),
    city: requiredText("the city", 2, 80),
    state_code: z
      .string({ error: "Choose the state." })
      .trim()
      .refine((v) => isValidStateCode(v), { error: "Choose the state." }),
    pincode: z
      .string()
      .nullish()
      .transform((v) => (v ? v.replace(/\s+/g, "") : null))
      .superRefine((v, ctx) => {
        if (!v) return;
        const r = validatePincode(v);
        if (!r.ok) ctx.addIssue({ code: "custom", message: r.error });
      }),
    phone: optionalText(20).refine((v) => v === null || /^\+?[0-9][0-9\s-]{6,18}$/.test(v), {
      error: "Enter a phone number, like +91 97405 40239.",
    }),
    email: optionalEmail,
    website: optionalText(200).refine((v) => v === null || /^https?:\/\/[^\s]+\.[^\s]+$/i.test(v), {
      error: "Enter the full address, like https://www.twchartered.com/.",
    }),
    gstin: optionalIdentifier(validateGstin),
    pan: optionalIdentifier(validatePan),
    tan: optionalIdentifier(validateTan),
    icai_frn: z
      .string()
      .nullish()
      .transform((v) => (v ? v.replace(/\s+/g, "").toUpperCase() : null))
      .refine((v) => v === null || FRN_PATTERN.test(v), { error: "Enter the FRN as on the ICAI certificate, like 012345S." }),
    partners: z.array(PartnerMembershipSchema).max(50).default([]),
  })
  .superRefine((d, ctx) => {
    const mismatch = gstinPanMismatch(d.gstin, d.pan);
    if (mismatch) ctx.addIssue({ code: "custom", path: ["pan"], message: mismatch });
    if (d.gstin && isValidGstin(d.gstin) && d.gstin.slice(0, 2) !== d.state_code) {
      ctx.addIssue({
        code: "custom",
        path: ["state_code"],
        message: `The GSTIN is registered in state ${d.gstin.slice(0, 2)}. Choose that state, or check the GSTIN.`,
      });
    }
  });
export type FirmDetailsInput = z.input<typeof FirmDetailsSchema>;
export type FirmDetailsValues = z.output<typeof FirmDetailsSchema>;

// -------------------------------------------------------------------------------------------------
// Logo (§1, §7.21): PNG, SVG or JPG, at most 1 MB
// -------------------------------------------------------------------------------------------------

export const LOGO_MAX_BYTES = 1024 * 1024;
export const LOGO_ACCEPT = "image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg";
export type LogoKind = "png" | "jpeg" | "svg";
export const LOGO_CONTENT_TYPE: Record<LogoKind, string> = { png: "image/png", jpeg: "image/jpeg", svg: "image/svg+xml" };
export const LOGO_EXTENSION: Record<LogoKind, string> = { png: "png", jpeg: "jpg", svg: "svg" };

/**
 * What a file really is, from its first bytes (§12: by magic bytes, not the extension): PNG
 * (89 50 4E 47 0D 0A 1A 0A), JPEG (FF D8 FF), or SVG (text whose first element is <svg>, after an
 * optional BOM, XML declaration, comments and doctype). Anything else is null.
 */
export function sniffLogoKind(bytes: Uint8Array): LogoKind | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  const stripped = head
    .replace(/^﻿/, "")
    .replace(/^\s*<\?xml[^>]*\?>/i, "")
    .replace(/^(\s*<!--[\s\S]*?-->)*/, "")
    .replace(/^\s*<!DOCTYPE[^>]*>/i, "")
    .replace(/^(\s*<!--[\s\S]*?-->)*/, "")
    .trimStart();
  if (/^<svg[\s>]/i.test(stripped)) return "svg";
  return null;
}

/**
 * Refuses SVGs that could run code or fetch things when opened directly: scripts, event handlers,
 * javascript: links, embedded HTML, external references and entity declarations. Returns the reason
 * or null when it is a plain drawing.
 */
export function svgSafetyProblem(text: string): string | null {
  if (/<script[\s>]/i.test(text)) return "The SVG contains a script. Export it again as a plain drawing, or upload a PNG.";
  if (/\son[a-z]+\s*=/i.test(text)) return "The SVG contains event handlers. Export it again as a plain drawing, or upload a PNG.";
  if (/javascript:/i.test(text)) return "The SVG contains a javascript: link. Export it again as a plain drawing, or upload a PNG.";
  if (/<foreignObject[\s>]/i.test(text)) return "The SVG embeds HTML. Export it again as a plain drawing, or upload a PNG.";
  if (/<!ENTITY/i.test(text)) return "The SVG declares entities. Export it again as a plain drawing, or upload a PNG.";
  if (/(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/)/i.test(text)) {
    return "The SVG links to files on the internet. Embed everything in it, or upload a PNG.";
  }
  if (/<(?:iframe|embed|object)[\s>]/i.test(text)) return "The SVG embeds other content. Export it again as a plain drawing, or upload a PNG.";
  return null;
}

export type LogoCheck = { ok: true; kind: LogoKind } | { ok: false; error: string };

/** The full logo check for an uploaded file's bytes (used in the browser before upload and on the server). */
export function checkLogoBytes(bytes: Uint8Array, size: number = bytes.length): LogoCheck {
  if (size === 0) return { ok: false, error: "The file is empty." };
  if (size > LOGO_MAX_BYTES) {
    return { ok: false, error: `The logo is ${(size / (1024 * 1024)).toFixed(1)} MB. Use a file of at most 1 MB.` };
  }
  const kind = sniffLogoKind(bytes);
  if (!kind) return { ok: false, error: "Upload a PNG, JPG or SVG image." };
  if (kind === "svg") {
    const problem = svgSafetyProblem(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true, kind };
}

/**
 * The logo goes up in two steps, so the file never passes through a Server Action body (capped at
 * 1 MB by Next.js, which a 1 MB logo plus its envelope would exceed):
 *   1. `LogoUploadRequestSchema`: the browser says what it checked (kind and size) and gets a
 *      short-lived signed upload URL for a fresh path in the `branding` bucket;
 *   2. the browser uploads straight to Storage, then `LogoConfirmSchema` asks the server to check
 *      the stored bytes again (magic bytes, size, SVG safety) and point firm_settings at it.
 */
export const LogoUploadRequestSchema = z.object({
  kind: z.enum(["png", "jpeg", "svg"], { error: "Upload a PNG, JPG or SVG image." }),
  size: z
    .number({ error: "Choose a logo file." })
    .int()
    .min(1, { error: "The file is empty." })
    .max(LOGO_MAX_BYTES, { error: "Use a file of at most 1 MB." }),
});
export type LogoUploadRequestInput = z.input<typeof LogoUploadRequestSchema>;

/** `logo/<uuid>.<ext>` inside the branding bucket: the only paths the confirm step accepts. */
export const LOGO_PATH_PATTERN = /^logo\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|svg)$/;

export const LogoConfirmSchema = z.object({
  path: z.string().regex(LOGO_PATH_PATTERN, { error: "Upload the logo again." }),
  updated_at: concurrencyToken,
});
export type LogoConfirmInput = z.input<typeof LogoConfirmSchema>;

export const LogoRemoveSchema = z.object({ updated_at: concurrencyToken });
export type LogoRemoveInput = z.input<typeof LogoRemoveSchema>;

// -------------------------------------------------------------------------------------------------
// Bank & UPI (§7.21: shown on invoices and in the portal Pay dialog)
// -------------------------------------------------------------------------------------------------

export const BankSchema = z
  .object({
    updated_at: concurrencyToken,
    bank_name: optionalText(120),
    bank_account_name: optionalText(160),
    bank_account_number: z
      .string()
      .nullish()
      .transform((v) => (v ? v.replace(/[\s-]/g, "") : null))
      .refine((v) => v === null || /^[0-9]{9,18}$/.test(v), { error: "An Indian bank account number has 9 to 18 digits." }),
    bank_account_number_confirm: z
      .string()
      .nullish()
      .transform((v) => (v ? v.replace(/[\s-]/g, "") : null)),
    bank_ifsc: optionalIdentifier(validateIfsc),
    bank_branch: optionalText(120),
    upi_id: z
      .string()
      .trim()
      .nullish()
      .transform((v) => (v ? v : null))
      .refine((v) => v === null || isValidUpiId(v), { error: "Enter a UPI ID like taxwise@okhdfcbank." }),
    upi_payee_name: optionalText(80),
  })
  .superRefine((d, ctx) => {
    if ((d.bank_account_number ?? null) !== (d.bank_account_number_confirm ?? null)) {
      ctx.addIssue({ code: "custom", path: ["bank_account_number_confirm"], message: "The two account numbers don't match." });
    }
    const anyBank = d.bank_name || d.bank_account_name || d.bank_account_number || d.bank_ifsc || d.bank_branch;
    if (anyBank) {
      if (!d.bank_account_name) ctx.addIssue({ code: "custom", path: ["bank_account_name"], message: "Enter the account name as the bank has it." });
      if (!d.bank_account_number) ctx.addIssue({ code: "custom", path: ["bank_account_number"], message: "Enter the account number." });
      if (!d.bank_ifsc) ctx.addIssue({ code: "custom", path: ["bank_ifsc"], message: "Enter the IFSC." });
    }
    if (d.upi_id && !d.upi_payee_name) {
      ctx.addIssue({ code: "custom", path: ["upi_payee_name"], message: "Enter the payee name the UPI app should show." });
    }
  });
export type BankInput = z.input<typeof BankSchema>;
export type BankValues = z.output<typeof BankSchema>;

// -------------------------------------------------------------------------------------------------
// Numbering (§7.21, §0.1 rule 6): prefixes and the next number per series, ≤ 16 characters
// -------------------------------------------------------------------------------------------------

export const PREFIX_SERIES = SERIES_KEYS.filter((k) => SERIES[k].prefixSetting !== null) as SeriesKey[];

export const SeriesNextSchema = z.object({
  key: z.enum(SERIES_KEYS),
  next_value: intField("the next number", 1, 99_999_999),
  /** The number_series row's updated_at when loaded; null when the row didn't exist yet. */
  updated_at: z.string().nullish().transform((v) => v || null),
  /** The value loaded, to tell whether this series was changed. */
  loaded_next_value: z.number().int().nullish(),
});

export const NumberingSchema = z
  .object({
    updated_at: concurrencyToken,
    invoice_prefix: z.string().trim(),
    credit_note_prefix: z.string().trim(),
    quotation_prefix: z.string().trim(),
    receipt_prefix: z.string().trim(),
    client_code_prefix: z.string().trim(),
    series: z.array(SeriesNextSchema).max(SERIES_KEYS.length),
  })
  .superRefine((d, ctx) => {
    const fy = financialYearOf(todayIST());
    const prefixes: Partial<Record<SeriesKey, string>> = {};
    for (const key of PREFIX_SERIES) {
      const field = SERIES[key].prefixSetting as keyof typeof d & string;
      const prefix = String(d[field] ?? "");
      const check = checkSeriesPrefix(key, prefix, { fy });
      if (!check.ok) ctx.addIssue({ code: "custom", path: [field], message: check.error });
      else prefixes[key] = check.prefix;
    }
    d.series.forEach((s, i) => {
      const def = SERIES[s.key];
      const prefix = def.prefixSetting ? prefixes[s.key] : def.defaultPrefix;
      if (prefix === undefined) return; // the prefix error already explains it
      if (!Number.isSafeInteger(s.next_value) || s.next_value < 1) return; // the field's own error explains it
      const number = formatSeriesNumber(s.key, { seq: s.next_value, prefix, fy });
      if (number.length > NUMBERING_DEFAULTS.gstDocumentMaxLength) {
        ctx.addIssue({
          code: "custom",
          path: ["series", i, "next_value"],
          message: `The next ${def.noun} number would be ${number} (${number.length} characters). It can have at most ${NUMBERING_DEFAULTS.gstDocumentMaxLength}.`,
        });
      }
    });
  });
export type NumberingInput = z.input<typeof NumberingSchema>;
export type NumberingValues = z.output<typeof NumberingSchema>;

// -------------------------------------------------------------------------------------------------
// Billing (§7.21, §6.4)
// -------------------------------------------------------------------------------------------------

/** The SAC map's keys: every service type, plus individual income tax (§6.4: 998232). */
export const SAC_MAP_KEYS = [...SERVICE_TYPES, "income_tax_individual"] as const;
export type SacMapKey = (typeof SAC_MAP_KEYS)[number];

/** A SAC for services: 4, 6 or 8 digits starting 99 (§6.4: 9982, 998221 …). */
export const SAC_PATTERN = /^99[0-9]{2}(?:[0-9]{2}){0,2}$/;

const sacText = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v.replace(/\s+/g, "") : null))
  .refine((v) => v === null || SAC_PATTERN.test(v), { error: "A SAC for services has 4, 6 or 8 digits and starts with 99." });

export const SacRowSchema = z.object({ service: z.enum(SAC_MAP_KEYS), sac: sacText });

/** Rupees typed into a money field, as a decimal string (empty allowed only where a limit is off). */
const amountText = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === null || v === undefined ? "" : String(v).trim()));

export const INVOICE_APPROVAL_MODES = ["none", "above"] as const;
export const QUOTATION_APPROVAL_MODES = ["always", "never", "above"] as const;

/** `YYYY-MM`, a calendar month. */
export const MONTH_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export const BillingSchema = z
  .object({
    updated_at: concurrencyToken,
    default_tax_rate: z
      .union([z.string(), z.number()], { error: "Choose the default GST rate." })
      .transform((v) => String(v).trim())
      .pipe(z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, { error: "Enter the GST rate as a percentage, for example 18." }))
      .transform(Number)
      .pipe(z.number().min(0, { error: "The rate can't be negative." }).max(100, { error: "A GST rate can't be more than 100%." })),
    default_sac: z
      .string({ error: "Enter the default SAC." })
      .trim()
      .regex(SAC_PATTERN, { error: "A SAC for services has 4, 6 or 8 digits and starts with 99." }),
    sac_map: z.array(SacRowSchema).max(SAC_MAP_KEYS.length),
    payment_terms_days: intField("the payment terms", 0, 365),
    invoice_terms: optionalText(2000),
    invoice_footer_note: optionalText(500),
    round_off_enabled: z.boolean(),
    invoice_approval_mode: z.enum(INVOICE_APPROVAL_MODES),
    invoice_approval_limit: amountText,
    quotation_approval_mode: z.enum(QUOTATION_APPROVAL_MODES),
    quotation_approval_limit: amountText,
    quotation_validity_days: intField("the validity", 1, 365),
    quotation_terms: optionalText(4000),
    e_invoicing_applies: z.boolean(),
    last_gstr1_reported_month: z
      .string()
      .trim()
      .nullish()
      // "none" is the select's "Not filed yet" (a select can't hold an empty value).
      .transform((v) => (v && v !== "none" ? v : null))
      .refine((v) => v === null || MONTH_PATTERN.test(v), { error: "Choose a month." }),
  })
  .superRefine((d, ctx) => {
    if (d.invoice_approval_mode === "above") {
      const r = parseAmount(d.invoice_approval_limit);
      if (!r.ok) ctx.addIssue({ code: "custom", path: ["invoice_approval_limit"], message: r.error });
    }
    if (d.quotation_approval_mode === "above") {
      const r = parseAmount(d.quotation_approval_limit);
      if (!r.ok) ctx.addIssue({ code: "custom", path: ["quotation_approval_limit"], message: r.error });
      else if (r.paise === 0) {
        ctx.addIssue({ code: "custom", path: ["quotation_approval_limit"], message: "Enter an amount above ₹0, or choose Never." });
      }
    }
    if (d.last_gstr1_reported_month) {
      const current = todayIST().slice(0, 7);
      if (d.last_gstr1_reported_month > current) {
        ctx.addIssue({ code: "custom", path: ["last_gstr1_reported_month"], message: "That month hasn't happened yet." });
      }
    }
    const seen = new Set<string>();
    d.sac_map.forEach((row, i) => {
      if (seen.has(row.service)) ctx.addIssue({ code: "custom", path: ["sac_map", i, "service"], message: "This service is listed twice." });
      seen.add(row.service);
    });
  });
export type BillingInput = z.input<typeof BillingSchema>;
export type BillingValues = z.output<typeof BillingSchema>;

/** The SAC map rows as the jsonb column stores them (empty entries left out). */
export function sacMapToJson(rows: ReadonlyArray<{ service: SacMapKey; sac: string | null }>): Partial<Record<SacMapKey, string>> {
  const out: Partial<Record<SacMapKey, string>> = {};
  for (const r of rows) if (r.sac) out[r.service] = r.sac;
  return out;
}

/** The jsonb column as editor rows, one per key, in a fixed order. */
export function sacMapFromJson(json: unknown): Array<{ service: SacMapKey; sac: string }> {
  const obj = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  return SAC_MAP_KEYS.map((service) => ({ service, sac: typeof obj[service] === "string" ? (obj[service] as string) : "" }));
}

/** Labels for the SAC map editor. */
export const SAC_MAP_LABELS: Record<SacMapKey, string> = {
  gst: "GST returns and advisory",
  income_tax: "Corporate tax consulting and preparation",
  income_tax_individual: "Individual tax preparation",
  tds: "TDS/TCS",
  payroll: "Payroll (PF/ESIC/PT)",
  bookkeeping: "Accounting and bookkeeping",
  audit: "Audit and assurance",
  company_law: "ROC/Company law",
  incorporation: "Incorporation",
  other: "Other and general",
};

/** The approval limit columns from the form's modes (§5.2 null/0 semantics). Amounts as decimal strings. */
export function approvalLimitsFromForm(d: Pick<BillingValues, "invoice_approval_mode" | "invoice_approval_limit" | "quotation_approval_mode" | "quotation_approval_limit">): {
  invoice_approval_limit: string | null;
  quotation_approval_limit: string | null;
} {
  const amount = (text: string): string => {
    const r = parseAmount(text);
    if (!r.ok) throw new RangeError(r.error);
    return (r.paise / 100).toFixed(2);
  };
  return {
    // null = no approvals needed; an amount (0 included) = Manager invoices above it wait for a Partner.
    invoice_approval_limit: d.invoice_approval_mode === "none" ? null : amount(d.invoice_approval_limit),
    // null = Managers' quotations always need approval; 0 = never; an amount = above it.
    quotation_approval_limit:
      d.quotation_approval_mode === "always" ? null : d.quotation_approval_mode === "never" ? "0.00" : amount(d.quotation_approval_limit),
  };
}

/** The form's modes from the stored columns. */
export function approvalModesFromRow(row: { invoice_approval_limit: string | number | null; quotation_approval_limit: string | number | null }): {
  invoice_approval_mode: (typeof INVOICE_APPROVAL_MODES)[number];
  invoice_approval_limit: string;
  quotation_approval_mode: (typeof QUOTATION_APPROVAL_MODES)[number];
  quotation_approval_limit: string;
} {
  const inv = row.invoice_approval_limit;
  const quo = row.quotation_approval_limit;
  const quoZero = quo !== null && Number(quo) === 0;
  return {
    invoice_approval_mode: inv === null ? "none" : "above",
    invoice_approval_limit: inv === null ? "" : String(inv),
    quotation_approval_mode: quo === null ? "always" : quoZero ? "never" : "above",
    quotation_approval_limit: quo === null || quoZero ? "" : String(quo),
  };
}

// -------------------------------------------------------------------------------------------------
// Working hours (§7.21, §7.11.4, §7.12)
// -------------------------------------------------------------------------------------------------

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const WEEKDAY_LABELS: Record<number, string> = { 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun" };

export const CapacityThresholdsSchema = z
  .object({
    busy: decimalField("the busy threshold", 0.1, 50),
    tight: decimalField("the tight threshold", 0.1, 50),
    over: decimalField("the over-capacity threshold", 0.1, 50),
  })
  .superRefine((t, ctx) => {
    const ok = (n: number) => Number.isFinite(n);
    if (ok(t.busy) && ok(t.tight) && !(t.busy < t.tight)) ctx.addIssue({ code: "custom", path: ["tight"], message: "Tight must be higher than Busy." });
    if (ok(t.tight) && ok(t.over) && !(t.tight < t.over)) ctx.addIssue({ code: "custom", path: ["over"], message: "Over must be higher than Tight." });
  });

export const WorkingHoursSchema = z
  .object({
    updated_at: concurrencyToken,
    work_day_start: z
      .string({ error: "Enter the start time." })
      .trim()
      .transform((v) => v.slice(0, 5))
      .pipe(z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, { error: "Enter a time like 09:30." })),
    late_grace_minutes: intField("the late grace", 0, 240),
    half_day_minutes: intField("the half-day minutes", 0, 720),
    working_weekdays: z
      .array(z.union([z.number(), z.string()]).transform(Number).pipe(z.number().int().min(1).max(7)))
      .min(1, { error: "Choose at least one working day." })
      .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    weekly_hours_target: intField("the weekly target", 0, 112),
    capacity_thresholds: CapacityThresholdsSchema,
  })
  .superRefine((d, ctx) => {
    const maxPossible = d.working_weekdays.length * 24;
    if (d.weekly_hours_target > maxPossible) {
      ctx.addIssue({ code: "custom", path: ["weekly_hours_target"], message: `With ${d.working_weekdays.length} working days the target can be at most ${maxPossible} hours.` });
    }
  });
export type WorkingHoursInput = z.input<typeof WorkingHoursSchema>;
export type WorkingHoursValues = z.output<typeof WorkingHoursSchema>;

export const HolidaySchema = z.object({
  date: z
    .string({ error: "Choose the date." })
    .refine((v) => isDateString(v), { error: "Choose the date." }),
  name: requiredText("the holiday's name", 2, 80),
});
export type HolidayInput = z.input<typeof HolidaySchema>;

export const HolidayRemoveSchema = z.object({ date: z.string().refine((v) => isDateString(v), { error: "Choose the date." }) });
export type HolidayRemoveInput = z.input<typeof HolidayRemoveSchema>;

// -------------------------------------------------------------------------------------------------
// Reminders (§7.21, §8)
// -------------------------------------------------------------------------------------------------

/** "1, 7, 15" → [1, 7, 15]: whole days, unique, ascending. */
export const dayListField = (label: string, opts: { min: number; max: number; maxItems: number; allowEmpty?: boolean }) =>
  z
    .union([z.string(), z.array(z.union([z.number(), z.string()]))])
    .transform((v) => (Array.isArray(v) ? v.map(String) : v.split(/[\s,;]+/)).map((s) => s.trim()).filter(Boolean))
    .superRefine((parts, ctx) => {
      if (!opts.allowEmpty && parts.length === 0) ctx.addIssue({ code: "custom", message: `Enter at least one day for ${label}.` });
      const bad = parts.find((p) => !/^\d+$/.test(p));
      if (bad) ctx.addIssue({ code: "custom", message: `"${bad}" isn't a whole number of days.` });
    })
    .transform((parts) => [...new Set(parts.filter((p) => /^\d+$/.test(p)).map(Number))].sort((a, b) => a - b))
    .superRefine((days, ctx) => {
      if (days.length > opts.maxItems) ctx.addIssue({ code: "custom", message: `Use at most ${opts.maxItems} reminders.` });
      const out = days.find((n) => n < opts.min || n > opts.max);
      if (out !== undefined) ctx.addIssue({ code: "custom", message: `Each day must be between ${opts.min} and ${opts.max}.` });
    });

export const RemindersSchema = z.object({
  updated_at: concurrencyToken,
  compliance_reminder_days: intField("the compliance lead days", 0, 90),
  invoice_reminder_before_days: intField("the days before the due date", 0, 60),
  invoice_reminder_after_days: dayListField("the overdue reminders", { min: 1, max: 365, maxItems: 6 }),
  document_request_reminder_every_days: intField("the document request cadence", 1, 60),
  quotation_follow_up_days: dayListField("the quotation follow-ups", { min: 1, max: 90, maxItems: 6, allowEmpty: true }),
  digest_enabled: z.boolean(),
});
export type RemindersInput = z.input<typeof RemindersSchema>;
export type RemindersValues = z.output<typeof RemindersSchema>;

// -------------------------------------------------------------------------------------------------
// Settings sections (§7.21; routes fixed in docs/CONVENTIONS.md §2)
// -------------------------------------------------------------------------------------------------

export const SETTINGS_SECTIONS = [
  { slug: "firm", label: "Firm details", group: "Firm" },
  { slug: "bank", label: "Bank & UPI", group: "Firm" },
  { slug: "numbering", label: "Numbering", group: "Firm" },
  { slug: "billing", label: "Billing", group: "Firm" },
  { slug: "working-hours", label: "Working hours", group: "Team" },
  { slug: "reminders", label: "Reminders", group: "Team" },
  { slug: "email", label: "Email", group: "Communication" },
  { slug: "whatsapp", label: "WhatsApp", group: "Communication" },
  { slug: "templates", label: "Templates", group: "Communication" },
  { slug: "law", label: "Law & rules", group: "Compliance" },
  { slug: "data", label: "Data", group: "System" },
  { slug: "diagnostics", label: "Diagnostics", group: "System" },
] as const;
export type SettingsSlug = (typeof SETTINGS_SECTIONS)[number]["slug"];

/** Service types in SAC map order (re-exported for the editor). */
export const SAC_SERVICE_TYPES: readonly ServiceType[] = SERVICE_TYPES;
