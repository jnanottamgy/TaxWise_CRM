import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { addDays, istDayBounds, todayIST, type DateString } from "@/lib/domain/fy";
import { formatDate, formatDateTime } from "@/lib/format";
import { logUnexpected } from "@/lib/log";
import type { NoticeStatus } from "@/lib/domain/enums";
import { notify, type NotificationType } from "@/server/notify";
import { APPEAL_FORUM_LABEL, planNoticeReminders, splitHearing, type NoticeAppealForum, type NoticeReminder } from "@/lib/schemas/notices";

/**
 * Notice reminders, part of the 09:00 IST reminders (§8 "notice reply and hearing reminders", §7.8.4,
 * §9):
 *   1. Reply due: 7 and 2 days before the reply due date while a reply is pending (Open or Reply
 *      drafted), to the person the notice is assigned to (else the client's owner, else the
 *      Managers).
 *   2. Hearing: 7 and 2 days before the hearing, to the same person.
 *   3. Reply overdue: once per due date, to the same person and the Managers ("overdue replies are
 *      red on the dashboard"; the dashboards read lib/data/notices.ts getNoticeAlerts).
 *   4. Appeal limitation: 7 and 2 days before the last day to appeal while the appeal task isn't
 *      filed, to the same person and, at 2 days or once passed, the Partners.
 * A reminder is due from its lead day onwards, so a missed run is caught up the next day; each one
 * carries a dedupe key naming the notice, the date and the lead, so a second run notifies nobody
 * twice and a moved date starts afresh (lib/schemas/notices.ts planNoticeReminders). Notices of a
 * client in the recycle bin are skipped. A notice that fails is logged with its Ref and the run
 * carries on (§8). Notifications about a covered client reach the cover person too (§4.7, notify).
 */

export type NoticeReminderCounts = {
  reply_reminders: number;
  hearing_reminders: number;
  reply_overdue: number;
  appeal_reminders: number;
  appeal_overdue: number;
  failed: number;
};

const PAGE = 1000;

type Row = {
  id: string;
  client_id: string;
  notice_type: string;
  reference_no: string | null;
  status: NoticeStatus;
  reply_due_date: string | null;
  hearing_date: string | null;
  appeal_decision: "appeal" | "no_appeal" | null;
  appeal_forum: NoticeAppealForum | null;
  limitation_date: string | null;
  assigned_employee_id: string | null;
  appeal_task_id: string | null;
  clients: { display_name: string; owner_employee_id: string | null; deleted_at: string | null } | null;
  tasks: { status: string; deleted_at: string | null } | null;
};

const SELECT =
  "id, client_id, notice_type, reference_no, status, reply_due_date, hearing_date, appeal_decision, appeal_forum, limitation_date, assigned_employee_id, appeal_task_id, clients!inner(display_name, owner_employee_id, deleted_at), tasks:appeal_task_id(status, deleted_at)";

/** The notices any reminder could fall on today: replies due within 7 days or overdue, hearings in the next 7 days, open appeals. */
async function candidates(admin: AdminSupabase, today: DateString): Promise<Row[]> {
  const horizon = addDays(today, 7);
  const hearingFrom = istDayBounds(today).start.toISOString();
  const hearingTo = istDayBounds(horizon).end.toISOString();
  const byId = new Map<string, Row>();
  const take = async (build: () => PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await build();
    if (error) throw error;
    for (const r of (data ?? []) as Row[]) byId.set(r.id, r);
  };
  await take(() => admin.from("tax_notices").select(SELECT).in("status", ["open", "reply_drafted"]).lte("reply_due_date", horizon).is("clients.deleted_at", null).limit(PAGE));
  await take(() =>
    admin
      .from("tax_notices")
      .select(SELECT)
      .in("status", ["open", "reply_drafted", "replied", "hearing"])
      .gte("hearing_date", hearingFrom)
      .lt("hearing_date", hearingTo)
      .is("clients.deleted_at", null)
      .limit(PAGE),
  );
  await take(() => admin.from("tax_notices").select(SELECT).eq("appeal_decision", "appeal").lte("limitation_date", horizon).is("clients.deleted_at", null).limit(PAGE));
  return [...byId.values()];
}

function message(n: Row, r: NoticeReminder): { type: NotificationType; title: string; body: string } {
  const client = n.clients?.display_name ?? "A client";
  const ref = n.reference_no ? ` (ref. ${n.reference_no})` : "";
  const inDays = r.daysLeft === 0 ? "today" : r.daysLeft === 1 ? "tomorrow" : `in ${r.daysLeft} days`;
  const late = -r.daysLeft;
  switch (r.kind) {
    case "reply":
      return { type: "compliance_due", title: `Reply due ${inDays}: ${n.notice_type}`, body: `${client}${ref}: the reply is due on ${formatDate(r.date)}.` };
    case "hearing": {
      const at = n.hearing_date ? formatDateTime(n.hearing_date) : formatDate(r.date);
      return { type: "compliance_due", title: `Hearing ${inDays}: ${n.notice_type}`, body: `${client}${ref}: the hearing is on ${at}.` };
    }
    case "reply_overdue":
      return {
        type: "warning",
        title: `Reply overdue: ${n.notice_type}`,
        body: `${client}${ref}: the reply was due on ${formatDate(r.date)}, ${late} ${late === 1 ? "day" : "days"} ago. File it, or record the extension granted.`,
      };
    case "appeal": {
      const forum = n.appeal_forum ? ` to ${APPEAL_FORUM_LABEL[n.appeal_forum]}` : "";
      return { type: "compliance_due", title: `Appeal limitation ${inDays}: ${n.notice_type}`, body: `${client}${ref}: file the appeal${forum} by ${formatDate(r.date)}.` };
    }
    case "appeal_overdue":
      return {
        type: "warning",
        title: `Appeal limitation passed: ${n.notice_type}`,
        body: `${client}${ref}: the last day to appeal was ${formatDate(r.date)}. An appeal now needs a condonation of delay; record the decision on the notice.`,
      };
  }
}

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: NoticeReminderCounts }> {
  const today = todayIST(now);
  const counts: NoticeReminderCounts = { reply_reminders: 0, hearing_reminders: 0, reply_overdue: 0, appeal_reminders: 0, appeal_overdue: 0, failed: 0 };

  let rows: Row[];
  try {
    rows = await candidates(admin, today);
  } catch (err) {
    counts.failed++;
    logUnexpected(err, { source: "job:notice-reminders:load" });
    return { counts };
  }

  for (const n of rows) {
    try {
      if (!n.clients || n.clients.deleted_at) continue;
      const appealFiled = Boolean(n.tasks && !n.tasks.deleted_at && n.tasks.status === "filed_done");
      const reminders = planNoticeReminders(
        n.id,
        {
          status: n.status,
          replyDueDate: n.reply_due_date,
          hearingOn: n.hearing_date ? splitHearing(n.hearing_date).date || null : null,
          appealDecision: n.appeal_decision,
          limitationDate: n.limitation_date,
          appealFiled,
        },
        today,
      );
      for (const r of reminders) {
        const person = n.assigned_employee_id ?? n.clients.owner_employee_id;
        const roles: Array<"partner" | "manager"> = [];
        if (!person || r.kind === "reply_overdue") roles.push("manager");
        if (r.kind === "appeal_overdue" || (r.kind === "appeal" && r.lead <= 2)) roles.push("partner");
        const m = message(n, r);
        await notify({
          to: { employeeIds: person ? [person] : [], roles },
          type: m.type,
          title: m.title,
          body: m.body,
          linkUrl: `/workpapers/notices/${n.id}`,
          entity: { type: "tax_notice", id: n.id },
          clientId: n.client_id,
          dedupeKey: r.dedupeKey,
        });
        if (r.kind === "reply") counts.reply_reminders++;
        else if (r.kind === "hearing") counts.hearing_reminders++;
        else if (r.kind === "reply_overdue") counts.reply_overdue++;
        else if (r.kind === "appeal") counts.appeal_reminders++;
        else counts.appeal_overdue++;
      }
    } catch (err) {
      counts.failed++;
      logUnexpected(err, { source: "job:notice-reminders", noticeId: n.id });
    }
  }
  return { counts };
}
