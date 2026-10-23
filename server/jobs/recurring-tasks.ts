import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { istDateOf, todayIST } from "@/lib/domain/fy";
import { formatDate } from "@/lib/format";
import { logUnexpected } from "@/lib/log";
import { dueRuns, firstRunOnOrAfter, planRun, readRecurringConfig, runInstant, type RecurringFrequency, RECURRING_FREQUENCIES } from "@/lib/schemas/job-templates";
import { notify } from "@/server/notify";
import { addTimelineEvent } from "@/server/timeline";

/**
 * Recurring tasks, daily (§7.6.7): each active recurring-task automation whose next run date has
 * come creates the period's task for its client ("GSTR-3B: Oct 2026" on 1 Nov), with the job
 * template's steps as its checklist, assigned as set up, then moves to its next run date. Suggested
 * time: 07:00 IST, before the 08:00 escalation run.
 *
 * Idempotent: one task per automation and period (create_task with the unique index of 0130), so a
 * second run the same day finds the task already there. When the job was down, the latest three
 * missed periods are created and older ones skipped (counted). Clients that are On hold or Inactive
 * get no new work (§3.6) but still move on to the next date. A disabled assignee leaves the task
 * unassigned for a Manager to pick up. One automation failing is logged with its Ref and the run
 * carries on (§8).
 */

type AutomationRow = {
  id: string;
  client_id: string | null;
  frequency: string;
  config: unknown;
  next_run_at: string | null;
  created_by: string | null;
  clients: { display_name: string; status: string; deleted_at: string | null } | null;
};

async function canTakeWork(admin: AdminSupabase, employeeId: string | null): Promise<boolean> {
  if (!employeeId) return false;
  const { data, error } = await admin.rpc("employee_can_take_work", { p_employee_id: employeeId });
  if (error) throw error;
  return data === true;
}

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const today = todayIST(now);
  const counts = { automations: 0, created: 0, existing: 0, skippedPeriods: 0, clientPaused: 0, unassigned: 0, invalid: 0, failed: 0 };

  const { data, error } = await admin
    .from("task_automations")
    .select("id, client_id, frequency, config, next_run_at, created_by, clients(display_name, status, deleted_at)")
    .eq("type", "recurring_task")
    .eq("is_active", true)
    .or(`next_run_at.is.null,next_run_at.lte.${now.toISOString()}`)
    .order("next_run_at", { ascending: true, nullsFirst: true })
    .limit(2000);
  if (error) throw error;

  let fallbackCreator: string | null | undefined;
  const creatorFor = async (a: AutomationRow): Promise<string | null> => {
    if (a.created_by) return a.created_by;
    if (fallbackCreator === undefined) {
      const { data: p } = await admin.from("profiles").select("id").eq("role", "partner").eq("is_active", true).order("created_at").limit(1).maybeSingle();
      fallbackCreator = p?.id ?? null;
    }
    return fallbackCreator;
  };

  for (const a of (data ?? []) as unknown as AutomationRow[]) {
    counts.automations++;
    try {
      const config = readRecurringConfig(a.config);
      if (!config || !a.client_id || !(RECURRING_FREQUENCIES as readonly string[]).includes(a.frequency)) {
        counts.invalid++;
        continue;
      }
      const schedule = { frequency: a.frequency as RecurringFrequency, run_day: config.run_day, run_month: config.run_month, run_weekday: config.run_weekday, period_offset: config.period_offset, due_after_days: config.due_after_days };
      const nextRun = a.next_run_at ? istDateOf(a.next_run_at) : firstRunOnOrAfter(schedule, today);
      const due = dueRuns(schedule, nextRun, today);
      counts.skippedPeriods += due.skipped;

      const client = a.clients;
      const paused = !client || client.deleted_at !== null || client.status === "on_hold" || client.status === "inactive";
      if (due.runs.length && paused) counts.clientPaused += due.runs.length;

      if (due.runs.length && !paused) {
        const createdBy = await creatorFor(a);
        if (!createdBy) throw new Error("no creator for a recurring task: the automation has no created_by and there is no active Partner");
        const assignee = (await canTakeWork(admin, config.assignee_employee_id)) ? config.assignee_employee_id : null;
        if (config.assignee_employee_id && !assignee) counts.unassigned += due.runs.length;
        let reviewer = (await canTakeWork(admin, config.reviewer_employee_id)) ? config.reviewer_employee_id : null;
        if (reviewer && reviewer === assignee) reviewer = null;
        let templateId = config.job_template_id;
        if (templateId) {
          const { data: tpl } = await admin.from("job_templates").select("is_active").eq("id", templateId).maybeSingle();
          if (!tpl?.is_active) templateId = null;
        }

        for (const runDate of due.runs) {
          const plan = planRun(schedule, config.title, runDate);
          const { data: res, error: createError } = await admin.rpc("create_task", {
            p: {
              client_id: a.client_id,
              title: plan.title,
              description: config.description,
              service_type: config.service_type,
              financial_year: plan.financialYear,
              period_label: plan.period,
              due_date: plan.dueDate,
              priority: config.priority,
              estimated_minutes: config.estimated_minutes,
              assigned_employee_id: assignee,
              reviewer_employee_id: reviewer,
              template_id: templateId,
              automation_id: a.id,
              created_by: createdBy,
            },
          });
          if (createError) throw createError;
          const r = res as { id: string | null; task_number: string | null; existed: boolean };
          if (r.existed || !r.id) {
            counts.existing++;
            continue;
          }
          counts.created++;
          const taskId = r.id;
          if (assignee) {
            await notify({
              to: { employeeIds: [assignee] },
              type: "task_assigned",
              title: "Task assigned to you",
              body: `A recurring task was created for you: ${r.task_number} · ${plan.title} for ${client!.display_name}, due ${formatDate(plan.dueDate)}. Accept it or decline it with a reason.`,
              linkUrl: `/work/${taskId}`,
              entity: { type: "task", id: taskId },
              clientId: a.client_id,
              dedupeKey: `recurring_task_assigned:${taskId}`,
            });
          }
          await addTimelineEvent({
            clientId: a.client_id,
            eventType: "task_created",
            title: `Recurring task created: ${plan.title}`,
            metadata: { task_id: taskId, task_number: r.task_number, automation_id: a.id, period: plan.period },
            performedBy: createdBy,
          });
        }
      }

      const { error: moveError } = await admin
        .from("task_automations")
        .update({ next_run_at: runInstant(due.next), ...(due.runs.length ? { last_run_at: now.toISOString() } : {}) })
        .eq("id", a.id);
      if (moveError) throw moveError;
    } catch (err) {
      counts.failed++;
      logUnexpected(err, { source: "job:recurring-tasks:automation", automationId: a.id });
    }
  }
  return { counts };
}
