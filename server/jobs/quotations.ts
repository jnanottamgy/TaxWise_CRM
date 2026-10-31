import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { formatDate } from "@/lib/format";
import { log, logUnexpected } from "@/lib/log";
import { todayIST } from "@/lib/domain/fy";
import { dueFollowUp, type FollowUpRow } from "@/lib/schemas/quotations";
import { notify } from "@/server/notify";

/**
 * Quotations, 14:30 IST daily (§8):
 *   1. Expiry: Sent, Viewed, Approved and Pending approval quotations past their valid-until date
 *      become Expired (expire_lapsed_quotations, 0146; their link then says "This quotation has
 *      expired. Contact TaxWise for an updated one."), and each author is told.
 *   2. Follow-ups on day 3, 7 and 14 after sending, while the quotation is still Sent or Viewed and
 *      within its validity (§7.5.3): the app sends no email, so the author is asked, once, to send
 *      the latest one due on WhatsApp from the quotation page (/quotations/<id>?followup=<day>,
 *      where the message is ready). An earlier follow-up still waiting when a later one falls due
 *      is skipped, as are those of quotations no longer open.
 * Idempotent: the expiry runs on what is still open; a follow-up request is sent once
 * (notified_at) with a dedupe key. One quotation that fails is logged and the rest carry on.
 */

type FollowUpJoin = {
  id: string;
  quotation_id: string;
  follow_up_day: number;
  scheduled_at: string;
  status: string;
  notified_at: string | null;
  quotations: {
    id: string;
    quotation_number: string;
    status: string;
    valid_until: string;
    deleted_at: string | null;
    client_name: string;
    client_company: string | null;
    client_id: string | null;
    created_by: string;
  } | null;
};

const PAGE = 500;

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const counts = { expired: 0, follow_ups_to_hand_off: 0, follow_ups_skipped: 0, failed: 0 };
  const today = todayIST(now);

  // 1. Expiry.
  const { data: expired, error: expireError } = await admin.rpc("expire_lapsed_quotations", { p_today: today });
  if (expireError) throw expireError;
  for (const q of expired ?? []) {
    counts.expired++;
    if (!q.id || !q.created_by) continue;
    try {
      await notify({
        to: { userIds: [q.created_by] },
        type: "info",
        title: `Quotation ${q.quotation_number} expired`,
        body: `It was valid until ${formatDate(q.valid_until)}${q.client_name ? ` for ${q.client_name}` : ""}. Revise it to send an updated one.`,
        linkUrl: `/quotations/${q.id}`,
        entity: { type: "quotation", id: q.id },
        clientId: q.client_id,
        dedupeKey: `quotation_expired:${q.id}`,
      });
    } catch (err) {
      counts.failed++;
      logUnexpected(err, { source: "jobs:quotations:expiry", quotationId: q.id });
    }
  }

  // 2. Follow-ups due.
  const rows: FollowUpJoin[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("quotation_follow_ups")
      .select(
        "id, quotation_id, follow_up_day, scheduled_at, status, notified_at, quotations(id, quotation_number, status, valid_until, deleted_at, client_name, client_company, client_id, created_by)",
      )
      .eq("status", "pending")
      .lte("scheduled_at", now.toISOString())
      .order("scheduled_at")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as FollowUpJoin[]));
    if ((data ?? []).length < PAGE) break;
  }
  if (rows.length === 0) return { counts };

  const byQuotation = new Map<string, FollowUpJoin[]>();
  for (const r of rows) byQuotation.set(r.quotation_id, [...(byQuotation.get(r.quotation_id) ?? []), r]);

  for (const [quotationId, list] of byQuotation) {
    try {
      const q = list[0].quotations;
      const open = q && !q.deleted_at && (q.status === "sent" || q.status === "viewed") && q.valid_until >= today;
      if (!q || !open) {
        const { error } = await admin
          .from("quotation_follow_ups")
          .update({ status: "skipped", note: "The quotation is no longer open." })
          .eq("quotation_id", quotationId)
          .eq("status", "pending");
        if (error) throw error;
        counts.follow_ups_skipped += list.length;
        continue;
      }
      const plan = dueFollowUp(list.map((r): FollowUpRow => ({ id: r.id, follow_up_day: r.follow_up_day, scheduled_at: r.scheduled_at, status: r.status })), now);
      if (!plan) continue;
      if (plan.skip.length) {
        const { error } = await admin
          .from("quotation_follow_ups")
          .update({ status: "skipped", note: "A later follow-up went instead." })
          .in("id", plan.skip.map((s) => s.id))
          .eq("status", "pending");
        if (error) throw error;
        counts.follow_ups_skipped += plan.skip.length;
      }
      const due = list.find((r) => r.id === plan.due.id)!;
      const day = due.follow_up_day;
      const who = q.client_company?.trim() || q.client_name;

      if (!due.notified_at) {
        await notify({
          to: { userIds: [q.created_by] },
          type: "info",
          title: `Follow up quotation ${q.quotation_number} on WhatsApp (day ${day})`,
          body: `Send the day-${day} follow-up to ${who} on WhatsApp from the quotation: the message and the link are ready.`,
          linkUrl: `/quotations/${q.id}?followup=${day}`,
          entity: { type: "quotation", id: q.id },
          clientId: q.client_id,
          dedupeKey: `quotation_follow_up:${q.id}:${day}`,
        });
        const { error } = await admin.from("quotation_follow_ups").update({ notified_at: now.toISOString() }).eq("id", due.id).is("notified_at", null);
        if (error) throw error;
        counts.follow_ups_to_hand_off++;
      }
    } catch (err) {
      counts.failed++;
      logUnexpected(err, { source: "jobs:quotations:follow-up", quotationId });
    }
  }

  if (counts.failed) log("warn", "quotations job finished with failures", { source: "jobs:quotations", counts });
  return { counts };
}
