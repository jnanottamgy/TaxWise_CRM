"use server";

import { defineAction, throwIfDbError, type ActionContext } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { STAFF_ROLES } from "@/lib/auth/roles";
import { taxYearLabel, type FinancialYear } from "@/lib/domain/fy";
import type { AgeBand, Regime } from "@/lib/domain/itr-rulesets";
import type { Json } from "@/lib/database.types";
import type { ComboOption } from "@/components/app/form/combobox";
import {
  ItrClientContextSchema,
  ItrClientSearchSchema,
  ItrFormSchema,
  ItrRefSchema,
  ItrStatusSchema,
  ITR_STATUS_INFO,
  REGIME_LABEL,
  ageBandFor,
  computeStored,
  defaultReturnKind,
  formToStoredInputs,
  type ItrStatus,
  type ReturnDueDate,
  type ReturnKind,
} from "@/lib/schemas/itr";
import {
  dueDatesFor,
  getItrClientFacts,
  getItrRuleSetRows,
  getReturnDueDateSources,
  ruleSetFor,
  searchItrClients as searchClients,
  type ItrClientFacts,
} from "@/lib/data/itr";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";
import { logActivity, logEmployeeActivity } from "@/server/activity";

/**
 * ITR computations (§6.11, §7.8.2). Staff for their own clients (RLS: Employees see only theirs,
 * §4.1); the guard on itr_computations (0205) is the real control for who reviews and who marks
 * Final, and for the rule set the results are computed with.
 *
 *   searchItrClients / getItrClientContext   the editor's client picker and its facts
 *   saveItrComputation   the editor's save (autosave every 5 s while a draft, §3.4, or Save):
 *                        the results are computed HERE from the inputs and the rule set read from
 *                        statutory_parameters, never taken from the browser
 *   setItrStatus         Draft → Reviewed (the reviewer records the regime chosen) → Final
 *                        (Manager/Partner), or back to Draft with a note
 *   deleteItrComputation Partner/Manager, never a final one
 *
 * Each writes an audit row; the computation's history, the client's timeline and notices to the
 * preparer run after the save (ctx.after) and never fail it (§0.1 rule 5).
 */

const MP = ["partner", "manager"] as const;

function throwDb(error: { code?: string; message?: string } | null): void {
  if (error?.message?.startsWith("USER: Changed by ")) throw new ActionError(error.message.slice(6), { code: "conflict" });
  throwIfDbError(error);
}

function history(id: string, action: string, description: string) {
  return () => logActivity({ entityType: "itr_computation", entityId: id, action, description });
}

// =================================================================================================
// Lookups for the editor
// =================================================================================================

export const searchItrClients = defineAction(
  { name: "itr.search_clients", schema: ItrClientSearchSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<ComboOption[]>> => ok(await searchClients(ctx.supabase, input.q)),
);

export type ItrClientContext = {
  client: ItrClientFacts;
  /** From the date of birth; null when it isn't recorded. */
  ageBand: AgeBand | null;
  dueDates: Partial<Record<ReturnKind, ReturnDueDate>>;
  defaultKind: ReturnKind;
  yearLabel: string;
  ruleSetError: string | null;
};

/** The facts the editor needs when the client or the year is chosen. */
export const getItrClientContext = defineAction(
  { name: "itr.client_context", schema: ItrClientContextSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<ItrClientContext>> => {
    const [client, rows, sources] = await Promise.all([getItrClientFacts(ctx.supabase, input.clientId), getItrRuleSetRows(ctx.supabase), getReturnDueDateSources(ctx.supabase)]);
    if (!client) return fail("That client isn't one of yours, or it is in the recycle bin.", { code: "not_found" });
    if (!client.eligible) return fail("ITR computations are for individuals and HUFs. This client is recorded as another kind of entity.", { code: "blocked" });
    const rs = ruleSetFor(rows, input.financialYear);
    return ok({
      client,
      ageBand: client.assesseeType === "huf" ? "below_60" : ageBandFor(client.date_of_birth, input.financialYear),
      dueDates: dueDatesFor(input.financialYear, sources),
      defaultKind: defaultReturnKind({ taxAuditApplicable: client.tax_audit_applicable, businessIncome: false }),
      yearLabel: taxYearLabel(input.financialYear),
      ruleSetError: rs.ok ? null : rs.error,
    });
  },
);

// =================================================================================================
// Save (§7.8.2)
// =================================================================================================

export type SavedItr = {
  id: string;
  status: ItrStatus;
  updatedAt: string;
  created: boolean;
  backToDraft: boolean;
  recommendedRegime: Regime;
  savingPaise: number;
  /** The server's own age band and due date, when it applied the automatic ones. */
  ageBand: AgeBand;
  dueDate: string;
};

type CurrentRow = { id: string; status: ItrStatus; client_id: string; financial_year: string; updated_at: string };

async function currentRow(ctx: ActionContext, id: string): Promise<CurrentRow> {
  const { data, error } = await ctx.supabase.from("itr_computations").select("id, status, client_id, financial_year, updated_at").eq("id", id).maybeSingle();
  throwIfDbError(error);
  if (!data) throw new ActionError("That computation no longer exists, or isn't one of yours.", { code: "not_found" });
  return data as CurrentRow;
}

export const saveItrComputation = defineAction(
  { name: "itr.save", schema: ItrFormSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<SavedItr>> => {
    const existing = input.id ? await currentRow(ctx, input.id) : null;
    if (existing?.status === "final") return fail("This computation is final. A Manager or Partner can reopen it to make changes.", { code: "blocked" });
    if (existing && input.intent === "autosave" && existing.status !== "draft") {
      return fail("This computation is reviewed. Save it yourself to send it back to Draft with the changes.", { code: "blocked" });
    }
    const clientId = existing?.client_id ?? input.client_id;
    const fy: FinancialYear = existing?.financial_year ?? input.financial_year;

    const [client, rows, sources] = await Promise.all([getItrClientFacts(ctx.supabase, clientId), getItrRuleSetRows(ctx.supabase), getReturnDueDateSources(ctx.supabase)]);
    if (!client) return fail("That client isn't one of yours, or it is in the recycle bin.", { code: "not_found", fieldErrors: { client_id: ["Choose one of your clients."] } });
    if (!client.eligible) {
      return fail("ITR computations are for individuals and HUFs. This client is recorded as another kind of entity.", { code: "blocked", fieldErrors: { client_id: ["Choose an individual or a HUF."] } });
    }
    const rs = ruleSetFor(rows, fy);
    if (!rs.ok) return fail(rs.error, { code: "blocked", fieldErrors: { financial_year: [rs.error] } });

    // The automatic age band and due date are the server's, so they always follow the client's
    // date of birth and the rules and extensions in force (§7.8.2 "age band auto … overridable").
    const values = { ...input, client_id: clientId, financial_year: fy };
    if (client.assesseeType === "huf") values.age_band = "below_60";
    else if (values.age_band_source === "auto") {
      const band = ageBandFor(client.date_of_birth, fy);
      if (band) values.age_band = band;
    }
    if (values.due_date_source === "rule") {
      const due = dueDatesFor(fy, sources)[values.return_kind];
      if (due) values.due_date = due.date;
    }

    const converted = formToStoredInputs(values, client.assesseeType);
    if (!converted.ok) return fail("Please check the highlighted fields.", { code: "validation", fieldErrors: converted.fieldErrors });
    const computed = computeStored(converted.stored, rs.ruleSet);
    if (!computed.ok) return fail("Please check the highlighted fields.", { code: "validation", fieldErrors: computed.fieldErrors });
    const result = computed.result;

    const { data, error } = await ctx.supabase.rpc("save_itr_computation", {
      p_payload: {
        id: existing?.id ?? null,
        updated_at: existing ? input.updated_at : null,
        client_id: clientId,
        financial_year: fy,
        label: values.label,
        inputs: converted.stored,
        results: result,
        rule_set: rs.raw,
        rule_set_param_id: rs.paramId,
      } as unknown as Json,
    });
    throwDb(error);
    const r = (data ?? {}) as { id: string; status: ItrStatus; updated_at: string; created: boolean; back_to_draft: boolean };

    await ctx.audit({
      event: r.created ? "data_create" : "data_update",
      resourceType: "itr_computation",
      resourceId: r.id,
      action: input.intent === "autosave" ? "itr.autosave" : "itr.save",
      details: { client_id: clientId, financial_year: fy, status: r.status, recommended_regime: result.recommendedRegime, rule_set_param_id: rs.paramId, back_to_draft: r.back_to_draft },
    });

    const yearLabel = result.yearLabel;
    if (r.created) {
      ctx.after("Add to the client's timeline", () =>
        addTimelineEvent({ clientId, eventType: "itr_computation_created", title: `ITR computation started for ${yearLabel}`, metadata: { itr_computation_id: r.id, financial_year: fy } }),
      );
      ctx.after("Record it in the computation's history", history(r.id, "itr_created", `Started for ${yearLabel} (${client.display_name}).`));
      ctx.after("Add to your activity", () =>
        logEmployeeActivity({ activityType: "itr_computation_created", description: `Started an ITR computation for ${client.display_name}, ${yearLabel}`, entityType: "itr_computation", entityId: r.id, entityName: client.display_name }),
      );
    } else if (input.intent !== "autosave") {
      ctx.after(
        "Record it in the computation's history",
        history(r.id, r.back_to_draft ? "itr_back_to_draft" : "itr_saved", r.back_to_draft ? "Figures changed after review, so it is back in Draft for a fresh review." : "Figures saved and recomputed."),
      );
    }
    return ok({
      id: r.id,
      status: r.status,
      updatedAt: r.updated_at,
      created: Boolean(r.created),
      backToDraft: Boolean(r.back_to_draft),
      recommendedRegime: result.recommendedRegime,
      savingPaise: result.saving,
      ageBand: values.age_band,
      dueDate: values.due_date,
    });
  },
);

// =================================================================================================
// Review and final (§7.8.2)
// =================================================================================================

export const setItrStatus = defineAction(
  { name: "itr.status", schema: ItrStatusSchema, roles: STAFF_ROLES },
  async (input, ctx): Promise<ActionResult<{ status: ItrStatus; updatedAt: string }>> => {
    const { data, error } = await ctx.supabase.rpc("set_itr_computation_status", {
      p_id: input.id,
      p_updated_at: input.updatedAt,
      p_status: input.status,
      p_regime: input.regime,
      p_note: input.note || null,
    });
    throwDb(error);
    const r = (data ?? {}) as {
      status: ItrStatus;
      from_status: ItrStatus;
      updated_at: string;
      regime_chosen: Regime | null;
      client_id: string;
      financial_year: string;
      prepared_by: string | null;
    };
    const label = ITR_STATUS_INFO[r.status].label;
    const yearLabel = taxYearLabel(r.financial_year);
    const regimeText = r.regime_chosen ? REGIME_LABEL[r.regime_chosen].toLowerCase() : null;
    const what =
      r.status === "reviewed"
        ? r.from_status === "reviewed"
          ? `Regime chosen changed to the ${regimeText}`
          : `Reviewed; regime chosen: ${regimeText}`
        : r.status === "final"
          ? `Marked Final (${regimeText})`
          : r.from_status === "final"
            ? `Reopened as a draft: ${input.note}`
            : `Sent back to Draft: ${input.note}`;

    await ctx.audit({
      event: "data_update",
      resourceType: "itr_computation",
      resourceId: input.id,
      action: "itr.status",
      details: { from: r.from_status, to: r.status, regime_chosen: r.regime_chosen, note: input.note || null },
    });
    ctx.after("Record it in the computation's history", history(input.id, `itr_${r.status}`, `${what}.`));
    if (r.status === "final") {
      ctx.after("Add to the client's timeline", () =>
        addTimelineEvent({
          clientId: r.client_id,
          eventType: "itr_computation_final",
          title: `ITR computation final for ${yearLabel}: ${regimeText}`,
          metadata: { itr_computation_id: input.id, financial_year: r.financial_year, regime: r.regime_chosen },
        }),
      );
    }
    if (r.prepared_by && r.prepared_by !== ctx.user.id) {
      ctx.after(
        "Tell the preparer",
        () =>
          notify({
            to: { userIds: [r.prepared_by as string] },
            type: "info",
            title: r.status === "draft" ? `ITR computation sent back: ${yearLabel}` : `ITR computation ${label.toLowerCase()}: ${yearLabel}`,
            body: `${ctx.user.fullName}: ${what}.`,
            linkUrl: `/workpapers/itr/${input.id}`,
            entity: { type: "itr_computation", id: input.id },
            clientId: r.client_id,
            dedupeKey: `itr_status:${input.id}:${r.updated_at}`,
          }),
        "The preparer wasn't notified. Tell them about the change.",
      );
    }
    return ok({ status: r.status, updatedAt: r.updated_at });
  },
);

export const deleteItrComputation = defineAction(
  { name: "itr.delete", schema: ItrRefSchema, roles: MP },
  async (input, ctx): Promise<ActionResult<{ clientId: string }>> => {
    const { data, error } = await ctx.supabase.rpc("delete_itr_computation", { p_id: input.id, p_updated_at: input.updatedAt });
    throwDb(error);
    const r = (data ?? {}) as { client_id: string; financial_year: string; status: string };
    await ctx.audit({ event: "data_delete", resourceType: "itr_computation", resourceId: input.id, action: "itr.delete", details: { client_id: r.client_id, financial_year: r.financial_year, status: r.status } });
    ctx.after("Add to the client's timeline", () =>
      addTimelineEvent({ clientId: r.client_id, eventType: "itr_computation_deleted", title: `ITR computation for ${taxYearLabel(r.financial_year)} deleted`, metadata: { financial_year: r.financial_year } }),
    );
    return ok({ clientId: r.client_id });
  },
);
