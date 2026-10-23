import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { env } from "@/lib/env";
import { formatDate } from "@/lib/format";
import { log, logUnexpected } from "@/lib/log";
import { todayIST } from "@/lib/domain/fy";
import { toPaise } from "@/lib/domain/money";
import { dueFollowUp, followUpTone, type FollowUpRow } from "@/lib/schemas/quotations";
import { getEmailReadiness } from "@/server/email/readiness";
import { sendEmail } from "@/server/email/send";
import { emailFirm, quotationFollowUpEmail, type EmailFirm } from "@/server/email/templates";
import { getFirmProfile } from "@/server/firm";
import { notify } from "@/server/notify";

/**
 * Quotations, 14:30 IST daily (§8):
 *   1. Expiry: Sent, Viewed, Approved and Pending approval quotations past their valid-until date
 *      become Expired (expire_lapsed_quotations, 0146; their link then says "This quotation has
 *      expired. Contact TaxWise for an updated one."), and each author is told.
 *   2. Follow-ups on day 3, 7 and 14 after sending, while the quotation is still Sent or Viewed and
 *      within its validity (§7.5.3): the latest one due goes by email (§10.6) when email works and
 *      the client has an address; otherwise (or when the email fails) the author is asked, once, to
 *      hand it off by WhatsApp or Gmail from the quotation page (/quotations/<id>?followup=<day>).
 *      An earlier follow-up still waiting when a later one falls due is skipped, as are those of
 *      quotations no longer open.
 * Idempotent: the expiry runs on what is still open; a follow-up email carries the idempotency key
 * quotation:<id>:follow_up_<day> and the row's status moves on; a hand-off request is sent once
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
    client_email: string | null;
    client_id: string | null;
    token: string;
    total: number;
    sent_at: string | null;
    created_by: string;
  } | null;
};

const PAGE = 500;

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const counts = { expired: 0, follow_ups_emailed: 0, follow_ups_to_hand_off: 0, follow_ups_skipped: 0, emails_failed: 0, failed: 0 };
  const today = todayIST(now);
  const appUrl = env.appUrl().replace(/\/+$/, "");

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
        "id, quotation_id, follow_up_day, scheduled_at, status, notified_at, quotations(id, quotation_number, status, valid_until, deleted_at, client_name, client_company, client_email, client_id, token, total, sent_at, created_by)",
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

  const email = await getEmailReadiness(admin);
  let firm: EmailFirm | null = null;

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

      let handOff = !email.ready || !q.client_email;
      if (!handOff) {
        firm ??= emailFirm(await getFirmProfile(admin));
        const { data: author } = await admin.from("profiles").select("full_name").eq("id", q.created_by).maybeSingle();
        const mail = quotationFollowUpEmail(
          {
            day: followUpTone(day),
            recipientName: q.client_name,
            quotationNumber: q.quotation_number,
            totalPaise: toPaise(q.total),
            validUntil: q.valid_until,
            viewUrl: `${appUrl}/q/${q.token}`,
            sentOn: q.sent_at ?? today,
            senderName: author?.full_name ?? firm.firmName,
          },
          firm,
        );
        const sent = await sendEmail({
          to: q.client_email!,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          kind: "quotation_follow_up",
          clientId: q.client_id,
          related: { type: "quotation", id: q.id },
          idempotencyKey: `quotation:${q.id}:follow_up_${day}`,
        });
        if (sent.status === "sent") {
          const { error } = await admin.rpc("record_quotation_follow_up", {
            p_id: q.id,
            p_day: day,
            p_channel: "email",
            p_to: q.client_email,
            p_subject: mail.subject,
            p_status: "sent",
            p_provider_message_id: sent.providerMessageId ?? null,
          });
          if (error) throw error;
          counts.follow_ups_emailed++;
          continue;
        }
        if (sent.status === "failed") {
          counts.emails_failed++;
          const { error } = await admin.rpc("record_quotation_follow_up", {
            p_id: q.id,
            p_day: day,
            p_channel: "email",
            p_to: q.client_email,
            p_subject: mail.subject,
            p_status: "failed",
            p_error: sent.error ?? "The email didn't go through.",
          });
          if (error) throw error;
        }
        handOff = true;
      }

      if (handOff && !due.notified_at) {
        await notify({
          to: { userIds: [q.created_by] },
          type: "info",
          title: `Follow up quotation ${q.quotation_number} (day ${day})`,
          body: email.ready
            ? `The day-${day} follow-up to ${who} couldn't go by email. Send it by WhatsApp or Gmail from the quotation.`
            : `Email isn't set up yet, so send the day-${day} follow-up to ${who} by WhatsApp or Gmail from the quotation.`,
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
