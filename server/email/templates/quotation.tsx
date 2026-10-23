import "server-only";

import type { Paise } from "@/lib/domain/money";
import { renderEmail, type DetailRow, type EmailBlock, type EmailFirm, type RenderedEmail } from "@/server/email/templates/layout";
import { day, dayTime, greeting, rupees, signOff } from "@/server/email/templates/parts";

/**
 * §10.5–§10.7 Quotation emails (§7.5.3):
 *   quotationSentEmail        covering note, total, valid-until, View quotation (/q/<token>), PDF attached
 *   quotationFollowUpEmail    day 3, 7 and 14 after sending, each shorter than the last
 *   quotationAcceptedEmail    confirmation to the client
 *   quotationDeclinedEmail    confirmation to the client
 *   quotationResponseAlertEmail  the alert to the firm (creator + Partners)
 * Money in paise (lib/domain/money); totals include GST.
 */

export interface QuotationSentData {
  recipientName: string;
  quotationNumber: string;
  totalPaise: Paise;
  /** YYYY-MM-DD */
  validUntil: string;
  /** Absolute URL of the public page /q/<token>. */
  viewUrl: string;
  /** The covering note the sender typed (plain text); a standard note when empty. */
  coveringNote?: string | null;
  preparedByName: string;
  /** A revision replaces an earlier quotation (§7.5.3 Revise). */
  revisionOf?: string | null;
}

export function quotationSentEmail(d: QuotationSentData, firm: EmailFirm): RenderedEmail {
  const note = d.coveringNote?.trim();
  const blocks: EmailBlock[] = note
    ? note
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((text) => ({ kind: "paragraph" as const, text }))
    : [{ kind: "paragraph", text: "Thank you for the opportunity to work with you. Please find our quotation for the services we discussed." }];
  if (d.revisionOf) {
    blocks.push({ kind: "callout", tone: "info", text: `This replaces our earlier quotation ${d.revisionOf}, which can no longer be accepted.` });
  }
  blocks.push(
    {
      kind: "details",
      rows: [
        { label: "Quotation", value: d.quotationNumber, mono: true },
        { label: "Total (including GST)", value: rupees(d.totalPaise), numeric: true, emphasis: true },
        { label: "Valid until", value: day(d.validUntil), numeric: true },
      ],
    },
    { kind: "button", label: "View quotation", url: d.viewUrl },
    {
      kind: "paragraph",
      text: "The quotation is also attached as a PDF. You can accept or decline it from the link above: accepting takes a minute and needs only your name.",
    },
  );
  return renderEmail(
    {
      subjectItem: `Quotation ${d.quotationNumber}${d.revisionOf ? " (revised)" : ""}`,
      preheader: `Total ${rupees(d.totalPaise)}, valid until ${day(d.validUntil)}.`,
      greeting: greeting(d.recipientName),
      blocks,
      signOff: signOff(firm, d.preparedByName),
    },
    firm,
  );
}

export interface QuotationFollowUpData {
  day: 3 | 7 | 14;
  recipientName: string;
  quotationNumber: string;
  totalPaise: Paise;
  validUntil: string;
  viewUrl: string;
  /** When it was sent (YYYY-MM-DD or a timestamp). */
  sentOn: string;
  senderName: string;
}

export function quotationFollowUpEmail(d: QuotationFollowUpData, firm: EmailFirm): RenderedEmail {
  let blocks: EmailBlock[];
  if (d.day === 3) {
    blocks = [
      {
        kind: "paragraph",
        text: `Following up on our quotation ${d.quotationNumber}, sent on ${day(d.sentOn)}. If you have any questions about the scope or the fees, reply to this email${firm.phone ? ` or call us on ${firm.phone}` : ""}; we're happy to walk you through it.`,
      },
      {
        kind: "details",
        rows: [
          { label: "Total (including GST)", value: rupees(d.totalPaise), numeric: true, emphasis: true },
          { label: "Valid until", value: day(d.validUntil), numeric: true },
        ],
      },
      { kind: "button", label: "View quotation", url: d.viewUrl },
    ];
  } else if (d.day === 7) {
    blocks = [
      { kind: "paragraph", text: `A reminder that quotation ${d.quotationNumber} (${rupees(d.totalPaise)}) is valid until ${day(d.validUntil)}.` },
      { kind: "button", label: "View quotation", url: d.viewUrl },
    ];
  } else {
    blocks = [
      { kind: "paragraph", text: `Quotation ${d.quotationNumber} is valid until ${day(d.validUntil)}.` },
      { kind: "button", label: "View quotation", url: d.viewUrl },
    ];
  }
  return renderEmail(
    {
      subjectItem: d.day === 14 ? `Quotation ${d.quotationNumber}: valid until ${day(d.validUntil)}` : `Following up on quotation ${d.quotationNumber}`,
      preheader: `Valid until ${day(d.validUntil)}.`,
      greeting: greeting(d.recipientName),
      blocks,
      signOff: signOff(firm, d.senderName),
    },
    firm,
  );
}

export interface QuotationAcceptedData {
  recipientName: string;
  quotationNumber: string;
  totalPaise: Paise;
  acceptedByName: string;
  /** Timestamp of the acceptance. */
  acceptedAt: string;
  /** Who will contact them to start onboarding. */
  ownerName: string;
}

export function quotationAcceptedEmail(d: QuotationAcceptedData, firm: EmailFirm): RenderedEmail {
  return renderEmail(
    {
      subjectItem: `Thank you for accepting quotation ${d.quotationNumber}`,
      preheader: `${d.ownerName} will be in touch to get started.`,
      greeting: greeting(d.recipientName),
      blocks: [
        { kind: "paragraph", text: `Thank you. We've recorded your acceptance of quotation ${d.quotationNumber}.` },
        {
          kind: "details",
          rows: [
            { label: "Quotation", value: d.quotationNumber, mono: true },
            { label: "Total (including GST)", value: rupees(d.totalPaise), numeric: true },
            { label: "Accepted electronically by", value: d.acceptedByName },
            { label: "Accepted on", value: dayTime(d.acceptedAt), numeric: true },
          ],
        },
        {
          kind: "paragraph",
          text: `${d.ownerName} will be in touch to get started: we'll ask for your KYC documents, send our engagement letter and set up your client portal.`,
        },
      ],
      signOff: signOff(firm, d.ownerName),
    },
    firm,
  );
}

export interface QuotationDeclinedData {
  recipientName: string;
  quotationNumber: string;
  reason?: string | null;
  senderName?: string | null;
}

export function quotationDeclinedEmail(d: QuotationDeclinedData, firm: EmailFirm): RenderedEmail {
  const reason = d.reason?.trim();
  return renderEmail(
    {
      subjectItem: `Quotation ${d.quotationNumber} declined`,
      preheader: "Thank you for letting us know.",
      greeting: greeting(d.recipientName),
      blocks: [
        { kind: "paragraph", text: `We've recorded that you declined quotation ${d.quotationNumber}. Thank you for letting us know.` },
        ...(reason ? [{ kind: "details" as const, rows: [{ label: "Your reason", value: reason }] }] : []),
        { kind: "paragraph", text: "If your needs change, reply to this email and we'll prepare an updated quotation." },
      ],
      signOff: signOff(firm, d.senderName),
    },
    firm,
  );
}

export interface QuotationResponseAlertData {
  recipientName: string;
  response: "accepted" | "declined";
  quotationNumber: string;
  clientName: string;
  totalPaise: Paise;
  /** Timestamp of the response. */
  respondedAt: string;
  acceptedByName?: string | null;
  reason?: string | null;
  note?: string | null;
  /** Absolute URL of /quotations/<id>. */
  quotationUrl: string;
}

export function quotationResponseAlertEmail(d: QuotationResponseAlertData, firm: EmailFirm): RenderedEmail {
  const accepted = d.response === "accepted";
  const rows: DetailRow[] = [
    { label: "Client", value: d.clientName },
    { label: "Quotation", value: d.quotationNumber, mono: true },
    { label: "Total (including GST)", value: rupees(d.totalPaise), numeric: true, emphasis: true },
    { label: accepted ? "Accepted on" : "Declined on", value: dayTime(d.respondedAt), numeric: true },
  ];
  if (accepted && d.acceptedByName) rows.push({ label: "Accepted by", value: d.acceptedByName });
  if (!accepted && d.reason?.trim()) rows.push({ label: "Reason", value: d.reason.trim() });
  if (d.note?.trim()) rows.push({ label: "Their note", value: d.note.trim() });
  return renderEmail(
    {
      subjectItem: `Quotation ${d.quotationNumber} ${accepted ? "accepted" : "declined"} by ${d.clientName}`,
      preheader: accepted ? "Next: create the client from the quotation." : "The lead can be followed up or marked lost.",
      greeting: greeting(d.recipientName),
      blocks: [
        {
          kind: "paragraph",
          text: accepted
            ? `${d.clientName} accepted quotation ${d.quotationNumber}. The lead has moved to Won; create the client from the quotation to start onboarding.`
            : `${d.clientName} declined quotation ${d.quotationNumber}.`,
        },
        { kind: "details", rows },
        { kind: "button", label: "Open the quotation", url: d.quotationUrl },
      ],
    },
    firm,
  );
}
