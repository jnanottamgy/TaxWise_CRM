import "server-only";

import { env } from "@/lib/env";
import type { ServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/server/admin";
import { getDomain, resendConfigured, type ResendDomain, type ResendFailure } from "@/server/email/resend";
import {
  describeSendError,
  dnsRecordRows,
  emailSendingReady,
  formatSender,
  isDeliveryStatus,
  mapResendDomainStatus,
  type DeliveryStatus,
  type DnsRecordRow,
  type DomainStatus,
} from "@/server/email/policy";

/**
 * Reads for Settings → Email (§7.13.5, §7.21) and the domain-status mirror the actions and the
 * webhook share. Reads run under the Partner's session (RLS: firm_settings staff read, the delivery
 * ledger Partner read); the mirror writes as the system, because only Resend's answer may change the
 * status (0100 firm_settings_email_domain_guard).
 */

export interface EmailSettingsView {
  fromName: string;
  fromAddress: string;
  replyTo: string;
  sendingDomain: string;
  resendDomainId: string | null;
  domainStatus: DomainStatus;
  domainVerifiedAt: string | null;
  /** The firm's public email, for the DMARC report address. */
  firmEmail: string | null;
  updatedAt: string;
  apiKeyPresent: boolean;
  webhookSecretPresent: boolean;
  webhookUrl: string;
  lastWebhookAt: string | null;
  /** Ready to send automatic email, or why not (same rule sendEmail uses). */
  ready: boolean;
  notReadyReason: string | null;
  sender: string;
}

function asDomainStatus(v: string | null | undefined): DomainStatus {
  return v === "pending" || v === "verified" || v === "failed" ? v : "not_started";
}

/** Null when the settings row is missing (the seed hasn't run). Throws on a database error. */
export async function getEmailSettingsView(supabase: ServerSupabase): Promise<EmailSettingsView | null> {
  const { data, error } = await supabase
    .from("firm_settings")
    .select("email_from_name, email_from_address, email_reply_to, sending_domain, resend_domain_id, domain_status, domain_verified_at, email, updated_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message || "firm_settings read failed"), error);
  if (!data) return null;

  const last = await supabase.from("email_webhook_events").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (last.error) throw Object.assign(new Error(last.error.message || "email_webhook_events read failed"), last.error);

  const apiKeyPresent = resendConfigured();
  const readiness = emailSendingReady({
    apiKeyPresent,
    domainStatus: data.domain_status,
    sendingDomain: data.sending_domain,
    fromAddress: data.email_from_address,
  });
  return {
    fromName: data.email_from_name,
    fromAddress: data.email_from_address,
    replyTo: data.email_reply_to,
    sendingDomain: data.sending_domain,
    resendDomainId: data.resend_domain_id,
    domainStatus: asDomainStatus(data.domain_status),
    domainVerifiedAt: data.domain_verified_at,
    firmEmail: data.email,
    updatedAt: data.updated_at,
    apiKeyPresent,
    webhookSecretPresent: Boolean(env.resendWebhookSecret()?.trim()),
    webhookUrl: `${env.appUrl().replace(/\/+$/, "")}/api/webhooks/resend`,
    lastWebhookAt: last.data?.created_at ?? null,
    ready: readiness.ready,
    notReadyReason: readiness.ready ? null : readiness.reason,
    sender: formatSender(data.email_from_name, data.email_from_address),
  };
}

export interface DomainDetails {
  id: string;
  name: string;
  /** Resend's own word for it. */
  resendStatus: string;
  status: DomainStatus;
  region: string | null;
  records: DnsRecordRow[];
  checkedAt: string;
}

export function toDomainDetails(domain: ResendDomain, reportTo: string | null): DomainDetails {
  return {
    id: domain.id,
    name: domain.name,
    resendStatus: domain.status,
    status: mapResendDomainStatus(domain.status),
    region: domain.region,
    records: dnsRecordRows(domain.records, domain.name, reportTo),
    checkedAt: new Date().toISOString(),
  };
}

export type DomainLookup =
  | { ok: true; details: DomainDetails }
  | { ok: false; missing: boolean; error: string; failure: ResendFailure };

/** The domain as Resend has it now. `missing` when Resend no longer knows the id. */
export async function lookUpDomain(resendDomainId: string, reportTo: string | null): Promise<DomainLookup> {
  const r = await getDomain(resendDomainId);
  if (r.ok) return { ok: true, details: toDomainDetails(r.domain, reportTo) };
  const missing = r.error.statusCode === 404 || r.error.name === "not_found";
  return { ok: false, missing, error: describeSendError(r.error), failure: r.error };
}

/**
 * Writes what Resend said about the domain (§5.2 "mirrors Resend, never set locally"). Writes only
 * when something changed, so polling doesn't touch the row. Returns whether it changed.
 */
export async function mirrorDomain(
  current: { resendDomainId: string | null; domainStatus: DomainStatus; sendingDomain: string; domainVerifiedAt: string | null },
  next: { id: string | null; name: string; status: DomainStatus },
): Promise<boolean> {
  const verifiedAt = next.status === "verified" ? (current.domainStatus === "verified" && current.domainVerifiedAt ? current.domainVerifiedAt : new Date().toISOString()) : null;
  const changed =
    current.resendDomainId !== next.id ||
    current.domainStatus !== next.status ||
    current.sendingDomain.toLowerCase() !== next.name.toLowerCase() ||
    (current.domainVerifiedAt ?? null) !== verifiedAt;
  if (!changed) return false;
  const admin = createAdminClient();
  const { error } = await admin
    .from("firm_settings")
    .update({ resend_domain_id: next.id, domain_status: next.status, sending_domain: next.name, domain_verified_at: verifiedAt })
    .eq("id", 1);
  if (error) throw Object.assign(new Error(error.message || "firm_settings mirror failed"), error);
  return true;
}

export interface DeliveryLogRow {
  id: string;
  createdAt: string;
  kind: string;
  recipient: string;
  subject: string;
  status: DeliveryStatus;
  error: string | null;
  attempts: number;
  clientId: string | null;
  clientName: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  lastEventAt: string | null;
}

export const DELIVERY_LOG_LIMIT = 50;

/** The latest 50 emails (or only the problems among them). Partner session (RLS). */
export async function getDeliveryLog(supabase: ServerSupabase, opts: { problemsOnly?: boolean } = {}): Promise<{ rows: DeliveryLogRow[]; anyAtAll: boolean }> {
  let q = supabase
    .from("email_deliveries")
    .select("id, created_at, kind, recipient, subject, status, error, attempts, client_id, sent_at, delivered_at, opened_at, last_event_at, clients(display_name)")
    .order("created_at", { ascending: false })
    .limit(DELIVERY_LOG_LIMIT);
  if (opts.problemsOnly) q = q.in("status", ["bounced", "complained", "failed"]);
  const { data, error } = await q;
  if (error) throw Object.assign(new Error(error.message || "email_deliveries read failed"), error);
  let anyAtAll = (data ?? []).length > 0;
  if (!anyAtAll && opts.problemsOnly) {
    const probe = await supabase.from("email_deliveries").select("id").limit(1);
    if (probe.error) throw Object.assign(new Error(probe.error.message || "email_deliveries read failed"), probe.error);
    anyAtAll = (probe.data ?? []).length > 0;
  }
  const rows = (data ?? []).map((r) => {
    const client = (r as unknown as { clients: { display_name: string } | Array<{ display_name: string }> | null }).clients;
    const clientName = Array.isArray(client) ? (client[0]?.display_name ?? null) : (client?.display_name ?? null);
    return {
      id: r.id,
      createdAt: r.created_at,
      kind: r.kind,
      recipient: r.recipient,
      subject: r.subject,
      status: isDeliveryStatus(r.status) ? r.status : "queued",
      error: r.error,
      attempts: r.attempts,
      clientId: r.client_id,
      clientName,
      sentAt: r.sent_at,
      deliveredAt: r.delivered_at,
      openedAt: r.opened_at,
      lastEventAt: r.last_event_at,
    } satisfies DeliveryLogRow;
  });
  return { rows, anyAtAll };
}
