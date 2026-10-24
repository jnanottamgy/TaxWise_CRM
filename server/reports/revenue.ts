import "server-only";

import { SERVICE_TYPE_LABELS, type ServiceType } from "@/lib/domain/enums";
import { compareDates, fyEnd, fyStart, MONTH_ABBR } from "@/lib/domain/fy";
import { sumPaise, type Paise } from "@/lib/domain/money";
import { ratioPercent } from "@/lib/domain/collections";
import type { RealisationRow } from "@/lib/domain/realisation";
import { loadRealisation } from "@/lib/data/realisation";
import { getRevenueLedger, type LedgerInvoiceRow, type LedgerReceiptRow } from "@/lib/data/revenue";
import type { ReportResult, ReportRow } from "@/components/reports/report-types";
import { paise, reportHeader, SCREEN_LIST_ROWS, type ReportLoader } from "@/server/reports/shared";

/**
 * Revenue and realisation (§7.16 → §7.9.10), reusing the collections module's reads: the fee
 * realisation of the FY (lib/data/realisation.ts: agreed vs invoiced vs collected per engagement,
 * and the leakage list) and the revenue ledger (lib/data/revenue.ts: issued invoices and receipts),
 * here totalled by service, by client and by month. Partners and Managers only (§4.1).
 */

const LEDGER_MAX = 20000;

type Agg = { agreed: Paise; invoiced: Paise; collected: Paise };

function addTo(map: Map<string, Agg & { label: string; sub?: string; href?: string }>, key: string, label: string, r: RealisationRow, extra: { sub?: string; href?: string } = {}) {
  const e = map.get(key) ?? { label, agreed: 0, invoiced: 0, collected: 0, ...extra };
  e.agreed += r.agreedPaise;
  e.invoiced += r.invoicedPaise;
  e.collected += r.collectedPaise;
  map.set(key, e);
}

function fyMonths(fy: string): string[] {
  const start = fyStart(fy);
  const y = Number(start.slice(0, 4));
  return Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1;
    const year = m >= 4 ? y : y + 1;
    return `${year}-${String(m).padStart(2, "0")}`;
  });
}

export const loadRevenueReport: ReportLoader = async (supabase, f, ctx) => {
  const asOf = compareDates(fyEnd(f.fy), ctx.today) < 0 ? fyEnd(f.fy) : ctx.today;
  const range = { from: fyStart(f.fy), to: fyEnd(f.fy) };
  const [header, realisation, invoices, receipts] = await Promise.all([
    reportHeader(supabase, "revenue", f, ctx),
    loadRealisation(supabase, f.fy, asOf),
    f.service ? Promise.resolve(null) : getRevenueLedger(supabase, { kind: "invoices", ...range, clientId: f.clientId, sort: "date", dir: "asc", offset: 0, limit: LEDGER_MAX }),
    f.service ? Promise.resolve(null) : getRevenueLedger(supabase, { kind: "receipts", ...range, clientId: f.clientId, sort: "date", dir: "asc", offset: 0, limit: LEDGER_MAX }),
  ]);

  const rows = realisation.rows.filter((r) => (!f.clientId || r.clientId === f.clientId) && (!f.service || r.serviceType === f.service));
  const leakage = realisation.leakage.filter((l) => (!f.clientId || l.clientId === f.clientId) && (!f.service || realisation.rows.some((r) => r.engagementId === l.engagementId && r.serviceType === f.service)));

  const totals: Agg = {
    agreed: sumPaise(rows.map((r) => r.agreedPaise)),
    invoiced: sumPaise(rows.map((r) => r.invoicedPaise)),
    collected: sumPaise(rows.map((r) => r.collectedPaise)),
  };
  const leakagePaise = sumPaise(leakage.map((l) => l.agreedPaise));

  const byService = new Map<string, Agg & { label: string }>();
  for (const r of rows) addTo(byService, r.serviceType, SERVICE_TYPE_LABELS[r.serviceType as ServiceType] ?? r.serviceLabel, r);
  const byClient = new Map<string, Agg & { label: string; sub?: string; href?: string }>();
  for (const r of rows) addTo(byClient, r.clientId, r.clientName, r, { sub: r.clientCode, href: `/clients/${r.clientId}?tab=billing` });

  const aggRow = (label: ReportRow[string], a: Agg): ReportRow => ({
    label,
    agreed: a.agreed,
    invoiced: a.invoiced,
    collected: a.collected,
    billing: ratioPercent(a.invoiced, a.agreed),
    realisation: ratioPercent(a.collected, a.invoiced),
  });

  const serviceRows = [...byService.values()].sort((a, b) => b.agreed - a.agreed || b.invoiced - a.invoiced || a.label.localeCompare(b.label)).map((a) => aggRow(a.label, a));
  const clientAll = [...byClient.values()].sort((a, b) => b.agreed - a.agreed || b.invoiced - a.invoiced || a.label.localeCompare(b.label));
  const clientRows = (ctx.forExport ? clientAll : clientAll.slice(0, SCREEN_LIST_ROWS)).map((a) => aggRow({ text: a.label, href: a.href ?? "", sub: a.sub ?? null }, a));

  // By month, from the ledger: fee value and invoice totals by issue date (cancelled ones left out),
  // collections (received + TDS, reversed receipts left out) by payment date.
  const months = fyMonths(f.fy);
  const monthRows: ReportRow[] = [];
  if (invoices && receipts) {
    const inv = (invoices.rows as LedgerInvoiceRow[]).filter((i) => !i.cancelled_at);
    const rec = (receipts.rows as LedgerReceiptRow[]).filter((x) => !x.reversed_at);
    for (const m of months) {
      if (compareDates(`${m}-01`, asOf) > 0) break;
      const mi = inv.filter((i) => i.issue_date.startsWith(m));
      const mr = rec.filter((x) => x.payment_date.startsWith(m));
      const [y, mm] = m.split("-").map(Number);
      monthRows.push({
        month: `${MONTH_ABBR[mm - 1]} ${y}`,
        invoices: mi.length,
        taxable: sumPaise(mi.map((i) => paise(i.taxable_amount))),
        total: sumPaise(mi.map((i) => paise(i.total_amount))),
        collected: sumPaise(mr.map((x) => paise(x.amount_received) + paise(x.tds_amount))),
      });
    }
  }
  const sumMonths = (k: string) => sumPaise(monthRows.map((r) => Number(r[k] ?? 0)));

  const leakageRows = (ctx.forExport ? leakage : leakage.slice(0, SCREEN_LIST_ROWS)).map((l) => ({
    client: { text: l.clientName, href: `/clients/${l.clientId}?tab=billing`, sub: l.clientCode },
    service: l.serviceLabel,
    period: l.periodLabel,
    agreed: l.agreedPaise,
  }));

  const moneyColumns = [
    { key: "agreed", header: "Agreed", kind: "money" as const, mobile: "secondary" as const },
    { key: "invoiced", header: "Invoiced", kind: "money" as const, mobile: "trailing" as const },
    { key: "collected", header: "Collected", kind: "money" as const, mobile: "secondary" as const },
    { key: "billing", header: "Billing %", kind: "percent" as const, hideBelow: "lg" as const },
    { key: "realisation", header: "Realisation %", kind: "percent" as const, mobile: "secondary" as const },
  ];

  const result: ReportResult = {
    ...header,
    kpis: [
      { label: "Realisation", kind: "percent", value: ratioPercent(totals.collected, totals.invoiced), sub: "Collected of the fees invoiced" },
      { label: "Agreed", kind: "money", value: totals.agreed, sub: `Billing periods to ${asOf === ctx.today ? "today" : "31 Mar"}` },
      { label: "Invoiced", kind: "money", value: totals.invoiced, sub: totals.agreed ? `${ratioPercent(totals.invoiced, totals.agreed) ?? 0}% of agreed` : "Fees, before GST" },
      { label: "Collected", kind: "money", value: totals.collected, sub: "Received plus TDS" },
      { label: "Not invoiced", kind: "money", value: leakagePaise, sub: `${leakage.length} ${leakage.length === 1 ? "period" : "periods"} with no invoice`, href: "/fee-realisation?show=leakage" },
    ],
    sections: [
      {
        id: "by-service",
        title: "By service",
        description: "Fees only: GST and reimbursements are left out, credit notes taken off.",
        columns: [{ key: "label", header: "Service", kind: "text", mobile: "primary" }, ...moneyColumns],
        rows: serviceRows,
        totals: serviceRows.length > 1 ? aggRow("All services", totals) : null,
        empty: "No engagement has a fee, and nothing was invoiced in this FY.",
      },
      {
        id: "by-month",
        title: "By month",
        description: f.service
          ? "Monthly totals cover every service, so they aren't shown with a service chosen."
          : "Issued invoices by their date (cancelled ones left out) and collections by the day they came in.",
        columns: [
          { key: "month", header: "Month", kind: "text", mobile: "primary" },
          { key: "invoices", header: "Invoices", kind: "count", mobile: "secondary" },
          { key: "taxable", header: "Fee value", kind: "money", mobile: "secondary" },
          { key: "total", header: "Invoiced with GST", kind: "money", hideBelow: "lg" },
          { key: "collected", header: "Collected", kind: "money", mobile: "trailing" },
        ],
        rows: monthRows,
        totals: monthRows.length ? { month: "FY so far", invoices: monthRows.reduce((n, r) => n + Number(r.invoices ?? 0), 0), taxable: sumMonths("taxable"), total: sumMonths("total"), collected: sumMonths("collected") } : null,
        empty: f.service ? "Remove the service filter to see the months." : "Nothing was invoiced or collected in this FY yet.",
        chart: f.service ? null : { x: "month", y: "collected", label: "Collected", xLabel: "Month", format: "money" },
      },
      {
        id: "by-client",
        title: "By client",
        description: "Largest agreed fees first.",
        columns: [{ key: "label", header: "Client", kind: "link", mobile: "primary" }, ...moneyColumns],
        rows: clientRows,
        total: clientAll.length,
        more: clientAll.length > clientRows.length ? { label: `View all ${clientAll.length} in fee realisation`, href: "/fee-realisation" } : null,
        empty: "No client has a fee agreed or invoiced in this FY.",
      },
      {
        id: "leakage",
        title: "Periods not invoiced",
        description: "Ended billing periods of active, fee-bearing engagements with no invoice raised (a draft counts as raised).",
        columns: [
          { key: "client", header: "Client", kind: "link", mobile: "primary" },
          { key: "service", header: "Service", kind: "text", mobile: "secondary" },
          { key: "period", header: "Period", kind: "text", mobile: "secondary" },
          { key: "agreed", header: "Agreed fee", kind: "money", mobile: "trailing" },
        ],
        rows: leakageRows,
        totals: leakage.length ? { client: "All periods", service: null, period: null, agreed: leakagePaise } : null,
        total: leakage.length,
        more: leakage.length > leakageRows.length ? { label: `View all ${leakage.length} in fee realisation`, href: "/fee-realisation?show=leakage" } : null,
        empty: "Every ended billing period has an invoice.",
      },
    ],
  };
  return result;
};
