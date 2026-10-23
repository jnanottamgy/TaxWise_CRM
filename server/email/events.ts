import "server-only";

import type { Json, TablesUpdate } from "@/lib/database.types";
import { createAdminClient, type AdminSupabase } from "@/server/admin";
import { notify } from "@/server/notify";
import {
  emailKindLabel,
  isDeliveryStatus,
  isMoneyEmail,
  isEmailKind,
  mapResendDomainStatus,
  messageStatusFor,
  nextDeliveryStatus,
  webhookEvent,
  type DeliveryEvent,
  type DeliveryStatus,
} from "@/server/email/policy";
import { log } from "@/lib/log";

/**
 * Applies one verified Resend webhook to the records (§7.13.1 "Sent / delivered / opened / bounced
 * (Resend webhooks)", §7.13.5, §9 "Email bounced → Sender + owner"):
 *   - email_deliveries: the status moves forward only (a late "delivered" never undoes "opened",
 *     nothing undoes a bounce), with the time of each event;
 *   - the client's messages row and a message_events entry (Communication tab);
 *   - quotation_email_logs rows with the same provider id (§5.4);
 *   - a bounce flags the contact's email as bad (client_contacts.email_bounced) and notifies the
 *     person who sent it and the client's owner; a failure after Resend accepted it notifies them too;
 *   - domain.updated mirrors the sending domain's status (§5.2 "mirrors Resend").
 * Each webhook delivery is applied once (email_webhook_events, by svix id). Runs as the system.
 */

export interface ResendWebhookPayload {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    subject?: string;
    tags?: Record<string, string> | Array<{ name: string; value: string }>;
    bounce?: { message?: string; type?: string; subType?: string };
    failed?: { reason?: string };
    suppressed?: { message?: string; type?: string };
    // domain.* events
    id?: string;
    name?: string;
    status?: string;
  };
}

export interface ApplyResult {
  handled: boolean;
  reason?: "duplicate" | "ignored" | "unknown_email" | "domain";
  status?: DeliveryStatus;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tagValue(tags: NonNullable<ResendWebhookPayload["data"]>["tags"], name: string): string | null {
  if (!tags) return null;
  if (Array.isArray(tags)) return tags.find((t) => t?.name === name)?.value ?? null;
  const v = (tags as Record<string, unknown>)[name];
  return typeof v === "string" ? v : null;
}

function occurredAt(payload: ResendWebhookPayload): string {
  const t = payload.created_at ? Date.parse(payload.created_at) : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

function problemText(event: DeliveryEvent, payload: ResendWebhookPayload): string | null {
  const d = payload.data ?? {};
  if (event === "bounced") {
    const kind = d.bounce?.type === "Permanent" ? "The address doesn't accept mail" : "The mail server turned it away";
    return d.bounce?.message ? `${kind}: ${d.bounce.message}` : `${kind}.`;
  }
  if (event === "suppressed") return "Resend didn't send it: this address bounced or complained before, so it is on the suppression list.";
  if (event === "failed") return d.failed?.reason ? `Resend couldn't deliver it: ${d.failed.reason}` : "Resend couldn't deliver it.";
  if (event === "complained") return "The recipient marked it as spam.";
  return null;
}

type DeliveryRow = {
  id: string;
  kind: string;
  recipient: string;
  subject: string;
  status: string;
  client_id: string | null;
  contact_id: string | null;
  message_id: string | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  sent_by: string | null;
  provider_message_id: string | null;
  delivered_at: string | null;
  opened_at: string | null;
};

const DELIVERY_COLUMNS =
  "id, kind, recipient, subject, status, client_id, contact_id, message_id, related_entity_type, related_entity_id, sent_by, provider_message_id, delivered_at, opened_at";

/** Where a bounce notice links, and what it is about (money notices stay with Partners and Managers). Exported for tests. */
export function bounceNoticeTarget(d: Pick<DeliveryRow, "id" | "kind" | "client_id" | "related_entity_type" | "related_entity_id">): {
  linkUrl: string;
  entity: { type: string; id: string };
} {
  const rel = d.related_entity_type && d.related_entity_id && UUID.test(d.related_entity_id) ? { type: d.related_entity_type, id: d.related_entity_id } : null;
  const routes: Record<string, (id: string) => string> = {
    invoice: (id) => `/invoices/${id}`,
    quotation: (id) => `/quotations/${id}`,
    lead: (id) => `/leads/${id}`,
    task: (id) => `/work/${id}`,
    employee: (id) => `/people/${id}`,
  };
  if (rel && routes[rel.type]) return { linkUrl: routes[rel.type](rel.id), entity: rel };
  const money = isEmailKind(d.kind) && isMoneyEmail(d.kind, d.related_entity_type);
  const entity = rel ?? { type: money ? "fee_email" : "email_delivery", id: d.id };
  if (d.client_id) return { linkUrl: `/clients/${d.client_id}?tab=communication`, entity };
  if (d.kind === "test") return { linkUrl: "/settings/email", entity };
  if (d.kind === "partner_digest") return { linkUrl: "/dashboard", entity };
  return { linkUrl: "/inbox", entity };
}

async function applyDomainEvent(admin: AdminSupabase, payload: ResendWebhookPayload): Promise<ApplyResult> {
  const id = payload.data?.id;
  if (!id) return { handled: false, reason: "ignored" };
  const { data: fs, error } = await admin.from("firm_settings").select("resend_domain_id, domain_status").eq("id", 1).maybeSingle();
  if (error) throw error;
  if (!fs || fs.resend_domain_id !== id) return { handled: false, reason: "ignored" };
  if (payload.type === "domain.deleted") {
    await admin.from("firm_settings").update({ resend_domain_id: null, domain_status: "not_started", domain_verified_at: null }).eq("id", 1);
    return { handled: true, reason: "domain" };
  }
  const status = mapResendDomainStatus(payload.data?.status);
  if (status !== fs.domain_status) {
    const { error: upd } = await admin
      .from("firm_settings")
      .update({ domain_status: status, domain_verified_at: status === "verified" ? occurredAt(payload) : null })
      .eq("id", 1);
    if (upd) throw upd;
  }
  return { handled: true, reason: "domain" };
}

export async function applyResendEvent(webhookId: string, payload: ResendWebhookPayload): Promise<ApplyResult> {
  const admin = createAdminClient();
  const type = payload.type ?? "";
  const event = webhookEvent(type);
  const providerId = payload.data?.email_id ?? null;

  // Applied once: the receipt is the lock.
  const receipt = await admin
    .from("email_webhook_events")
    .upsert(
      { webhook_id: webhookId.slice(0, 200), event_type: type.slice(0, 60) || "unknown", provider_message_id: providerId, occurred_at: occurredAt(payload) },
      { onConflict: "webhook_id", ignoreDuplicates: true },
    )
    .select("id");
  if (receipt.error) throw receipt.error;
  const receiptId = receipt.data?.[0]?.id;
  if (!receiptId) return { handled: false, reason: "duplicate" };

  try {
    if (type.startsWith("domain.")) return await applyDomainEvent(admin, payload);
    if (!event) return { handled: false, reason: "ignored" };

    // The delivery: by Resend's id, or by our tag when the webhook beat our own update.
    let delivery: DeliveryRow | null = null;
    if (providerId) {
      const r = await admin.from("email_deliveries").select(DELIVERY_COLUMNS).eq("provider_message_id", providerId).maybeSingle();
      if (r.error) throw r.error;
      delivery = (r.data as DeliveryRow | null) ?? null;
    }
    const tagged = tagValue(payload.data?.tags, "delivery");
    if (!delivery && tagged && UUID.test(tagged)) {
      const r = await admin.from("email_deliveries").select(DELIVERY_COLUMNS).eq("id", tagged).maybeSingle();
      if (r.error) throw r.error;
      delivery = (r.data as DeliveryRow | null) ?? null;
    }

    const at = occurredAt(payload);
    await updateQuotationLogs(admin, providerId, event, at, problemText(event, payload));

    if (!delivery) return { handled: false, reason: "unknown_email" };
    await admin.from("email_webhook_events").update({ delivery_id: delivery.id }).eq("id", receiptId);

    const current: DeliveryStatus = isDeliveryStatus(delivery.status) ? delivery.status : "queued";
    const next = nextDeliveryStatus(current, event);
    const problem = problemText(event, payload);

    const patch: TablesUpdate<"email_deliveries"> = { last_event_at: at };
    if (!delivery.provider_message_id && providerId) patch.provider_message_id = providerId;
    if (event === "delivered" && !delivery.delivered_at) patch.delivered_at = at;
    if ((event === "opened" || event === "clicked") && !delivery.opened_at) patch.opened_at = at;
    if (event === "bounced" || event === "suppressed") patch.bounced_at = at;
    if (event === "complained") patch.complained_at = at;
    if (event === "failed" && next) patch.failed_at = at;
    if (problem && (next || event === "complained")) patch.error = problem;
    if (next) patch.status = next;
    const upd = await admin.from("email_deliveries").update(patch).eq("id", delivery.id);
    if (upd.error) throw upd.error;

    // The Communication history.
    if (delivery.message_id && (next || event === "complained" || event === "delayed")) {
      const status = messageStatusFor(next ?? current);
      const msgPatch: TablesUpdate<"messages"> = { status };
      if (event === "delivered") msgPatch.delivered_at = at;
      if (event === "opened" || event === "clicked") msgPatch.read_at = at;
      if (status === "failed") {
        msgPatch.failed_at = at;
        msgPatch.error = problem;
      }
      const m = await admin.from("messages").update(msgPatch).eq("id", delivery.message_id);
      if (m.error) throw m.error;
      const e = await admin.from("message_events").insert({
        message_id: delivery.message_id,
        status: messageStatusFor(next ?? (event === "complained" ? "complained" : current)),
        details: { event: type, at, ...(problem ? { detail: problem } : {}) } as Json,
      });
      if (e.error) throw e.error;
    }

    // A bounce or a failure after acceptance: flag the address and tell the people involved.
    if (next === "bounced" || (next === "failed" && current !== "failed")) {
      if (next === "bounced") await flagBouncedContact(admin, delivery);
      await tellSenderAndOwner(admin, delivery, next, problem);
    }
    return { handled: true, status: next ?? current };
  } catch (err) {
    // Let Resend's retry apply it again.
    await admin.from("email_webhook_events").delete().eq("id", receiptId);
    throw err;
  }
}

async function updateQuotationLogs(admin: AdminSupabase, providerId: string | null, event: DeliveryEvent, at: string, problem: string | null) {
  if (!providerId) return;
  let q;
  switch (event) {
    case "delivered":
      q = admin.from("quotation_email_logs").update({ status: "delivered", delivered_at: at }).eq("provider_message_id", providerId).eq("status", "sent");
      break;
    case "opened":
    case "clicked":
      q = admin.from("quotation_email_logs").update({ status: "opened", opened_at: at }).eq("provider_message_id", providerId).in("status", ["sent", "delivered"]);
      break;
    case "bounced":
    case "suppressed":
      q = admin.from("quotation_email_logs").update({ status: "bounced", error: problem }).eq("provider_message_id", providerId).neq("status", "bounced");
      break;
    case "failed":
      q = admin.from("quotation_email_logs").update({ status: "failed", error: problem }).eq("provider_message_id", providerId).eq("status", "sent");
      break;
    default:
      return;
  }
  const { error } = await q;
  if (error) log("warn", "quotation email log not updated", { source: "email:webhook", providerId, err: error });
}

async function flagBouncedContact(admin: AdminSupabase, d: DeliveryRow) {
  try {
    if (d.contact_id) {
      const { error } = await admin.from("client_contacts").update({ email_bounced: true }).eq("id", d.contact_id);
      if (error) throw error;
      return;
    }
    if (d.client_id) {
      const addresses = d.recipient.split(",").map((a) => a.trim()).filter(Boolean);
      if (!addresses.length) return;
      const { error } = await admin.from("client_contacts").update({ email_bounced: true }).eq("client_id", d.client_id).in("email", addresses);
      if (error) throw error;
    }
  } catch (err) {
    log("error", "bounced contact not flagged", { source: "email:webhook", deliveryId: d.id, err });
  }
}

async function tellSenderAndOwner(admin: AdminSupabase, d: DeliveryRow, status: "bounced" | "failed", problem: string | null) {
  let ownerEmployeeId: string | null = null;
  let clientName: string | null = null;
  if (d.client_id) {
    const { data } = await admin.from("clients").select("owner_employee_id, display_name").eq("id", d.client_id).maybeSingle();
    ownerEmployeeId = data?.owner_employee_id ?? null;
    clientName = data?.display_name ?? null;
  }
  const userIds = d.sent_by ? [d.sent_by] : [];
  const employeeIds = ownerEmployeeId ? [ownerEmployeeId] : [];
  if (!userIds.length && !employeeIds.length) return;
  const target = bounceNoticeTarget(d);
  const what = emailKindLabel(d.kind).replace(/\s*email$/i, "").toLowerCase();
  const who = clientName ? `${d.recipient} (${clientName})` : d.recipient;
  await notify({
    to: { userIds, employeeIds },
    type: "warning",
    title: status === "bounced" ? "Email bounced" : "Email not delivered",
    body: `The ${what} email to ${who} wasn't delivered, so they haven't received it. ${problem ?? ""} Send it from your own mailbox or WhatsApp instead${status === "bounced" ? ", and check the address" : ""}.`
      .replace(/\s+/g, " ")
      .trim(),
    linkUrl: target.linkUrl,
    entity: target.entity,
    clientId: d.client_id,
    dedupeKey: `email_${status}:${d.id}`,
  });
}
