/**
 * The rules behind automatic email (§7.13.1, §7.13.5, §10, §13), as pure functions with no I/O, so
 * server/email/send.ts, the Resend webhook and Settings → Email share one definition and the unit
 * tests (tests/unit/platform-email-policy.test.ts) pin them down.
 *
 * Safe to import anywhere (no server-only code); nothing here sends anything.
 */

// -------------------------------------------------------------------------------------------------
// Kinds of email (§10)
// -------------------------------------------------------------------------------------------------

export const EMAIL_KINDS = [
  "staff_invite",
  "portal_invite",
  "welcome",
  "quotation_sent",
  "quotation_follow_up",
  "quotation_accepted",
  "quotation_declined",
  "quotation_response_alert",
  "invoice",
  "payment_receipt",
  "payment_reminder",
  "document_request",
  "document_request_reminder",
  "compliance_reminder",
  "engagement_letter",
  "partner_digest",
  "notification",
  "notice",
  "test",
] as const;

export type EmailKind = (typeof EMAIL_KINDS)[number];

export function isEmailKind(v: unknown): v is EmailKind {
  return typeof v === "string" && (EMAIL_KINDS as readonly string[]).includes(v);
}

/** What each kind is called in the delivery log. */
export const EMAIL_KIND_LABEL: Record<EmailKind, string> = {
  staff_invite: "Staff invite",
  portal_invite: "Portal invite",
  welcome: "Welcome",
  quotation_sent: "Quotation",
  quotation_follow_up: "Quotation follow-up",
  quotation_accepted: "Quotation accepted",
  quotation_declined: "Quotation declined",
  quotation_response_alert: "Quotation response",
  invoice: "Invoice",
  payment_receipt: "Payment receipt",
  payment_reminder: "Payment reminder",
  document_request: "Document request",
  document_request_reminder: "Document reminder",
  compliance_reminder: "Compliance reminder",
  engagement_letter: "Engagement letter",
  partner_digest: "Partner digest",
  notification: "Notification",
  notice: "Notice",
  test: "Test email",
};

export function emailKindLabel(kind: string): string {
  return isEmailKind(kind) ? EMAIL_KIND_LABEL[kind] : kind.replace(/_/g, " ");
}

/**
 * Kinds that carry fees, invoices, receipts or quotations (§4.1: an Employee never receives them,
 * and never sends them). The partner digest lists overdue receivables.
 */
export const MONEY_EMAIL_KINDS: ReadonlySet<EmailKind> = new Set<EmailKind>([
  "quotation_sent",
  "quotation_follow_up",
  "quotation_accepted",
  "quotation_declined",
  "quotation_response_alert",
  "invoice",
  "payment_receipt",
  "payment_reminder",
  "engagement_letter",
  "partner_digest",
]);

/**
 * Mirrors money_side_kind() in the database (0043): lead, quotation, invoice, payment, receipt,
 * credit note, engagement letter, fee, TDS credit and portal payment claim records.
 */
export function isMoneySideKind(kind: string | null | undefined): boolean {
  if (!kind) return false;
  return /^(lead|quotation|invoice|payment|receipt|credit_note|engagement_letter|fee|tds_credit|portal_payment_claim)/.test(kind.trim().toLowerCase());
}

/** An email about money: by its kind or by the record it is about. */
export function isMoneyEmail(kind: EmailKind, relatedType?: string | null): boolean {
  return MONEY_EMAIL_KINDS.has(kind) || isMoneySideKind(relatedType);
}

// -------------------------------------------------------------------------------------------------
// Addresses
// -------------------------------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@<>(),;:"[\]\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidEmailAddress(v: string): boolean {
  const t = v.trim();
  return t.length <= 254 && EMAIL_PATTERN.test(t);
}

/** One address or several (comma / semicolon separated, or an array), trimmed, de-duplicated (case-insensitive). */
export function parseRecipients(to: string | readonly string[]): string[] {
  const list = typeof to === "string" ? to.split(/[,;]/) : [...to];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const a = raw.trim();
    if (!a) continue;
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

/** The domain of an address, lower-cased ("noreply@twchartered.com" → "twchartered.com"). */
export function emailDomainOf(address: string): string | null {
  const at = address.trim().lastIndexOf("@");
  if (at < 1) return null;
  const domain = address.trim().slice(at + 1).toLowerCase();
  return domain || null;
}

/** Resend sends only from the verified domain itself: the from address must be on it. */
export function fromAddressOnDomain(address: string, domain: string): boolean {
  const d = emailDomainOf(address);
  return d !== null && d === domain.trim().toLowerCase().replace(/\.$/, "");
}

/** A domain name as typed ("https://www.twchartered.com/" → "www.twchartered.com"), or null. */
export function normaliseDomain(input: string): string | null {
  const t = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(t)) return null;
  return t;
}

/** `TaxWise Consultants <noreply@twchartered.com>`; quotes the name when it holds special characters. */
export function formatSender(name: string, address: string): string {
  const clean = name.replace(/[\r\n]+/g, " ").replace(/["<>]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return address.trim();
  const needsQuotes = /[,;:@()[\]\\.]/.test(clean);
  return `${needsQuotes ? `"${clean}"` : clean} <${address.trim()}>`;
}

// -------------------------------------------------------------------------------------------------
// Idempotency and retries (§13: "Resend idempotency keys per message, retried 3× with backoff")
// -------------------------------------------------------------------------------------------------

export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

/** The key as stored and sent: trimmed, control characters removed, at most 256 characters; null if empty. */
export function normaliseIdempotencyKey(key: string): string | null {
  const k = key.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!k) return null;
  return k.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
}

/** Waits before retries 1, 2 and 3 (exponential, with up to 20% jitter added by the caller). */
export const RETRY_DELAYS_MS = [500, 1500, 4000] as const;

/** Resend errors worth retrying: rate limits, its own failures, timeouts and network errors. */
const RETRYABLE_NAMES = new Set(["rate_limit_exceeded", "application_error", "internal_server_error", "concurrent_idempotent_requests"]);

/** Refusals that the same request will always get again (quota used up, bad key, invalid email …). */
const FINAL_NAMES = new Set([
  "validation_error",
  "missing_required_field",
  "invalid_parameter",
  "invalid_attachment",
  "invalid_from_address",
  "invalid_access",
  "invalid_region",
  "missing_api_key",
  "invalid_api_key",
  "restricted_api_key",
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
  "invalid_idempotency_key",
  "invalid_idempotent_request",
  "not_found",
  "method_not_allowed",
  "security_error",
]);

export function isRetryableSendError(err: { name?: string | null; statusCode?: number | null } | null | undefined): boolean {
  if (!err) return false;
  if (err.name && FINAL_NAMES.has(err.name)) return false;
  if (err.name && RETRYABLE_NAMES.has(err.name)) return true;
  const code = err.statusCode ?? null;
  if (code === null) return !err.name; // a network error has neither
  return code === 408 || code === 429 || code >= 500;
}

/** A Resend refusal in plain words, for the delivery log and the person who sent it. */
export function describeSendError(err: { name?: string | null; message?: string | null; statusCode?: number | null }): string {
  const message = (err.message ?? "").trim();
  switch (err.name) {
    case "invalid_from_address":
      return "Resend refused the sender address. Check the from address in Settings → Email; it must be on the verified domain.";
    case "missing_api_key":
    case "invalid_api_key":
    case "restricted_api_key":
      return "Resend refused the API key. Check RESEND_API_KEY on this deployment.";
    case "daily_quota_exceeded":
    case "monthly_quota_exceeded":
      return "The Resend sending quota is used up. Sending resumes when the quota resets, or raise the plan in Resend.";
    case "rate_limit_exceeded":
      return "Resend asked us to slow down and the retries ran out. Try again in a minute.";
    case "invalid_attachment":
      return "Resend refused an attachment. Send it without the attachment, or from your own mailbox.";
    case "invalid_idempotent_request":
      return "This email was already sent with different content under the same reference, so it wasn't sent again.";
    case "validation_error":
      return message ? `Resend refused the email: ${message}` : "Resend refused the email as invalid.";
    default:
      return message ? `Resend couldn't send it: ${message}` : "Resend couldn't be reached.";
  }
}

/** True when Resend says the domain isn't (or is no longer) verified. */
export function isDomainNotVerifiedError(err: { name?: string | null; message?: string | null; statusCode?: number | null }): boolean {
  const m = (err.message ?? "").toLowerCase();
  return (err.statusCode === 403 || err.name === "validation_error") && /domain/.test(m) && /not verified|verify/.test(m);
}

// -------------------------------------------------------------------------------------------------
// Domain status (§5.2 domain_status "mirrors Resend, never set locally")
// -------------------------------------------------------------------------------------------------

export type DomainStatus = "not_started" | "pending" | "verified" | "failed";

/**
 * Resend's domain status → firm_settings.domain_status. Only Resend's own `verified` is Verified;
 * `partially_verified` (some records still pending) waits, `partially_failed` and `temporary_failure`
 * count as failed until Resend says otherwise.
 */
export function mapResendDomainStatus(status: string | null | undefined): DomainStatus {
  switch (status) {
    case "verified":
      return "verified";
    case "pending":
    case "partially_verified":
      return "pending";
    case "failed":
    case "partially_failed":
    case "temporary_failure":
      return "failed";
    default:
      return "not_started";
  }
}

export const DOMAIN_STATUS_LABEL: Record<DomainStatus, string> = {
  not_started: "Not set up",
  pending: "Waiting for DNS",
  verified: "Verified",
  failed: "Couldn't verify",
};

export const DOMAIN_STATUS_MEANING: Record<DomainStatus, string> = {
  not_started: "Not set up: the domain hasn't been added to Resend, so the app can't send email. Every send shows WhatsApp and Gmail instead.",
  pending: "Waiting for DNS: Resend is looking for the records below. Until it finds them, the app doesn't send email; staff use WhatsApp or Gmail.",
  verified: "Verified: Resend has confirmed the records. The app sends email from this domain.",
  failed: "Couldn't verify: Resend didn't find the records, or found different values. Check each record at your DNS provider, then check again.",
};

/** May the app send automatic email? (§7.13.5 "Until verified: automatic client emails are not attempted silently".) */
export function emailSendingReady(input: {
  apiKeyPresent: boolean;
  domainStatus: string | null | undefined;
  sendingDomain: string | null | undefined;
  fromAddress: string | null | undefined;
}): { ready: true } | { ready: false; reason: string } {
  if (!input.apiKeyPresent) return { ready: false, reason: "RESEND_API_KEY isn't set on this deployment." };
  if (input.domainStatus !== "verified") {
    return { ready: false, reason: "The sending domain isn't verified in Resend yet (Settings → Email)." };
  }
  if (!input.sendingDomain || !input.fromAddress || !fromAddressOnDomain(input.fromAddress, input.sendingDomain)) {
    return { ready: false, reason: `The from address must be on ${input.sendingDomain ?? "the verified domain"} (Settings → Email).` };
  }
  return { ready: true };
}

// -------------------------------------------------------------------------------------------------
// DNS records (Settings → Email wizard)
// -------------------------------------------------------------------------------------------------

export type DnsRecordStatus = "verified" | "pending" | "failed" | "not_started" | "recommended";

export interface DnsRecordRow {
  /** What it is for, in words. */
  purpose: string;
  type: string;
  /** The host as Resend gives it, relative to the domain ("send", "resend._domainkey"). */
  host: string;
  /** The full name ("send.twchartered.com"), for DNS providers that want it. */
  fullName: string;
  value: string;
  priority: number | null;
  ttl: string;
  status: DnsRecordStatus;
  /** Not checked by Resend (the DMARC recommendation). */
  advisory: boolean;
}

export interface ResendDnsRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  ttl?: string | null;
  status?: string | null;
  priority?: number | null;
}

function recordStatus(s: string | null | undefined): DnsRecordStatus {
  if (s === "verified") return "verified";
  if (s === "failed" || s === "temporary_failure") return "failed";
  if (s === "not_started") return "not_started";
  return "pending";
}

function purposeOf(r: ResendDnsRecord): string {
  const kind = r.record.toUpperCase();
  if (kind === "SPF" && r.type.toUpperCase() === "MX") return "Return path (MX)";
  if (kind === "SPF") return "SPF";
  if (kind === "DKIM") return "DKIM";
  if (kind === "RECEIVING") return "Inbound mail (MX)";
  if (kind === "TRACKING") return "Link tracking";
  if (kind === "TRACKINGCAA") return "Tracking certificate (CAA)";
  return r.record;
}

const PURPOSE_ORDER = ["SPF", "Return path (MX)", "DKIM", "Inbound mail (MX)", "Link tracking", "Tracking certificate (CAA)"];

/** The host relative to the domain; Resend sometimes returns "@" or the full name. */
export function relativeHost(name: string, domain: string): string {
  const n = name.trim().replace(/\.$/, "").toLowerCase();
  const d = domain.trim().toLowerCase();
  if (n === "" || n === "@" || n === d) return "@";
  if (n.endsWith(`.${d}`)) return n.slice(0, -(d.length + 1));
  return n;
}

function fullNameOf(host: string, domain: string): string {
  return host === "@" ? domain : `${host}.${domain}`;
}

/** The DMARC record we recommend (§7.13.5): monitor first (p=none) with reports to the firm's mailbox. */
export function dmarcRecommendation(domain: string, reportTo: string | null | undefined): DnsRecordRow {
  const rua = reportTo && isValidEmailAddress(reportTo) ? `; rua=mailto:${reportTo.trim()}` : "";
  return {
    purpose: "DMARC (recommended)",
    type: "TXT",
    host: "_dmarc",
    fullName: `_dmarc.${domain}`,
    value: `v=DMARC1; p=none${rua}`,
    priority: null,
    ttl: "Auto",
    status: "recommended",
    advisory: true,
  };
}

/** Resend's records as rows for the wizard, in the order to add them, plus the DMARC recommendation. */
export function dnsRecordRows(records: readonly ResendDnsRecord[], domain: string, reportTo: string | null | undefined): DnsRecordRow[] {
  const rows = records.map<DnsRecordRow>((r) => {
    const host = relativeHost(r.name, domain);
    return {
      purpose: purposeOf(r),
      type: r.type.toUpperCase(),
      host,
      fullName: fullNameOf(host, domain),
      value: r.value,
      priority: typeof r.priority === "number" ? r.priority : null,
      ttl: r.ttl?.trim() || "Auto",
      status: recordStatus(r.status),
      advisory: false,
    };
  });
  rows.sort((a, b) => {
    const ia = PURPOSE_ORDER.indexOf(a.purpose);
    const ib = PURPOSE_ORDER.indexOf(b.purpose);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return [...rows, dmarcRecommendation(domain, reportTo)];
}

// -------------------------------------------------------------------------------------------------
// Delivery status (the ledger, the webhook)
// -------------------------------------------------------------------------------------------------

export const DELIVERY_STATUSES = ["queued", "sent", "delayed", "delivered", "opened", "bounced", "complained", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export function isDeliveryStatus(v: unknown): v is DeliveryStatus {
  return typeof v === "string" && (DELIVERY_STATUSES as readonly string[]).includes(v);
}

export type DeliveryEvent = "sent" | "delayed" | "delivered" | "opened" | "clicked" | "bounced" | "complained" | "failed" | "suppressed";

/** Resend webhook event types → our events; null for events we don't track. */
export function webhookEvent(type: string): DeliveryEvent | null {
  switch (type) {
    case "email.sent":
      return "sent";
    case "email.delivery_delayed":
      return "delayed";
    case "email.delivered":
      return "delivered";
    case "email.opened":
      return "opened";
    case "email.clicked":
      return "clicked";
    case "email.bounced":
      return "bounced";
    case "email.complained":
      return "complained";
    case "email.failed":
      return "failed";
    case "email.suppressed":
      return "suppressed";
    default:
      return null;
  }
}

const PROGRESS: Record<DeliveryStatus, number> = {
  queued: 0,
  failed: 1,
  sent: 2,
  delayed: 3,
  delivered: 4,
  opened: 5,
  complained: 6,
  bounced: 7,
};

/**
 * The ledger status after an event, or null when it doesn't change. Events can arrive out of order:
 * a late "delivered" never undoes "opened", nothing undoes a bounce, a complaint comes after
 * delivery, and a click counts as an open. "failed" and "suppressed" mean Resend didn't deliver it.
 */
export function nextDeliveryStatus(current: DeliveryStatus, event: DeliveryEvent): DeliveryStatus | null {
  const target: DeliveryStatus =
    event === "clicked" ? "opened" : event === "suppressed" ? "bounced" : event === "failed" ? "failed" : event;
  if (current === "bounced") return null;
  if (target === "bounced") return "bounced";
  if (target === "failed") return current === "queued" || current === "sent" || current === "delayed" ? "failed" : null;
  if (target === "complained") return current === "complained" ? null : "complained";
  if (current === "complained") return null;
  return PROGRESS[target] > PROGRESS[current] ? target : null;
}

/** The messages.status a delivery status shows as in the Communication history (§5.9 message_status). */
export function messageStatusFor(status: DeliveryStatus): "queued" | "sent" | "delivered" | "read" | "failed" {
  switch (status) {
    case "queued":
      return "queued";
    case "sent":
    case "delayed":
      return "sent";
    case "delivered":
    case "complained":
      return "delivered";
    case "opened":
      return "read";
    case "bounced":
    case "failed":
      return "failed";
  }
}

/** Delivery-log chip for each status (label, tone, what it means). */
export const DELIVERY_STATUS_INFO: Record<DeliveryStatus, { label: string; tone: "success" | "warning" | "danger" | "info" | "muted" | "violet"; meaning: string }> = {
  queued: { label: "Queued", tone: "muted", meaning: "Queued: being handed to Resend now. If it stays here, the send was interrupted; it is retried the next time it is sent." },
  sent: { label: "Sent", tone: "info", meaning: "Sent: Resend accepted it. It changes to Delivered when the recipient's mail server takes it." },
  delayed: { label: "Delayed", tone: "warning", meaning: "Delayed: the recipient's server is slow to accept it. Resend keeps trying for up to 72 hours." },
  delivered: { label: "Delivered", tone: "success", meaning: "Delivered: the recipient's mail server accepted it." },
  opened: { label: "Opened", tone: "success", meaning: "Opened: the recipient opened it (where their mail app allows us to tell)." },
  bounced: { label: "Bounced", tone: "danger", meaning: "Bounced: the address doesn't accept mail. The contact's email is flagged as bad; use WhatsApp or check the address." },
  complained: { label: "Marked as spam", tone: "violet", meaning: "Marked as spam: the recipient reported it. Don't email them again without speaking to them first." },
  failed: { label: "Failed", tone: "danger", meaning: "Failed: Resend couldn't send it. The error says why; send it from Gmail or WhatsApp instead." },
};
