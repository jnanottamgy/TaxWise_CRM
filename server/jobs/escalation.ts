import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { addDays, todayIST } from "@/lib/domain/fy";
import { ESCALATION_PARAM_KEYS, planEscalation, resolveEscalationParams } from "@/lib/domain/escalation";
import type { StatutoryParameterRow } from "@/lib/domain/gst";
import type { TaskStatus } from "@/lib/domain/enums";
import { formatDate } from "@/lib/format";
import { logUnexpected } from "@/lib/log";
import { taskRef } from "@/lib/schemas/tasks";
import { notify } from "@/server/notify";

/**
 * Task escalation, 08:00 IST daily (§7.6.7, §8, §9): a task overdue by more than 3 days reaches
 * level 1 (the assignee and Managers are told); by more than 7 days, level 2 (Partners are told).
 * The day counts come from `escalation.overdue_days` (statutory_parameters), defaulting to 3 and 7.
 *
 * Idempotent: a level is reached once (planEscalation never lowers it, and the update only applies
 * while the stored level is still the one read), and each notice carries a dedupe key, so running
 * the job twice changes and tells nothing the second time. It re-arms by itself: a reopen
 * (change_task_status, 0036) or a due-date change (tasks_track_assignment, 0130) puts the level
 * back to 0. Overdue is derived from status and due date, never stored (§0.1 rule 10). A task
 * that fails is logged with its Ref and the run carries on (§8).
 */

const PAGE = 500;

type Row = {
  id: string;
  task_number: string;
  title: string;
  client_id: string;
  status: TaskStatus;
  due_date: string | null;
  escalation_level: number;
  assigned_employee_id: string | null;
  clients: { display_name: string } | null;
  employees: { full_name: string } | null;
};

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const today = todayIST(now);
  const { data: paramRows, error: paramError } = await admin
    .from("statutory_parameters")
    .select("key, value, effective_from, effective_to, verified")
    .eq("key", ESCALATION_PARAM_KEYS.overdueDays);
  if (paramError) throw paramError;
  const rows: StatutoryParameterRow[] = (paramRows ?? []).map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, verified: r.verified }));
  const params = resolveEscalationParams(rows, today).escalation;
  // Overdue by MORE than level-1 days: due before today − level-1 days.
  const cutoff = addDays(today, -params.level1AfterDays);

  const counts = { checked: 0, level1: 0, level2: 0, notified: 0, failed: 0 };
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("tasks")
      .select("id, task_number, title, client_id, status, due_date, escalation_level, assigned_employee_id, clients(display_name), employees!tasks_assigned_employee_id_fkey(full_name)")
      .is("deleted_at", null)
      .neq("status", "filed_done")
      .lt("due_date", cutoff)
      .lt("escalation_level", 2)
      .order("due_date")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Row[];
    for (const t of page) {
      counts.checked++;
      try {
        const decision = planEscalation({ status: t.status, dueDate: t.due_date, currentLevel: t.escalation_level, today }, params);
        if (!decision.changed) continue;
        const { data: updated, error: updateError } = await admin
          .from("tasks")
          .update({ escalation_level: decision.level, escalated_at: now.toISOString() })
          .eq("id", t.id)
          .eq("escalation_level", t.escalation_level)
          .select("id");
        if (updateError) throw updateError;
        if (!updated?.length) continue; // another run got there first
        if (decision.reached.includes(1)) counts.level1++;
        if (decision.reached.includes(2)) counts.level2++;

        const roles: Array<"manager" | "partner"> = [];
        if (decision.notify.managers) roles.push("manager");
        if (decision.notify.partners) roles.push("partner");
        const client = t.clients?.display_name ?? "the client";
        const who = t.employees?.full_name ?? null;
        const days = decision.daysOverdue;
        await notify({
          to: { employeeIds: decision.notify.assignee && t.assigned_employee_id ? [t.assigned_employee_id] : [], roles },
          type: "task_overdue",
          title: decision.level === 2 ? `Escalated to Partners: ${t.title}` : `Overdue by ${days} days: ${t.title}`,
          body: `${taskRef(t)} for ${client} was due ${formatDate(t.due_date)} and is ${days} ${days === 1 ? "day" : "days"} overdue${who ? `; it is with ${who}` : "; nobody is assigned"}.${decision.level === 2 ? " Level 2: Partners are told." : " Level 1: Managers are told."}`,
          linkUrl: `/work/${t.id}`,
          entity: { type: "task", id: t.id },
          clientId: t.client_id,
          dedupeKey: `task_escalation:${t.id}:L${decision.level}:${today}`,
        });
        counts.notified++;
      } catch (err) {
        counts.failed++;
        logUnexpected(err, { source: "job:escalation:task", taskId: t.id });
      }
    }
    if (page.length < PAGE) break;
  }
  return { counts };
}
