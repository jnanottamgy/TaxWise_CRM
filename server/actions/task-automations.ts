"use server";

import { defineAction, throwIfDbError } from "@/lib/action";
import { fail, ok, type ActionResult } from "@/lib/result";
import { todayIST } from "@/lib/domain/fy";
import { formatDate } from "@/lib/format";
import { AutomationSchema, DeleteAutomationSchema, SetAutomationActiveSchema, automationConfig, firstRunOnOrAfter, runInstant } from "@/lib/schemas/job-templates";
import type { Json } from "@/lib/database.types";
import { addTimelineEvent } from "@/server/timeline";

/**
 * Recurring tasks (§7.6.7): a task_automations row of type recurring_task creates a task each
 * period for a client and service, from a title with a {period} token and optionally a job
 * template ("GSTR-3B: {period}" on the 1st of every month). Partners and Managers only (RLS, 0035).
 * The daily job (server/jobs/recurring-tasks.ts) creates the tasks; one task per automation and
 * period (unique index, 0130), so it never doubles up.
 */

const PM = ["partner", "manager"] as const;

export const saveAutomation = defineAction(
  { name: "task_automations.save", schema: AutomationSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string; next_run_on: string }>> => {
    const config = automationConfig(input);
    const schedule = { frequency: input.frequency, run_day: config.run_day, run_month: config.run_month, run_weekday: config.run_weekday, period_offset: config.period_offset, due_after_days: config.due_after_days };
    const today = todayIST();
    const from = input.starts_on && input.starts_on > today ? input.starts_on : today;
    const nextRun = firstRunOnOrAfter(schedule, from);

    if (input.assignee_employee_id) {
      const { data: ok_ } = await ctx.supabase.rpc("employee_can_take_work", { p_employee_id: input.assignee_employee_id });
      if (ok_ === false) return fail("That person's account is disabled, so the work would be lost. Choose someone active.", { code: "blocked", fieldErrors: { assignee_employee_id: ["Choose someone active."] } });
    }
    if (input.job_template_id) {
      const { data: tpl } = await ctx.supabase.from("job_templates").select("is_active").eq("id", input.job_template_id).maybeSingle();
      if (!tpl?.is_active) return fail("That job template isn't available. Choose an active template.", { code: "validation", fieldErrors: { job_template_id: ["Choose an active template."] } });
    }

    const row = {
      client_id: input.client_id,
      type: "recurring_task" as const,
      frequency: input.frequency,
      config: config as unknown as Json,
      is_active: input.is_active,
      next_run_at: runInstant(nextRun),
    };
    let id: string;
    if (input.id) {
      let q = ctx.supabase.from("task_automations").update(row).eq("id", input.id);
      if (input.expected_updated_at) q = q.eq("updated_at", input.expected_updated_at);
      const { data, error } = await q.select("id");
      throwIfDbError(error);
      if (!data || data.length === 0) return fail("This recurring task was changed by someone else. Reload to see their changes.", { code: "conflict" });
      id = input.id;
    } else {
      const { data, error } = await ctx.supabase.from("task_automations").insert(row).select("id").single();
      throwIfDbError(error);
      id = data!.id;
    }
    await ctx.audit({
      event: input.id ? "data_update" : "data_create",
      resourceType: "task_automation",
      resourceId: id,
      details: { client_id: input.client_id, frequency: input.frequency, title: input.title, next_run_on: nextRun, is_active: input.is_active },
    });
    if (!input.id) {
      ctx.after("Add to the client's timeline", () =>
        addTimelineEvent({ clientId: input.client_id, eventType: "recurring_task_set_up", title: `Recurring task set up: ${input.title} (first on ${formatDate(nextRun)})`, metadata: { automation_id: id, frequency: input.frequency } }),
      );
    }
    return ok({ id, next_run_on: nextRun });
  },
);

export const setAutomationActive = defineAction(
  { name: "task_automations.set_active", schema: SetAutomationActiveSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data: current, error: loadError } = await ctx.supabase.from("task_automations").select("id, frequency, config, next_run_at").eq("id", input.id).maybeSingle();
    throwIfDbError(loadError);
    if (!current) return fail("That recurring task no longer exists.", { code: "not_found" });
    const patch: { is_active: boolean; next_run_at?: string } = { is_active: input.is_active };
    if (input.is_active) {
      // Resuming starts from the next run date from today: paused periods aren't created afterwards.
      const c = current.config as Record<string, unknown> | null;
      const schedule = {
        frequency: current.frequency as "weekly" | "monthly" | "quarterly" | "yearly",
        run_day: typeof c?.run_day === "number" ? c.run_day : 1,
        run_month: typeof c?.run_month === "number" ? c.run_month : null,
        run_weekday: typeof c?.run_weekday === "number" ? c.run_weekday : null,
        period_offset: (c?.period_offset === 0 ? 0 : 1) as 0 | 1,
        due_after_days: typeof c?.due_after_days === "number" ? c.due_after_days : 0,
      };
      patch.next_run_at = runInstant(firstRunOnOrAfter(schedule, todayIST()));
    }
    const { error } = await ctx.supabase.from("task_automations").update(patch).eq("id", input.id);
    throwIfDbError(error);
    await ctx.audit({ event: "data_update", resourceType: "task_automation", resourceId: input.id, details: patch });
    return ok({ id: input.id });
  },
);

export const deleteAutomation = defineAction(
  { name: "task_automations.delete", schema: DeleteAutomationSchema, roles: PM },
  async (input, ctx): Promise<ActionResult<{ id: string }>> => {
    const { data, error } = await ctx.supabase.from("task_automations").delete().eq("id", input.id).select("id, client_id, config");
    throwIfDbError(error);
    if (!data || data.length === 0) return fail("That recurring task no longer exists.", { code: "not_found" });
    await ctx.audit({ event: "data_delete", resourceType: "task_automation", resourceId: input.id, details: { client_id: data[0].client_id } });
    return ok({ id: input.id });
  },
);
