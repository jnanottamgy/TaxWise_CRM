"use client"

import * as React from "react"
import Link from "next/link"
import { FormDialog } from "@/components/app/form-dialog"
import { Money } from "@/components/app/money"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { SERVICE_FREQUENCY_LABELS } from "@/lib/domain/enums"
import { fromPaise, sumPaise, toPaise } from "@/lib/domain/money"
import { normalisePeriodLabel } from "@/lib/domain/invoice"
import {
  completedTaskLine,
  engagementLine,
  engagementName,
  hoursLabel,
  periodChoices,
  sacForService,
  unbilledTimeLines,
  type BilledPeriod,
  type CompletedTaskOption,
  type EngagementOption,
  type InvoiceLineValues,
  type UnbilledEntry,
} from "@/lib/schemas/invoices"
import type { EditorSettings } from "@/components/invoices/editor/types"

/**
 * "Add from" (§7.9.2): an engagement's agreed fee for a billing period, picked unbilled time (billed
 * at each person's rate, one line per task), or a completed task. Each adds lines to the invoice.
 */

type AddResult = { lines: InvoiceLineValues[]; periodLabel?: string; note?: string }

export function AddFromEngagementDialog({
  open,
  onOpenChange,
  engagements,
  billed,
  invoiceId,
  today,
  settings,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  engagements: EngagementOption[]
  billed: BilledPeriod[]
  invoiceId: string | null
  today: string
  settings: EditorSettings
  onAdd: (r: AddResult) => void
}) {
  const active = engagements.filter((e) => e.is_active)
  const [serviceId, setServiceId] = React.useState<string>(active[0]?.id ?? "")
  const service = active.find((e) => e.id === serviceId) ?? null
  const choices = service ? periodChoices(service.billing_frequency ?? service.frequency, today) : []
  const [period, setPeriod] = React.useState<string>("")
  const effective = period || choices[0] || ""
  const taken = service && effective ? billed.find((b) => b.client_service_id === service.id && b.invoice_id !== invoiceId && normalisePeriodLabel(b.billing_period_label) === normalisePeriodLabel(effective)) : null
  const periodId = React.useId()

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add from an engagement"
      description="The engagement's agreed fee for a billing period. You can change the amount on the line."
      submitLabel="Add line"
      submitDisabled={!service || !effective || Boolean(taken)}
      onSubmit={(e) => {
        e.preventDefault()
        if (!service || !effective || taken) return
        onAdd({ lines: [engagementLine(service, effective, sacForService(service.service_type, settings.sacByService, settings.defaultSac))], periodLabel: effective })
        onOpenChange(false)
      }}
    >
      {active.length === 0 ? (
        <EmptyState size="compact" message="This client has no active engagements. Add one on Client 360 → Services & fees, or type the line yourself." />
      ) : (
        <div className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-text">Engagement</legend>
            <RadioGroup
              value={serviceId}
              onValueChange={(v) => {
                setServiceId(v)
                setPeriod("")
              }}
              className="gap-0"
            >
              {active.map((e) => (
                <label key={e.id} className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-border/70 py-2 last:border-b-0">
                  <RadioGroupItem value={e.id} aria-label={engagementName(e)} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-base text-text">{engagementName(e)}</span>
                    <span className="text-xs text-text-muted">
                      {SERVICE_FREQUENCY_LABELS[e.billing_frequency ?? e.frequency]} billing{e.sac_code ? ` · SAC ${e.sac_code}` : ""}
                    </span>
                  </span>
                  <span className="text-right text-sm">{e.agreed_fee === null || e.agreed_fee === "" ? <span className="text-text-muted">No agreed fee</span> : <Money value={e.agreed_fee} />}</span>
                </label>
              ))}
            </RadioGroup>
          </fieldset>
          {service ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={periodId}>Billing period</Label>
              <Input id={periodId} list={`${periodId}-list`} value={period} placeholder={choices[0]} onChange={(e) => setPeriod(e.target.value)} autoComplete="off" />
              <datalist id={`${periodId}-list`}>
                {choices.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
              <p className="text-sm text-text-muted">A month, a quarter or the year: {choices.slice(0, 3).join(", ")}.</p>
              {taken ? (
                <p role="alert" className="text-sm text-danger-text">
                  {effective} is already billed for this engagement on{" "}
                  <Link href={`/invoices/${taken.invoice_id}`} className="font-medium underline underline-offset-4" target="_blank" rel="noopener">
                    {taken.invoice_number ? `invoice ${taken.invoice_number}` : "a draft invoice"}
                  </Link>
                  . Open it instead of raising another.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </FormDialog>
  )
}

export function AddFromTimeDialog({
  open,
  onOpenChange,
  entries,
  alreadyOnInvoice,
  today,
  sac,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entries: UnbilledEntry[]
  /** Entries already on a line of this invoice. */
  alreadyOnInvoice: ReadonlySet<string>
  today: string
  sac: string
  onAdd: (r: AddResult) => void
}) {
  const available = entries.filter((e) => !alreadyOnInvoice.has(e.id))
  const rated = available.filter((e) => e.amount !== null && e.billing_rate_per_hour !== null)
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set(rated.map((e) => e.id)))
  const chosen = rated.filter((e) => picked.has(e.id))
  const minutes = chosen.reduce((n, e) => n + e.minutes, 0)
  const valuePaise = sumPaise(chosen.map((e) => toPaise(e.amount as number | string)))
  const all = rated.length > 0 && chosen.length === rated.length

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Add unbilled time"
      description="Billed at each person's rate, one line per task. The time is marked billed when the invoice is issued."
      submitLabel={chosen.length ? `Add ${chosen.length} ${chosen.length === 1 ? "entry" : "entries"}` : "Add time"}
      submitDisabled={chosen.length === 0}
      footerStart={chosen.length ? <span className="num text-sm text-text-muted tabular-nums">{hoursLabel(minutes)} · <Money value={fromPaise(valuePaise)} /></span> : null}
      onSubmit={(e) => {
        e.preventDefault()
        const { lines, unrated } = unbilledTimeLines(chosen, { sac })
        onAdd({ lines, note: unrated.length ? `${unrated.length} entries have no billing rate and weren't added.` : undefined })
        onOpenChange(false)
      }}
    >
      {available.length === 0 ? (
        <EmptyState size="compact" message="No unbilled time for this client. Time logged as billable and finished shows here." />
      ) : (
        <div className="flex flex-col">
          <label className="flex min-h-11 items-center gap-3 border-b border-border pb-2 text-sm font-medium text-text">
            <Checkbox checked={all ? true : chosen.length ? "indeterminate" : false} onCheckedChange={(v) => setPicked(v === true ? new Set(rated.map((e) => e.id)) : new Set())} aria-label="Select all billable time" />
            All billable time
          </label>
          <ul className="flex flex-col">
            {available.map((e) => {
              const unrated = e.amount === null || e.billing_rate_per_hour === null
              return (
                <li key={e.id} className="flex min-h-12 items-center gap-3 border-b border-border/70 py-1.5 last:border-b-0">
                  <Checkbox
                    checked={picked.has(e.id)}
                    disabled={unrated}
                    aria-label={`Bill ${hoursLabel(e.minutes)} by ${e.employee_name}`}
                    onCheckedChange={(v) =>
                      setPicked((prev) => {
                        const next = new Set(prev)
                        if (v === true) next.add(e.id)
                        else next.delete(e.id)
                        return next
                      })
                    }
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-base text-text">{e.task_title ?? "Other work"}</span>
                    <span className="text-xs text-text-muted">
                      {e.employee_name} · <DateText date={e.started_at.slice(0, 10)} today={today} />
                    </span>
                  </span>
                  <span className="num flex flex-col items-end text-sm tabular-nums">
                    <span>{hoursLabel(e.minutes)}</span>
                    {unrated ? <span className="text-xs text-warning-text">No billing rate</span> : <Money value={e.amount} />}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </FormDialog>
  )
}

export function AddFromTaskDialog({
  open,
  onOpenChange,
  tasks,
  alreadyOnInvoice,
  today,
  settings,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tasks: CompletedTaskOption[]
  alreadyOnInvoice: ReadonlySet<string>
  today: string
  settings: EditorSettings
  onAdd: (r: AddResult) => void
}) {
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set())
  const chosen = tasks.filter((t) => picked.has(t.id))
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Add completed work"
      description="Filed tasks of this client. Each becomes a line; enter its fee."
      submitLabel={chosen.length ? `Add ${chosen.length} ${chosen.length === 1 ? "task" : "tasks"}` : "Add tasks"}
      submitDisabled={chosen.length === 0}
      onSubmit={(e) => {
        e.preventDefault()
        onAdd({ lines: chosen.map((t) => completedTaskLine(t, sacForService(t.service_type, settings.sacByService, settings.defaultSac))) })
        onOpenChange(false)
      }}
    >
      {tasks.length === 0 ? (
        <EmptyState size="compact" message="No filed tasks for this client yet." />
      ) : (
        <ul className="flex flex-col">
          {tasks.map((t) => {
            const on = alreadyOnInvoice.has(t.id)
            return (
              <li key={t.id} className="flex min-h-12 items-center gap-3 border-b border-border/70 py-1.5 last:border-b-0">
                <Checkbox
                  checked={picked.has(t.id)}
                  disabled={on}
                  aria-label={`Add ${t.title}`}
                  onCheckedChange={(v) =>
                    setPicked((prev) => {
                      const next = new Set(prev)
                      if (v === true) next.add(t.id)
                      else next.delete(t.id)
                      return next
                    })
                  }
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-base text-text">{t.title}</span>
                  <span className="text-xs text-text-muted">
                    {t.task_number}
                    {t.period_label ? ` · ${t.period_label}` : ""}
                    {on ? " · already on this invoice" : ""}
                  </span>
                </span>
                <span className="text-right text-sm text-text-muted">{t.completion_date ? <>Filed <DateText date={t.completion_date.slice(0, 10)} today={today} /></> : null}</span>
              </li>
            )
          })}
        </ul>
      )}
    </FormDialog>
  )
}
