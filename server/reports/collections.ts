import "server-only";

import { AGEING_BUCKETS } from "@/lib/domain/dashboard";
import { collectionRate } from "@/lib/domain/collections";
import { formatINR, sumPaise } from "@/lib/domain/money";
import { reportRpcParams } from "@/lib/schemas/reports";
import type { ReportResult, ReportRow, ReportStatusCell } from "@/components/reports/report-types";
import { callReport, paise, rate, reportHeader, SCREEN_LIST_ROWS, type ReportLoader } from "@/server/reports/shared";

/**
 * Collections (§7.16): "ageing, collection rate, promised vs actual". Receivables are issued
 * invoices (Sent, Partially paid, Disputed; not cancelled or in the bin) with a balance, aged by days
 * since the invoice date as the dashboards age them. The collection rate is what came in (received
 * plus TDS) out of what there was to collect in the period: receivables open on its first day, plus
 * billing, less credit notes and write-offs (lib/domain/collections.ts). Promises are the latest
 * promised payment date logged on an invoice, falling in the period, against what was received since
 * the promise. Partners and Managers only (§4.1). report_collections (0213) sums it in SQL.
 */

type Raw = {
  receivables: { outstanding: string; count: number; overdue: string; overdue_count: number; disputed: string; disputed_count: number; clients: number };
  ageing: Array<{ bucket: string; count: number; amount: string }>;
  collection: { opening: string; billed: string; credited: string; written_off: string; collected: string; tds: string };
  promises: {
    count: number;
    promised: string;
    received: string;
    kept: number;
    missed: number;
    open: number;
    rows: Array<{ invoice_id: string; invoice_number: string | null; client_id: string; client_name: string; promised_on: string; promised: string; received: string; outstanding: string; status: "kept" | "missed" | "open" }>;
  };
  debtors_total: number;
  debtors: Array<{ client_id: string; client_name: string; client_code: string; outstanding: string; overdue: string; invoices: number; oldest_issue_date: string }>;
};

const PROMISE: Record<"kept" | "missed" | "open", ReportStatusCell> = {
  kept: { label: "Kept", tone: "success", meaning: "Kept: the invoice was settled after the promise." },
  missed: { label: "Missed", tone: "danger", meaning: "Missed: the promised date has passed and a balance is still due." },
  open: { label: "Open", tone: "info", meaning: "Open: the promised date hasn't come yet." },
};

export const loadCollectionsReport: ReportLoader = async (supabase, f, ctx) => {
  const [header, r] = await Promise.all([reportHeader(supabase, "collections", f, ctx), callReport<Raw>(supabase, "report_collections", reportRpcParams(f))]);
  const c = {
    openingPaise: paise(r.collection.opening),
    billedPaise: paise(r.collection.billed),
    creditedPaise: paise(r.collection.credited),
    writtenOffPaise: paise(r.collection.written_off),
    collectedPaise: paise(r.collection.collected),
  };
  const rateOut = collectionRate(c);
  const outstanding = paise(r.receivables.outstanding);
  const promised = paise(r.promises.promised);
  const received = paise(r.promises.received);

  const ageingRows: ReportRow[] = AGEING_BUCKETS.map((b) => {
    const a = r.ageing.find((x) => x.bucket === b.id);
    const amount = paise(a?.amount);
    return { bucket: b.label, invoices: a?.count ?? 0, amount, share: rate(amount, outstanding) };
  });

  const debtors = (ctx.forExport ? r.debtors : r.debtors.slice(0, SCREEN_LIST_ROWS)).map((d) => ({
    client: { text: d.client_name, href: `/clients/${d.client_id}?tab=billing`, sub: d.client_code },
    invoices: d.invoices,
    oldest: d.oldest_issue_date,
    outstanding: paise(d.outstanding),
    overdue: paise(d.overdue),
  }));

  const promises = (ctx.forExport ? r.promises.rows : r.promises.rows.slice(0, SCREEN_LIST_ROWS)).map((p) => ({
    invoice: { text: p.invoice_number ?? "Invoice", href: `/invoices/${p.invoice_id}`, sub: p.client_name },
    promised_on: p.promised_on,
    promised: paise(p.promised),
    received: paise(p.received),
    outstanding: paise(p.outstanding),
    status: PROMISE[p.status],
  }));

  const result: ReportResult = {
    ...header,
    kpis: [
      { label: "Outstanding", kind: "money", value: outstanding, sub: `${r.receivables.count} ${r.receivables.count === 1 ? "invoice" : "invoices"}, ${r.receivables.clients} ${r.receivables.clients === 1 ? "client" : "clients"}`, href: "/invoices?status=sent,partially_paid,disputed" },
      { label: "Overdue", kind: "money", value: paise(r.receivables.overdue), sub: r.receivables.overdue_count ? `${r.receivables.overdue_count} past the due date` : "Nothing past its due date", href: "/invoices?status=overdue" },
      { label: "Collection rate", kind: "percent", value: rateOut.ratePercent, sub: "Collected of what was due in the period" },
      { label: "Collected", kind: "money", value: c.collectedPaise, sub: `Received plus TDS (TDS ${formatINR(paise(r.collection.tds))})` },
      { label: "Promised vs received", kind: "percent", value: rate(received, promised), sub: r.promises.count ? `${r.promises.kept} kept, ${r.promises.missed} missed of ${r.promises.count}` : "No promises fall in the period" },
    ],
    sections: [
      {
        id: "ageing",
        title: "Ageing",
        description: "What is outstanding today, by days since the invoice date.",
        columns: [
          { key: "bucket", header: "Age", kind: "text", mobile: "primary" },
          { key: "invoices", header: "Invoices", kind: "count", mobile: "secondary" },
          { key: "amount", header: "Outstanding", kind: "money", mobile: "trailing" },
          { key: "share", header: "Share", kind: "percent", mobile: "secondary" },
        ],
        rows: ageingRows,
        totals: { bucket: "All receivables", invoices: r.receivables.count, amount: outstanding, share: outstanding ? 100 : null },
        empty: "Nothing is outstanding.",
        chart: { x: "bucket", y: "amount", label: "Outstanding", xLabel: "Age", format: "money" },
        half: true,
      },
      {
        id: "rate",
        title: "Collection rate",
        description:
          rateOut.ratePercent === null
            ? "Collected out of what there was to collect in the period: nothing was due."
            : `Collected out of what there was to collect in the period: ${rateOut.ratePercent.toFixed(1)}%.`,
        columns: [
          { key: "figure", header: "Figure", kind: "text", mobile: "primary" },
          { key: "amount", header: "Amount", kind: "money", mobile: "trailing" },
        ],
        rows: [
          { figure: "Open on the first day", amount: c.openingPaise },
          { figure: "Invoiced in the period", amount: c.billedPaise },
          { figure: "Less credit notes", amount: -c.creditedPaise },
          { figure: "Less written off (waived)", amount: -c.writtenOffPaise },
          { figure: "To collect", amount: rateOut.duePaise },
          { figure: "Collected (received plus TDS)", amount: c.collectedPaise },
          { figure: "Of which TDS", amount: paise(r.collection.tds) },
        ],
        empty: "Nothing to collect in this period.",
        half: true,
      },
      {
        id: "promises",
        title: "Promised against received",
        description: "Payment promises falling due in the period, with what came in on the invoice since the promise.",
        columns: [
          { key: "invoice", header: "Invoice", kind: "link", mobile: "primary" },
          { key: "promised_on", header: "Promised for", kind: "date", mobile: "secondary" },
          { key: "promised", header: "Promised", kind: "money", mobile: "secondary" },
          { key: "received", header: "Received since", kind: "money", mobile: "trailing" },
          { key: "outstanding", header: "Still due", kind: "money", hideBelow: "lg" },
          { key: "status", header: "Promise", kind: "status", mobile: "secondary" },
        ],
        rows: promises,
        totals: r.promises.count ? { invoice: "All promises", promised_on: null, promised, received, outstanding: sumPaise(r.promises.rows.map((p) => paise(p.outstanding))), status: null } : null,
        total: r.promises.count,
        more: r.promises.count > promises.length ? { label: "View collections on the payments dashboard", href: "/payments" } : null,
        empty: "No payment promise falls in this period.",
      },
      {
        id: "debtors",
        title: "Largest debtors",
        description: "Clients with the most outstanding today.",
        columns: [
          { key: "client", header: "Client", kind: "link", mobile: "primary" },
          { key: "invoices", header: "Invoices", kind: "count", mobile: "secondary" },
          { key: "oldest", header: "Oldest invoice", kind: "date", hideBelow: "lg" },
          { key: "overdue", header: "Overdue", kind: "money", mobile: "secondary" },
          { key: "outstanding", header: "Outstanding", kind: "money", mobile: "trailing" },
        ],
        rows: debtors,
        total: r.debtors_total,
        more: r.debtors_total > debtors.length ? { label: `View all outstanding invoices`, href: "/invoices?status=sent,partially_paid,disputed&sort=outstanding_amount&dir=desc" } : null,
        empty: "No client owes anything.",
      },
    ],
  };
  return result;
};
