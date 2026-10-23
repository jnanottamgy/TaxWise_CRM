import type { EngagementStatus, GstRegistration, ServiceType } from "@/lib/domain/enums";
import type { KycCheck } from "@/lib/domain/ceiling";
import { diffDays, type DateString } from "@/lib/domain/fy";
import { formatDate } from "@/lib/format";

/**
 * The Client 360 warnings strip (§7.3.3): no email/phone; registered (or on GST returns) but GSTIN
 * missing; KYC incomplete for audit clients; engagement letter missing for this FY (Partner/Manager
 * only: the letter is money-side, §4.6); DSC expiring; portal invite pending. Pure and client-safe;
 * the page loads the facts under the viewer's RLS and passes them in.
 */

export type WarningId = "unreachable" | "gstin_missing" | "kyc" | "engagement_letter" | "dsc" | "portal_invite";

export interface ClientWarning {
  id: WarningId;
  /** danger only for something already past (an expired DSC); warning otherwise. */
  tone: "warning" | "danger";
  message: string;
  /** Where to fix it: a tab of this page (`?tab=…`) or another page. */
  action?: { label: string; href: string };
}

export interface WarningFacts {
  clientId: string;
  client: {
    email: string | null;
    phone: string | null;
    whatsapp: string | null;
    gst_registration: GstRegistration;
    gstin: string | null;
    portal_user_id: string | null;
    portal_invited_at: string | null;
    portal_last_seen_at: string | null;
  };
  contacts: ReadonlyArray<{ email: string | null; phone: string | null; whatsapp: string | null }>;
  activeServices: readonly ServiceType[];
  /** kycCompleteness for the client's KYC record; only looked at when an audit service is active. */
  kyc: KycCheck | null;
  /**
   * The engagement letter for `fy`: null when not applicable or not loaded (Employees never get it),
   * `{ status: null }` when there is no letter for that FY.
   */
  engagementLetter: { fy: string; status: EngagementStatus | null } | null;
  dsc: ReadonlyArray<{ holder_name: string; expiry_date: DateString; status: string }>;
  today: DateString;
  /** DSC expiry warning window (§7.15.1 alerts at 30, 15 and 7 days). */
  dscWarnDays?: number;
}

const blank = (v: string | null | undefined) => !v || v.trim() === "";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function clientWarnings(f: WarningFacts): ClientWarning[] {
  const out: ClientWarning[] = [];
  const base = `/clients/${f.clientId}`;

  // 1. Unreachable: no email, phone or WhatsApp on the client or any contact (§7.3.1 "unreachable").
  const reachable =
    !blank(f.client.email) ||
    !blank(f.client.phone) ||
    !blank(f.client.whatsapp) ||
    f.contacts.some((c) => !blank(c.email) || !blank(c.phone) || !blank(c.whatsapp));
  if (!reachable) {
    out.push({
      id: "unreachable",
      tone: "warning",
      message: "No email or phone for this client or any of its contacts, so reminders can't reach them.",
      action: { label: "Add a contact", href: `${base}?tab=profile#contacts` },
    });
  }

  // 2. GSTIN missing: registered, or GST returns are an active service, but no GSTIN is recorded.
  if (blank(f.client.gstin)) {
    if (f.client.gst_registration === "registered") {
      out.push({
        id: "gstin_missing",
        tone: "warning",
        message: "Registered for GST but no GSTIN is recorded. Invoices to this client are blocked until it is added.",
        action: { label: "Add the GSTIN", href: `${base}?tab=profile#master-data` },
      });
    } else if (f.activeServices.includes("gst")) {
      out.push({
        id: "gstin_missing",
        tone: "warning",
        message:
          f.client.gst_registration === "unknown"
            ? "GST returns are an active service, but the GST registration isn't confirmed and no GSTIN is recorded."
            : "GST returns are an active service, but the client is recorded as not registered for GST.",
        action: { label: "Update tax registrations", href: `${base}?tab=profile#master-data` },
      });
    }
  }

  // 3. KYC incomplete, for audit clients (§6.8: mandatory for attest engagements).
  if (f.activeServices.includes("audit") && f.kyc && !f.kyc.current) {
    const message = !f.kyc.complete
      ? `KYC is incomplete for this audit client: ${f.kyc.missing.join(", ")} missing. The audit can't move past acceptance until it is done.`
      : "KYC needs its annual re-confirmation before the audit moves past acceptance.";
    out.push({ id: "kyc", tone: "warning", message, action: { label: "Complete KYC", href: `${base}?tab=profile#kyc` } });
  }

  // 4. Engagement letter for this FY (Partner/Manager only).
  if (f.engagementLetter && f.activeServices.length > 0) {
    const { fy, status } = f.engagementLetter;
    let message: string | null = null;
    if (status === null) message = `No engagement letter for FY ${fy}.`;
    else if (status === "draft") message = `The FY ${fy} engagement letter is still a draft. Issue it to the client.`;
    else if (status === "declined") message = `The client declined the FY ${fy} engagement letter.`;
    else if (status === "expired") message = `The FY ${fy} engagement letter has expired. Renew it.`;
    if (message) out.push({ id: "engagement_letter", tone: "warning", message, action: { label: "Open engagement", href: `${base}?tab=engagement` } });
  }

  // 5. DSC expiring (or already expired but still marked active).
  const window = f.dscWarnDays ?? 30;
  const dscs = f.dsc
    .filter((d) => d.status === "active")
    .map((d) => ({ ...d, days: diffDays(d.expiry_date, f.today) }))
    .filter((d) => d.days <= window)
    .sort((a, b) => a.days - b.days);
  if (dscs.length > 0) {
    const first = dscs[0];
    const more = dscs.length > 1 ? ` (and ${plural(dscs.length - 1, "other")})` : "";
    const message =
      first.days < 0
        ? `The DSC of ${first.holder_name} expired on ${formatDate(first.expiry_date)}${more}. Renew it before the next filing that needs it.`
        : first.days === 0
          ? `The DSC of ${first.holder_name} expires today${more}.`
          : `The DSC of ${first.holder_name} expires on ${formatDate(first.expiry_date)}, in ${plural(first.days, "day")}${more}.`;
    out.push({ id: "dsc", tone: first.days < 0 ? "danger" : "warning", message, action: { label: "Open registers", href: `${base}?tab=registers` } });
  }

  // 6. Portal invite pending: linked and invited, but the client has never signed in.
  if (f.client.portal_user_id && f.client.portal_invited_at && !f.client.portal_last_seen_at) {
    out.push({
      id: "portal_invite",
      tone: "warning",
      message: `The portal invite sent on ${formatDate(f.client.portal_invited_at)} hasn't been used yet.`,
      action: { label: "Resend invite", href: `${base}#portal-access` },
    });
  }

  return out;
}
