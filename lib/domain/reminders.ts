/**
 * The 09:00 reminders job's rules (§8 "Reminders", §7.7, §7.14, §7.3.4), pure and client-safe:
 *   - which compliance deadlines are due a reminder today (per their `reminder_days`, once, §5.6);
 *   - which service a compliance type belongs to, so the reminder goes to the contact who handles
 *     it (§10.12, §7.13.2 "the handles field picks the right contact");
 *   - how a client is notified: its own "Notify the client by" channels, or the firm's defaults
 *     (§7.3.2 step 5, Settings → Reminders), and never while On hold or Inactive (§3.6, §7.3.4);
 *   - when a document's expiry or renewal date is close enough to flag (§7.14).
 */

import { addDays, compareDates, type DateString } from "@/lib/domain/fy";
import type { ClientStatus, ComplianceStatus, ComplianceType, ServiceType } from "@/lib/domain/enums";

export const CLIENT_CHANNELS = ["email", "whatsapp", "portal"] as const;
export type ClientChannel = (typeof CLIENT_CHANNELS)[number];

/** How many days ahead a document's expiry or renewal date is flagged to the client's owner. */
export const DOCUMENT_EXPIRY_LEAD_DAYS = 30;

/** The service a compliance deadline belongs to (null for a custom date). */
export function complianceServiceType(type: ComplianceType | string): ServiceType | null {
  switch (type) {
    case "gstr_1":
    case "gstr_3b":
      return "gst";
    case "tds":
      return "tds";
    case "itr":
    case "advance_tax":
      return "income_tax";
    case "roc":
      return "company_law";
    case "pf_esic":
    case "pt":
      return "payroll";
    case "audit":
      return "audit";
    default:
      return null;
  }
}

/**
 * True when a deadline should be reminded about today: still pending, not reminded yet for this
 * date (a moved date clears `reminder_sent_at`), and today is within `reminderDays` of the due date
 * but not past it (an overdue deadline is the escalation's and the overdue lists' business).
 */
export function isComplianceReminderDue(e: { status: ComplianceStatus; dueDate: DateString; reminderDays: number; reminderSentAt: string | null }, today: DateString): boolean {
  if (e.status !== "pending" || e.reminderSentAt) return false;
  if (compareDates(today, e.dueDate) > 0) return false;
  const lead = Math.max(0, Math.floor(e.reminderDays));
  return compareDates(today, addDays(e.dueDate, -lead)) >= 0;
}

/** The first day a deadline enters its reminder window (for the job's query). */
export function reminderWindowStart(dueDate: DateString, reminderDays: number): DateString {
  return addDays(dueDate, -Math.max(0, Math.floor(reminderDays)));
}

/** The client's own channels, or the firm's defaults when it has none (an empty list means "firm defaults"). */
export function clientChannels(own: readonly string[] | null | undefined, firmDefaults: readonly string[] | null | undefined): ClientChannel[] {
  const pick = (list: readonly string[] | null | undefined) => CLIENT_CHANNELS.filter((c) => (list ?? []).includes(c));
  const mine = pick(own);
  return mine.length ? mine : pick(firmDefaults);
}

/** Reminders to the client pause while it is On hold or Inactive, and stop once it is in the recycle bin. */
export function clientRemindersPaused(c: { status: ClientStatus; deletedAt: string | null }): boolean {
  return Boolean(c.deletedAt) || c.status === "on_hold" || c.status === "inactive";
}

/**
 * The date of a document to flag today, if any: its expiry date or, failing that, its renewal date,
 * when it falls between today and `lead` days ahead.
 */
export function documentDateToFlag(d: { expiryDate: DateString | null; renewalDate: DateString | null }, today: DateString, lead = DOCUMENT_EXPIRY_LEAD_DAYS): { kind: "expiry" | "renewal"; date: DateString } | null {
  const horizon = addDays(today, lead);
  const within = (x: DateString | null) => !!x && compareDates(x, today) >= 0 && compareDates(x, horizon) <= 0;
  if (within(d.expiryDate)) return { kind: "expiry", date: d.expiryDate as DateString };
  if (within(d.renewalDate)) return { kind: "renewal", date: d.renewalDate as DateString };
  return null;
}
