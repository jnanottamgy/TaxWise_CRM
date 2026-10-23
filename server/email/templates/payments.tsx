import "server-only";

import type { Paise } from "@/lib/domain/money";
import { renderEmail, type DetailRow, type EmailBlock, type EmailFirm, type RenderedEmail } from "@/server/email/templates/layout";
import { bankRows, day, greeting, rupees, signOff, type PayingDetails } from "@/server/email/templates/parts";

/**
 * §10.9 Payment receipt (§7.9.4) and §10.10 Payment reminders (§7.9.5): 3 days before the due date
 * (gentle), then 1, 7 and 15 days after (firmer each time). Never sent for Draft, Disputed, Waived
 * or Paid invoices or clients On hold: that is the reminder job's rule, not the template's.
 */

export interface PaymentReceiptData {
  recipientName: string;
  receiptNumber: string;
  invoiceNumber: string;
  /** YYYY-MM-DD */
  paymentDate: string;
  amountReceivedPaise: Paise;
  tdsPaise?: Paise | null;
  /** "Bank transfer", "UPI", "Cheque" … */
  methodLabel: string;
  reference?: string | null;
  /** What remains on the invoice after this receipt. */
  balancePaise: Paise;
  senderName?: string | null;
}

export function paymentReceiptEmail(d: PaymentReceiptData, firm: EmailFirm): RenderedEmail {
  const rows: DetailRow[] = [
    { label: "Receipt", value: d.receiptNumber, mono: true },
    { label: "Against invoice", value: d.invoiceNumber, mono: true },
    { label: "Payment date", value: day(d.paymentDate), numeric: true },
    { label: "Amount received", value: rupees(d.amountReceivedPaise), numeric: true, emphasis: true },
  ];
  if (d.tdsPaise && d.tdsPaise > 0) rows.push({ label: "TDS deducted", value: rupees(d.tdsPaise), numeric: true });
  rows.push({ label: "Paid by", value: d.reference?.trim() ? `${d.methodLabel} · ${d.reference.trim()}` : d.methodLabel });
  rows.push(
    d.balancePaise > 0
      ? { label: "Still to pay on this invoice", value: rupees(d.balancePaise), numeric: true }
      : { label: "Still to pay on this invoice", value: "Nothing: this invoice is fully paid" },
  );
  const blocks: EmailBlock[] = [
    { kind: "paragraph", text: `Thank you for your payment. Your receipt ${d.receiptNumber} is attached.` },
    { kind: "details", rows },
  ];
  if (d.tdsPaise && d.tdsPaise > 0) {
    blocks.push({ kind: "small", text: "Please send us the TDS certificate (Form 16A) for the TDS deducted once it's issued, so we can claim the credit." });
  }
  return renderEmail(
    {
      subjectItem: `Receipt ${d.receiptNumber} for invoice ${d.invoiceNumber}`,
      preheader: `We've received ${rupees(d.amountReceivedPaise)}. Thank you.`,
      greeting: greeting(d.recipientName),
      blocks,
      signOff: signOff(firm, d.senderName),
    },
    firm,
  );
}

export interface PaymentReminderData extends PayingDetails {
  /** before: the gentle reminder before the due date; after: 1, 7 and 15 days after it. */
  stage: "before" | "after";
  /** Days before the due date (stage before) or days overdue (stage after). */
  days: number;
  recipientName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  outstandingPaise: Paise;
  viewPayUrl: string;
  senderName?: string | null;
}

/** How firm the reminder sounds, from the days overdue. Exported for tests. */
export function reminderTone(stage: "before" | "after", days: number): "gentle" | "prompt" | "firm" | "final" {
  if (stage === "before") return "gentle";
  if (days <= 1) return "prompt";
  if (days < 15) return "firm";
  return "final";
}

export function paymentReminderEmail(d: PaymentReminderData, firm: EmailFirm): RenderedEmail {
  const tone = reminderTone(d.stage, d.days);
  const amount = rupees(d.outstandingPaise);
  const due = day(d.dueDate);
  let subjectItem: string;
  let opening: string;
  let after: string | null = null;
  switch (tone) {
    case "gentle":
      subjectItem = `Invoice ${d.invoiceNumber} is due on ${due}`;
      opening = `A friendly reminder that our invoice ${d.invoiceNumber} for ${amount} is due on ${due}${d.days > 0 ? `, in ${d.days} ${d.days === 1 ? "day" : "days"}` : ""}.`;
      after = "If you've already paid, thank you, and please ignore this email.";
      break;
    case "prompt":
      subjectItem = `Invoice ${d.invoiceNumber} was due on ${due}`;
      opening = `Our invoice ${d.invoiceNumber} for ${amount} was due on ${due}. If the payment is already on its way, thank you. If not, you can pay from the link below.`;
      break;
    case "firm":
      subjectItem = `Invoice ${d.invoiceNumber} is ${d.days} days overdue`;
      opening = `Invoice ${d.invoiceNumber} for ${amount} was due on ${due} and is now ${d.days} days overdue. Please arrange the payment this week, or tell us if anything on the invoice needs our attention.`;
      break;
    case "final":
      subjectItem = `Invoice ${d.invoiceNumber} is ${d.days} days overdue`;
      opening = `Invoice ${d.invoiceNumber} for ${amount} is now ${d.days} days past its due date of ${due}. Please pay it at the earliest${firm.phone ? `, or call us on ${firm.phone} if there is a problem with it` : ", or reply to tell us if there is a problem with it"}.`;
      break;
  }
  const blocks: EmailBlock[] = [
    { kind: "paragraph", text: opening },
    {
      kind: "details",
      rows: [
        { label: "Invoice", value: d.invoiceNumber, mono: true },
        { label: "Invoice date", value: day(d.invoiceDate), numeric: true },
        { label: "Due date", value: due, numeric: true },
        { label: "Amount due", value: amount, numeric: true, emphasis: true },
      ],
    },
    { kind: "button", label: "View & pay", url: d.viewPayUrl },
  ];
  const bank = bankRows(d.bank);
  if (bank && tone !== "gentle") blocks.push({ kind: "details", title: "Bank transfer", rows: bank });
  if (d.upi && tone !== "gentle") blocks.push({ kind: "details", title: "UPI", rows: [{ label: "UPI ID", value: d.upi.id, mono: true }] });
  if (after) blocks.push({ kind: "small", text: after });
  else blocks.push({ kind: "small", text: "If you've paid in the last day or two, thank you: please reply with the payment reference so we can match it." });

  return renderEmail(
    {
      subjectItem,
      preheader: `${amount} ${tone === "gentle" ? "due" : "was due"} on ${due}.`,
      greeting: greeting(d.recipientName),
      blocks,
      signOff: signOff(firm, d.senderName),
    },
    firm,
  );
}
