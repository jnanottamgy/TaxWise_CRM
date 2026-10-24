"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { BriefcaseBusinessIcon, CirclePlayIcon, EllipsisIcon, IndianRupeeIcon, PencilIcon, PlusIcon, SquareIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { Money } from "@/components/app/money"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { SERVICE_FREQUENCY_LABELS } from "@/lib/domain/enums"
import { paiseToDecimalString } from "@/lib/domain/money"
import { billingCycle, perCycleLabel, serviceName } from "@/lib/schemas/client-services"
import { resumeClientService } from "@/server/actions/client-services"
import type { ServiceRow } from "@/lib/data/client360"
import type { NextInvoicePreview } from "@/components/client360/logic/next-invoice"
import { AddServiceDialog, EditServiceDialog, EndServiceDialog, RepriceDialog } from "@/components/client360/services/service-dialogs"

export interface ServiceView {
  row: ServiceRow
  /** The next deadline for this service: from the compliance calendar, else the hand-set date. */
  nextDue: { date: string; title: string | null } | null
  preview: NextInvoicePreview
  /** The SAC the invoice uses when there is no override (from Settings → Billing). */
  defaultSac: string
}

type Dialog = { kind: "add" } | { kind: "edit" | "reprice" | "end" | "resume"; service: ServiceRow } | null

/**
 * Services & fees (§7.3.3 tab 3; Partner/Manager only): each engagement with its frequency, next
 * due date, agreed fee, billing frequency, SAC, auto-invoice and next billing date, and a preview
 * of the next invoice (§6.4: CGST + SGST or IGST, computed in paise). Add, change terms, re-price
 * (records fee_agreed_at and the fee history), end and resume.
 */
export function ServicesPanel({ clientId, clientName, views, defaultSacFor }: { clientId: string; clientName: string; views: ServiceView[]; defaultSacFor: Record<string, string> }) {
  const router = useRouter()
  const [dialog, setDialog] = React.useState<Dialog>(null)
  const close = (o: boolean) => !o && setDialog(null)
  const active = views.filter((v) => v.row.is_active)
  const ended = views.filter((v) => !v.row.is_active)

  return (
    <SectionCard
      title="Engagements"
      description={views.length ? `${active.length} active${ended.length ? ` · ${ended.length} ended` : ""}. Fees are per billing occurrence, excl. GST.` : undefined}
      flush
      action={
        <Button type="button" variant="ghost" size="sm" onClick={() => setDialog({ kind: "add" })}>
          <PlusIcon aria-hidden="true" />
          Add service
        </Button>
      }
    >
      {views.length === 0 ? (
        <div className="px-4 pb-4 md:px-5">
          <EmptyState
            icon={<BriefcaseBusinessIcon />}
            message={`No services set up for ${clientName} yet. Add the first engagement and its fee.`}
            action={
              <Button type="button" onClick={() => setDialog({ kind: "add" })}>
                Add service
              </Button>
            }
          />
        </div>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border/70">
          {[...active, ...ended].map(({ row: s, preview, nextDue }) => {
            const cycle = billingCycle(s.frequency, s.billing_frequency)
            return (
              <li key={s.id} className="grid grid-cols-1 gap-4 px-4 py-4 md:px-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
                <div className="min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-semibold text-text">{serviceName(s.service_type, s.custom_name)}</span>
                        {s.is_active ? null : <StatusChip label="Ended" tone="muted" meaning="Ended: not billed and not in the client's active services. Resume it to bill again." />}
                      </p>
                      <p className="mt-0.5 text-sm text-text-muted">Filed {SERVICE_FREQUENCY_LABELS[s.frequency].toLowerCase()}</p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${serviceName(s.service_type, s.custom_name)}`}>
                          <EllipsisIcon aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        {s.is_active ? (
                          <>
                            <DropdownMenuItem onSelect={() => setDialog({ kind: "edit", service: s })}>
                              <PencilIcon aria-hidden="true" />
                              Change terms
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setDialog({ kind: "reprice", service: s })}>
                              <IndianRupeeIcon aria-hidden="true" />
                              Re-price
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => setDialog({ kind: "end", service: s })} className="text-danger-text focus:text-danger-text">
                              <SquareIcon aria-hidden="true" />
                              End service
                            </DropdownMenuItem>
                          </>
                        ) : (
                          <DropdownMenuItem onSelect={() => setDialog({ kind: "resume", service: s })}>
                            <CirclePlayIcon aria-hidden="true" />
                            Resume service
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                    <Term label="Next due">
                      <span className="flex min-w-0 flex-col">
                        <DateText date={nextDue?.date ?? null} withRelative={s.is_active} />
                        {nextDue?.title ? (
                          <span className="truncate text-xs text-text-muted" title={nextDue.title}>
                            {nextDue.title}
                          </span>
                        ) : null}
                      </span>
                    </Term>
                    <Term label="Agreed fee">
                      {s.agreed_fee !== null ? (
                        <span>
                          <Money value={s.agreed_fee} /> <span className="text-sm text-text-muted">{perCycleLabel(cycle)}</span>
                        </span>
                      ) : (
                        <span className="text-text-muted">Not agreed</span>
                      )}
                    </Term>
                    <Term label="Agreed on">
                      <DateText date={s.fee_agreed_at} />
                    </Term>
                    <Term label="Billing">{s.billing_frequency ? SERVICE_FREQUENCY_LABELS[s.billing_frequency] : `${SERVICE_FREQUENCY_LABELS[s.frequency]} (as filed)`}</Term>
                    <Term label="SAC">
                      <span className="font-mono text-[13px]">{s.sac_code ?? (preview.kind === "preview" ? preview.sac : "—")}</span>
                      {s.sac_code ? null : <span className="text-sm text-text-muted"> (Settings)</span>}
                    </Term>
                    <Term label="Automatic invoice">
                      {s.auto_invoice ? (
                        <span>
                          On · next <DateText date={s.next_billing_date} />
                        </span>
                      ) : (
                        <span className="text-text-muted">Off</span>
                      )}
                    </Term>
                  </dl>
                </div>
                <NextInvoice preview={preview} />
              </li>
            )
          })}
        </ul>
      )}

      <AddServiceDialog open={dialog?.kind === "add"} onOpenChange={close} clientId={clientId} clientName={clientName} defaultSacFor={defaultSacFor} existing={views.map((v) => v.row)} />
      {dialog && dialog.kind !== "add" ? (
        <>
          <EditServiceDialog open={dialog.kind === "edit"} onOpenChange={close} clientId={clientId} service={dialog.service} defaultSac={views.find((v) => v.row.id === dialog.service.id)?.defaultSac ?? defaultSacFor.default} />
          <RepriceDialog open={dialog.kind === "reprice"} onOpenChange={close} clientId={clientId} service={dialog.service} perCycle={perCycleLabel(billingCycle(dialog.service.frequency, dialog.service.billing_frequency))} />
          <EndServiceDialog open={dialog.kind === "end"} onOpenChange={close} clientId={clientId} service={dialog.service} />
          <ConfirmDialog
            open={dialog.kind === "resume"}
            onOpenChange={close}
            title={`Resume ${serviceName(dialog.service.service_type, dialog.service.custom_name)}?`}
            description="It becomes an active service again with its last terms and fee, and the client's deadlines are regenerated. Automatic invoicing stays off until you switch it on in Change terms."
            confirmLabel="Resume service"
            onConfirm={async () => {
              const r = await resumeClientService({ id: dialog.service.id, clientId, updatedAt: dialog.service.updated_at })
              if (!r.ok) {
                toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
                return false
              }
              for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
              toast.success("Service resumed.")
              router.refresh()
            }}
          />
        </>
      ) : null}
    </SectionCard>
  )
}

function Term({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs leading-4 text-text-muted">{label}</dt>
      <dd className="mt-0.5 text-base leading-5 text-text">{children}</dd>
    </div>
  )
}

function NextInvoice({ preview }: { preview: NextInvoicePreview }) {
  if (preview.kind === "none") {
    return (
      <div className="flex flex-col justify-center rounded-md border border-dashed border-border px-3 py-3">
        <p className="text-sm font-medium text-text">Next invoice</p>
        <p className="mt-1 text-sm text-text-muted">{preview.reason}</p>
      </div>
    )
  }
  const p = (n: number) => paiseToDecimalString(n)
  return (
    <section aria-label="Preview of the next invoice" className="rounded-md border border-border bg-surface-2 px-3 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-text">Next invoice</p>
        <p className="text-sm text-text-muted">{preview.billingDate ? <DateText date={preview.billingDate} withRelative /> : "By hand"}</p>
      </div>
      <p className="mt-1 truncate text-sm text-text-muted" title={preview.description}>
        {preview.description} · SAC {preview.sac}
      </p>
      <table className="mt-2 w-full text-sm">
        <tbody>
          <Line label="Taxable value" value={p(preview.taxablePaise)} />
          {preview.intraState ? (
            <>
              <Line label={`CGST ${preview.taxRate / 2}%`} value={p(preview.cgstPaise)} />
              <Line label={`SGST ${preview.taxRate / 2}%`} value={p(preview.sgstPaise)} />
            </>
          ) : (
            <Line label={`IGST ${preview.taxRate}%`} value={p(preview.igstPaise)} />
          )}
          <tr className="border-t border-border">
            <th scope="row" className="pt-1.5 text-left font-semibold text-text">
              Total
            </th>
            <td className="pt-1.5 text-right font-semibold">
              <Money value={p(preview.totalPaise)} />
            </td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-text-muted">
        Place of supply {preview.placeOfSupply.name} ({preview.placeOfSupply.code}). {preview.basis}
      </p>
      {preview.paused ? <p className="mt-1 text-xs text-warning-text">{preview.paused}</p> : null}
    </section>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <th scope="row" className="py-0.5 text-left font-normal text-text-muted">
        {label}
      </th>
      <td className="py-0.5 text-right">
        <Money value={value} />
      </td>
    </tr>
  )
}
