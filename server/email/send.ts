import "server-only";

import type { Json } from "@/lib/database.types";
import { createAdminClient, type AdminSupabase } from "@/server/admin";
import { sessionActor, type Actor } from "@/server/activity";
import { getDomain, resendConfigured, sendWithRetry, type ResendEmailPayload, type ResendFailure } from "@/server/email/resend";
import {
  describeSendError,
  emailSendingReady,
  formatSender,
  isDeliveryStatus,
  isDomainNotVerifiedError,
  isMoneyEmail,
  isValidEmailAddress,
  mapResendDomainStatus,
  normaliseIdempotencyKey,
  parseRecipients,
  type DeliveryStatus,
  type EmailKind,
} from "@/server/email/policy";
import { emailFirm, withFooter, type EmailFirm } from "@/server/email/templates/layout";
import { defaultFirmProfile, firmLogoUrl, toFirmProfile } from "@/server/firm";
import { log, logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";

/**
 * Sends one automatic email through Resend and records it (§7.13.1, §7.13.5, §10, §13).
 *
 *   const mail = invoiceEmail({ … }, emailFirm(await getFirmProfile(ctx.supabase)));
 *   ctx.after("Email the invoice", async () => {
 *     const r = await sendEmail({ to: contact.email, ...mail, kind: "invoice", clientId, contactId: contact.id,
 *       related: { type: "invoice", id: invoice.id }, attachments: [{ filename: "TW-26-27-0042.pdf", content: pdf }],
 *       idempotencyKey: `invoice:${invoice.id}:issue` });
 *     if (r.status === "not_configured") … offer the WhatsApp / Gmail hand-off (lib/handoff.ts)
 *     if (r.status === "failed") … show r.error and the hand-off, prominently (§7.13.3)
 *   });
 *
 * Never throws. Returns:
 *   - `not_configured` when RESEND_API_KEY is missing, the sending domain isn't verified in Resend,
 *     or the from address isn't on it (§7.13.5 "not attempted silently"): nothing is sent or
 *     recorded, and the caller shows the hand-off buttons with the banner text in lib/handoff.ts;
 *   - `sent` with Resend's id once Resend accepted it (delivery, opens and bounces arrive later by
 *     webhook, app/api/webhooks/resend); also when this idempotency key was already sent, without
 *     sending again;
 *   - `failed` with a plain-language error after the retries (3, with backoff); the failure is on
 *     the record (email_deliveries, and the client's messages row).
 *
 * The idempotency key names the send ("invoice:<id>:issue", "quotation:<id>:follow_up_7",
 * "notification:<id>"): the same key never sends twice, here or at Resend.
 * Every email carries the footer (§7.13.5), added here if the caller's HTML or text lacks it.
 * An Employee can't send fee, invoice or quotation emails (§4.1); a portal user sends none.
 */

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  text: string;
  html?: string | null;
  /** Defaults to Settings → Email reply-to (info@twchartered.com). */
  replyTo?: string | null;
  kind: EmailKind;
  /** Client emails are also logged in `messages` (the Communication history). */
  clientId?: string | null;
  contactId?: string | null;
  related?: { type: string; id: string } | null;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
  idempotencyKey: string;
}

export interface SendEmailResult {
  status: "sent" | "not_configured" | "failed";
  providerMessageId?: string;
  error?: string;
  /** messages.id, for client emails. */
  messageId?: string;
  /** email_deliveries.id */
  deliveryId?: string;
}

/** Resend's limit is 40 MB per email after encoding; stay well inside it. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** A 'queued' row older than this was interrupted mid-send and may be retried. */
const STALE_QUEUED_MS = 10 * 60 * 1000;

const ALREADY_SENT: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>(["sent", "delayed", "delivered", "opened", "complained", "bounced"]);

type SettingsRow = {
  firm_name: string;
  legal_name: string | null;
  tagline: string | null;
  address: string | null;
  city: string | null;
  state_code: string;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  gstin: string | null;
  logo_path: string | null;
  logo_updated_at: string | null;
  email_from_name: string;
  email_from_address: string;
  email_reply_to: string;
  sending_domain: string;
  domain_status: string | null;
  resend_domain_id: string | null;
};

const SETTINGS_COLUMNS =
  "firm_name, legal_name, tagline, address, city, state_code, pincode, phone, email, website, gstin, logo_path, logo_updated_at, email_from_name, email_from_address, email_reply_to, sending_domain, domain_status, resend_domain_id";

export interface EmailConfig {
  ready: boolean;
  reason: string | null;
  from: string;
  replyTo: string;
  sendingDomain: string;
  domainStatus: string;
  resendDomainId: string | null;
  firm: EmailFirm;
}

/** The sender, reply-to, domain status and footer block, as sendEmail sees them. Throws on a database error. */
export async function loadEmailConfig(admin: AdminSupabase = createAdminClient()): Promise<EmailConfig | null> {
  const { data, error } = await admin.from("firm_settings").select(SETTINGS_COLUMNS).eq("id", 1).maybeSingle();
  if (error) throw Object.assign(new Error(error.message || "firm_settings read failed"), error);
  if (!data) return null;
  const s = data as unknown as SettingsRow;
  const profile = toFirmProfile(
    {
      firm_name: s.firm_name,
      legal_name: s.legal_name,
      tagline: s.tagline,
      address: s.address,
      city: s.city,
      state_code: s.state_code,
      pincode: s.pincode,
      phone: s.phone,
      email: s.email,
      website: s.website,
      gstin: s.gstin,
      logo_path: s.logo_path,
      logo_updated_at: s.logo_updated_at,
      bank_name: null,
      bank_account_name: null,
      bank_account_number: null,
      bank_ifsc: null,
      bank_branch: null,
      upi_id: null,
      upi_payee_name: null,
    },
    firmLogoUrl(admin, s.logo_path, s.logo_updated_at),
  );
  const readiness = emailSendingReady({
    apiKeyPresent: resendConfigured(),
    domainStatus: s.domain_status,
    sendingDomain: s.sending_domain,
    fromAddress: s.email_from_address,
  });
  return {
    ready: readiness.ready,
    reason: readiness.ready ? null : readiness.reason,
    from: formatSender(s.email_from_name, s.email_from_address),
    replyTo: s.email_reply_to,
    sendingDomain: s.sending_domain,
    domainStatus: s.domain_status ?? "not_started",
    resendDomainId: s.resend_domain_id,
    firm: emailFirm(profile),
  };
}

function refusal(error: string): SendEmailResult {
  return { status: "failed", error };
}

function safeFilename(name: string): string {
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim();
  return (base || "attachment").slice(0, 120);
}

/** When Resend says the domain isn't verified any more, mirror its real status (best effort). */
async function mirrorDomainStatus(admin: AdminSupabase, resendDomainId: string | null): Promise<void> {
  if (!resendDomainId) return;
  try {
    const r = await getDomain(resendDomainId);
    if (!r.ok) return;
    const status = mapResendDomainStatus(r.domain.status);
    await admin
      .from("firm_settings")
      .update({ domain_status: status, ...(status === "verified" ? {} : { domain_verified_at: null }) })
      .eq("id", 1);
  } catch (err) {
    log("warn", "domain status mirror failed", { source: "email:send", err });
  }
}

async function addEvent(admin: AdminSupabase, messageId: string | null, status: "queued" | "sent" | "failed", details: Record<string, unknown>) {
  if (!messageId) return;
  const { error } = await admin.from("message_events").insert({ message_id: messageId, status, details: details as Json });
  if (error) log("warn", "message event not recorded", { source: "email:send", messageId, err: error });
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  let actor: Actor | null = null;
  try {
    // 1. What is being sent, and by whom.
    const recipients = parseRecipients(input.to);
    if (recipients.length === 0) return refusal("There's no email address to send to.");
    const bad = recipients.find((a) => !isValidEmailAddress(a));
    if (bad) return refusal(`${bad} isn't a valid email address.`);
    if (recipients.length > 50) return refusal("An email can go to at most 50 people.");
    const subject = input.subject.replace(/[\r\n]+/g, " ").trim();
    if (!subject) return refusal("The email needs a subject.");
    if (!input.text.trim()) return refusal("The email needs a message.");
    const key = normaliseIdempotencyKey(input.idempotencyKey);
    if (!key) return refusal("The email needs an idempotency key.");
    const attachmentBytes = (input.attachments ?? []).reduce((n, a) => n + a.content.byteLength, 0);
    if (attachmentBytes > MAX_ATTACHMENT_BYTES) return refusal("The attachments are over 25 MB. Send a link instead.");
    if (input.replyTo && !isValidEmailAddress(input.replyTo)) return refusal(`${input.replyTo} isn't a valid reply-to address.`);

    actor = await sessionActor();
    if (actor?.role === "client" && input.kind !== "notification") {
      return refusal("Portal users can't send emails from the app.");
    }
    if (actor?.role === "employee" && input.kind !== "notification" && isMoneyEmail(input.kind, input.related?.type)) {
      return refusal("Emails about fees, invoices or quotations are sent by a Manager or a Partner.");
    }
    if (actor?.role === "employee" && input.clientId) {
      const { data: visible, error: visError } = await actor.supabase.rpc("can_see_client", { cid: input.clientId });
      if (visError) throw visError;
      if (!visible) return refusal("You can't email this client.");
    }

    // 2. Is email set up? (§7.13.5: never attempted silently until the domain is verified.)
    const admin = createAdminClient();
    const config = await loadEmailConfig(admin);
    if (!config) return { status: "not_configured", error: "The firm's settings row is missing, so email isn't set up." };
    if (!config.ready) return { status: "not_configured", error: config.reason ?? "Email isn't set up yet." };

    // 3. Claim the idempotency key (unique in email_deliveries).
    const recipient = recipients.join(", ");
    const claimed = await admin
      .from("email_deliveries")
      .upsert(
        {
          idempotency_key: key,
          kind: input.kind,
          recipient,
          subject,
          client_id: input.clientId ?? null,
          contact_id: input.contactId ?? null,
          related_entity_type: input.related?.type ?? null,
          related_entity_id: input.related?.id ?? null,
          sent_by: actor?.userId ?? null,
        },
        { onConflict: "idempotency_key", ignoreDuplicates: true },
      )
      .select("id, status, message_id, provider_message_id, attempts, updated_at");
    if (claimed.error) throw claimed.error;

    let delivery = claimed.data?.[0] ?? null;
    if (!delivery) {
      const existing = await admin
        .from("email_deliveries")
        .select("id, status, message_id, provider_message_id, attempts, updated_at")
        .eq("idempotency_key", key)
        .maybeSingle();
      if (existing.error) throw existing.error;
      if (!existing.data) throw new Error("email delivery claim vanished");
      const row = existing.data;
      const status = isDeliveryStatus(row.status) ? row.status : "queued";
      if (ALREADY_SENT.has(status)) {
        return {
          status: "sent",
          providerMessageId: row.provider_message_id ?? undefined,
          messageId: row.message_id ?? undefined,
          deliveryId: row.id,
        };
      }
      if (status === "queued" && Date.now() - Date.parse(row.updated_at) < STALE_QUEUED_MS) {
        return { status: "failed", error: "This email is already being sent. Check the delivery log in a minute.", deliveryId: row.id, messageId: row.message_id ?? undefined };
      }
      // A failed (or interrupted) send of this key: try again on the same row. The claim is
      // conditional on the row as read, so two retries at once can't both send.
      const reset = await admin
        .from("email_deliveries")
        .update({ status: "queued", error: null, failed_at: null, recipient, subject, sent_by: actor?.userId ?? null })
        .eq("id", row.id)
        .eq("status", row.status)
        .eq("updated_at", row.updated_at)
        .select("id, status, message_id, provider_message_id, attempts, updated_at")
        .maybeSingle();
      if (reset.error) throw reset.error;
      if (!reset.data) {
        return { status: "failed", error: "This email is already being sent. Check the delivery log in a minute.", deliveryId: row.id, messageId: row.message_id ?? undefined };
      }
      delivery = reset.data;
    }

    // 4. The client's Communication history (§7.13.1): one messages row per email.
    let messageId = delivery.message_id ?? null;
    if (input.clientId && !messageId) {
      const msg = await admin
        .from("messages")
        .insert({
          client_id: input.clientId,
          contact_id: input.contactId ?? null,
          channel: "email",
          direction: "outbound",
          recipient,
          subject,
          body: input.text,
          status: "queued",
          related_entity_type: input.related?.type ?? null,
          related_entity_id: input.related?.id ?? null,
          sent_by: actor?.userId ?? null,
        })
        .select("id")
        .single();
      if (msg.error) {
        await admin.from("email_deliveries").update({ status: "failed", error: "The client's record couldn't be updated.", failed_at: new Date().toISOString() }).eq("id", delivery.id);
        throw msg.error;
      }
      messageId = msg.data.id;
      const link = await admin.from("email_deliveries").update({ message_id: messageId }).eq("id", delivery.id);
      if (link.error) log("warn", "delivery not linked to its message", { source: "email:send", deliveryId: delivery.id, err: link.error });
    } else if (messageId) {
      await admin.from("messages").update({ status: "queued", error: null, failed_at: null }).eq("id", messageId);
    }

    // 5. Send (first try + 3 retries with backoff, one idempotency key).
    const body = withFooter({ subject, text: input.text, html: input.html }, config.firm);
    const payload: ResendEmailPayload = {
      from: config.from,
      to: recipients,
      subject,
      html: body.html,
      text: body.text,
      reply_to: [input.replyTo?.trim() || config.replyTo],
      headers: { "X-Entity-Ref-ID": delivery.id },
      tags: [
        { name: "delivery", value: delivery.id },
        { name: "kind", value: input.kind },
      ],
      attachments: input.attachments?.length
        ? input.attachments.map((a) => ({ filename: safeFilename(a.filename), content: a.content.toString("base64"), ...(a.contentType ? { content_type: a.contentType } : {}) }))
        : undefined,
    };
    const result = await sendWithRetry(payload, key);
    const now = new Date().toISOString();
    const attempts = Math.min(20, (delivery.attempts ?? 0) + result.attempts);

    if (result.ok && result.providerMessageId) {
      const upd = await admin
        .from("email_deliveries")
        .update({ provider_message_id: result.providerMessageId, attempts, sent_at: now, error: null, failed_at: null })
        .eq("id", delivery.id);
      if (upd.error) log("error", "delivery not marked sent", { source: "email:send", deliveryId: delivery.id, err: upd.error });
      // The webhook may already have moved it on (delivered, opened): only lift queued / failed.
      await admin.from("email_deliveries").update({ status: "sent", last_event_at: now }).eq("id", delivery.id).in("status", ["queued", "failed"]);
      if (messageId) {
        await admin.from("messages").update({ provider_message_id: result.providerMessageId, sent_at: now, error: null, failed_at: null }).eq("id", messageId);
        await admin.from("messages").update({ status: "sent" }).eq("id", messageId).in("status", ["queued", "failed"]);
        await addEvent(admin, messageId, "sent", { attempts: result.attempts, provider_message_id: result.providerMessageId });
      }
      return { status: "sent", providerMessageId: result.providerMessageId, messageId: messageId ?? undefined, deliveryId: delivery.id };
    }

    const failure: ResendFailure = result.error ?? { name: null, message: "Resend couldn't be reached.", statusCode: null };
    const error = describeSendError(failure);
    if (isDomainNotVerifiedError(failure)) await mirrorDomainStatus(admin, config.resendDomainId);
    await admin.from("email_deliveries").update({ status: "failed", error, failed_at: now, attempts, last_event_at: now }).eq("id", delivery.id).in("status", ["queued", "failed"]);
    if (messageId) {
      await admin.from("messages").update({ status: "failed", error, failed_at: now }).eq("id", messageId).in("status", ["queued", "failed"]);
      await addEvent(admin, messageId, "failed", { error, code: failure.name, http_status: failure.statusCode, attempts: result.attempts });
    }
    log("warn", "email not sent", { source: "email:send", kind: input.kind, deliveryId: delivery.id, code: failure.name, status: failure.statusCode, attempts: result.attempts });
    return { status: "failed", error, messageId: messageId ?? undefined, deliveryId: delivery.id };
  } catch (err) {
    const ref = logUnexpected(err, { source: "email:send", userId: actor?.userId ?? null, role: actor?.role ?? null, kind: input.kind });
    return { status: "failed", error: unexpectedMessage(ref) };
  }
}

/** The §1 identity as an email footer block, for callers that render before settings load. */
export function fallbackEmailFirm(): EmailFirm {
  return emailFirm(defaultFirmProfile());
}
