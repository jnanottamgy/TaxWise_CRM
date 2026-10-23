import "server-only";

import { relativeDue } from "@/lib/format";
import { renderEmail, type EmailBlock, type EmailFirm, type RenderedEmail } from "@/server/email/templates/layout";
import { day, greeting, signOff } from "@/server/email/templates/parts";

/**
 * §10.12 Compliance reminder (§8 09:00 Reminders, §7.13.2): what's due, when, and what we need from
 * the client, sent to the contact who handles that service (pickContactForService in
 * lib/domain/messaging.ts chooses them).
 */

export interface ComplianceReminderData {
  contactName: string;
  clientName: string;
  /** "GSTR-3B", "TDS return (Form 26Q)", "Advance tax instalment". */
  complianceLabel: string;
  /** "September 2026", "Q2 2026-27", "AY 2026-27". */
  period: string;
  /** What it is, in plain words ("your monthly GST summary return"). */
  explanation?: string | null;
  /** YYYY-MM-DD */
  dueDate: string;
  /** Today in IST (todayIST()), for "in 5 days". */
  today: string;
  /** What we still need from the client; empty when we have everything. */
  whatWeNeed: string[];
  /** Absolute URL of the portal (documents), when they have a login. */
  portalUrl?: string | null;
  ownerName: string;
}

export function complianceReminderEmail(d: ComplianceReminderData, firm: EmailFirm): RenderedEmail {
  const rel = relativeDue(d.dueDate, d.today);
  const when = rel.days < 0 ? `was due on ${day(d.dueDate)}` : `is due on ${day(d.dueDate)}, ${rel.text}`;
  const what = d.explanation?.trim() ? ` (${d.explanation.trim()})` : "";
  const blocks: EmailBlock[] = [{ kind: "paragraph", text: `${d.complianceLabel} for ${d.period}${what} for ${d.clientName} ${when}.` }];
  if (d.whatWeNeed.length) {
    blocks.push({ kind: "list", title: "What we need from you", items: d.whatWeNeed.map((t) => ({ title: t })) });
    blocks.push({
      kind: "paragraph",
      text: "The sooner we have these, the more time we have to check them before the due date. Late filing attracts late fees and interest that we can't waive.",
    });
    if (d.portalUrl) blocks.push({ kind: "button", label: "Upload in the client portal", url: d.portalUrl });
    else blocks.push({ kind: "paragraph", text: `You can reply to this email with the documents attached, or send them to ${d.ownerName}.` });
  } else {
    blocks.push({ kind: "paragraph", text: "We have what we need for now, so there is nothing for you to do. We'll confirm once it's filed." });
  }
  return renderEmail(
    {
      subjectItem: `${d.complianceLabel} for ${d.period} is due on ${day(d.dueDate)}`,
      preheader: d.whatWeNeed.length ? `What we need from you: ${d.whatWeNeed.slice(0, 3).join(", ")}.` : "Nothing needed from you for now.",
      greeting: greeting(d.contactName),
      blocks,
      signOff: signOff(firm, d.ownerName),
    },
    firm,
  );
}
