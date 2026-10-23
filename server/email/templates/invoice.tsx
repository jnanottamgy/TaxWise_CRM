import "server-only";

import type { Paise } from "@/lib/domain/money";
import { renderEmail, type DetailRow, type EmailBlock, type EmailFirm, type RenderedEmail } from "@/server/email/templates/layout";
import { bankRows, day, greeting, rupees, signOff, type PayingDetails } from "@/server/email/templates/parts";

/**
 * §10.8 Invoice (§7.9.3 Issue/Send): summary, due date, View & pay (the portal invoice page), the
 * PDF attached, and bank and UPI details. Subject: "TaxWise Consultants | Invoice TW/26-27/0042 for
 * September fees" (§10).
 */

export interface InvoiceEmailData extends PayingDetails {
  recipientName: string;
  clientName: string;
  invoiceNumber: string;
  /** YYYY-MM-DD */
  invoiceDate: string;
  dueDate: string;
  /** The billing period label ("September fees", "Q2 retainer"). */
  periodLabel?: string | null;
  totalPaise: Paise;
  /** What is still to pay (after part payments); defaults to the total. */
  outstandingPaise?: Paise | null;
  /** Absolute URL of the portal invoice page. */
  viewPayUrl: string;
  note?: string | null;
  senderName?: string | null;
}

export function invoiceEmail(d: InvoiceEmailData, firm: EmailFirm): RenderedEmail {
  const due = d.outstandingPaise ?? d.totalPaise;
  const period = d.periodLabel?.trim();
  const rows: DetailRow[] = [
    { label: "Invoice", value: d.invoiceNumber, mono: true },
    { label: "Invoice date", value: day(d.invoiceDate), numeric: true },
  ];
  if (period) rows.push({ label: "For", value: period });
  rows.push({ label: "Invoice total", value: rupees(d.totalPaise), numeric: true });
  if (due !== d.totalPaise) rows.push({ label: "Still to pay", value: rupees(due), numeric: true, emphasis: true });
  rows.push({ label: "Due by", value: day(d.dueDate), numeric: true, emphasis: due === d.totalPaise });

  const blocks: EmailBlock[] = [
    {
      kind: "paragraph",
      text: `Please find attached our invoice ${d.invoiceNumber}${period ? ` for ${period}` : ""} to ${d.clientName}.`,
    },
    { kind: "details", rows },
  ];
  if (d.note?.trim()) blocks.push({ kind: "paragraph", text: d.note.trim() });
  blocks.push({ kind: "button", label: "View & pay", url: d.viewPayUrl });
  const bank = bankRows(d.bank);
  if (bank) blocks.push({ kind: "details", title: "Pay by bank transfer (NEFT / IMPS / RTGS)", rows: bank });
  if (d.upi) {
    blocks.push({
      kind: "details",
      title: "Or pay by UPI",
      rows: [
        { label: "UPI ID", value: d.upi.id, mono: true },
        ...(d.upi.payeeName ? [{ label: "Payee", value: d.upi.payeeName }] : []),
      ],
    });
  }
  blocks.push({
    kind: "small",
    text: `Please quote ${d.invoiceNumber} with your payment. If you deduct TDS, send us the TDS certificate (Form 16A) when it's issued so we can match it to this invoice.`,
  });

  return renderEmail(
    {
      subjectItem: `Invoice ${d.invoiceNumber}${period ? ` for ${period}` : ""}`,
      preheader: `${rupees(due)} due by ${day(d.dueDate)}.`,
      greeting: greeting(d.recipientName),
      blocks,
      signOff: signOff(firm, d.senderName),
    },
    firm,
  );
}
