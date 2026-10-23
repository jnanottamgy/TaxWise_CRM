import "server-only";

import type { Paise } from "@/lib/domain/money";
import { renderEmail, type DetailRow, type EmailBlock, type EmailFirm, type RenderedEmail } from "@/server/email/templates/layout";
import { day, greeting, rupees } from "@/server/email/templates/parts";

/**
 * §10.14 Partner daily digest (§7.17, §8 08:00): today's deadlines, approvals waiting, overdue
 * receivables and unassigned work, with a link to each list. Optional (Settings → Reminders, and
 * each Partner's own notification preference). Partners only: it carries receivables.
 */

export interface DigestDeadline {
  clientName: string;
  label: string;
  /** Who's on it. */
  assignee?: string | null;
}

export interface DigestReceivable {
  clientName: string;
  invoiceNumber: string;
  outstandingPaise: Paise;
  daysOverdue: number;
}

export interface DigestTask {
  title: string;
  clientName: string;
  /** YYYY-MM-DD */
  dueDate?: string | null;
}

export interface PartnerDigestData {
  partnerName: string;
  /** YYYY-MM-DD (IST) */
  date: string;
  deadlines: { total: number; items: DigestDeadline[] };
  approvals: { invoices: number; quotations: number; leave: number; dataRequests: number };
  overdue: { count: number; totalPaise: Paise; top: DigestReceivable[] };
  unassigned: { count: number; top: DigestTask[] };
  /** Absolute URLs. */
  links: { dashboard: string; deadlines: string; approvals: string; receivables: string; unassigned: string };
}

const MAX_ROWS = 5;

export function partnerDigestEmail(d: PartnerDigestData, firm: EmailFirm): RenderedEmail {
  const blocks: EmailBlock[] = [{ kind: "paragraph", text: `Here is what needs you today, ${day(d.date)}.` }];

  // Due today
  blocks.push({ kind: "subheading", text: `Due today: ${d.deadlines.total}` });
  if (d.deadlines.items.length) {
    blocks.push({
      kind: "list",
      items: d.deadlines.items.slice(0, MAX_ROWS).map((it) => ({ title: `${it.label} · ${it.clientName}`, detail: it.assignee ? `With ${it.assignee}` : "Not assigned" })),
    });
    if (d.deadlines.total > MAX_ROWS) blocks.push({ kind: "link", label: `And ${d.deadlines.total - MAX_ROWS} more:`, url: d.links.deadlines });
  } else {
    blocks.push({ kind: "small", text: "Nothing is due today." });
  }

  // Approvals
  const waiting = d.approvals.invoices + d.approvals.quotations + d.approvals.leave + d.approvals.dataRequests;
  blocks.push({ kind: "subheading", text: `Waiting for approval: ${waiting}` });
  if (waiting) {
    const rows: DetailRow[] = [];
    if (d.approvals.invoices) rows.push({ label: "Invoices", value: String(d.approvals.invoices), numeric: true });
    if (d.approvals.quotations) rows.push({ label: "Quotations", value: String(d.approvals.quotations), numeric: true });
    if (d.approvals.leave) rows.push({ label: "Leave requests", value: String(d.approvals.leave), numeric: true });
    if (d.approvals.dataRequests) rows.push({ label: "Data requests (DPDP)", value: String(d.approvals.dataRequests), numeric: true });
    blocks.push({ kind: "details", rows }, { kind: "link", label: "Review them:", url: d.links.approvals });
  } else {
    blocks.push({ kind: "small", text: "Nothing is waiting for you." });
  }

  // Overdue receivables
  blocks.push({ kind: "subheading", text: `Overdue receivables: ${d.overdue.count}` });
  if (d.overdue.count) {
    blocks.push({
      kind: "details",
      rows: [
        { label: "Total overdue", value: rupees(d.overdue.totalPaise), numeric: true, emphasis: true },
        ...d.overdue.top.slice(0, MAX_ROWS).map<DetailRow>((r) => ({
          label: `${r.clientName} · ${r.invoiceNumber}`,
          value: `${rupees(r.outstandingPaise)}\n${r.daysOverdue} ${r.daysOverdue === 1 ? "day" : "days"} overdue`,
          numeric: true,
        })),
      ],
    });
    blocks.push({ kind: "link", label: "All overdue invoices:", url: d.links.receivables });
  } else {
    blocks.push({ kind: "small", text: "No invoice is overdue." });
  }

  // Unassigned work
  blocks.push({ kind: "subheading", text: `Unassigned work: ${d.unassigned.count}` });
  if (d.unassigned.count) {
    blocks.push({
      kind: "list",
      items: d.unassigned.top.slice(0, MAX_ROWS).map((t) => ({ title: `${t.title} · ${t.clientName}`, detail: t.dueDate ? `Due ${day(t.dueDate)}` : null })),
    });
    blocks.push({ kind: "link", label: "Assign them:", url: d.links.unassigned });
  } else {
    blocks.push({ kind: "small", text: "Every open task has someone on it." });
  }

  blocks.push(
    { kind: "button", label: "Open the dashboard", url: d.links.dashboard },
    { kind: "small", text: "You get this digest because it's on in Settings → Reminders and in your Profile → Notifications." },
  );

  return renderEmail(
    {
      subjectItem: `Partner digest for ${day(d.date)}`,
      preheader: `${d.deadlines.total} due today · ${waiting} waiting for approval · ${d.overdue.count} overdue invoices · ${d.unassigned.count} unassigned`,
      greeting: greeting(d.partnerName),
      blocks,
    },
    firm,
  );
}
