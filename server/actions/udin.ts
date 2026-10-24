"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { STAFF_ROLES, isManagerOrPartner } from "@/lib/auth/roles";
import { formatDate } from "@/lib/format";
import { fyStart, isDateString } from "@/lib/domain/fy";
import {
  CEILING_PARAM_KEYS,
  FORM_26_CATEGORIES,
  REPORT_FORMS,
  ceilingThresholdsCrossed,
  checkNewTaxAudit,
  resolveCeilingParams,
  type CeilingParams,
  type Form26Category,
  type ReportForm,
} from "@/lib/domain/ceiling";
import { addTimelineEvent } from "@/server/timeline";
import { notify } from "@/server/notify";
import { getUdinLinkOptions, type UdinLinkOptions } from "@/lib/data/registers";
import {
  CreateUdinSchema,
  ExternalCountSchema,
  RecordRefSchema,
  UdinCheckSchema,
  UpdateUdinSchema,
  ceilingFyOf,
  reportFormLabel,
  udinCounts,
  udinWarnings,
} from "@/lib/schemas/registers";

/**
 * The UDIN register and the tax-audit ceiling (§7.15.1, §6.2, §6.8, §18.3 Partner 7).
 *
 *   checkUdin           the form's live check: the UDIN's shape, the signing partner's membership
 *                       number in characters 3–8 [verify], the 60 days from signing, and where the
 *                       report would put the partner against the ceiling (warn at 50 and 58; past 60
 *                       a Partner must confirm).
 *   createUdin          Partners and Managers for any signing Partner; an Employee only as the
 *                       signing member themselves, for their own client (§4.1 "UDIN add if signing
 *                       staff"; RLS 0037). The database refuses a 61st without a Partner's
 *                       confirmation (udin_records_guard_ceiling, 0192), which only a Partner gives,
 *                       as themselves. When the count reaches 50, 58 or 60, the partner is told (§9).
 *   updateUdin / deleteUdin   Partners and Managers.
 *   saveExternalCount   a Partner's "audits signed elsewhere" for an FY (other firms, individual
 *                       capacity), which the ceiling adds (§6.8).
 *   loadUdinLinks       the client's filings and audit engagements a UDIN can be linked to.
 */

const MANAGERS = ["partner", "manager"] as const;
const STALE = "This UDIN was changed by someone else. Reload to see their changes.";

async function ceilingParams(ctx: ActionContext, fy: string): Promise<CeilingParams> {
  const { data, error } = await ctx.supabase.from("statutory_parameters").select("key, value, effective_from, effective_to, verified").in("key", Object.values(CEILING_PARAM_KEYS));
  throwIfDbError(error);
  return resolveCeilingParams(
    (data ?? []).map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, verified: r.verified })),
    fyStart(fy),
  ).params;
}

type Member = { id: string; name: string; role: string; membershipNo: string | null; active: boolean };

async function memberOf(ctx: ActionContext, id: string): Promise<Member | null> {
  const { data, error } = await ctx.supabase.from("profiles").select("id, full_name, role, icai_membership_no, is_active").eq("id", id).maybeSingle();
  throwIfDbError(error);
  if (data) return { id: data.id, name: data.full_name, role: data.role, membershipNo: data.icai_membership_no, active: data.is_active };
  // An Employee can't read other profiles: they may only name themselves anyway.
  return null;
}

/** Who may be named as the signing member (§4.1, §6.8). */
async function signingMember(ctx: ActionContext, id: string): Promise<Member> {
  if (!isManagerOrPartner(ctx.user.role) && id !== ctx.user.id) {
    throw new ActionError("You can log a UDIN only for a document you signed yourself.", { code: "forbidden", fieldErrors: { signingPartnerId: ["Choose yourself as the signing member."] } });
  }
  const m = await memberOf(ctx, id);
  if (!m || !m.active) throw new ActionError("The signing partner isn't an active member of the firm.", { code: "validation", fieldErrors: { signingPartnerId: ["Choose an active Partner."] } });
  if (m.role !== "partner" && !m.membershipNo?.trim()) {
    throw new ActionError("Only a member who signs reports can log a UDIN. Ask a Partner to add your ICAI membership number to your profile first.", { code: "forbidden", fieldErrors: { signingPartnerId: ["No ICAI membership number on record."] } });
  }
  if (m.role !== "partner" && m.id !== ctx.user.id) {
    throw new ActionError("The signing partner is a Partner of the firm.", { code: "validation", fieldErrors: { signingPartnerId: ["Choose a Partner."] } });
  }
  return m;
}

type Position = { counted: number; adds: boolean; ceiling: number | null };

async function position(ctx: ActionContext, input: { memberId: string; fy: string; recordId: string | null; clientId: string | null; financialYear: string | null; filingRecordId: string | null; auditEngagementId: string | null }): Promise<Position> {
  const { data: key, error: keyError } = await ctx.supabase.rpc("udin_report_key", {
    p_client_id: input.clientId,
    p_financial_year: input.financialYear,
    p_filing_record_id: input.filingRecordId,
    p_audit_engagement_id: input.auditEngagementId,
    p_id: input.recordId ?? randomUUID(),
  });
  throwIfDbError(keyError);
  const { data, error } = await ctx.supabase.rpc("tax_audit_position", { p_member: input.memberId, p_fy: input.fy, p_record_id: input.recordId, p_key: key as string });
  throwIfDbError(error);
  const r = (data ?? {}) as { counted?: number; adds?: boolean; ceiling?: number | null };
  return { counted: r.counted ?? 0, adds: r.adds !== false, ceiling: r.ceiling ?? null };
}

export type UdinCheck = {
  /** Field-level problems with the UDIN itself, or null. */
  udinError: string | null;
  warnings: string[];
  counts: boolean | null;
  ceiling: null | {
    fy: string;
    /** This report's place in the partner's count (or the count it joins, for a branch report). */
    position: number;
    total: number;
    ceiling: number;
    level: "ok" | "warn" | "confirm";
    message: string | null;
    adds: boolean;
  };
};

export const checkUdin = defineAction(
  { name: "udin.check", schema: UdinCheckSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<UdinCheck>> => {
    const out: UdinCheck = { udinError: null, warnings: [], counts: null, ceiling: null };
    const udinOk = /^[0-9]{2}[0-9]{6}[A-Z0-9]{10}$/.test(input.udin.toUpperCase());
    if (input.udin && !udinOk) out.udinError = "A UDIN has 18 characters: the 2-digit year, the 6-digit membership number, then 10 letters or digits.";
    const member = input.signingPartnerId ? await memberOf(ctx, input.signingPartnerId) : null;
    if (input.udin && udinOk && isDateString(input.signedOn) && isDateString(input.generatedOn)) {
      out.warnings = udinWarnings({ udin: input.udin, membershipNo: member?.membershipNo ?? null, signedOn: input.signedOn, generatedOn: input.generatedOn });
    }
    const form = (REPORT_FORMS as readonly string[]).includes(input.reportForm) ? (input.reportForm as ReportForm) : null;
    const cat = (FORM_26_CATEGORIES as readonly string[]).includes(input.form26Category) ? (input.form26Category as Form26Category) : null;
    out.counts = udinCounts(form, input.isRevised, cat);
    if (out.counts && member && isDateString(input.signedOn)) {
      if (!isManagerOrPartner(ctx.user.role) && member.id !== ctx.user.id) return ok(out);
      const fy = ceilingFyOf(input.signedOn);
      const [params, pos] = await Promise.all([
        ceilingParams(ctx, fy),
        position(ctx, { memberId: member.id, fy, recordId: input.recordId, clientId: input.clientId, financialYear: input.financialYear || null, filingRecordId: null, auditEngagementId: null }),
      ]);
      if (pos.adds) {
        const check = checkNewTaxAudit({ currentTotal: pos.counted, actorRole: ctx.user.role, confirmed: false }, params);
        out.ceiling = { fy, position: check.position, total: pos.counted, ceiling: pos.ceiling ?? params.taxAuditCeiling, level: check.level, message: check.message, adds: true };
      } else {
        out.ceiling = {
          fy,
          position: pos.counted,
          total: pos.counted,
          ceiling: pos.ceiling ?? params.taxAuditCeiling,
          level: "ok",
          message: "Another report of this client for the same year is already counted: head office and branch reports count once.",
          adds: false,
        };
      }
    }
    return ok(out);
  },
);

type SavedUdin = { id: string; updatedAt: string };

function uniqueUdin(error: { code?: string; message?: string } | null): void {
  if (error?.message?.startsWith("USER: This would be tax audit")) {
    throw new ActionError(error.message.slice(6), { code: "blocked", fieldErrors: { confirmOverCeiling: [error.message.slice(6)] } });
  }
  throwIfDbError(error, { uniqueField: "udin", uniqueMessage: "This UDIN is already in the register." });
}

async function ceilingGate(
  ctx: ActionContext,
  input: { signingPartnerId: string; signedOn: string; counts: boolean | null; confirmOverCeiling: boolean; recordId: string | null; clientId: string | null; financialYear: string | null; filingRecordId: string | null; auditEngagementId: string | null },
): Promise<{ confirmedBy: string | null; warnings: string[]; before: number; after: number; params: CeilingParams; fy: string }> {
  const fy = ceilingFyOf(input.signedOn);
  const params = await ceilingParams(ctx, fy);
  if (!input.counts) return { confirmedBy: null, warnings: [], before: 0, after: 0, params, fy };
  const pos = await position(ctx, { memberId: input.signingPartnerId, fy, recordId: input.recordId, clientId: input.clientId, financialYear: input.financialYear, filingRecordId: input.filingRecordId, auditEngagementId: input.auditEngagementId });
  if (!pos.adds) return { confirmedBy: null, warnings: [], before: pos.counted, after: pos.counted, params, fy };
  const check = checkNewTaxAudit({ currentTotal: pos.counted, actorRole: ctx.user.role, confirmed: input.confirmOverCeiling }, params);
  if (!check.allowed) {
    const msg = ctx.user.role === "partner" ? `${check.message} Tick the confirmation to log it.` : `${check.message} Ask a Partner to log it.`;
    throw new ActionError(msg, { code: "blocked", fieldErrors: { confirmOverCeiling: [msg] } });
  }
  return {
    confirmedBy: check.level === "confirm" && ctx.user.role === "partner" && input.confirmOverCeiling ? ctx.user.id : null,
    warnings: check.level === "warn" && check.message ? [check.message] : [],
    before: pos.counted,
    after: pos.counted + 1,
    params,
    fy,
  };
}

function ceilingNotices(ctx: ActionContext, member: Member, gate: { before: number; after: number; params: CeilingParams; fy: string }) {
  const crossed = ceilingThresholdsCrossed(gate.before, gate.after, gate.params);
  for (const mark of crossed) {
    ctx.after("Tell the partner about the tax-audit count", () =>
      notify({
        to: { userIds: [member.id] },
        type: "warning",
        title: mark >= gate.params.taxAuditCeiling ? `Tax audits for FY ${gate.fy}: at the ICAI ceiling of ${gate.params.taxAuditCeiling}` : `Tax audits for FY ${gate.fy}: ${mark} of ${gate.params.taxAuditCeiling}`,
        body: `${member.name} has ${gate.after} tax audit ${gate.after === 1 ? "report" : "reports"} counted for FY ${gate.fy}, including any signed elsewhere. ${gate.params.taxAuditCeiling - gate.after > 0 ? `${gate.params.taxAuditCeiling - gate.after} left.` : "Another one needs a Partner's confirmation."}`,
        linkUrl: "/registers?tab=udin",
        dedupeKey: `tax_audit_ceiling:${member.id}:${gate.fy}:${mark}`,
      }),
    );
  }
}

export const createUdin = defineAction(
  { name: "udin.create", schema: CreateUdinSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<SavedUdin>> => {
    const member = await signingMember(ctx, input.signingPartnerId);
    if (input.confirmOverCeiling && ctx.user.role !== "partner") return fail("Only a Partner can confirm a tax audit over the ceiling.", { code: "forbidden", fieldErrors: { confirmOverCeiling: ["Only a Partner can confirm this."] } });
    if (input.clientId) {
      const { data: client, error } = await ctx.supabase.from("clients").select("id, deleted_at").eq("id", input.clientId).maybeSingle();
      throwIfDbError(error);
      if (!client || client.deleted_at) return fail("That client isn't one you can see, or it's in the recycle bin.", { code: "not_found", fieldErrors: { clientId: ["Choose one of your clients."] } });
    }
    const counts = udinCounts(input.reportForm, input.isRevised, input.form26Category);
    const gate = await ceilingGate(ctx, { signingPartnerId: member.id, signedOn: input.signedOn, counts, confirmOverCeiling: input.confirmOverCeiling, recordId: null, clientId: input.clientId, financialYear: input.financialYear, filingRecordId: input.filingRecordId, auditEngagementId: input.auditEngagementId });
    const { data, error } = await ctx.supabase
      .from("udin_records")
      .insert({
        udin: input.udin,
        client_id: input.clientId,
        document_type: input.documentType,
        document_date: input.signedOn,
        report_form: input.reportForm,
        form26_category: input.reportForm === "FORM_26" ? input.form26Category : null,
        counts_towards_tax_audit_ceiling: input.reportForm === "FORM_26" ? counts : null,
        financial_year: input.financialYear,
        signed_on: input.signedOn,
        generated_on: input.generatedOn,
        signing_partner_id: member.id,
        filing_record_id: input.filingRecordId,
        audit_engagement_id: input.auditEngagementId,
        is_revised: input.isRevised,
        remarks: input.remarks,
        ceiling_confirmed_by: gate.confirmedBy,
      })
      .select("id, updated_at")
      .single();
    uniqueUdin(error);
    const row = data as { id: string; updated_at: string };
    const warnings = [...udinWarnings({ udin: input.udin, membershipNo: member.membershipNo, signedOn: input.signedOn, generatedOn: input.generatedOn }, gate.params), ...gate.warnings];
    await ctx.audit({
      event: "data_create",
      resourceType: "udin_record",
      resourceId: row.id,
      details: {
        client_id: input.clientId,
        udin: input.udin,
        document_type: input.documentType,
        report_form: input.reportForm,
        signing_partner_id: member.id,
        signed_on: input.signedOn,
        counts_towards_ceiling: counts,
        ceiling_confirmed: Boolean(gate.confirmedBy),
        ...(gate.confirmedBy ? { ceiling_position: gate.after } : {}),
      },
    });
    if (input.clientId) {
      const clientId = input.clientId;
      ctx.after("Add the UDIN to the client's timeline", () =>
        addTimelineEvent({
          clientId,
          eventType: "udin_logged",
          title: `UDIN ${input.udin} logged: ${input.documentType}${input.reportForm ? ` (${reportFormLabel(input.reportForm)})` : ""}, signed ${formatDate(input.signedOn)} by ${member.name}`,
          metadata: { udin_record_id: row.id },
        }),
      );
    }
    ceilingNotices(ctx, member, gate);
    return ok({ id: row.id, updatedAt: row.updated_at }, warnings);
  },
);

export const updateUdin = defineAction(
  { name: "udin.update", schema: UpdateUdinSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<SavedUdin>> => {
    const { data: before, error: readError } = await ctx.supabase.from("udin_records").select("id, client_id, udin, updated_at").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!before) return fail("That UDIN no longer exists. Reload to see the register.", { code: "not_found" });
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });
    if (input.confirmOverCeiling && ctx.user.role !== "partner") return fail("Only a Partner can confirm a tax audit over the ceiling.", { code: "forbidden", fieldErrors: { confirmOverCeiling: ["Only a Partner can confirm this."] } });
    const member = await signingMember(ctx, input.signingPartnerId);
    const counts = udinCounts(input.reportForm, input.isRevised, input.form26Category);
    const gate = await ceilingGate(ctx, { signingPartnerId: member.id, signedOn: input.signedOn, counts, confirmOverCeiling: input.confirmOverCeiling, recordId: input.id, clientId: input.clientId, financialYear: input.financialYear, filingRecordId: input.filingRecordId, auditEngagementId: input.auditEngagementId });
    const { data, error } = await ctx.supabase
      .from("udin_records")
      .update({
        udin: input.udin,
        client_id: input.clientId,
        document_type: input.documentType,
        document_date: input.signedOn,
        report_form: input.reportForm,
        form26_category: input.reportForm === "FORM_26" ? input.form26Category : null,
        counts_towards_tax_audit_ceiling: input.reportForm === "FORM_26" ? counts : null,
        financial_year: input.financialYear,
        signed_on: input.signedOn,
        generated_on: input.generatedOn,
        signing_partner_id: member.id,
        filing_record_id: input.filingRecordId,
        audit_engagement_id: input.auditEngagementId,
        is_revised: input.isRevised,
        remarks: input.remarks,
        ...(gate.confirmedBy ? { ceiling_confirmed_by: gate.confirmedBy } : {}),
      })
      .eq("id", input.id)
      .eq("updated_at", input.updatedAt)
      .select("id, updated_at");
    uniqueUdin(error);
    const row = (data ?? [])[0] as { id: string; updated_at: string } | undefined;
    if (!row) return fail(STALE, { code: "conflict" });
    await ctx.audit({ event: "data_update", resourceType: "udin_record", resourceId: row.id, details: { client_id: input.clientId, udin: input.udin, signing_partner_id: member.id, counts_towards_ceiling: counts } });
    if (input.clientId) {
      const clientId = input.clientId;
      ctx.after("Add the change to the client's timeline", () =>
        addTimelineEvent({ clientId, eventType: "udin_updated", title: `UDIN ${input.udin} updated in the register`, metadata: { udin_record_id: row.id } }),
      );
    }
    ceilingNotices(ctx, member, gate);
    const warnings = [...udinWarnings({ udin: input.udin, membershipNo: member.membershipNo, signedOn: input.signedOn, generatedOn: input.generatedOn }, gate.params), ...gate.warnings];
    return ok({ id: row.id, updatedAt: row.updated_at }, warnings);
  },
);

export const deleteUdin = defineAction(
  { name: "udin.delete", schema: RecordRefSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: before, error: readError } = await ctx.supabase.from("udin_records").select("id, client_id, udin, updated_at").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!before) return fail("That UDIN has already been removed.", { code: "not_found" });
    if (before.updated_at !== input.updatedAt) return fail(STALE, { code: "conflict" });
    const { data, error } = await ctx.supabase.from("udin_records").delete().eq("id", input.id).eq("updated_at", input.updatedAt).select("id");
    throwIfDbError(error);
    if (!data?.length) return fail(STALE, { code: "conflict" });
    await ctx.audit({ event: "data_delete", resourceType: "udin_record", resourceId: input.id, details: { client_id: before.client_id, udin: String(before.udin) } });
    if (before.client_id) {
      const clientId = before.client_id;
      ctx.after("Add the removal to the client's timeline", () =>
        addTimelineEvent({ clientId, eventType: "udin_removed", title: `UDIN ${String(before.udin)} removed from the register`, metadata: { udin_record_id: input.id } }),
      );
    }
    return ok({ id: input.id });
  },
);

export const saveExternalCount = defineAction(
  { name: "udin.external_count", schema: ExternalCountSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ total: number }>> => {
    const member = await memberOf(ctx, input.memberId);
    if (!member || member.role !== "partner") return fail("Audits signed elsewhere are recorded for the firm's Partners.", { code: "validation" });
    const { data: prior, error: priorError } = await ctx.supabase.from("tax_audit_ceiling_view").select("total_count").eq("member_profile_id", member.id).eq("financial_year", input.financialYear).maybeSingle();
    throwIfDbError(priorError);
    const { error } = await ctx.supabase
      .from("tax_audit_external_counts")
      .upsert({ member_profile_id: member.id, financial_year: input.financialYear, audits_signed_elsewhere: input.auditsSignedElsewhere, notes: input.notes, updated_by: ctx.user.id }, { onConflict: "member_profile_id,financial_year" });
    throwIfDbError(error);
    const { data: after, error: afterError } = await ctx.supabase.from("tax_audit_ceiling_view").select("total_count").eq("member_profile_id", member.id).eq("financial_year", input.financialYear).maybeSingle();
    throwIfDbError(afterError);
    const total = after?.total_count ?? input.auditsSignedElsewhere;
    await ctx.audit({ event: "data_update", resourceType: "tax_audit_external_count", resourceId: member.id, details: { financial_year: input.financialYear, audits_signed_elsewhere: input.auditsSignedElsewhere, total } });
    const params = await ceilingParams(ctx, input.financialYear);
    ceilingNotices(ctx, member, { before: prior?.total_count ?? 0, after: total, params, fy: input.financialYear });
    const warnings = total > params.taxAuditCeiling ? [`${member.name} now has ${total} tax audits counted for FY ${input.financialYear}, over the ICAI ceiling of ${params.taxAuditCeiling}.`] : undefined;
    return ok({ total }, warnings);
  },
);

export const loadUdinLinks = defineAction(
  { name: "udin.links", schema: z.object({ clientId: z.uuid() }), roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<UdinLinkOptions>> => ok(await getUdinLinkOptions(ctx.supabase, input.clientId)),
);
