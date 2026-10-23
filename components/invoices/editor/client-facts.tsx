"use client"

import Link from "next/link"
import { ArrowUpRightIcon } from "lucide-react"
import { Money } from "@/components/app/money"
import { MonoId } from "@/components/app/mono-id"
import { StatusChip } from "@/components/app/status-chip"
import { GST_REGISTRATION_LABELS } from "@/lib/domain/enums"
import { fromPaise, sumPaise, toPaise } from "@/lib/domain/money"
import { hoursLabel } from "@/lib/schemas/invoices"
import type { ClientBillingFacts } from "@/lib/data/invoices"
import { stateLabel } from "@/components/invoices/invoice-ui"

/**
 * The client at a glance while invoicing (§7.9.2 "Client* (shows GST status, state, outstanding,
 * engagements)"): GST registration and GSTIN, state, what's outstanding and overdue, engagements with
 * an agreed fee, and unbilled time.
 */
export function ClientFacts({ client }: { client: ClientBillingFacts }) {
  const active = client.engagements.filter((e) => e.is_active)
  const withFee = active.filter((e) => e.agreed_fee !== null && e.agreed_fee !== "")
  const unbilledMinutes = client.unbilled.reduce((n, u) => n + u.minutes, 0)
  const unbilledPaise = sumPaise(client.unbilled.filter((u) => u.amount !== null).map((u) => toPaise(u.amount as number | string)))
  return (
    <div className="rounded-md border border-border bg-surface-2/60 p-3">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-text-muted">GST</dt>
          <dd className="flex flex-wrap items-center gap-x-2 text-text">
            <span>{GST_REGISTRATION_LABELS[client.gst_registration]}</span>
            {client.gstin ? <MonoId value={client.gstin} copy label="GSTIN" /> : client.gst_registration === "registered" ? <span className="text-danger-text">GSTIN missing</span> : null}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-text-muted">State</dt>
          <dd className="text-text">{stateLabel(client.state_code) ?? <span className="text-text-muted">Not recorded</span>}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-text-muted">Outstanding</dt>
          <dd className="flex flex-wrap items-baseline gap-x-2">
            <Money value={fromPaise(client.outstandingPaise)} />
            {client.overduePaise > 0 ? (
              <span className="text-xs text-danger-text">
                <Money value={fromPaise(client.overduePaise)} /> overdue
              </span>
            ) : client.openInvoices ? (
              <span className="text-xs text-text-muted">
                {client.openInvoices} open {client.openInvoices === 1 ? "invoice" : "invoices"}
              </span>
            ) : null}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-text-muted">Engagements</dt>
          <dd className="text-text">
            {active.length ? (
              <>
                {active.length} active
                <span className="text-text-muted"> · {withFee.length} with an agreed fee</span>
              </>
            ) : (
              <span className="text-text-muted">None active</span>
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5 sm:col-span-2">
          <dt className="text-xs text-text-muted">Unbilled time</dt>
          <dd className="text-text">
            {unbilledMinutes ? (
              <>
                {hoursLabel(unbilledMinutes)} · <Money value={fromPaise(unbilledPaise)} />
              </>
            ) : (
              <span className="text-text-muted">None</span>
            )}
          </dd>
        </div>
      </dl>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
        {client.status !== "active" ? <StatusChip kind="client_status" value={client.status} /> : <span />}
        <Link href={`/clients/${client.id}?tab=billing`} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline" target="_blank" rel="noopener">
          Client billing
          <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
        </Link>
      </div>
    </div>
  )
}
