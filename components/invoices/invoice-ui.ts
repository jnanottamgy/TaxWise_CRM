import { statusOptions, type StatusTone } from "@/lib/status";
import type { InvoiceStatus } from "@/lib/domain/enums";
import { stateName } from "@/lib/domain/india-validators";

/**
 * Small display helpers shared by the invoice list, the detail page, the editor and Client 360 →
 * Billing. Client-safe.
 */

/** "Cancelled" isn't a stored status (§7.9.3: the original keeps its number and is marked cancelled). */
export const CANCELLED_CHIP = {
  label: "Cancelled",
  tone: "muted" as StatusTone,
  meaning: "Cancelled: replaced by a reissued invoice. It keeps its number, is never payable, and gets no reminders.",
};

/** The status filter: every stored status, the derived Overdue, and Cancelled. */
export function invoiceStatusFilterOptions(): Array<{ value: string; label: string; tone: StatusTone }> {
  return [
    ...statusOptions("invoice_status").map((o) => ({ value: String(o.value), label: o.label, tone: o.tone })),
    { value: "cancelled", label: CANCELLED_CHIP.label, tone: CANCELLED_CHIP.tone },
  ];
}

/** The chip for an invoice: the derived status (overdue / cancelled) when there is one. */
export function invoiceChipValue(row: { status: InvoiceStatus | string; is_overdue?: boolean | null; cancelled_at?: string | null; display_status?: string | null }): { cancelled: true } | { cancelled: false; value: string } {
  if (row.cancelled_at || row.display_status === "cancelled") return { cancelled: true };
  if (row.display_status) return { cancelled: false, value: row.display_status };
  if (row.is_overdue && (row.status === "sent" || row.status === "partially_paid")) return { cancelled: false, value: "overdue" };
  return { cancelled: false, value: String(row.status) };
}

/** "Karnataka (29)" */
export function stateLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const name = stateName(code);
  return name ? `${name} (${code})` : code;
}

/** "TW-C-0042 · Sharma Traders" */
export function clientLabel(c: { client_code: string; display_name: string }): string {
  return `${c.client_code} · ${c.display_name}`;
}

