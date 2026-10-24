"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import type { Json, TablesUpdate } from "@/lib/database.types";
import { todayIST } from "@/lib/domain/fy";
import { fromPaise } from "@/lib/domain/money";
import { formatDate } from "@/lib/format";
import {
  AUDIT_STAGE_LABELS,
  AUDIT_TYPE_LABELS,
  computeMateriality,
  isAuditStage,
  isAuditType,
  stageIndex,
  toStoredCompanyFacts,
  type AuditStage,
  type GateItem,
} from "@/lib/domain/audit-stages";
import {
  AdvanceStageSchema,
  AttachEvidenceSchema,
  AuditRefSchema,
  CompanyFactsSchema,
  CreateAuditSchema,
  DetachEvidenceSchema,
  LimitOverrideSchema,
  MaterialitySchema,
  ReportSchema,
  SignoffSchema,
  UpdateAuditSchema,
} from "@/lib/schemas/audits";
import { getStageGate, searchEvidenceDocuments } from "@/lib/data/audits";
import { escapeLike } from "@/components/app/data-table/params";
import type { ComboOption } from "@/components/app/form/combobox";
import { z } from "zod";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity } from "@/server/activity";

/**
 * Audit engagements (§6.9, §7.15.5). Partners and Managers only (§4.1, RLS 0033); the gates, the
 * engagement partner's approval, sign-off rules and the archive lock live in the database (0195,
 * 0196), which refuses with plain sentences that reach the user as they are.
 *
 *   createAudit / updateAudit / deleteAudit   the engagement (delete only at Acceptance, Partner)
 *   saveMateriality      SA 320: basis × percentage, performance and clearly trivial, computed here
 *   saveCompanyFacts     for CARO 2020 and the s.141(3)(g) count
 *   saveReport           report type and date, the UDIN, the CARO decision
 *   advanceStage         the engagement partner moves the engagement (gate in SQL)
 *   signoffStep          prepare · not applicable · review · reopen
 *   attachEvidence / detachEvidence   vault documents tagged to a step (amendments after archive)
 *   confirmLimitOverride a Partner confirms a tax audit over the ICAI ceiling
 *
 * Each writes an audit row; the activity history, the client timeline and notices run after the
 * save (ctx.after) and never fail it (§0.1 rule 5).
 */

const MANAGERS = ["partner", "manager"] as const;

type Head = { id: string; client_id: string; audit_type: string; financial_year: string; stage: string; engagement_partner_id: string; review_manager_id: string | null; updated_at: string; archived_at: string | null; clients: { display_name: string } | null };

async function head(ctx: ActionContext, id: string): Promise<Head> {
  const { data, error } = await ctx.supabase
    .from("audit_engagements")
    .select("id, client_id, audit_type, financial_year, stage, engagement_partner_id, review_manager_id, updated_at, archived_at, clients!inner(display_name)")
    .eq("id", id)
    .maybeSingle();
  throwIfDbError(error);
  if (!data) throw new ActionError("That audit engagement no longer exists.", { code: "not_found" });
  return data as unknown as Head;
}

function typeLabel(t: string): string {
  return isAuditType(t) ? AUDIT_TYPE_LABELS[t] : "Audit";
}

function title(h: Pick<Head, "audit_type" | "financial_year">): string {
  return `${typeLabel(h.audit_type)} FY ${h.financial_year}`;
}

/** "Changed by Anita at 12:41. Reload to see their changes." when the row moved on (§13). */
async function conflict(ctx: ActionContext, id: string): Promise<never> {
  const { data } = await ctx.supabase.rpc("audit_change_conflict", { p_id: id });
  const msg = typeof data === "string" && data.startsWith("USER: ") ? data.slice(6) : "The engagement was changed by someone else. Reload to see their changes.";
  throw new ActionError(msg, { code: "conflict" });
}

function throwDb(error: { code?: string; message?: string } | null): void {
  if (error?.message?.startsWith("USER: Changed by ")) throw new ActionError(error.message.slice(6), { code: "conflict" });
  throwIfDbError(error);
}

/** Profile ids of employees (engagement partner / review manager), for notices. */
async function profileIdsOf(ctx: ActionContext, employeeIds: ReadonlyArray<string | null>): Promise<string[]> {
  const ids = employeeIds.filter((x): x is string => !!x);
  if (!ids.length) return [];
  const { data, error } = await ctx.supabase.from("employees").select("profile_id").in("id", ids);
  throwIfDbError(error);
  return (data ?? []).map((r) => r.profile_id).filter((x): x is string => !!x && x !== ctx.user.id);
}

function history(id: string, action: string, description: string, metadata?: Record<string, unknown>) {
  return () => logActivity({ entityType: "audit_engagement", entityId: id, action, description, metadata: metadata ?? null });
}

// =================================================================================================
// Lookups
// =================================================================================================

export const searchAuditClients = defineAction(
  { name: "audits.search_clients", schema: z.object({ q: z.string().max(100).default("") }), roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<ComboOption[]>> => {
    let q = ctx.supabase.from("clients").select("id, display_name, client_code, entity_type").is("deleted_at", null).neq("status", "inactive");
    if (input.q.trim()) {
      const like = `%${escapeLike(input.q.trim())}%`;
      q = q.or(`display_name.ilike.${like},client_code.ilike.${like},legal_name.ilike.${like}`);
    }
    const { data, error } = await q.order("display_name").limit(20);
    throwIfDbError(error);
    return ok((data ?? []).map((c) => ({ value: c.id, label: c.display_name, description: String(c.client_code) })));
  },
);

export const searchEvidenceDocs = defineAction(
  { name: "audits.search_documents", schema: z.object({ clientId: z.uuid(), q: z.string().max(100).default("") }), roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<ComboOption[]>> => ok(await searchEvidenceDocuments(ctx.supabase, input.clientId, input.q)),
);

// =================================================================================================
// The engagement
// =================================================================================================

export const createAudit = defineAction(
  { name: "audits.create", schema: CreateAuditSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: client, error: clientError } = await ctx.supabase.from("clients").select("id, display_name, deleted_at").eq("id", input.clientId).maybeSingle();
    throwIfDbError(clientError);
    if (!client || client.deleted_at) return fail("That client isn't in the client list any more.", { code: "not_found", fieldErrors: { clientId: ["Choose a current client."] } });

    const { data, error } = await ctx.supabase
      .from("audit_engagements")
      .insert({
        client_id: input.clientId,
        audit_type: input.auditType,
        financial_year: input.financialYear,
        engagement_partner_id: input.engagementPartnerId,
        review_manager_id: input.reviewManagerId,
        had_previous_auditor: input.hadPreviousAuditor,
        requires_peer_reviewed_auditor: input.requiresPeerReviewedAuditor,
        notes: input.notes,
      })
      .select("id")
      .single();
    if (error?.message?.includes("engagement partner")) throw new ActionError(error.message.replace(/^USER: /, ""), { fieldErrors: { engagementPartnerId: [error.message.replace(/^USER: /, "")] } });
    if (error?.message?.includes("review manager")) throw new ActionError(error.message.replace(/^USER: /, ""), { fieldErrors: { reviewManagerId: [error.message.replace(/^USER: /, "")] } });
    throwDb(error);
    const id = data!.id;
    const label = `${AUDIT_TYPE_LABELS[input.auditType]} FY ${input.financialYear}`;

    await ctx.audit({ event: "data_create", resourceType: "audit_engagement", resourceId: id, details: { client_id: input.clientId, audit_type: input.auditType, financial_year: input.financialYear, engagement_partner_id: input.engagementPartnerId } });
    ctx.after("Record it in the engagement's history", history(id, "audit_created", `Engagement opened at Acceptance by ${ctx.user.fullName}`));
    ctx.after("Add it to the client's timeline", () =>
      addTimelineEvent({ clientId: input.clientId, eventType: "audit_engagement_created", title: `${label} opened`, description: "At Acceptance: KYC, independence, the previous auditor and the SA 210 letter come first.", metadata: { audit_engagement_id: id } }),
    );
    ctx.after("Tell the engagement partner", async () => {
      const to = await profileIdsOf(ctx, [input.engagementPartnerId, input.reviewManagerId]);
      if (!to.length) return;
      await notify({
        to: { userIds: to },
        type: "info",
        title: `${label}: you're on the engagement`,
        body: `${ctx.user.fullName} opened the ${label.toLowerCase()} of ${client.display_name}. It starts at Acceptance.`,
        linkUrl: `/audits/${id}`,
        entity: { type: "audit_engagement", id },
        clientId: input.clientId,
        dedupeKey: `audit_created:${id}`,
      });
    });
    return ok({ id });
  },
);

export const updateAudit = defineAction(
  { name: "audits.update", schema: UpdateAuditSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const h = await head(ctx, input.id);
    if (h.archived_at) return fail("This audit file is archived and read-only.", { code: "blocked" });
    const patch: TablesUpdate<"audit_engagements"> = {
      review_manager_id: input.reviewManagerId,
      notes: input.notes,
    };
    if (h.stage === "acceptance") {
      patch.audit_type = input.auditType;
      patch.financial_year = input.financialYear;
      patch.had_previous_auditor = input.hadPreviousAuditor;
      patch.requires_peer_reviewed_auditor = input.requiresPeerReviewedAuditor;
    }
    if (input.engagementPartnerId !== h.engagement_partner_id) {
      if (ctx.user.role !== "partner") return fail("Only a Partner can change the engagement partner.", { code: "forbidden", fieldErrors: { engagementPartnerId: ["Only a Partner can change this."] } });
      patch.engagement_partner_id = input.engagementPartnerId;
    }
    const { data, error } = await ctx.supabase.from("audit_engagements").update(patch).eq("id", input.id).eq("updated_at", input.updatedAt).select("updated_at");
    throwDb(error);
    if (!data?.length) await conflict(ctx, input.id);
    await ctx.audit({ event: "data_update", resourceType: "audit_engagement", resourceId: input.id, details: { fields: Object.keys(patch) } });
    ctx.after("Record it in the engagement's history", history(input.id, "audit_updated", "Engagement details updated"));
    if (patch.engagement_partner_id) {
      ctx.after("Tell the new engagement partner", async () => {
        const to = await profileIdsOf(ctx, [input.engagementPartnerId]);
        if (!to.length) return;
        await notify({
          to: { userIds: to },
          type: "info",
          title: `${title(h)}: you're now the engagement partner`,
          body: `${ctx.user.fullName} made you the engagement partner on the ${title(h).toLowerCase()} of ${h.clients?.display_name ?? "a client"}. You approve each stage move.`,
          linkUrl: `/audits/${input.id}`,
          entity: { type: "audit_engagement", id: input.id },
          clientId: h.client_id,
        });
      });
    }
    return ok({ updatedAt: data![0].updated_at });
  },
);

export const deleteAudit = defineAction(
  { name: "audits.delete", schema: AuditRefSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const h = await head(ctx, input.id);
    const { error, count } = await ctx.supabase.from("audit_engagements").delete({ count: "exact" }).eq("id", input.id);
    throwDb(error);
    if (!count) return fail("That audit engagement no longer exists.", { code: "not_found" });
    await ctx.audit({ event: "data_delete", resourceType: "audit_engagement", resourceId: input.id, details: { client_id: h.client_id, audit_type: h.audit_type, financial_year: h.financial_year } });
    ctx.after("Add it to the client's timeline", () =>
      addTimelineEvent({ clientId: h.client_id, eventType: "audit_engagement_deleted", title: `${title(h)} removed at Acceptance`, metadata: { audit_engagement_id: input.id } }),
    );
    return ok({ id: input.id });
  },
);

// =================================================================================================
// Materiality, company facts, report
// =================================================================================================

export const saveMateriality = defineAction(
  { name: "audits.materiality", schema: MaterialitySchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string; guidance: string[] }>> => {
    const h = await head(ctx, input.id);
    if (h.archived_at) return fail("This audit file is archived and read-only.", { code: "blocked" });
    const m = computeMateriality({
      basis: input.basis,
      baseAmountPaise: input.baseAmount,
      percent: input.percent,
      performancePercent: input.performancePercent,
      trivialPercent: input.trivialPercent,
    });
    if (m.overallPaise <= 0 || m.trivialPaise <= 0) return fail("Those figures give no materiality. Check the benchmark and the percentages.", { code: "validation" });
    const stored = {
      basis: input.basis,
      base_amount: fromPaise(input.baseAmount),
      percent: input.percent,
      overall: fromPaise(m.overallPaise),
      performance_percent: input.performancePercent,
      performance: fromPaise(m.performancePaise),
      trivial_percent: input.trivialPercent,
      trivial: fromPaise(m.trivialPaise),
      rationale: input.rationale,
      determined_on: todayIST(),
      determined_by: ctx.user.id,
    };
    const { data, error } = await ctx.supabase.from("audit_engagements").update({ materiality: stored as unknown as Json }).eq("id", input.id).eq("updated_at", input.updatedAt).select("updated_at");
    throwDb(error);
    if (!data?.length) await conflict(ctx, input.id);
    await ctx.audit({ event: "data_update", resourceType: "audit_engagement", resourceId: input.id, action: "audits.materiality", details: { basis: input.basis, percent: input.percent, performance_percent: input.performancePercent, trivial_percent: input.trivialPercent } });
    ctx.after("Record it in the engagement's history", history(input.id, "audit_materiality", `Materiality set on ${input.basis.replace(/_/g, " ")} at ${input.percent}% (SA 320)`));
    return ok({ updatedAt: data![0].updated_at, guidance: m.warnings });
  },
);

export const saveCompanyFacts = defineAction(
  { name: "audits.company_facts", schema: CompanyFactsSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string; countsTowardsLimit: boolean | null }>> => {
    const h = await head(ctx, input.id);
    if (h.archived_at) return fail("This audit file is archived and read-only.", { code: "blocked" });
    const rupees = (p: number | null) => (p === null ? null : fromPaise(p));
    const has = (k: (typeof input.flags)[number]) => input.flags.includes(k);
    const profile = toStoredCompanyFacts({
      isPublic: input.isPublic === "public",
      isOnePersonCompany: has("isOnePersonCompany"),
      isSection8: has("isSection8"),
      isBanking: has("isBanking"),
      isInsurance: has("isInsurance"),
      isHoldingOrSubsidiary: has("isHoldingOrSubsidiary"),
      isHoldingOrSubsidiaryOfPublic: has("isHoldingOrSubsidiaryOfPublic"),
      isSpecialAct: has("isSpecialAct"),
      isDormant: has("isDormant"),
      paidUpCapital: rupees(input.paidUpCapital),
      turnover: rupees(input.turnover),
      capitalAndReserves: rupees(input.capitalAndReserves),
      maxBorrowings: rupees(input.maxBorrowings),
      revenue: rupees(input.revenue),
    });
    const { data, error } = await ctx.supabase
      .from("audit_engagements")
      .update({ company_profile: profile as unknown as Json })
      .eq("id", input.id)
      .eq("updated_at", input.updatedAt)
      .select("updated_at, counts_towards_company_audit_limit");
    throwDb(error);
    if (!data?.length) await conflict(ctx, input.id);
    await ctx.audit({ event: "data_update", resourceType: "audit_engagement", resourceId: input.id, action: "audits.company_facts", details: { is_public: input.isPublic === "public" } });
    ctx.after("Record it in the engagement's history", history(input.id, "audit_company_facts", "Company facts recorded (CARO 2020, s.141(3)(g))"));
    return ok({ updatedAt: data![0].updated_at, countsTowardsLimit: data![0].counts_towards_company_audit_limit });
  },
);

export const saveReport = defineAction(
  { name: "audits.report", schema: ReportSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const h = await head(ctx, input.id);
    if (h.archived_at) return fail("This audit file is archived and read-only.", { code: "blocked" });
    if (stageIndex(h.stage as AuditStage) < stageIndex("reporting") && h.stage !== "completion") {
      return fail("Record the report once the engagement reaches Completion or Reporting.", { code: "blocked" });
    }
    if (input.reportDate > todayIST()) return fail("The report date can't be in the future.", { code: "validation", fieldErrors: { reportDate: ["The report date can't be in the future."] } });
    const patch = { report_type: input.reportType, report_date: input.reportDate, udin_record_id: input.udinRecordId, caro_applicable: h.audit_type === "statutory_companies_act" ? input.caroApplicable : null };
    const { data, error } = await ctx.supabase.from("audit_engagements").update(patch).eq("id", input.id).eq("updated_at", input.updatedAt).select("updated_at");
    if (error?.message?.includes("UDIN")) throw new ActionError(error.message.replace(/^USER: /, ""), { fieldErrors: { udinRecordId: [error.message.replace(/^USER: /, "")] } });
    throwDb(error);
    if (!data?.length) await conflict(ctx, input.id);
    await ctx.audit({ event: "data_update", resourceType: "audit_engagement", resourceId: input.id, action: "audits.report", details: { report_type: input.reportType, report_date: input.reportDate, udin_record_id: input.udinRecordId, caro_applicable: patch.caro_applicable } });
    ctx.after("Record it in the engagement's history", history(input.id, "audit_report", `Report recorded: ${input.reportType} opinion dated ${formatDate(input.reportDate)}`));
    return ok({ updatedAt: data![0].updated_at });
  },
);

// =================================================================================================
// Stage moves
// =================================================================================================

export type StageMoved = { stage: AuditStage; updatedAt: string; warnings: string[]; archivedAt: string | null };

export const advanceStage = defineAction(
  { name: "audits.advance_stage", schema: AdvanceStageSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<StageMoved>> => {
    const h = await head(ctx, input.id);
    const { data, error } = await ctx.supabase.rpc("advance_audit_stage", { p_id: input.id, p_to: input.to, p_note: input.note, p_expected_updated_at: input.updatedAt });
    throwDb(error);
    const r = (data ?? {}) as { stage: string; from: string; updated_at: string; archived_at: string | null; warnings?: GateItem[]; documents_retention_extended?: number };
    const to: AuditStage = isAuditStage(r.stage) ? r.stage : input.to;
    const from: AuditStage = isAuditStage(r.from) ? r.from : (h.stage as AuditStage);
    const back = stageIndex(to) < stageIndex(from);
    const warnings = (r.warnings ?? []).map((w) => w.message.charAt(0).toUpperCase() + w.message.slice(1).replace(/\.?$/, "."));

    await ctx.audit({
      event: "data_update",
      resourceType: "audit_engagement",
      resourceId: input.id,
      action: to === "archived" ? "audits.archive" : "audits.stage_move",
      details: { from, to, note: input.note, warnings: warnings.length ? warnings : undefined, documents_retention_extended: r.documents_retention_extended ?? 0 },
    });
    const what = to === "archived" ? "Archived: the file is locked" : back ? `Moved back to ${AUDIT_STAGE_LABELS[to]}` : `Moved to ${AUDIT_STAGE_LABELS[to]}`;
    ctx.after("Record it in the engagement's history", history(input.id, to === "archived" ? "audit_archived" : "audit_stage_moved", `${what}, approved by ${ctx.user.fullName}${input.note ? `: ${input.note}` : ""}`, { from, to }));
    ctx.after("Add it to the client's timeline", () =>
      addTimelineEvent({
        clientId: h.client_id,
        eventType: to === "archived" ? "audit_archived" : "audit_stage_moved",
        title: `${title(h)}: ${what.toLowerCase()}`,
        description: to === "archived" ? "The file is read-only now; anything added later is logged as an amendment (SA 230)." : null,
        metadata: { audit_engagement_id: input.id, from, to },
      }),
    );
    ctx.after("Tell the review manager", async () => {
      const to_ = await profileIdsOf(ctx, [h.review_manager_id]);
      if (!to_.length) return;
      await notify({
        to: { userIds: to_ },
        type: "info",
        title: `${title(h)}: ${what.toLowerCase()}`,
        body: `${ctx.user.fullName} ${back ? "moved" : "approved moving"} the ${title(h).toLowerCase()} of ${h.clients?.display_name ?? "a client"} ${back ? "back to" : "to"} ${AUDIT_STAGE_LABELS[to]}.`,
        linkUrl: `/audits/${input.id}`,
        entity: { type: "audit_engagement", id: input.id },
        clientId: h.client_id,
        dedupeKey: `audit_stage:${input.id}:${to}:${r.updated_at}`,
      });
    });
    return ok({ stage: to, updatedAt: r.updated_at, warnings, archivedAt: r.archived_at ?? null }, warnings);
  },
);

// =================================================================================================
// Sign-offs and evidence
// =================================================================================================

export type SignedStep = { step: string; updatedAt: string; gateOk: boolean | null };

const ACTION_WORDS: Record<string, string> = { prepare: "prepared", not_applicable: "marked not applicable", review: "reviewed", reopen: "reopened" };

export const signoffStep = defineAction(
  { name: "audits.signoff", schema: SignoffSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<SignedStep>> => {
    const h = await head(ctx, input.id);
    const { data, error } = await ctx.supabase.rpc("audit_step_signoff", { p_id: input.id, p_step: input.step, p_action: input.action, p_note: input.note });
    throwDb(error);
    const r = (data ?? {}) as { updated_at: string };
    await ctx.audit({ event: "data_update", resourceType: "audit_engagement", resourceId: input.id, action: `audits.signoff.${input.action}`, details: { step: input.step, note: input.note } });
    ctx.after("Record it in the engagement's history", history(input.id, "audit_step_signed", `Step ${input.step} ${ACTION_WORDS[input.action]} by ${ctx.user.fullName}${input.note ? `: ${input.note}` : ""}`, { step: input.step, action: input.action }));

    let gateOk: boolean | null = null;
    if (input.action === "review" && isAuditStage(h.stage)) {
      try {
        const gate = await getStageGate(ctx.supabase, input.id, h.stage);
        gateOk = gate?.ok ?? null;
        if (gate?.ok) {
          ctx.after("Tell the engagement partner the stage is ready", async () => {
            const to = await profileIdsOf(ctx, [h.engagement_partner_id]);
            if (!to.length) return;
            await notify({
              to: { userIds: to },
              type: "review_requested",
              title: `${title(h)}: ready to move on from ${AUDIT_STAGE_LABELS[h.stage as AuditStage]}`,
              body: `Every step of ${AUDIT_STAGE_LABELS[h.stage as AuditStage]} for ${h.clients?.display_name ?? "the client"} is prepared and reviewed. Your approval moves it to the next stage.`,
              linkUrl: `/audits/${input.id}`,
              entity: { type: "audit_engagement", id: input.id },
              clientId: h.client_id,
              dedupeKey: `audit_stage_ready:${input.id}:${h.stage}`,
            });
          });
        }
      } catch {
        gateOk = null;
      }
    }
    return ok({ step: input.step, updatedAt: r.updated_at, gateOk });
  },
);

export const attachEvidence = defineAction(
  { name: "audits.attach_evidence", schema: AttachEvidenceSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ added: number; amendment: boolean }>> => {
    const h = await head(ctx, input.id);
    const { data, error } = await ctx.supabase.rpc("audit_attach_evidence", { p_id: input.id, p_step: input.step, p_document_ids: input.documentIds, p_note: input.note });
    throwDb(error);
    const r = (data ?? {}) as { added: number; amendment: boolean };
    await ctx.audit({
      event: "data_update",
      resourceType: "audit_engagement",
      resourceId: input.id,
      action: r.amendment ? "audits.amendment" : "audits.attach_evidence",
      details: { step: input.step, document_ids: input.documentIds, added: r.added, note: input.note },
    });
    ctx.after(
      "Record it in the engagement's history",
      history(input.id, r.amendment ? "audit_amendment" : "audit_evidence_added", `${r.added} working ${r.added === 1 ? "paper" : "papers"} added to ${input.step}${r.amendment ? ` as an amendment after archive: ${input.note}` : ""}`, { step: input.step }),
    );
    if (r.amendment) {
      ctx.after("Add the amendment to the client's timeline", () =>
        addTimelineEvent({ clientId: h.client_id, eventType: "audit_amendment", title: `${title(h)}: amendment to the archived file`, description: input.note, metadata: { audit_engagement_id: input.id, step: input.step } }),
      );
    }
    return ok({ added: r.added, amendment: r.amendment });
  },
);

export const detachEvidence = defineAction(
  { name: "audits.detach_evidence", schema: DetachEvidenceSchema, roles: MANAGERS },
  async (input, ctx): Promise<ActionResult<{ engagementId: string }>> => {
    const { data, error } = await ctx.supabase.rpc("audit_detach_evidence", { p_link_id: input.linkId });
    throwDb(error);
    const r = (data ?? {}) as { engagement_id: string; step: string; document_id: string };
    await ctx.audit({ event: "data_update", resourceType: "audit_engagement", resourceId: r.engagement_id, action: "audits.detach_evidence", details: { step: r.step, document_id: r.document_id } });
    ctx.after("Record it in the engagement's history", history(r.engagement_id, "audit_evidence_removed", `A working paper was removed from ${r.step}`, { step: r.step }));
    return ok({ engagementId: r.engagement_id });
  },
);

export const confirmLimitOverride = defineAction(
  { name: "audits.limit_override", schema: LimitOverrideSchema, roles: ["partner"] },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const h = await head(ctx, input.id);
    const { data, error } = await ctx.supabase.rpc("confirm_audit_limit_override", { p_id: input.id, p_note: input.note });
    throwDb(error);
    const r = (data ?? {}) as { updated_at: string; position: number; limit: number };
    await ctx.audit({ event: "permission_change", resourceType: "audit_engagement", resourceId: input.id, action: "audits.tax_audit_ceiling_confirmed", details: { position: r.position, limit: r.limit, note: input.note } });
    ctx.after("Record it in the engagement's history", history(input.id, "audit_limit_override", `${ctx.user.fullName} confirmed tax audit ${r.position} over the ceiling of ${r.limit}: ${input.note}`));
    ctx.after("Tell the engagement partner", async () => {
      const to = await profileIdsOf(ctx, [h.engagement_partner_id]);
      if (!to.length) return;
      await notify({
        to: { userIds: to },
        type: "warning",
        title: `Tax audit ${r.position} confirmed over the ceiling`,
        body: `${ctx.user.fullName} confirmed the ${title(h).toLowerCase()} of ${h.clients?.display_name ?? "a client"} as tax audit ${r.position}, over the ICAI ceiling of ${r.limit}.`,
        linkUrl: `/audits/${input.id}`,
        entity: { type: "audit_engagement", id: input.id },
        clientId: h.client_id,
      });
    });
    return ok({ updatedAt: r.updated_at });
  },
);
