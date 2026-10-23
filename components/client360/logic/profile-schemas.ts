import { z } from "zod";

/**
 * Small Client 360 forms (§7.3.3): an Employee's notes (§4.1 "read + limited edit"), the Partner's
 * tax-audit decision (§6.6), the group (§7.4), and the owner and engagement team (§5.3). Shared by
 * the forms and server/actions/client-profile.ts. Client-safe.
 */

const uuid = (what: string) => z.uuid({ error: `That ${what} isn't valid.` });
const optionalUuid = (what: string) =>
  z
    .union([uuid(what), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? v : null));
const updatedAt = z.string().min(1, { error: "Reload the page and try again." });

export const ClientNotesSchema = z.object({
  clientId: uuid("client"),
  updatedAt,
  notes: z
    .string()
    .trim()
    .max(4000, { error: "Keep the notes under 4,000 characters." })
    .nullish()
    .transform((v) => (v ? v : null)),
});
export type ClientNotesInput = z.input<typeof ClientNotesSchema>;

export const TAX_AUDIT_DECISIONS = ["yes", "no", "review"] as const;
export type TaxAuditDecision = (typeof TAX_AUDIT_DECISIONS)[number];

/** §6.6 tax_audit_applicable: yes / no / review, worded as the client wizard words them. */
export const TAX_AUDIT_DECISION_LABELS: Record<TaxAuditDecision, string> = {
  yes: "Tax audit applies",
  no: "No tax audit",
  review: "Partner to review",
};

export const TaxAuditDecisionSchema = z
  .object({
    clientId: uuid("client"),
    updatedAt,
    decision: z.enum(TAX_AUDIT_DECISIONS, { error: "Choose the decision." }),
    note: z
      .string()
      .trim()
      .max(1000, { error: "Keep the note under 1,000 characters." })
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "review" && !v.note) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "Say what still needs checking." });
    }
  });
export type TaxAuditDecisionInput = z.input<typeof TaxAuditDecisionSchema>;

export const ClientGroupSchema = z
  .object({
    clientId: uuid("client"),
    updatedAt,
    /** An existing group, or "" / null for none. */
    groupId: optionalUuid("group"),
    /** A new group to create and join (instead of groupId). */
    newGroupName: z
      .string()
      .trim()
      .max(120, { error: "Keep the group name under 120 characters." })
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  .superRefine((v, ctx) => {
    if (v.groupId && v.newGroupName) ctx.addIssue({ code: "custom", path: ["newGroupName"], message: "Choose an existing group or name a new one, not both." });
    if (v.newGroupName !== null && v.newGroupName.length < 2) ctx.addIssue({ code: "custom", path: ["newGroupName"], message: "Name the group (at least 2 characters)." });
  });
export type ClientGroupInput = z.input<typeof ClientGroupSchema>;

export const ClientTeamSchema = z
  .object({
    clientId: uuid("client"),
    /** teamSignature() of the team as loaded (§13). */
    signature: z.string().min(1, { error: "Reload the page and try again." }),
    owner: optionalUuid("owner").refine((v) => v !== null, { error: "Choose the client owner." }),
    engagementPartner: optionalUuid("engagement partner"),
    reviewManager: optionalUuid("review manager"),
    preparers: z
      .array(uuid("preparer"))
      .max(20, { error: "A client can have at most 20 preparers." })
      .default([])
      .transform((ids) => Array.from(new Set(ids))),
  });
export type ClientTeamInput = z.input<typeof ClientTeamSchema>;

/** Client portal access (§7.22): invite (or restore a revoked login), resend, revoke. */
export const PortalAccessSchema = z.object({
  clientId: uuid("client"),
  updatedAt,
});
export type PortalAccessInput = z.input<typeof PortalAccessSchema>;

export const RevokePortalSchema = z.object({
  clientId: uuid("client"),
  updatedAt,
  reason: z
    .string()
    .trim()
    .min(3, { error: "Give a reason (at least 3 characters)." })
    .max(500, { error: "Keep the reason under 500 characters." }),
});
export type RevokePortalInput = z.input<typeof RevokePortalSchema>;
