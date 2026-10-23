import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { env } from "@/lib/env";
import { todayIST } from "@/lib/domain/fy";
import { sumPaise, toPaise } from "@/lib/domain/money";
import { logUnexpected } from "@/lib/log";
import { readDigestPreference } from "@/lib/schemas/profile";
import { sendEmail } from "@/server/email/send";
import { emailFirm } from "@/server/email/templates/layout";
import { partnerDigestEmail, type DigestDeadline, type DigestReceivable, type DigestTask, type PartnerDigestData } from "@/server/email/templates";
import { getFirmProfile } from "@/server/firm";

/**
 * Partner daily digest, 08:00 IST (§8 "Task escalation + digest", §7.17, §10.14): one email to each
 * active Partner with today's deadlines, approvals waiting, overdue receivables and unassigned work,
 * each with a link to the list behind it. Optional twice over: Settings → Reminders turns it off for
 * the firm, and each Partner's Profile → Notifications for themselves. Partners only, because it
 * carries receivables (§4.1).
 *
 * Idempotent: the email's key is `digest:<partner profile id>:<YYYY-MM-DD>`, so a second run the
 * same day sends nothing new (the delivery ledger, server/email/send.ts). When the sending domain
 * isn't verified, nothing is sent and the run says so in its counts. One Partner failing is logged
 * with its Ref and the run carries on (§8).
 */

const TOP = 5;

type Counts = { partners: number; sent: number; skipped_off: number; not_configured: number; failed: number; disabled: number };

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const counts: Counts = { partners: 0, sent: 0, skipped_off: 0, not_configured: 0, failed: 0, disabled: 0 };
  const today = todayIST(now);

  const { data: settings, error: settingsError } = await admin.from("firm_settings").select("digest_enabled").eq("id", 1).maybeSingle();
  if (settingsError) throw settingsError;
  if (!settings?.digest_enabled) {
    counts.disabled = 1;
    return { counts };
  }

  const { data: partners, error: partnersError } = await admin
    .from("profiles")
    .select("id, full_name, email, role, is_active, preferences")
    .eq("role", "partner")
    .eq("is_active", true);
  if (partnersError) throw partnersError;
  const recipients = (partners ?? []).filter((p) => {
    if (!p.email) return false;
    if (!readDigestPreference(p.preferences, "partner")) {
      counts.skipped_off++;
      return false;
    }
    return true;
  });
  counts.partners = recipients.length;
  if (recipients.length === 0) return { counts };

  const shared = await loadShared(admin, today);
  const firm = emailFirm(await getFirmProfile(admin));
  const base = env.appUrl().replace(/\/+$/, "");
  const links: PartnerDigestData["links"] = {
    dashboard: `${base}/dashboard`,
    deadlines: `${base}/calendar?view=agenda&day=${today}`,
    approvals: `${base}/inbox`,
    receivables: `${base}/invoices?status=overdue`,
    unassigned: `${base}/work?assignee=none&status=not_started,in_progress,data_awaited,under_review,on_hold`,
  };

  for (const p of recipients) {
    try {
      const leave = await leaveWaitingFor(admin, p.id);
      const mail = partnerDigestEmail(
        {
          partnerName: p.full_name,
          date: today,
          deadlines: shared.deadlines,
          approvals: { ...shared.approvals, leave },
          overdue: shared.overdue,
          unassigned: shared.unassigned,
          links,
        },
        firm,
      );
      const r = await sendEmail({
        to: p.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        kind: "partner_digest",
        idempotencyKey: `digest:${p.id}:${today}`,
      });
      if (r.status === "sent") counts.sent++;
      else if (r.status === "not_configured") counts.not_configured++;
      else {
        counts.failed++;
        logUnexpected(new Error(r.error ?? "digest email failed"), { source: "job:partner-digest:send", userId: p.id });
      }
    } catch (err) {
      counts.failed++;
      logUnexpected(err, { source: "job:partner-digest:partner", userId: p.id });
    }
  }
  return { counts };
}

/** What every Partner's digest shares: deadlines, the money approvals, receivables and unassigned work. */
async function loadShared(admin: AdminSupabase, today: string) {
  const [events, invoicesWaiting, quotationsWaiting, dataRequests, overdue, unassigned] = await Promise.all([
    admin
      .from("compliance_events")
      .select("id, title, form_code, filing_period, client_id, task_id", { count: "exact" })
      .eq("due_date", today)
      .eq("status", "pending")
      .order("title")
      .limit(50),
    admin.from("invoices").select("id", { count: "exact", head: true }).eq("status", "awaiting_approval").is("deleted_at", null),
    admin.from("quotations").select("id", { count: "exact", head: true }).eq("status", "pending_approval").is("deleted_at", null),
    admin.from("data_requests").select("id", { count: "exact", head: true }).eq("status", "open"),
    admin
      .from("invoices_view")
      .select("id, invoice_number, client_id, client_name_snapshot, outstanding_amount, days_overdue", { count: "exact" })
      .eq("is_overdue", true)
      .is("deleted_at", null)
      .order("days_overdue", { ascending: false })
      .limit(1000),
    admin
      .from("tasks")
      .select("id, title, client_id, due_date", { count: "exact" })
      .is("assigned_employee_id", null)
      .is("deleted_at", null)
      .neq("status", "filed_done")
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(TOP),
  ]);
  for (const r of [events, invoicesWaiting, quotationsWaiting, dataRequests, overdue, unassigned]) if (r.error) throw r.error;

  const eventRows = events.data ?? [];
  const taskRows = unassigned.data ?? [];
  const clientIds = [...new Set([...eventRows.map((e) => e.client_id), ...taskRows.map((t) => t.client_id)].filter((c): c is string => !!c))];
  const taskIds = eventRows.map((e) => e.task_id).filter((t): t is string => !!t);
  const [clients, linkedTasks] = await Promise.all([
    clientIds.length ? admin.from("clients").select("id, display_name, owner_employee_id, deleted_at").in("id", clientIds) : Promise.resolve({ data: [], error: null }),
    taskIds.length ? admin.from("tasks").select("id, assigned_employee_id").in("id", taskIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (clients.error) throw clients.error;
  if (linkedTasks.error) throw linkedTasks.error;
  const clientById = new Map((clients.data ?? []).map((c) => [c.id, c]));
  const assigneeByTask = new Map((linkedTasks.data ?? []).map((t) => [t.id, t.assigned_employee_id]));
  const employeeIds = [
    ...new Set(
      eventRows
        .map((e) => (e.task_id ? assigneeByTask.get(e.task_id) : null) ?? (e.client_id ? clientById.get(e.client_id)?.owner_employee_id : null))
        .filter((x): x is string => !!x),
    ),
  ];
  const { data: employees, error: employeesError } = employeeIds.length
    ? await admin.from("employees").select("id, full_name").in("id", employeeIds)
    : { data: [] as Array<{ id: string; full_name: string }>, error: null };
  if (employeesError) throw employeesError;
  const nameOf = new Map((employees ?? []).map((e) => [e.id, e.full_name]));

  const liveEvents = eventRows.filter((e) => !e.client_id || !clientById.get(e.client_id)?.deleted_at);
  const deadlineItems: DigestDeadline[] = liveEvents.slice(0, TOP).map((e) => {
    const client = e.client_id ? clientById.get(e.client_id) : null;
    const who = (e.task_id ? assigneeByTask.get(e.task_id) : null) ?? client?.owner_employee_id ?? null;
    return {
      clientName: client?.display_name ?? "Firm",
      label: [e.form_code ?? e.title, e.filing_period].filter(Boolean).join(" · "),
      assignee: who ? (nameOf.get(who) ?? null) : null,
    };
  });

  const overdueRows = overdue.data ?? [];
  const top: DigestReceivable[] = overdueRows.slice(0, TOP).map((i) => ({
    clientName: i.client_name_snapshot ?? "Client",
    invoiceNumber: i.invoice_number ?? "Draft",
    outstandingPaise: toPaise(i.outstanding_amount ?? 0),
    daysOverdue: i.days_overdue ?? 0,
  }));
  const tasks: DigestTask[] = taskRows.map((t) => ({ title: t.title, clientName: clientById.get(t.client_id)?.display_name ?? "Client", dueDate: t.due_date }));

  return {
    deadlines: { total: Math.max(liveEvents.length, (events.count ?? 0) - (eventRows.length - liveEvents.length)), items: deadlineItems },
    approvals: { invoices: invoicesWaiting.count ?? 0, quotations: quotationsWaiting.count ?? 0, dataRequests: dataRequests.count ?? 0 },
    overdue: {
      count: overdue.count ?? overdueRows.length,
      totalPaise: sumPaise(overdueRows.map((i) => toPaise(i.outstanding_amount ?? 0))),
      top,
    },
    unassigned: { count: unassigned.count ?? taskRows.length, top: tasks },
  };
}

/** Leave requests this Partner may decide (decide_leave, 0106: a Partner decides anyone's but their own). */
async function leaveWaitingFor(admin: AdminSupabase, partnerProfileId: string): Promise<number> {
  const { data, error } = await admin.from("employee_leave").select("id, employees!inner(profile_id)").eq("status", "requested").limit(1000);
  if (error) throw error;
  return (data ?? []).filter((l) => (l.employees as unknown as { profile_id: string | null } | null)?.profile_id !== partnerProfileId).length;
}
