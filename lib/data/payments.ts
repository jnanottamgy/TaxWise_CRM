import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import { fyStart, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { toPaise, type Paise } from "@/lib/domain/money";
import { collectionRate, daysSalesOutstanding } from "@/lib/domain/collections";
import { AGEING_BUCKETS, type AgeingBucket } from "@/lib/domain/invoice";

/**
 * The payments dashboard (§7.9.5, Partner only): one call to payments_dashboard (0163), which sums
 * everything in SQL; the amounts arrive as decimal strings and become paise here, and the collection
 * rate and DSO are worked out from them in paise (lib/domain/collections.ts).
 */

type Raw = {
  today: string;
  financial_year: string;
  receivables: { outstanding: string; count: number; overdue: string; overdue_count: number; disputed: string; disputed_count: number; clients: number };
  ageing: Array<{ bucket: string; count: number; amount: string }>;
  collection: { opening: string; billed: string; credited: string; written_off: string; collected: string; collected_month: string; tds_month: string };
  dso: { outstanding: string; billed_90: string; days: number };
  top_debtors: Array<{ client_id: string; client_name: string; client_code: string; outstanding: string; overdue: string; invoices: number; oldest_issue_date: string; max_days_overdue: number }>;
  promises: {
    month_start: string;
    month_end: string;
    promised: string;
    count: number;
    received: string;
    kept: number;
    missed: number;
    open: number;
    rows: Array<{ invoice_id: string; invoice_number: string | null; client_id: string; client_name: string; promised_payment_date: string; promised_amount: string; outstanding: string; status: "kept" | "missed" | "open" }>;
  };
  monthly: Array<{ month: string; collected: string }>;
  unbilled: { amount: string; minutes: number; clients: number };
  handoffs: { count: number; rows: Array<{ id: string; invoice_id: string; invoice_number: string | null; client_name: string; reminder_key: string | null; channel: string; owner_name: string | null; outstanding: string; created_at: string }> };
};

export type PaymentsDashboard = {
  today: DateString;
  financialYear: FinancialYear;
  receivables: { outstandingPaise: Paise; count: number; overduePaise: Paise; overdueCount: number; disputedPaise: Paise; disputedCount: number; clients: number };
  ageing: Array<{ bucket: AgeingBucket; count: number; amountPaise: Paise }>;
  collection: {
    openingPaise: Paise;
    billedPaise: Paise;
    creditedPaise: Paise;
    writtenOffPaise: Paise;
    collectedPaise: Paise;
    duePaise: Paise;
    ratePercent: number | null;
    collectedMonthPaise: Paise;
    tdsMonthPaise: Paise;
  };
  dso: { days: number | null; outstandingPaise: Paise; billedPaise: Paise; windowDays: number };
  topDebtors: Array<{ clientId: string; clientName: string; clientCode: string; outstandingPaise: Paise; overduePaise: Paise; invoices: number; oldestIssueDate: DateString; maxDaysOverdue: number }>;
  promises: {
    monthStart: DateString;
    monthEnd: DateString;
    promisedPaise: Paise;
    receivedPaise: Paise;
    count: number;
    kept: number;
    missed: number;
    open: number;
    rows: Array<{ invoiceId: string; invoiceNumber: string | null; clientId: string; clientName: string; promisedOn: DateString; promisedPaise: Paise; outstandingPaise: Paise; status: "kept" | "missed" | "open" }>;
  };
  /** FY months from April: `2026-04` … with what was collected (received + TDS). */
  monthly: Array<{ month: string; collectedPaise: Paise }>;
  unbilled: { amountPaise: Paise; minutes: number; clients: number };
  handoffs: { count: number; rows: Array<{ id: string; invoiceId: string; invoiceNumber: string | null; clientName: string; reminderKey: string | null; channel: string; ownerName: string | null; outstandingPaise: Paise; createdAt: string }> };
};

export async function getPaymentsDashboard(supabase: ServerSupabase, today: DateString): Promise<PaymentsDashboard> {
  const { data, error } = await supabase.rpc("payments_dashboard", { p_today: today });
  if (error) throw error;
  const r = data as unknown as Raw;
  const c = {
    openingPaise: toPaise(r.collection.opening),
    billedPaise: toPaise(r.collection.billed),
    creditedPaise: toPaise(r.collection.credited),
    writtenOffPaise: toPaise(r.collection.written_off),
    collectedPaise: toPaise(r.collection.collected),
  };
  const rate = collectionRate(c);
  const dsoOutstanding = toPaise(r.dso.outstanding);
  const dsoBilled = toPaise(r.dso.billed_90);
  const known = new Set<string>(AGEING_BUCKETS);
  return {
    today: r.today,
    financialYear: r.financial_year,
    receivables: {
      outstandingPaise: toPaise(r.receivables.outstanding),
      count: r.receivables.count,
      overduePaise: toPaise(r.receivables.overdue),
      overdueCount: r.receivables.overdue_count,
      disputedPaise: toPaise(r.receivables.disputed),
      disputedCount: r.receivables.disputed_count,
      clients: r.receivables.clients,
    },
    ageing: (r.ageing ?? []).filter((a) => known.has(a.bucket)).map((a) => ({ bucket: a.bucket as AgeingBucket, count: a.count, amountPaise: toPaise(a.amount) })),
    collection: { ...c, duePaise: rate.duePaise, ratePercent: rate.ratePercent, collectedMonthPaise: toPaise(r.collection.collected_month), tdsMonthPaise: toPaise(r.collection.tds_month) },
    dso: { days: daysSalesOutstanding({ outstandingPaise: dsoOutstanding, billedPaise: dsoBilled, days: r.dso.days }), outstandingPaise: dsoOutstanding, billedPaise: dsoBilled, windowDays: r.dso.days },
    topDebtors: (r.top_debtors ?? []).map((d) => ({
      clientId: d.client_id,
      clientName: d.client_name,
      clientCode: d.client_code,
      outstandingPaise: toPaise(d.outstanding),
      overduePaise: toPaise(d.overdue),
      invoices: d.invoices,
      oldestIssueDate: d.oldest_issue_date,
      maxDaysOverdue: d.max_days_overdue,
    })),
    promises: {
      monthStart: r.promises.month_start,
      monthEnd: r.promises.month_end,
      promisedPaise: toPaise(r.promises.promised),
      receivedPaise: toPaise(r.promises.received),
      count: r.promises.count,
      kept: r.promises.kept,
      missed: r.promises.missed,
      open: r.promises.open,
      rows: (r.promises.rows ?? []).map((p) => ({
        invoiceId: p.invoice_id,
        invoiceNumber: p.invoice_number,
        clientId: p.client_id,
        clientName: p.client_name,
        promisedOn: p.promised_payment_date,
        promisedPaise: toPaise(p.promised_amount),
        outstandingPaise: toPaise(p.outstanding),
        status: p.status,
      })),
    },
    monthly: (r.monthly ?? []).map((m) => ({ month: m.month, collectedPaise: toPaise(m.collected) })),
    unbilled: { amountPaise: toPaise(r.unbilled.amount), minutes: r.unbilled.minutes, clients: r.unbilled.clients },
    handoffs: {
      count: r.handoffs.count,
      rows: (r.handoffs.rows ?? []).map((h) => ({
        id: h.id,
        invoiceId: h.invoice_id,
        invoiceNumber: h.invoice_number,
        clientName: h.client_name,
        reminderKey: h.reminder_key,
        channel: h.channel,
        ownerName: h.owner_name,
        outstandingPaise: toPaise(h.outstanding),
        createdAt: h.created_at,
      })),
    },
  };
}

/** The first day of the dashboard's FY, for links into the ledgers. */
export function dashboardFyStart(d: PaymentsDashboard): DateString {
  return fyStart(d.financialYear);
}
