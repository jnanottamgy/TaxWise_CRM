import "server-only";

import type { AdminSupabase } from "@/server/admin";
import { todayIST } from "@/lib/domain/fy";
import { formatINR, toPaise } from "@/lib/domain/money";
import { overdueFrom, sweepDueDates } from "@/lib/domain/collections";
import { formatDate } from "@/lib/format";
import { logUnexpected } from "@/lib/log";
import { notify } from "@/server/notify";

/**
 * Receivables sweep, 07:30 IST daily (§8, §9 "Invoice became overdue → Owner + Partners"):
 * every invoice that BECAME overdue (derived, §5.7: Sent or Partially paid, a balance, the due date
 * passed; never a draft, a disputed, waived, paid or cancelled one) is announced to the client's
 * owner when the owner is a Partner or Manager (an Employee never hears about money, §4.1) and to
 * every Partner, deep-linked to the invoice.
 *
 * "Became overdue today" is the day after the due date. A run that was missed is caught up for the
 * last 3 days; each notice's dedupe key names the invoice and the day it became overdue
 * (`invoice_overdue:<id>:<date>`), so running twice, or catching up, never repeats one. A record
 * that fails is logged with its Ref and the run carries on.
 */

const PAGE = 500;
const CATCH_UP_DAYS = 3;

type Row = {
  id: string;
  invoice_number: string | null;
  client_id: string;
  due_date: string;
  outstanding_amount: number;
  clients: { display_name: string; owner_employee_id: string | null; deleted_at: string | null } | null;
};

export async function run(admin: AdminSupabase, now: Date = new Date()): Promise<{ counts: Record<string, number> }> {
  const counts = { checked: 0, notified: 0, owners_notified: 0, failed: 0 };
  const today = todayIST(now);
  const window = sweepDueDates(today, CATCH_UP_DAYS);
  const owners = new Map<string, string | null>();

  let after: { due: string; id: string } | null = null;
  for (;;) {
    let q = admin
      .from("invoices")
      .select("id, invoice_number, client_id, due_date, outstanding_amount, clients!inner(display_name, owner_employee_id, deleted_at)")
      .is("deleted_at", null)
      .is("cancelled_at", null)
      .in("status", ["sent", "partially_paid"])
      .gt("outstanding_amount", 0)
      .not("invoice_number", "is", null)
      .gte("due_date", window.from)
      .lte("due_date", window.to);
    if (after) q = q.or(`due_date.gt.${after.due},and(due_date.eq.${after.due},id.gt.${after.id})`);
    const { data, error } = await q.order("due_date").order("id").limit(PAGE);
    if (error) throw error;
    const rows = (data ?? []) as unknown as Row[];
    if (!rows.length) break;
    after = { due: rows[rows.length - 1].due_date, id: rows[rows.length - 1].id };

    // The owners who may hear about money: Partners and Managers only.
    const wanted = [...new Set(rows.map((r) => r.clients?.owner_employee_id).filter((v): v is string => !!v && !owners.has(v)))];
    if (wanted.length) {
      const { data: emps, error: empError } = await admin.from("employees").select("id, is_active, profiles(role, is_active)").in("id", wanted);
      if (empError) throw empError;
      for (const id of wanted) owners.set(id, null);
      for (const e of (emps ?? []) as unknown as Array<{ id: string; is_active: boolean; profiles: { role: string; is_active: boolean } | null }>) {
        if (e.is_active && e.profiles?.is_active && (e.profiles.role === "partner" || e.profiles.role === "manager")) owners.set(e.id, e.id);
      }
    }

    for (const r of rows) {
      counts.checked++;
      try {
        if (!r.clients || r.clients.deleted_at) continue;
        const ownerEmployee = r.clients.owner_employee_id ? (owners.get(r.clients.owner_employee_id) ?? null) : null;
        const since = overdueFrom(r.due_date);
        await notify({
          to: { roles: ["partner"], employeeIds: ownerEmployee ? [ownerEmployee] : [] },
          type: "invoice_overdue",
          title: `Invoice ${r.invoice_number} is now overdue`,
          body: `${r.clients.display_name}: ${formatINR(toPaise(r.outstanding_amount))} outstanding, due ${formatDate(r.due_date)}.`,
          linkUrl: `/invoices/${r.id}`,
          entity: { type: "invoice", id: r.id },
          clientId: r.client_id,
          dedupeKey: `invoice_overdue:${r.id}:${since}`,
        });
        counts.notified++;
        if (ownerEmployee) counts.owners_notified++;
      } catch (err) {
        counts.failed++;
        logUnexpected(err, { source: "job:receivables-sweep", invoiceId: r.id });
      }
    }
    if (rows.length < PAGE) break;
  }
  return { counts };
}
