import "server-only";

import { renderEmail, type DetailRow, type EmailBlock, type EmailFirm, type RenderedEmail } from "@/server/email/templates/layout";
import { dayTime, greeting, signOff } from "@/server/email/templates/parts";

/**
 * Emails that aren't one of the client letters in §10:
 *   notificationEmail  an in-app notification for someone who asked for it by email (§7.17, §9)
 *   noticeEmail        a short staff notice with an optional detail table and one button
 *                      ("Also email the cover person", §4.7; access reviews; job alerts)
 *   testEmail          Settings → Email → Send test email (§7.13.5)
 */

export interface NotificationEmailData {
  recipientName: string;
  title: string;
  body: string;
  /** Absolute URL of the record. */
  linkUrl: string;
}

export function notificationEmail(d: NotificationEmailData, firm: EmailFirm): RenderedEmail {
  return renderEmail(
    {
      subjectItem: d.title,
      preheader: d.body.slice(0, 140),
      greeting: greeting(d.recipientName),
      blocks: [
        { kind: "paragraph", text: d.body },
        { kind: "button", label: "Open in TaxWise", url: d.linkUrl },
        { kind: "small", text: "You get this email because email is on for this kind of notification. Change it in Profile → Notifications." },
      ],
    },
    firm,
  );
}

export interface NoticeEmailData {
  recipientName: string;
  /** The subject item and the first line. */
  title: string;
  paragraphs: string[];
  details?: DetailRow[] | null;
  button?: { label: string; url: string } | null;
  senderName?: string | null;
}

export function noticeEmail(d: NoticeEmailData, firm: EmailFirm): RenderedEmail {
  const blocks: EmailBlock[] = d.paragraphs.filter((p) => p.trim()).map((text) => ({ kind: "paragraph" as const, text }));
  if (d.details?.length) blocks.push({ kind: "details", rows: d.details });
  if (d.button) blocks.push({ kind: "button", label: d.button.label, url: d.button.url });
  return renderEmail(
    {
      subjectItem: d.title,
      preheader: d.paragraphs[0]?.slice(0, 140) ?? d.title,
      greeting: greeting(d.recipientName),
      blocks,
      signOff: signOff(firm, d.senderName),
    },
    firm,
  );
}

export interface TestEmailData {
  recipientName: string;
  sentAt: Date;
  from: string;
  replyTo: string;
  domain: string;
}

export function testEmail(d: TestEmailData, firm: EmailFirm): RenderedEmail {
  return renderEmail(
    {
      subjectItem: "Test email",
      preheader: `Email from ${d.domain} is working.`,
      greeting: greeting(d.recipientName),
      blocks: [
        { kind: "paragraph", text: `This is the test email you sent from Settings → Email. If you're reading it, email from ${d.domain} works.` },
        {
          kind: "details",
          rows: [
            { label: "From", value: d.from },
            { label: "Replies go to", value: d.replyTo },
            { label: "Sent at", value: dayTime(d.sentAt), numeric: true },
          ],
        },
        {
          kind: "small",
          text: "In Settings → Email the delivery log shows this message as Sent, then Delivered once your mail server accepts it. If it landed in spam, mark it as not spam and check the DMARC record.",
        },
      ],
    },
    firm,
  );
}
