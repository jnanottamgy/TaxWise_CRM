import "server-only";

import type { ServerSupabase } from "@/lib/supabase/server";
import { fetchAll } from "@/server/compliance/engine";
import { fyEnd, fyStart, istDateOf, type DateString, type FinancialYear } from "@/lib/domain/fy";
import { toPaise } from "@/lib/domain/money";
import type { ClientStatus, ServiceFrequency, ServiceType } from "@/lib/domain/enums";
import { billingPeriodsOf, buildRealisation, periodKey, type RealisationEngagement, type RealisationInvoice, type RealisationReport } from "@/lib/domain/realisation";

/**
 * Fee realisation for an FY (§7.9.10), under the caller's session (Partners and Managers only):
 * the engagements with their fee history, the FY's issued invoices with their lines and credit
 * notes, and which engagement periods have an invoice (drafts count). The arithmetic is
 * lib/domain/realisation.ts buildRealisation, in paise.
 */

type ServiceRow = {
  id: string;
  client_id: string;
  service_type: ServiceType;
  custom_name: string | null;
  frequency: ServiceFrequency;
  billing_frequency: ServiceFrequency | null;
  is_active: boolean;
  agreed_fee: number | null;
  fee_agreed_at: string | null;
  created_at: string;
  updated_at: string;
  clients: { display_name: string; client_code: string; status: ClientStatus };
};

type InvoiceRow = {
  id: string;
  client_id: string;
  issue_date: string;
  client_service_id: string | null;
  service_type: ServiceType | null;
  total_amount: number;
  credit_noted: number;
  amount_received: number;
  tds_credited: number;
  clients: { display_name: string; client_code: string };
  invoice_items: Array<{ amount: number; is_reimbursement: boolean; service_type: ServiceType | null; client_service_id: string | null }>;
};

export async function loadRealisation(supabase: ServerSupabase, fy: FinancialYear, asOf: DateString): Promise<RealisationReport> {
  const from = fyStart(fy);
  const to = fyEnd(fy);
  const labels = [
    ...billingPeriodsOf(fy, "monthly").map((p) => p.label),
    ...billingPeriodsOf(fy, "quarterly").map((p) => p.label),
    `FY ${fy}`,
    fy,
  ];

  const [services, history, invoices, credits, billed] = await Promise.all([
    fetchAll<ServiceRow>((a, b) =>
      supabase
        .from("client_services")
        .select("id, client_id, service_type, custom_name, frequency, billing_frequency, is_active, agreed_fee, fee_agreed_at, created_at, updated_at, clients!inner(display_name, client_code, status, deleted_at)")
        .is("clients.deleted_at", null)
        .order("id")
        .range(a, b) as never,
    ),
    fetchAll<{ client_service_id: string; agreed_fee: number | null; changed_at: string }>((a, b) =>
      supabase.from("client_service_fee_history").select("client_service_id, agreed_fee, changed_at").lte("changed_at", `${to}T23:59:59+05:30`).order("id").range(a, b),
    ),
    fetchAll<InvoiceRow>((a, b) =>
      supabase
        .from("invoices")
        .select("id, client_id, issue_date, client_service_id, service_type, total_amount, credit_noted, amount_received, tds_credited, clients!inner(display_name, client_code), invoice_items(amount, is_reimbursement, service_type, client_service_id)")
        .is("deleted_at", null)
        .is("cancelled_at", null)
        .not("invoice_number", "is", null)
        .not("status", "in", "(draft,awaiting_approval)")
        .gte("issue_date", from)
        .lte("issue_date", to)
        .order("id")
        .range(a, b) as never,
    ),
    fetchAll<{ invoice_id: string; taxable_amount: number; reduces_gst: boolean }>((a, b) =>
      supabase
        .from("credit_notes")
        .select("invoice_id, taxable_amount, reduces_gst, invoices!inner(issue_date)")
        .gte("invoices.issue_date", from)
        .lte("invoices.issue_date", to)
        .order("id")
        .range(a, b) as never,
    ),
    fetchAll<{ id: string; client_service_id: string | null; billing_period_label: string | null; invoice_items: Array<{ client_service_id: string | null }> }>((a, b) =>
      supabase
        .from("invoices")
        .select("id, client_service_id, billing_period_label, invoice_items(client_service_id)")
        .is("deleted_at", null)
        .is("cancelled_at", null)
        .eq("invoice_kind", "tax_invoice")
        .in("billing_period_label", labels)
        .order("id")
        .range(a, b) as never,
    ),
  ]);

  const historyBy = new Map<string, Array<{ changedOn: DateString; agreedFeePaise: number | null }>>();
  for (const h of history) {
    const list = historyBy.get(h.client_service_id) ?? [];
    list.push({ changedOn: istDateOf(h.changed_at), agreedFeePaise: h.agreed_fee === null ? null : toPaise(h.agreed_fee) });
    historyBy.set(h.client_service_id, list);
  }

  const engagements: RealisationEngagement[] = services.map((s) => ({
    id: s.id,
    clientId: s.client_id,
    clientName: s.clients.display_name,
    clientCode: String(s.clients.client_code),
    clientStatus: s.clients.status,
    serviceType: s.service_type,
    customName: s.custom_name,
    frequency: s.frequency,
    billingFrequency: s.billing_frequency,
    isActive: s.is_active,
    agreedFeePaise: s.agreed_fee === null ? null : toPaise(s.agreed_fee),
    startedOn: istDateOf(s.fee_agreed_at && s.fee_agreed_at < s.created_at ? s.fee_agreed_at : s.created_at),
    endedOn: s.is_active ? null : istDateOf(s.updated_at),
    feeHistory: historyBy.get(s.id) ?? [],
  }));

  const creditTaxable = new Map<string, number>();
  for (const c of credits) creditTaxable.set(c.invoice_id, (creditTaxable.get(c.invoice_id) ?? 0) + toPaise(c.taxable_amount));

  const realisationInvoices: RealisationInvoice[] = invoices.map((i) => ({
    id: i.id,
    clientId: i.client_id,
    clientName: i.clients.display_name,
    clientCode: String(i.clients.client_code),
    issueDate: i.issue_date,
    clientServiceId: i.client_service_id,
    serviceType: i.service_type,
    totalPaise: toPaise(i.total_amount),
    creditNotedPaise: toPaise(i.credit_noted),
    creditTaxablePaise: creditTaxable.get(i.id) ?? 0,
    collectedPaise: toPaise(i.amount_received) + toPaise(i.tds_credited),
    lines: (i.invoice_items ?? []).map((l) => ({ amountPaise: toPaise(l.amount), isReimbursement: l.is_reimbursement, serviceType: l.service_type, clientServiceId: l.client_service_id })),
  }));

  const billedPeriodKeys = new Set<string>();
  for (const b of billed) {
    if (!b.billing_period_label) continue;
    const ids = new Set([b.client_service_id, ...(b.invoice_items ?? []).map((l) => l.client_service_id)].filter((v): v is string => !!v));
    for (const id of ids) billedPeriodKeys.add(periodKey(id, b.billing_period_label));
  }

  return buildRealisation({ fy, asOf, engagements, invoices: realisationInvoices, billedPeriodKeys });
}
