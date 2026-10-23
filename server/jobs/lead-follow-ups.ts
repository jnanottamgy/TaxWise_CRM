import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import { logUnexpected } from "@/lib/log";
import { STALE_LEAD_DAYS, isFollowUpDue, isLeadStale, leadTitle } from "@/lib/schemas/leads";
import type { LeadStatus } from "@/lib/domain/enums";
import { notify } from "@/server/notify";

/**
 * Lead follow-ups, hourly (§7.5.1 "Automation: a reminder at the next follow-up time; leads untouched
 * for 14 days surface on the manager's dashboard"):
 *   1. A reminder to the person the lead is assigned to (else whoever added it) when its next
 *      follow-up time has come: once per follow-up time (leads.follow_up_reminded_for, and the
 *      dedupe key lead_follow_up:<id>:<time>). A follow-up more than 30 days past isn't announced.
 *   2. An open lead with no call, note, stage change or quotation for 14 days: its owner is told
 *      once per quiet spell (leads.stale_notified_at; any new activity re-arms it). The Manager
 *      dashboard lists them too (lib/data/dashboard.ts).
 * The job's own bookkeeping doesn't count as activity (leads_touch_activity, 0142). Idempotent; a
 * lead that fails is logged and the rest carry on.
 */

type LeadRow = {
  id: string;
  lead_number: string | null;
  name: string;
  company: string | null;
  status: LeadStatus;
  assigned_to: string | null;
  created_by: string;
  next_follow_up_at: string | null;
  follow_up_reminded_for: string | null;
  last_activity_at: string;
  stale_notified_at: string | null;
};

const COLUMNS = "id, lead_number, name, company, status, assigned_to, created_by, next_follow_up_at, follow_up_reminded_for, last_activity_at, stale_notified_at";
const PAGE = 500;
const MAX_PAST_DAYS = 30;

async function fetchAll(make: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>): Promise<LeadRow[]> {
  const out: LeadRow[] = [];
  for (let from = 0; from < 20_000; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...((data ?? []) as LeadRow[]));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

function sameInstant(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && Date.parse(a) === Date.parse(b);
}

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const counts = { follow_ups_reminded: 0, stale_notified: 0, failed: 0 };

  // 1. Follow-ups due.
  const earliest = new Date(now.getTime() - MAX_PAST_DAYS * 86_400_000).toISOString();
  const due = await fetchAll((from, to) =>
    admin
      .from("leads")
      .select(COLUMNS)
      .is("deleted_at", null)
      .not("status", "in", "(won,lost)")
      .lte("next_follow_up_at", now.toISOString())
      .gte("next_follow_up_at", earliest)
      .order("next_follow_up_at")
      .order("id")
      .range(from, to),
  );
  for (const lead of due) {
    if (!isFollowUpDue(lead, now) || sameInstant(lead.follow_up_reminded_for, lead.next_follow_up_at)) continue;
    try {
      await notify({
        to: lead.assigned_to ? { employeeIds: [lead.assigned_to] } : { userIds: [lead.created_by] },
        type: "info",
        title: `Follow up: ${leadTitle(lead)}`,
        body: `The follow-up was due ${formatDateTime(lead.next_follow_up_at)}. Call or message them, then log it on the lead.`,
        linkUrl: `/leads/${lead.id}`,
        entity: { type: "lead", id: lead.id },
        dedupeKey: `lead_follow_up:${lead.id}:${lead.next_follow_up_at}`,
      });
      const { error } = await admin.from("leads").update({ follow_up_reminded_for: lead.next_follow_up_at }).eq("id", lead.id).eq("next_follow_up_at", lead.next_follow_up_at!);
      if (error) throw error;
      counts.follow_ups_reminded++;
    } catch (err) {
      counts.failed++;
      logUnexpected(err, { source: "jobs:lead-follow-ups:due", leadId: lead.id });
    }
  }

  // 2. Untouched for 14 days.
  const cutoff = new Date(now.getTime() - STALE_LEAD_DAYS * 86_400_000).toISOString();
  const quiet = await fetchAll((from, to) =>
    admin.from("leads").select(COLUMNS).is("deleted_at", null).not("status", "in", "(won,lost)").lt("last_activity_at", cutoff).order("last_activity_at").order("id").range(from, to),
  );
  for (const lead of quiet) {
    if (!isLeadStale(lead, now)) continue;
    if (lead.stale_notified_at && Date.parse(lead.stale_notified_at) >= Date.parse(lead.last_activity_at)) continue;
    try {
      await notify({
        to: lead.assigned_to ? { employeeIds: [lead.assigned_to] } : { userIds: [lead.created_by] },
        type: "warning",
        title: `Lead untouched for ${STALE_LEAD_DAYS} days: ${leadTitle(lead)}`,
        body: `Nothing has happened on it since ${formatTimeAgo(lead.last_activity_at, now)}. Follow up, or mark it lost with the reason.`,
        linkUrl: `/leads/${lead.id}`,
        entity: { type: "lead", id: lead.id },
        dedupeKey: `lead_stale:${lead.id}:${lead.last_activity_at}`,
      });
      const { error } = await admin.from("leads").update({ stale_notified_at: now.toISOString() }).eq("id", lead.id);
      if (error) throw error;
      counts.stale_notified++;
    } catch (err) {
      counts.failed++;
      logUnexpected(err, { source: "jobs:lead-follow-ups:stale", leadId: lead.id });
    }
  }

  return { counts };
}
