"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { fail, ok, type ActionResult } from "@/lib/result";
import { todayIST } from "@/lib/domain/fy";
import { formatDate } from "@/lib/format";
import { DeleteItemSchema, FrameworkSchema, ItemReviewedSchema, QUALITY_FRAMEWORK_LABELS, QualityItemSchema, RESTORE_OUTCOME_INFO, RestoreDrillSchema } from "@/lib/schemas/quality";
import { logActivity } from "@/server/activity";
import { notify } from "@/server/notify";

/**
 * The quality manual (SQC 1 elements, with the switch to SQM 1's risk-assessment approach, §6.8)
 * and restore drills (§12). §7.15.4: Partners maintain the module, Managers read it; RLS (0039)
 * refuses a Manager's write too. Edits carry the row's updated_at (§13).
 */

const PARTNER = ["partner"] as const;
const STALE = "This item was changed by someone else. Reload to see their changes.";

export const saveQualityItem = defineAction(
  { name: "quality.item_save", schema: QualityItemSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ id: string; updatedAt: string }>> => {
    if (input.lastReviewedOn && input.lastReviewedOn > todayIST()) {
      return fail("The last review can't be in the future.", { code: "validation", fieldErrors: { lastReviewedOn: ["Pick today or an earlier date."] } });
    }
    const values = {
      element: input.element,
      title: input.title,
      owner_employee_id: input.ownerEmployeeId,
      last_reviewed_on: input.lastReviewedOn,
      review_every_months: input.reviewEveryMonths,
      notes: input.notes,
      sqm1_component: input.sqm1Component,
      quality_objective: input.qualityObjective,
      quality_risk: input.qualityRisk,
      risk_response: input.riskResponse,
    };
    let row: { id: string; updated_at: string };
    if (input.id) {
      if (!input.updatedAt) return fail(STALE, { code: "conflict" });
      const { data, error } = await ctx.supabase.from("quality_manual_items").update(values).eq("id", input.id).eq("updated_at", input.updatedAt).select("id, updated_at");
      throwIfDbError(error);
      if (!data?.length) return fail(STALE, { code: "conflict" });
      row = data[0];
    } else {
      const { data: last } = await ctx.supabase.from("quality_manual_items").select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
      const { data, error } = await ctx.supabase
        .from("quality_manual_items")
        .insert({ ...values, sort_order: (last?.sort_order ?? 0) + 10 })
        .select("id, updated_at")
        .single();
      throwIfDbError(error);
      row = data!;
    }
    await ctx.audit({ event: input.id ? "data_update" : "data_create", resourceType: "quality_manual_item", resourceId: row.id, details: { element: input.element, title: input.title } });
    ctx.after("Record it in the item's history", () =>
      logActivity({ entityType: "quality_manual_item", entityId: row.id, action: input.id ? "quality_item_updated" : "quality_item_created", description: `${input.id ? "Updated" : "Added"} by ${ctx.user.fullName}` }),
    );
    return ok({ id: row.id, updatedAt: row.updated_at });
  },
);

export const markItemReviewed = defineAction(
  { name: "quality.item_reviewed", schema: ItemReviewedSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string; reviewedOn: string }>> => {
    const today = todayIST();
    const { data: item, error: readError } = await ctx.supabase.from("quality_manual_items").select("id, notes, title").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!item) return fail("That item no longer exists.", { code: "not_found" });
    const notes = input.note ? [item.notes, `${formatDate(today)}: ${input.note}`].filter(Boolean).join("\n") : item.notes;
    const { data, error } = await ctx.supabase.from("quality_manual_items").update({ last_reviewed_on: today, notes }).eq("id", input.id).eq("updated_at", input.updatedAt).select("updated_at");
    throwIfDbError(error);
    if (!data?.length) return fail(STALE, { code: "conflict" });
    await ctx.audit({ event: "data_update", resourceType: "quality_manual_item", resourceId: input.id, action: "quality.item_reviewed", details: { reviewed_on: today, note: input.note } });
    ctx.after("Record it in the item's history", () =>
      logActivity({ entityType: "quality_manual_item", entityId: input.id, action: "quality_item_reviewed", description: `Reviewed by ${ctx.user.fullName}${input.note ? `: ${input.note}` : ""}` }),
    );
    return ok({ updatedAt: data[0].updated_at, reviewedOn: today });
  },
);

export const deleteQualityItem = defineAction(
  { name: "quality.item_delete", schema: DeleteItemSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: item, error: readError } = await ctx.supabase.from("quality_manual_items").select("id, title, element").eq("id", input.id).maybeSingle();
    throwIfDbError(readError);
    if (!item) return fail("That item no longer exists.", { code: "not_found" });
    const { error } = await ctx.supabase.from("quality_manual_items").delete().eq("id", input.id);
    throwIfDbError(error);
    await ctx.audit({ event: "data_delete", resourceType: "quality_manual_item", resourceId: input.id, details: { title: item.title, element: item.element } });
    return ok({ id: input.id });
  },
);

export const setQualityFramework = defineAction(
  { name: "quality.framework", schema: FrameworkSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ updatedAt: string }>> => {
    const { data, error } = await ctx.supabase.from("firm_settings").update({ quality_framework: input.framework }).eq("id", 1).eq("updated_at", input.updatedAt).select("updated_at");
    throwIfDbError(error);
    if (!data?.length) return fail("The firm's settings were changed by someone else. Reload to see their changes.", { code: "conflict" });
    await ctx.audit({ event: "config_change", resourceType: "firm_settings", resourceId: "1", action: "quality.framework", details: { quality_framework: input.framework } });
    ctx.after("Tell the other Partners", () =>
      notify({
        to: { roles: ["partner"] },
        type: "info",
        title: `Quality framework: ${QUALITY_FRAMEWORK_LABELS[input.framework]}`,
        body:
          input.framework === "sqm1"
            ? `${ctx.user.fullName} switched the quality manual to SQM 1's risk-assessment approach. Record a quality objective, the risk and the response for each item.`
            : `${ctx.user.fullName} switched the quality manual back to the SQC 1 elements.`,
        linkUrl: "/quality?tab=manual",
        dedupeKey: `quality_framework:${input.framework}:${data[0].updated_at}`,
      }),
    );
    return ok({ updatedAt: data[0].updated_at });
  },
);

export const recordRestoreDrill = defineAction(
  { name: "quality.restore_drill", schema: RestoreDrillSchema, roles: PARTNER },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    if (input.performedOn > todayIST()) return fail("A restore drill can't be recorded for a future date.", { code: "validation", fieldErrors: { performedOn: ["Pick today or an earlier date."] } });
    const { data, error } = await ctx.supabase
      .from("restore_drills")
      .insert({
        performed_on: input.performedOn,
        outcome: input.outcome,
        backup_reference: input.backupReference,
        restored_to: input.restoredTo,
        duration_minutes: input.durationMinutes,
        checks: input.checks,
        issues: input.issues,
        notes: input.notes,
      })
      .select("id")
      .single();
    throwIfDbError(error);
    await ctx.audit({ event: "data_create", resourceType: "restore_drill", resourceId: data!.id, details: { performed_on: input.performedOn, outcome: input.outcome } });
    if (input.outcome !== "passed") {
      ctx.after("Tell the Partners", () =>
        notify({
          to: { roles: ["partner"] },
          type: "warning",
          title: `Restore drill ${RESTORE_OUTCOME_INFO[input.outcome].label.toLowerCase()}`,
          body: `${ctx.user.fullName} recorded the restore drill of ${formatDate(input.performedOn)}: ${input.issues ?? ""}`.trim(),
          linkUrl: "/quality?tab=restore-drills",
          entity: { type: "restore_drill", id: data!.id },
        }),
      );
    }
    return ok({ id: data!.id });
  },
);
