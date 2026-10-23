"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { ActionError, fail, ok, type ActionResult } from "@/lib/result";
import { DeleteJobTemplateSchema, JobTemplateSchema, SetTemplateActiveSchema } from "@/lib/schemas/job-templates";
import { formatTime } from "@/lib/format";

/**
 * Job templates (§5.5, §7.6.2; §4.1 "Job templates: Partner ✅ Manager ✅ Employee use only"): a
 * named list of steps with offsets from the job's due date. Saved in one transaction with its steps
 * (save_job_template, 0133), with optimistic concurrency (§13). Deactivating keeps the template on
 * the tasks that used it; deleting removes it from the list (those tasks keep their checklists).
 */

const PM = ["partner", "manager"] as const;

export const saveJobTemplate = defineAction(
  { name: "job_templates.save", schema: JobTemplateSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string; updated_at: string }>> => {
    const { data, error } = await ctx.supabase.rpc("save_job_template", {
      p: {
        id: input.id,
        name: input.name,
        service_type: input.service_type,
        description: input.description,
        default_lead_days: input.default_lead_days,
        is_active: input.is_active,
        items: input.items.map((i) => ({ id: i.id, title: i.title, description: i.description, offset_days: i.offset_days })),
      },
      p_expected_updated_at: input.id ? (input.expected_updated_at ?? undefined) : undefined,
    });
    if (error?.message?.startsWith("USER: Step ") || error?.message?.startsWith("USER: Every step")) {
      throw new ActionError(error.message.slice(6), { code: "validation" });
    }
    if (error?.message?.includes("changed by someone else")) throw new ActionError(error.message.slice(6), { code: "conflict" });
    throwIfDbError(error, { uniqueField: "name", uniqueMessage: "A template with this name already exists." });
    const r = data as { id: string; items: number; updated_at: string };
    await ctx.audit({
      event: input.id ? "data_update" : "data_create",
      resourceType: "job_template",
      resourceId: r.id,
      details: { name: input.name, service_type: input.service_type, steps: r.items, is_active: input.is_active },
    });
    return ok({ id: r.id, updated_at: r.updated_at });
  },
);

export const setJobTemplateActive = defineAction(
  { name: "job_templates.set_active", schema: SetTemplateActiveSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data, error } = await ctx.supabase.from("job_templates").update({ is_active: input.is_active }).eq("id", input.id).eq("updated_at", input.expected_updated_at).select("id");
    throwIfDbError(error);
    if (!data || data.length === 0) {
      const { data: now } = await ctx.supabase.from("job_templates").select("updated_at").eq("id", input.id).maybeSingle();
      return fail(now ? `This template was changed by someone else at ${formatTime(now.updated_at)}. Reload to see their changes.` : "That template no longer exists.", { code: now ? "conflict" : "not_found" });
    }
    await ctx.audit({ event: "data_update", resourceType: "job_template", resourceId: input.id, details: { is_active: input.is_active } });
    return ok({ id: input.id });
  },
);

export const deleteJobTemplate = defineAction(
  { name: "job_templates.delete", schema: DeleteJobTemplateSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: inUse } = await ctx.supabase.from("task_automations").select("id, config").eq("type", "recurring_task").eq("is_active", true);
    const automations = (inUse ?? []).filter((a) => (a.config as { job_template_id?: string } | null)?.job_template_id === input.id).length;
    if (automations > 0) {
      return fail(
        `${automations === 1 ? "A recurring task uses" : `${automations} recurring tasks use`} this template. Change ${automations === 1 ? "it" : "them"}, or deactivate the template instead.`,
        { code: "blocked" },
      );
    }
    const { data, error } = await ctx.supabase.from("job_templates").delete().eq("id", input.id).select("id, name");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail("That template no longer exists.", { code: "not_found" });
    await ctx.audit({ event: "data_delete", resourceType: "job_template", resourceId: input.id, details: { name: data[0].name } });
    return ok({ id: input.id });
  },
);
