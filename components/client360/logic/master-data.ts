import { z } from "zod";
import {
  CLIENT_PRIORITIES,
  ENTITY_TYPES,
  GST_REGISTRATIONS,
  type ClientPriority,
  type EntityType,
  type GstRegistration,
  type GstScheme,
} from "@/lib/domain/enums";
import { isDateString, isFinancialYear, todayIST } from "@/lib/domain/fy";
import { deriveFromGstin, gstinPanMismatch, isValidStateCode, normaliseIdentifier, validateGstin, validatePan, validatePincode, validateTan } from "@/lib/domain/india-validators";
import { paiseToDecimalString, parseAmount } from "@/lib/domain/money";
import { CLIENT_CODE_PATTERN, isWhatsAppNumber, validateIndianPhone } from "@/lib/schemas/clients";
import { INCOME_NATURES, INCOME_NATURE_LABELS } from "@/lib/schemas/onboarding";
import type { IncomeNature } from "@/lib/domain/scale";

/**
 * Client 360 → Profile & contacts → Master data (§7.3.3 "edit form = step 1 fields", §7.3.2 step 1):
 * identity, tax registrations, contact, scale and notes, with the wizard's validators (§6.2:
 * GSTIN checksum and state, the PAN inside the GSTIN, PAN holder type, TAN, pincode, Indian phone,
 * WhatsApp-capable number), plus priority (§3.6). Shared by the edit form and
 * server/actions/client-profile.ts. Client-safe.
 *
 * Non-blocking findings (a PAN whose holder type doesn't fit the entity type, §6.2 "Warn (don't
 * block)") come from masterDataWarnings and are returned as warnings after the save.
 */

export const MASTER_LIMITS = { displayName: 120, legalName: 200, entityOther: 80, address: 500, city: 80, notes: 4000, maxTurnoverRupees: 99_99_99_99_99_999 } as const;

/** Month names for "Financial year ends in" (§7.3.2 step 1). */
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** "Auto from turnover" is stored as null (§5.3 gst_scheme: null = derive from turnover, §6.6). */
export const GST_SCHEME_CHOICES = ["auto", "monthly", "qrmp"] as const;
export type GstSchemeChoice = (typeof GST_SCHEME_CHOICES)[number];

/**
 * Who may use a presumptive scheme (§6.6): s.44AD is for a resident individual, HUF or partnership
 * firm (not an LLP); s.44ADA for a resident individual or partnership firm (not an LLP). A
 * proprietorship is its proprietor, an individual. Everyone may be "business" or "profession".
 */
const PRESUMPTIVE_ENTITIES: Record<"presumptive_44ad" | "presumptive_44ada", readonly EntityType[]> = {
  presumptive_44ad: ["individual", "proprietorship", "huf", "partnership"],
  presumptive_44ada: ["individual", "proprietorship", "partnership"],
};

/** The "Income is earned from" choices open to an entity type (all four while it isn't chosen). */
export function incomeNatureChoices(entityType: EntityType | null | undefined): IncomeNature[] {
  return INCOME_NATURES.filter((n) => n === "business" || n === "profession" || !entityType || PRESUMPTIVE_ENTITIES[n].includes(entityType));
}

/** Why a presumptive choice doesn't fit the entity type, or null when it does. */
export function incomeNatureError(entityType: EntityType | null | undefined, nature: IncomeNature | null | undefined): string | null {
  if (!nature || !entityType || nature === "business" || nature === "profession") return null;
  if (PRESUMPTIVE_ENTITIES[nature].includes(entityType)) return null;
  return nature === "presumptive_44ad"
    ? "s.44AD is for individuals, HUFs and partnership firms (not LLPs). Choose business or profession."
    : "s.44ADA is for individuals and partnership firms (not LLPs). Choose business or profession.";
}

/** "Presumptive business (s.44AD)" for a stored clients.income_nature; null when not recorded. */
export function incomeNatureLabel(nature: string | null | undefined): string | null {
  return nature && (INCOME_NATURES as readonly string[]).includes(nature) ? INCOME_NATURE_LABELS[nature as IncomeNature] : null;
}

const optionalText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep the ${what} under ${max.toLocaleString("en-IN")} characters.` })
    .nullish()
    .transform((v) => (v ? v : null));

const identifier = (validate: (s: string) => { ok: true; value: string } | { ok: false; error: string }) =>
  z
    .string()
    .trim()
    .nullish()
    .transform((v, ctx) => {
      if (!v) return null;
      const r = validate(v);
      if (!r.ok) {
        ctx.addIssue({ code: "custom", message: r.error });
        return z.NEVER;
      }
      return r.value;
    });

export const MasterDataSchema = z
  .object({
    clientId: z.uuid({ error: "That client isn't valid." }),
    /** clients.updated_at when the form loaded (§13). */
    updatedAt: z.string().min(1, { error: "Reload the page and try again." }),

    // Identity
    displayName: z
      .string()
      .trim()
      .min(2, { error: "Enter the client's display name (at least 2 characters)." })
      .max(MASTER_LIMITS.displayName, { error: `Keep the display name under ${MASTER_LIMITS.displayName} characters.` }),
    legalName: optionalText(MASTER_LIMITS.legalName, "legal name"),
    clientCode: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .refine((v) => v.length > 0, { error: "Enter the client code." })
      .refine((v) => v.length === 0 || CLIENT_CODE_PATTERN.test(v), { error: "Use 2–20 letters, digits, - or /, like TW-C-0042." }),
    entityType: z.enum(ENTITY_TYPES, { error: "Choose the entity type." }),
    entityTypeOther: optionalText(MASTER_LIMITS.entityOther, "entity type"),
    isIncorporated: z.boolean().default(true),
    dateOfBirthOrIncorporation: z
      .string()
      .trim()
      .nullish()
      .transform((v) => (v ? v : null))
      .refine((v) => v === null || isDateString(v), { error: "Enter the date, for example 22 Oct 1985." })
      .refine((v) => v === null || !isDateString(v) || v <= todayIST(), { error: "The date can't be in the future." }),

    // Tax registrations
    pan: identifier((s) => {
      const r = validatePan(s);
      return r.ok ? { ok: true, value: r.value } : r;
    }),
    gstRegistration: z.enum(GST_REGISTRATIONS, { error: "Choose the GST registration." }),
    gstin: identifier((s) => {
      const r = validateGstin(s);
      return r.ok ? { ok: true, value: r.value } : r;
    }),
    stateCode: z
      .string()
      .trim()
      .nullish()
      .transform((v) => (v ? v.padStart(2, "0") : null))
      .refine((v) => v === null || isValidStateCode(v), { error: "Choose the state from the list." }),
    tan: identifier(validateTan),

    // Contact
    email: z
      .string()
      .trim()
      .max(254, { error: "That email address is too long." })
      .nullish()
      .transform((v) => (v ? v.toLowerCase() : null))
      .refine((v) => v === null || z.email().safeParse(v).success, { error: "Enter a valid email address, like accounts@company.in." }),
    phone: z
      .string()
      .trim()
      .nullish()
      .transform((v) => (v ? v : null))
      .superRefine((v, ctx) => {
        if (v === null) return;
        const r = validateIndianPhone(v);
        if (!r.ok) ctx.addIssue({ code: "custom", message: r.error });
      }),
    whatsapp: z
      .string()
      .trim()
      .nullish()
      .transform((v) => (v ? v : null))
      .refine((v) => v === null || isWhatsAppNumber(v), { error: "This number can't receive WhatsApp. Use a 10-digit mobile number." }),
    address: optionalText(MASTER_LIMITS.address, "address"),
    city: optionalText(MASTER_LIMITS.city, "city"),
    pincode: identifier(validatePincode),

    // Scale
    fyEndMonth: z.coerce.number({ error: "Choose the month the financial year ends in." }).int().min(1).max(12).default(3),
    annualTurnover: z
      .union([z.string(), z.number(), z.null()])
      .optional()
      .transform((v, ctx) => {
        if (v === null || v === undefined || String(v).trim() === "") return null;
        const r = parseAmount(String(v));
        if (!r.ok) {
          ctx.addIssue({ code: "custom", message: r.error });
          return z.NEVER;
        }
        if (r.paise > MASTER_LIMITS.maxTurnoverRupees * 100) {
          ctx.addIssue({ code: "custom", message: "That turnover is too large. Check the amount." });
          return z.NEVER;
        }
        return paiseToDecimalString(r.paise);
      }),
    turnoverFy: z
      .string()
      .trim()
      .nullish()
      .transform((v) => (v ? v : null))
      .refine((v) => v === null || isFinancialYear(v), { error: "Choose the financial year, like 2025-26." }),
    gstScheme: z.enum(GST_SCHEME_CHOICES).default("auto"),
    /** clients.income_nature (§6.6): how the income is earned, incl. the presumptive schemes. "" = not recorded. */
    incomeNature: z
      .union([z.literal(""), z.enum(INCOME_NATURES), z.null()])
      .optional()
      .transform((v): IncomeNature | null => (v ? v : null)),

    // Work
    priority: z.enum(CLIENT_PRIORITIES, { error: "Choose the priority." }),

    notes: optionalText(MASTER_LIMITS.notes, "notes"),
  })
  .superRefine((v, ctx) => {
    if (v.entityType === "other" && !v.entityTypeOther) {
      ctx.addIssue({ code: "custom", path: ["entityTypeOther"], message: "Specify the entity type." });
    }
    if (v.gstRegistration === "registered" && !v.gstin) {
      ctx.addIssue({ code: "custom", path: ["gstin"], message: "Enter the GSTIN: the client is GST-registered." });
    }
    const mismatch = gstinPanMismatch(v.gstin, v.pan);
    if (mismatch) ctx.addIssue({ code: "custom", path: ["gstin"], message: mismatch });
    const natureError = incomeNatureError(v.entityType, v.incomeNature);
    if (natureError) ctx.addIssue({ code: "custom", path: ["incomeNature"], message: natureError });
    if (v.annualTurnover !== null && !v.turnoverFy) {
      ctx.addIssue({ code: "custom", path: ["turnoverFy"], message: "Choose the financial year the turnover is for." });
    }
  })
  .transform((v) => {
    // The GSTIN fills the state and the PAN when they are empty (§7.3.2 step 1).
    const parts = v.gstin ? deriveFromGstin(v.gstin) : null;
    return {
      ...v,
      stateCode: parts ? parts.stateCode : v.stateCode,
      pan: v.pan ?? (parts ? parts.pan : null),
      entityTypeOther: v.entityType === "other" ? v.entityTypeOther : null,
      gstin: v.gstRegistration === "unregistered" ? null : v.gstin,
    };
  });
export type MasterDataInput = z.input<typeof MasterDataSchema>;
export type MasterDataValues = z.output<typeof MasterDataSchema>;

/**
 * A numeric(16,2) value as its exact decimal string. PostgREST casts the string into the column, so
 * no float ever carries the amount (§0.1 rule 7); the cast only satisfies the generated row type.
 */
export function asNumeric(decimal: string | null): number | null {
  return decimal as unknown as number | null;
}

/** The clients columns a master-data save writes. */
export function masterDataToRow(v: MasterDataValues) {
  return {
    display_name: v.displayName,
    legal_name: v.legalName,
    client_code: v.clientCode,
    entity_type: v.entityType,
    entity_type_other: v.entityTypeOther,
    is_incorporated: v.isIncorporated,
    date_of_birth_or_incorporation: v.dateOfBirthOrIncorporation,
    pan: v.pan,
    gst_registration: v.gstRegistration,
    gstin: v.gstin,
    state_code: v.stateCode,
    tan: v.tan,
    email: v.email,
    phone: v.phone,
    whatsapp: v.whatsapp,
    address: v.address,
    city: v.city,
    pincode: v.pincode,
    fy_end_month: v.fyEndMonth,
    annual_turnover: asNumeric(v.annualTurnover),
    turnover_fy: v.turnoverFy,
    gst_scheme: v.gstScheme === "auto" ? null : (v.gstScheme as GstScheme),
    income_nature: v.incomeNature,
    priority: v.priority,
    notes: v.notes,
  };
}

export type MasterDataRow = ReturnType<typeof masterDataToRow>;

/** A stored client → the edit form's values. */
export function masterDataDefaults(c: {
  id: string;
  updated_at: string;
  display_name: string;
  legal_name: string | null;
  client_code: string;
  entity_type: EntityType | null;
  entity_type_other: string | null;
  is_incorporated: boolean;
  date_of_birth_or_incorporation: string | null;
  pan: string | null;
  gst_registration: GstRegistration;
  gstin: string | null;
  state_code: string | null;
  tan: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  fy_end_month: number;
  annual_turnover: number | string | null;
  turnover_fy: string | null;
  gst_scheme: GstScheme | null;
  income_nature?: string | null;
  priority: ClientPriority;
  notes: string | null;
}): MasterDataInput {
  return {
    clientId: c.id,
    updatedAt: c.updated_at,
    displayName: c.display_name,
    legalName: c.legal_name ?? "",
    clientCode: c.client_code,
    // An old record without an entity type has to pick one before saving.
    entityType: (c.entity_type ?? undefined) as EntityType,
    entityTypeOther: c.entity_type_other ?? "",
    isIncorporated: c.is_incorporated,
    dateOfBirthOrIncorporation: c.date_of_birth_or_incorporation ?? "",
    pan: c.pan ?? "",
    gstRegistration: c.gst_registration,
    gstin: c.gstin ?? "",
    stateCode: c.state_code ?? "",
    tan: c.tan ?? "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    whatsapp: c.whatsapp ?? "",
    address: c.address ?? "",
    city: c.city ?? "",
    pincode: c.pincode ?? "",
    fyEndMonth: String(c.fy_end_month),
    annualTurnover: c.annual_turnover === null ? "" : String(c.annual_turnover),
    turnoverFy: c.turnover_fy ?? "",
    gstScheme: c.gst_scheme ?? "auto",
    incomeNature: (INCOME_NATURES as readonly string[]).includes(c.income_nature ?? "") ? (c.income_nature as IncomeNature) : "",
    priority: c.priority,
    notes: c.notes ?? "",
  };
}

/**
 * Warnings that never block the save (§6.2): a PAN whose 4th character doesn't fit the entity type,
 * or isn't a known holder type.
 */
export function masterDataWarnings(v: Pick<MasterDataValues, "pan" | "entityType">): string[] {
  if (!v.pan) return [];
  const r = validatePan(v.pan, { entityType: v.entityType });
  return r.ok && r.warning ? [r.warning] : [];
}

/** The fields whose change is worth naming in the timeline and audit row (no money involved). */
export const MASTER_FIELD_LABELS: Record<keyof MasterDataRow, string> = {
  display_name: "display name",
  legal_name: "legal name",
  client_code: "client code",
  entity_type: "entity type",
  entity_type_other: "entity type",
  is_incorporated: "incorporation",
  date_of_birth_or_incorporation: "date of birth / incorporation",
  pan: "PAN",
  gst_registration: "GST registration",
  gstin: "GSTIN",
  state_code: "state",
  tan: "TAN",
  email: "email",
  phone: "phone",
  whatsapp: "WhatsApp",
  address: "address",
  city: "city",
  pincode: "pincode",
  fy_end_month: "financial year end",
  annual_turnover: "turnover",
  turnover_fy: "turnover FY",
  gst_scheme: "GST scheme",
  income_nature: "how the income is earned",
  priority: "priority",
  notes: "notes",
};

/** The columns that changed between the stored row and the new values (identifiers compared normalised). */
export function changedMasterFields(before: Partial<Record<keyof MasterDataRow, unknown>>, after: MasterDataRow): Array<keyof MasterDataRow> {
  const norm = (k: keyof MasterDataRow, v: unknown): string => {
    if (v === null || v === undefined || v === "") return "";
    if (k === "annual_turnover") {
      const r = parseAmount(String(v));
      return r.ok ? String(r.paise) : String(v);
    }
    if (k === "pan" || k === "gstin" || k === "tan" || k === "client_code") return normaliseIdentifier(String(v));
    return String(v);
  };
  return (Object.keys(after) as Array<keyof MasterDataRow>).filter((k) => norm(k, before[k]) !== norm(k, after[k]));
}

/** The fields the deadline generator reads (server/compliance/generate.ts): a change refreshes the client's deadlines. */
export const CALENDAR_FIELDS: ReadonlyArray<keyof MasterDataRow> = ["entity_type", "gst_registration", "gstin", "state_code", "gst_scheme", "annual_turnover", "income_nature"];

/** "display name, GSTIN and phone" for a timeline line. */
export function describeChanges(fields: ReadonlyArray<keyof MasterDataRow>): string {
  const labels = Array.from(new Set(fields.map((f) => MASTER_FIELD_LABELS[f])));
  if (labels.length === 0) return "nothing";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
