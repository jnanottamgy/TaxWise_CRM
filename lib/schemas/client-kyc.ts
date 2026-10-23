import { z } from "zod";
import type { EntityType } from "@/lib/domain/enums";
import { addMonths, isDateString } from "@/lib/domain/fy";
import {
  AADHAAR_FULL_NUMBER_ERROR,
  containsFullAadhaar,
  validateAadhaarLast4,
  validateCin,
  validateDin,
  validateLlpin,
  validatePan,
} from "@/lib/domain/india-validators";
import type { KycCategory, KycPerson } from "@/lib/domain/ceiling";

/**
 * KYC on Client 360 (§6.8 ICAI KYC Norms, §5.12 client_kyc, Profile & contacts → KYC): the category
 * (individual/proprietor, corporate, non-corporate), PAN, CIN/LLPIN, business description,
 * registered address, last audited financial statements, engagement types, the principal persons
 * (directors, partners, trustees: name, address, PAN or DIN; never a full Aadhaar number, §6.10),
 * who verified it and when, and the next annual review. Completeness is lib/domain/ceiling.ts
 * kycCompleteness. Shared by the KYC form and server/actions/client-kyc.ts. Client-safe.
 */

export const KYC_CATEGORIES = ["individual_proprietor", "corporate", "non_corporate"] as const satisfies readonly KycCategory[];

export const KYC_CATEGORY_LABELS: Record<KycCategory, string> = {
  individual_proprietor: "Individual or proprietor",
  corporate: "Corporate (company or LLP)",
  non_corporate: "Non-corporate (firm, trust, AOP, HUF)",
};

/** The audit and certification engagements KYC covers (§6.8 "engagement type"; the audit_type values of §5.12). */
export const KYC_ENGAGEMENT_TYPES = ["statutory_companies_act", "tax_audit", "gst_audit", "internal", "bank_branch", "stock", "certification", "other"] as const;
export type KycEngagementType = (typeof KYC_ENGAGEMENT_TYPES)[number];

export const KYC_ENGAGEMENT_TYPE_LABELS: Record<KycEngagementType, string> = {
  statutory_companies_act: "Statutory audit (Companies Act)",
  tax_audit: "Tax audit",
  gst_audit: "GST audit",
  internal: "Internal audit",
  bank_branch: "Bank branch audit",
  stock: "Stock audit",
  certification: "Certification",
  other: "Other attest work",
};

/** A stored engagement type's label (unknown values are shown in plain words). */
export function engagementTypeLabel(value: string): string {
  return (KYC_ENGAGEMENT_TYPE_LABELS as Record<string, string>)[value] ?? value.replace(/_/g, " ");
}

const ENGAGEMENT_ALIASES: Record<string, KycEngagementType> = {
  "statutory audit": "statutory_companies_act",
  statutory: "statutory_companies_act",
  "tax audit": "tax_audit",
  tax: "tax_audit",
  "gst audit": "gst_audit",
  gst: "gst_audit",
  "internal audit": "internal",
};

/**
 * Stored engagement types → the form's codes. The onboarding wizard and the KYC form store codes;
 * rows written before that may hold labels ("Tax audit"), so codes, labels and their short forms are
 * all understood; anything else counts as Other.
 */
export function readEngagementTypes(stored: readonly string[] | null | undefined): KycEngagementType[] {
  const out = new Set<KycEngagementType>();
  for (const raw of stored ?? []) {
    const v = raw.trim();
    if ((KYC_ENGAGEMENT_TYPES as readonly string[]).includes(v)) {
      out.add(v as KycEngagementType);
      continue;
    }
    const key = v.toLowerCase();
    const byLabel = (Object.entries(KYC_ENGAGEMENT_TYPE_LABELS) as Array<[KycEngagementType, string]>).find(([, label]) => label.toLowerCase() === key)?.[0];
    out.add(byLabel ?? ENGAGEMENT_ALIASES[key] ?? "other");
  }
  return KYC_ENGAGEMENT_TYPES.filter((t) => out.has(t));
}

/** What a principal person is to the client. */
export const PRINCIPAL_ROLES = ["Director", "Designated partner", "Partner", "Trustee", "Karta", "Member", "Proprietor", "Other"] as const;

/** The KYC category an entity type normally falls in (§6.8). The form starts from this; it can be changed. */
export function kycCategoryFor(entityType: EntityType | null | undefined): KycCategory {
  switch (entityType) {
    case "pvt_ltd":
    case "public_ltd":
    case "section_8":
    case "llp":
      return "corporate";
    case "proprietorship":
    case "individual":
      return "individual_proprietor";
    default:
      return "non_corporate";
  }
}

/** The people the category asks for, as the form names them. */
export function principalPersonsLabel(category: KycCategory, entityType?: EntityType | null): string {
  if (category === "corporate") return entityType === "llp" ? "Designated partners" : "Directors";
  if (category === "non_corporate") return entityType === "trust" ? "Trustees" : entityType === "huf" ? "Karta and coparceners" : "Partners or trustees";
  return "Proprietor";
}

export const KYC_LIMITS = { persons: 50, name: 120, address: 500, description: 2000 } as const;

const uuid = (what: string) => z.uuid({ error: `That ${what} isn't valid.` });

const text = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep the ${what} under ${max.toLocaleString("en-IN")} characters.` })
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || !containsFullAadhaar(v), { error: AADHAAR_FULL_NUMBER_ERROR });

const dateOrNull = (label: string) =>
  z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || isDateString(v), { error: `Enter the ${label} as a date, for example 22 Oct 2026.` });

const optionalPan = z
  .string()
  .trim()
  .nullish()
  .transform((v, ctx) => {
    if (!v) return null;
    const r = validatePan(v);
    if (!r.ok) {
      ctx.addIssue({ code: "custom", message: r.error });
      return z.NEVER;
    }
    return r.value;
  });

const optionalDin = z
  .string()
  .trim()
  .nullish()
  .transform((v, ctx) => {
    if (!v) return null;
    const r = validateDin(v);
    if (!r.ok) {
      ctx.addIssue({ code: "custom", message: r.error });
      return z.NEVER;
    }
    return r.value;
  });

const optionalAadhaarLast4 = z
  .string()
  .trim()
  .nullish()
  .transform((v, ctx) => {
    if (!v) return null;
    const r = validateAadhaarLast4(v);
    if (!r.ok) {
      ctx.addIssue({ code: "custom", message: r.error });
      return z.NEVER;
    }
    return r.value;
  });

export const PrincipalPersonSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "Enter the person's name." })
    .max(KYC_LIMITS.name, { error: `Keep the name under ${KYC_LIMITS.name} characters.` })
    .refine((v) => !containsFullAadhaar(v), { error: AADHAAR_FULL_NUMBER_ERROR }),
  role: z
    .union([z.enum(PRINCIPAL_ROLES), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
  address: text(KYC_LIMITS.address, "address"),
  pan: optionalPan,
  din: optionalDin,
  aadhaarLast4: optionalAadhaarLast4,
});
export type PrincipalPersonInput = z.input<typeof PrincipalPersonSchema>;
export type PrincipalPerson = z.output<typeof PrincipalPersonSchema>;

export const SaveKycSchema = z
  .object({
    clientId: uuid("client"),
    /** client_kyc.updated_at as loaded; null when the client has no KYC record yet. */
    updatedAt: z.string().nullish().transform((v) => v ?? null),
    entityCategory: z.enum(KYC_CATEGORIES, { error: "Choose the KYC category." }),
    pan: optionalPan,
    cinLlpin: z.string().trim().nullish().transform((v) => (v ? v.toUpperCase() : null)),
    businessDescription: text(KYC_LIMITS.description, "business description"),
    registeredAddress: text(KYC_LIMITS.address, "registered address"),
    lastAuditedFsDocumentId: z.union([uuid("document"), z.literal(""), z.null()]).optional().transform((v) => (v ? v : null)),
    engagementTypes: z
      .array(z.enum(KYC_ENGAGEMENT_TYPES, { error: "Choose an engagement type from the list." }))
      .max(KYC_ENGAGEMENT_TYPES.length)
      .default([])
      .transform((list) => KYC_ENGAGEMENT_TYPES.filter((t) => list.includes(t))),
    principalPersons: z.array(PrincipalPersonSchema).max(KYC_LIMITS.persons, { error: `Add at most ${KYC_LIMITS.persons} people.` }).default([]),
    nextReviewOn: dateOrNull("next review date"),
  })
  .superRefine((v, ctx) => {
    if (v.cinLlpin) {
      // A company has a CIN, an LLP its LLPIN; either is accepted here (the category covers both).
      const cin = validateCin(v.cinLlpin);
      const llpin = validateLlpin(v.cinLlpin);
      if (!cin.ok && !llpin.ok) {
        ctx.addIssue({ code: "custom", path: ["cinLlpin"], message: "Enter a valid CIN (U74999KA2020PTC123456) or LLPIN (AAB-1234)." });
      }
    }
  })
  .transform((v) => {
    if (!v.cinLlpin) return v;
    const llpin = validateLlpin(v.cinLlpin);
    return { ...v, cinLlpin: validateCin(v.cinLlpin).ok ? v.cinLlpin : llpin.ok ? llpin.value : v.cinLlpin };
  });
export type SaveKycInput = z.input<typeof SaveKycSchema>;
export type SaveKycValues = z.output<typeof SaveKycSchema>;

export const VerifyKycSchema = z.object({
  clientId: uuid("client"),
  updatedAt: z.string().min(1, { error: "Reload the page and try again." }),
  verifiedOn: dateOrNull("date it was verified").refine((v) => v !== null, { error: "Enter the date the KYC was verified." }),
  /** Annual re-confirmation (§6.8); a year after verification when empty. */
  nextReviewOn: dateOrNull("next review date"),
});
export type VerifyKycInput = z.input<typeof VerifyKycSchema>;

/** The next annual review: twelve months after verification (§6.8 "Re-confirm annually"). */
export function defaultNextReview(verifiedOn: string): string {
  return addMonths(verifiedOn, 12);
}

/** Stored principal persons (jsonb) → the domain's KycPerson list, ignoring anything malformed. */
export function readPrincipalPersons(value: unknown): Array<KycPerson & { role: string | null; aadhaarLast4: string | null }> {
  if (!Array.isArray(value)) return [];
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return value
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && !Array.isArray(p))
    .map((p) => ({
      name: str(p.name),
      role: str(p.role),
      address: str(p.address),
      pan: str(p.pan),
      din: str(p.din),
      aadhaarLast4: str(p.aadhaar_last4 ?? p.aadhaarLast4),
    }))
    .filter((p) => p.name !== null);
}

/** Principal persons as stored in client_kyc.principal_persons (snake_case keys, no empty values). */
export function toStoredPersons(persons: readonly PrincipalPerson[]): Array<Record<string, string>> {
  return persons.map((p) => {
    const out: Record<string, string> = { name: p.name };
    if (p.role) out.role = p.role;
    if (p.address) out.address = p.address;
    if (p.pan) out.pan = p.pan;
    if (p.din) out.din = p.din;
    if (p.aadhaarLast4) out.aadhaar_last4 = p.aadhaarLast4;
    return out;
  });
}
