"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useController, useFieldArray, useWatch } from "react-hook-form"
import { toast } from "sonner"
import { ChevronDownIcon, ClockIcon, ListChecksIcon, PlusIcon, BriefcaseIcon, Trash2Icon } from "lucide-react"
import { useActionForm } from "@/hooks/use-action-form"
import { useAutosave } from "@/hooks/use-autosave"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { FormAlert } from "@/components/app/form/form-alert"
import { ComboboxField, DateField, TextareaField } from "@/components/app/form/fields"
import type { ComboOption } from "@/components/app/form/combobox"
import { SectionCard } from "@/components/app/section-card"
import { Money } from "@/components/app/money"
import { DraftStamp } from "@/components/app/draft-stamp"
import { UnsavedChangesGuard } from "@/components/app/unsaved-changes"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { cn } from "@/lib/utils"
import { formatDateTime } from "@/lib/format"
import { addMonths, compareDates, isDateString, monthPeriodLabel } from "@/lib/domain/fy"
import { amountInWords, formatINR, fromPaise } from "@/lib/domain/money"
import { stateOptions } from "@/lib/domain/india-validators"
import { placeOfSupply } from "@/lib/domain/gst"
import {
  SaveInvoiceSchema,
  agreedFeeNotes,
  defaultDueDate,
  duplicatePeriodOnForm,
  formTotals,
  isBlankLine,
  workRule47Warning,
  type InvoiceFormInput,
  type InvoiceLineValues,
  type SaveInvoiceInput,
} from "@/lib/schemas/invoices"
import type { ClientBillingFacts } from "@/lib/data/invoices"
import { deleteInvoiceDraft, getInvoiceClientContext, saveInvoice, searchInvoiceClients, type SavedInvoice } from "@/server/actions/invoices"
import { ClientFacts } from "@/components/invoices/editor/client-facts"
import { LineRow } from "@/components/invoices/editor/line-row"
import { AddFromEngagementDialog, AddFromTaskDialog, AddFromTimeDialog } from "@/components/invoices/editor/add-from-dialogs"
import type { EditorProps } from "@/components/invoices/editor/types"

type Form = SaveInvoiceInput

function blankLine(key: string): InvoiceLineValues {
  return {
    key,
    description: "",
    service_type: "",
    sac_code: "",
    quantity: "1",
    rate: "",
    tax_rate: "18",
    tax_rate_reason: "",
    is_reimbursement: false,
    client_service_id: "",
    source_task_id: "",
    time_entry_ids: [],
    source_label: "",
  }
}

let keySeq = 0
const nextKey = () => `l${Date.now().toString(36)}${(keySeq++).toString(36)}`

type Check = { tone: "danger" | "warning" | "info"; text: React.ReactNode }

/**
 * Create / edit an invoice (§7.9.2): the client (with its GST status, state, outstanding and
 * engagements), the dates, the place of supply (derived, overridable with a reason), the lines (by
 * hand, or added from an engagement, unbilled time or a completed task), the totals with CGST + SGST
 * or IGST, reimbursements, optional round-off and the amount in words, notes and terms. The checks
 * show beside the totals: a registered client without a GSTIN and the same engagement period already
 * invoiced block; a fee that differs from the agreed one, Rule 47 and the approval limit warn.
 * Autosaves a server draft every 5 seconds (§3.4) with "Draft saved · 12:41" in the sticky footer.
 */
export function InvoiceEditor({ mode, initial, invoice, client: initialClient, settings, gst, viewer, today }: EditorProps) {
  const router = useRouter()
  const [client, setClient] = React.useState<ClientBillingFacts | null>(initialClient)
  const [clientLabel, setClientLabel] = React.useState(initialClient ? `${initialClient.client_code} · ${initialClient.display_name}` : "")
  const [loadingClient, setLoadingClient] = React.useState(false)
  const [status, setStatus] = React.useState(invoice?.status ?? "draft")
  const [requiresApproval, setRequiresApproval] = React.useState(invoice?.requiresApproval ?? false)
  const idRef = React.useRef<string | null>(invoice?.id ?? null)
  const [invoiceId, setInvoiceId] = React.useState<string | null>(invoice?.id ?? null)
  const updatedAtRef = React.useRef<string | null>((initial.updated_at as string | null) ?? null)
  const chain = React.useRef<Promise<unknown>>(Promise.resolve())
  const intentRef = React.useRef<"save" | "submit">("save")
  const [dialog, setDialog] = React.useState<null | "engagement" | "time" | "task">(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [done, setDone] = React.useState(false)
  const clientLocked = Boolean(invoice && (invoice.invoiceKind === "debit_note" || invoice.revisedFrom))

  /** Every save goes through one queue, carrying the id and updated_at of the last save (§13). */
  const queued = React.useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.current.then(fn, fn)
    chain.current = run.catch(() => undefined)
    return run
  }, [])

  const afterSave = React.useCallback((r: SavedInvoice) => {
    const created = !idRef.current
    idRef.current = r.id
    setInvoiceId(r.id)
    updatedAtRef.current = r.updatedAt
    setStatus(r.status as "draft" | "awaiting_approval")
    setRequiresApproval(r.requiresApproval)
    if (created && typeof window !== "undefined") window.history.replaceState(null, "", `/invoices/${r.id}/edit`)
  }, [])

  const f = useActionForm(
    SaveInvoiceSchema,
    (values: Form) =>
      queued(async () => {
        const r = await saveInvoice({ ...values, id: idRef.current, updated_at: updatedAtRef.current, intent: intentRef.current })
        if (r.ok) afterSave(r.data)
        return r
      }),
    {
      defaultValues: { ...initial, intent: "save" } as Form,
      onSuccess: (r) => {
        setDone(true)
        draft.clear()
        if (r.submitted) toast.success("Sent to the Partners for approval.")
        else toast.success(mode === "new" ? "Invoice saved as a draft." : "Draft saved.")
        router.push(`/invoices/${r.id}`)
      },
    },
  )
  const { control, setValue, getValues } = f.form
  const lines = useFieldArray({ control, name: "lines", keyName: "_k" as never })
  const watched = useWatch({ control }) as InvoiceFormInput
  const watchedLines = (watched.lines ?? []) as InvoiceLineValues[]
  const isDirty = f.form.formState.isDirty

  const draft = useAutosave({
    key: `invoice:${invoice?.id ?? "new"}`,
    value: watched,
    enabled: isDirty && !done && Boolean(watched.client_id),
    onServerSave: async (v) => {
      const r = await queued(() => saveInvoice({ ...(v as Form), id: idRef.current, updated_at: updatedAtRef.current, intent: "autosave" }))
      if (r.ok) {
        afterSave(r.data)
        // What was saved is still what's on screen: the form is clean again (no "unsaved changes" prompt).
        const now = f.form.getValues()
        if (JSON.stringify({ ...now, intent: undefined }) === JSON.stringify({ ...(v as Form), intent: undefined })) {
          f.form.reset(now, { keepErrors: true, keepTouched: true, keepIsSubmitted: true })
        }
        return { ok: true }
      }
      return { ok: false, error: r.code === "conflict" ? r.error : `Couldn't save the draft: ${r.error}` }
    },
  })

  // ---- The client --------------------------------------------------------------------------
  const loadClient = async (id: string | null) => {
    if (!id) {
      setClient(null)
      return
    }
    setLoadingClient(true)
    try {
      const r = await getInvoiceClientContext({ clientId: id, invoiceId: idRef.current })
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      setClient(r.data)
      const derived = placeOfSupply({ gstin: r.data.gstin, stateCode: r.data.state_code }, settings.firmStateCode)
      setValue("place_of_supply_code", derived.code, { shouldDirty: true })
      setValue("place_of_supply_reason", "", { shouldDirty: true })
      // Lines added from the previous client's engagements, time or tasks don't belong to this one.
      const current = getValues("lines") as InvoiceLineValues[]
      const kept = current.filter((l) => !l.client_service_id && !l.source_task_id && !(l.time_entry_ids?.length))
      if (kept.length !== current.length) {
        lines.replace(kept.length ? kept : [blankLine(nextKey())])
        toast.info("Lines from the other client's engagements, time and tasks were taken off.")
      }
    } finally {
      setLoadingClient(false)
    }
  }

  // ---- Derived figures -----------------------------------------------------------------------
  const derivedPos = client ? placeOfSupply({ gstin: client.gstin, stateCode: client.state_code }, settings.firmStateCode) : null
  const pos = (watched.place_of_supply_code as string) || derivedPos?.code || settings.firmStateCode
  const totals = formTotals(watchedLines, pos, settings.firmStateCode, Boolean(watched.round_off))
  const intra = totals.intraState
  const overLimit = settings.approvalLimitPaise !== null && totals.totalPaise > settings.approvalLimitPaise
  const approved = Boolean(invoice?.approvedAt)
  const needsApproval = viewer.role === "manager" && !approved && (requiresApproval || overLimit)
  const primaryLabel = needsApproval ? (status === "awaiting_approval" ? "Save for approval" : "Submit for approval") : "Save and review"

  const checks: Check[] = []
  if (client) {
    if (client.status === "inactive") checks.push({ tone: "danger", text: `${client.display_name} is inactive, so it isn't billed. Make the client Active first.` })
    if (client.gst_registration === "registered" && !client.gstin) {
      checks.push({ tone: "danger", text: "This client is registered for GST but has no GSTIN on file. Add it before invoicing: an invoice without the recipient's GSTIN costs a registered client their input tax credit." })
    }
    const dup = invoice?.invoiceKind === "debit_note" ? null : duplicatePeriodOnForm({ id: invoiceId, billing_period_label: String(watched.billing_period_label ?? ""), lines: watchedLines }, client.billedPeriods)
    if (dup) {
      checks.push({
        tone: "danger",
        text: (
          <>
            {String(watched.billing_period_label)} is already billed for this engagement on{" "}
            <Link href={`/invoices/${dup.invoice_id}`} className="font-medium underline underline-offset-4">
              {dup.invoice_number ? `invoice ${dup.invoice_number}` : "a draft invoice"}
            </Link>
            . Open it instead of raising another.
          </>
        ),
      })
    }
    if (!client.gstin) {
      const over = gst.b2cInclusive ? totals.totalPaise >= gst.b2cThresholdPaise : totals.totalPaise > gst.b2cThresholdPaise
      if (over && (!client.address || !client.state_code)) {
        checks.push({ tone: "warning", text: `Add the client's address and state on their profile before issuing: an invoice over ${formatINR(gst.b2cThresholdPaise, { decimals: 0 })} to an unregistered client must show them (Rule 46).` })
      }
    }
    for (const note of agreedFeeNotes(watchedLines, client.engagements)) checks.push({ tone: "info", text: note })
    const taskDates = watchedLines.filter((l) => l.source_task_id).map((l) => client.completedTasks.find((t) => t.id === l.source_task_id)?.completion_date ?? null)
    const issueDate = String(watched.issue_date ?? "")
    const r47 = isDateString(issueDate) ? workRule47Warning({ periodLabel: String(watched.billing_period_label ?? ""), taskCompletionDates: taskDates, invoiceDate: issueDate }, gst) : null
    if (r47) checks.push({ tone: "warning", text: r47.message })
  }
  if (needsApproval && settings.approvalLimitPaise !== null) {
    checks.push({ tone: "warning", text: `Over the approval limit of ${formatINR(settings.approvalLimitPaise)} incl. GST: a Partner approves it before it can be sent.` })
  }
  const blocked = checks.some((c) => c.tone === "danger")

  const onIssueDate = (next: string) => {
    const prevIssue = String(getValues("issue_date") ?? "")
    const prevDue = String(getValues("due_date") ?? "")
    if (isDateString(next) && isDateString(prevIssue) && prevDue === defaultDueDate(prevIssue, settings.paymentTermsDays)) {
      setValue("due_date", defaultDueDate(next, settings.paymentTermsDays), { shouldDirty: true })
    }
  }

  const addLines = (added: InvoiceLineValues[], periodLabel?: string, note?: string) => {
    const current = getValues("lines") as InvoiceLineValues[]
    const keep = current.filter((l) => !isBlankLine(l))
    lines.replace([...keep, ...added.map((l) => ({ ...l, key: nextKey() }))])
    if (periodLabel && !String(getValues("billing_period_label") ?? "").trim()) setValue("billing_period_label", periodLabel, { shouldDirty: true })
    if (note) toast.warning(note)
  }

  const onTimeIds = new Set(watchedLines.flatMap((l) => l.time_entry_ids ?? []))
  const onTaskIds = new Set(watchedLines.map((l) => l.source_task_id).filter(Boolean) as string[])
  const sacDefault = settings.defaultSac

  const submitWith = (intent: "save" | "submit", e?: React.BaseSyntheticEvent) => {
    intentRef.current = intent
    setValue("intent", intent)
    return f.onSubmit(e)
  }

  const title = invoice?.invoiceKind === "debit_note" ? "Debit note" : "Invoice"

  return (
    <form onSubmit={(e) => void submitWith(needsApproval ? "submit" : "save", e)} noValidate className="flex min-w-0 flex-col">
      <UnsavedChangesGuard when={isDirty && !done} />
      <FormAlert state={f} />

      {invoice?.returnedAt && status === "draft" && invoice.approvalNote ? (
        <div role="note" className="mb-4 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-base text-text">
          <p className="font-medium">Returned by {invoice.returnedByName ?? "a Partner"} on {formatDateTime(invoice.returnedAt)}</p>
          <p className="mt-0.5">{invoice.approvalNote}</p>
        </div>
      ) : null}
      {status === "awaiting_approval" ? (
        <div role="note" className="mb-4 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-base text-text">
          Awaiting a Partner&apos;s approval{invoice?.submittedAt ? ` since ${formatDateTime(invoice.submittedAt)}` : ""}. You can still change it; the Partners see the latest version.
        </div>
      ) : null}
      {approved && viewer.role === "manager" ? (
        <div role="note" className="mb-4 rounded-md border border-success/40 bg-success-soft px-3 py-2.5 text-base text-text">
          Approved by {invoice?.approvedByName ?? "a Partner"} at its current amount. You can issue it; changing the amount needs a Partner.
        </div>
      ) : null}
      {invoice?.original ? (
        <p className="mb-4 text-base text-text-muted">
          Debit note (supplementary invoice) against{" "}
          <Link href={`/invoices/${invoice.original.id}`} className="font-medium text-text underline-offset-4 hover:underline">
            {invoice.original.number ?? "the original invoice"}
          </Link>
          . Add the extra amount as lines.
        </p>
      ) : invoice?.revisedFrom ? (
        <p className="mb-4 text-base text-text-muted">
          Reissue of the cancelled invoice{" "}
          <Link href={`/invoices/${invoice.revisedFrom.id}`} className="font-medium text-text underline-offset-4 hover:underline">
            {invoice.revisedFrom.number ?? ""}
          </Link>
          . It gets a new number when it is issued.
        </p>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6">
        <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
          <SectionCard title="Client and dates">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {clientLocked ? (
                <div className="flex flex-col gap-1.5 md:col-span-2">
                  <span className="text-sm font-medium text-text">Client</span>
                  <p className="flex h-9 items-center rounded-md border border-border bg-surface-2 px-3 text-base text-text">{clientLabel}</p>
                </div>
              ) : (
                <ComboboxField
                  control={control}
                  name="client_id"
                  label="Client"
                  required
                  className="md:col-span-2"
                  placeholder="Choose a client"
                  searchPlaceholder="Name or code"
                  selectedLabel={clientLabel}
                  loadOptions={async (q: string) => {
                    const r = await searchInvoiceClients({ q })
                    return r.ok ? r.data : []
                  }}
                  onSelectOption={(o?: ComboOption) => {
                    setClientLabel(o?.label ?? "")
                    void loadClient(o?.value ?? null)
                  }}
                />
              )}
              {loadingClient ? (
                <p className="flex items-center gap-2 text-sm text-text-muted md:col-span-2">
                  <Spinner className="size-3.5" /> Loading the client…
                </p>
              ) : client ? (
                <div className="md:col-span-2">
                  <ClientFacts client={client} />
                </div>
              ) : null}
              <DateField
                control={control}
                name="issue_date"
                label="Invoice date"
                required
                helper={compareDates(String(watched.issue_date ?? today), today) > 0 ? "After today: it can be issued only on that date." : undefined}
              />
              <DateField control={control} name="due_date" label="Due date" required helper={`${settings.paymentTermsDays} days' terms by default.`} />
              <PeriodField control={control} today={today} />
              <PlaceOfSupplyField
                value={pos}
                derived={derivedPos}
                reason={String(watched.place_of_supply_reason ?? "")}
                onChange={(code) => setValue("place_of_supply_code", code, { shouldDirty: true })}
                onReason={(text) => setValue("place_of_supply_reason", text, { shouldDirty: true })}
                error={f.form.formState.errors.place_of_supply_reason?.message ?? null}
                locked={invoice?.invoiceKind === "debit_note"}
              />
              <IssueDateWatcher control={control} onChange={onIssueDate} />
            </div>
          </SectionCard>

          <SectionCard
            title="Lines"
            description={totals.lines.length ? `${watchedLines.filter((l) => !isBlankLine(l)).length} ${watchedLines.length === 1 ? "line" : "lines"}` : undefined}
            flush
            action={
              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="sm" disabled={!client}>
                      Add from
                      <ChevronDownIcon aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    <DropdownMenuItem onSelect={() => setDialog("engagement")}>
                      <BriefcaseIcon aria-hidden="true" />
                      Engagement (agreed fee)
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setDialog("time")}>
                      <ClockIcon aria-hidden="true" />
                      Unbilled time
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setDialog("task")}>
                      <ListChecksIcon aria-hidden="true" />
                      Completed task
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button type="button" variant="outline" size="sm" onClick={() => lines.append(blankLine(nextKey()))} disabled={watchedLines.length >= 100}>
                  <PlusIcon aria-hidden="true" />
                  Add line
                </Button>
              </div>
            }
          >
            {/* The line layout follows this card's width (container queries in LineRow): beside the
                totals at 1366px there is no room for eight columns in one row. */}
            <div className="@container/lines">
              <div className="hidden border-b border-border bg-surface-2 px-5 py-2 text-xs font-medium text-text-muted @4xl/lines:grid @4xl/lines:grid-cols-[minmax(0,1fr)_9rem_6.5rem_4.5rem_8.5rem_7rem_7.5rem_2.25rem] @4xl/lines:gap-x-3" aria-hidden="true">
                <span>Description</span>
                <span>Service</span>
                <span>SAC</span>
                <span className="text-right">Qty</span>
                <span className="text-right">Rate</span>
                <span>GST</span>
                <span className="text-right">Amount</span>
                <span />
              </div>
              <ul aria-label="Invoice lines">
                {lines.fields.map((field, index) => (
                  <LineRow
                    key={(field as unknown as { _k: string })._k}
                    control={control as never}
                    index={index}
                    setValue={setValue as never}
                    settings={settings}
                    rateOptions={gst.rateOptions}
                    amountPaise={totals.linePaise[index] ?? 0}
                    canRemove={lines.fields.length > 1}
                    onRemove={() => lines.remove(index)}
                  />
                ))}
              </ul>
            </div>
            {f.form.formState.errors.lines?.message ? <p className="px-5 pb-3 text-sm text-danger-text">{String(f.form.formState.errors.lines.message)}</p> : null}
          </SectionCard>

          <SectionCard title="Notes and terms">
            <div className="grid grid-cols-1 gap-4">
              <TextareaField control={control} name="notes" label="Notes" rows={2} helper="Printed on the invoice: what the fee covers, a reference the client asked for." />
              <TextareaField control={control} name="terms" label="Terms" rows={3} helper="From Settings → Billing; change them for this invoice if needed." />
            </div>
          </SectionCard>
        </div>

        <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-4 lg:self-start" aria-label="Totals and checks">
          <SectionCard title={`${title} total`}>
            <dl className="flex flex-col text-base">
              <TotalRow label="Taxable value" paise={totals.taxablePaise} />
              {intra ? (
                <>
                  <TotalRow label="CGST" paise={totals.cgstPaise} />
                  <TotalRow label="SGST" paise={totals.sgstPaise} />
                </>
              ) : (
                <TotalRow label="IGST" paise={totals.igstPaise} />
              )}
              {totals.reimbursementPaise ? <TotalRow label="Reimbursements" paise={totals.reimbursementPaise} hint="No GST (pure agent)" /> : null}
              <div className="flex items-center justify-between gap-3 py-1.5">
                <Label htmlFor="round-off" className="text-sm font-normal text-text-muted">
                  Round off to whole rupees
                </Label>
                <Switch id="round-off" checked={Boolean(watched.round_off)} onCheckedChange={(v) => setValue("round_off", v, { shouldDirty: true })} />
              </div>
              {totals.roundOffPaise ? <TotalRow label="Round-off" paise={totals.roundOffPaise} /> : null}
              <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-border pt-2">
                <dt className="text-base font-semibold text-text">Total</dt>
                <dd className="num font-serif text-[26px] leading-8 font-[450] text-text tabular-nums">
                  <Money value={fromPaise(totals.totalPaise)} />
                </dd>
              </div>
              <p className="mt-1 text-sm text-text-muted">{amountInWords(totals.totalPaise)}</p>
              <p className="mt-2 text-xs text-text-muted">
                Place of supply {pos}: {intra ? "CGST + SGST" : "IGST"}.
              </p>
            </dl>
          </SectionCard>
          {checks.length ? (
            <section aria-label="Checks" className="flex flex-col gap-2">
              {checks.map((c, i) => (
                <div
                  key={i}
                  role={c.tone === "danger" ? "alert" : "note"}
                  className={cn(
                    "rounded-md border px-3 py-2 text-sm text-text",
                    c.tone === "danger" ? "border-danger/30 bg-danger-soft" : c.tone === "warning" ? "border-warning/40 bg-warning-soft" : "border-border bg-surface-2",
                  )}
                >
                  {c.text}
                </div>
              ))}
            </section>
          ) : null}
        </aside>
      </div>

      {/* Phones: the draft stamp gets its own line so the three buttons stay together on one row. */}
      <div className="sticky bottom-0 z-10 -mx-4 mt-6 flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-surface px-4 py-3 max-sm:justify-end md:-mx-6 md:px-6">
        <DraftStamp savedAt={draft.savedAt} saving={draft.saving} error={draft.error} className="mr-auto max-sm:basis-full" />
        {invoiceId ? (
          <Button type="button" variant="ghost" size="sm" className="text-danger-text" onClick={() => setConfirmDelete(true)}>
            <Trash2Icon aria-hidden="true" />
            <span className="max-sm:sr-only">Delete draft</span>
          </Button>
        ) : null}
        <Button type="button" variant="outline" asChild>
          <Link href={invoiceId ? `/invoices/${invoiceId}` : "/invoices"}>Cancel</Link>
        </Button>
        <Button type="button" variant="outline" disabled={f.pending || !watched.client_id} onClick={(e) => void submitWith("save", e)}>
          Save draft
        </Button>
        <Button type="submit" disabled={f.pending || blocked || !watched.client_id} aria-describedby={blocked ? "invoice-blocked" : undefined}>
          {f.pending ? <Spinner /> : null}
          {primaryLabel}
        </Button>
        {blocked ? (
          <span id="invoice-blocked" className="sr-only">
            Fix the problems marked in red first.
          </span>
        ) : null}
      </div>

      {dialog === "engagement" && client ? (
        <AddFromEngagementDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          engagements={client.engagements}
          billed={client.billedPeriods}
          invoiceId={invoiceId}
          today={today}
          settings={settings}
          onAdd={(r) => addLines(r.lines, r.periodLabel, r.note)}
        />
      ) : null}
      {dialog === "time" && client ? (
        <AddFromTimeDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          entries={client.unbilled}
          alreadyOnInvoice={onTimeIds}
          today={today}
          sac={sacDefault}
          onAdd={(r) => addLines(r.lines, undefined, r.note)}
        />
      ) : null}
      {dialog === "task" && client ? (
        <AddFromTaskDialog open onOpenChange={(o) => !o && setDialog(null)} tasks={client.completedTasks} alreadyOnInvoice={onTaskIds} today={today} settings={settings} onAdd={(r) => addLines(r.lines)} />
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this draft?"
        description="The draft moves to the recycle bin. It has no number yet, so nothing is lost from the invoice series."
        confirmLabel="Delete draft"
        destructive
        onConfirm={async () => {
          const id = idRef.current
          if (!id || !updatedAtRef.current) return false
          const r = await queued(() => deleteInvoiceDraft({ invoiceId: id, updatedAt: updatedAtRef.current as string }))
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
            return false
          }
          setDone(true)
          draft.clear()
          toast.success("Draft deleted.")
          router.push("/invoices")
        }}
      />
    </form>
  )
}

function TotalRow({ label, paise, hint }: { label: string; paise: number; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-sm text-text-muted" title={hint}>
        {label}
      </dt>
      <dd className="num tabular-nums">
        <Money value={fromPaise(paise)} />
      </dd>
    </div>
  )
}

/** Keeps the due date on the payment terms when the invoice date moves (unless it was changed by hand). */
function IssueDateWatcher({ control, onChange }: { control: unknown; onChange: (v: string) => void }) {
  const value = useWatch({ control: control as never, name: "issue_date" as never }) as unknown as string
  const prev = React.useRef(value)
  React.useEffect(() => {
    if (prev.current !== value) {
      onChange(value)
      prev.current = value
    }
  }, [value, onChange])
  return null
}

function PeriodField({ control, today }: { control: unknown; today: string }) {
  const listId = React.useId()
  const months = Array.from({ length: 6 }, (_, i) => monthPeriodLabel(addMonths(today, -i)))
  const { field, fieldState } = useController({ control: control as never, name: "billing_period_label" as never })
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${listId}-input`}>Billing period</Label>
      <Input
        id={`${listId}-input`}
        list={listId}
        value={String(field.value ?? "")}
        onChange={field.onChange}
        onBlur={field.onBlur}
        placeholder={months[1]}
        autoComplete="off"
        aria-invalid={fieldState.error ? true : undefined}
      />
      <datalist id={listId}>
        {months.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <p className="text-sm text-text-muted">{fieldState.error?.message ?? "Printed on the invoice: Sep 2026, Q2 2026-27 or FY 2026-27."}</p>
    </div>
  )
}

function PlaceOfSupplyField({
  value,
  derived,
  reason,
  onChange,
  onReason,
  error,
  locked,
}: {
  value: string
  derived: { code: string; name: string; source: string } | null
  reason: string
  onChange: (code: string) => void
  onReason: (text: string) => void
  error: string | null
  locked?: boolean
}) {
  const id = React.useId()
  const overridden = derived !== null && value !== derived.code
  const source = derived?.source === "gstin" ? "from the client's GSTIN" : derived?.source === "client_state" ? "from the client's state" : "the firm's own state (no GSTIN or state on file)"
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Place of supply</Label>
      <div className="[&>[data-slot=native-select-wrapper]]:w-full">
        <NativeSelect id={id} value={value} disabled={locked} onChange={(e) => onChange(e.target.value)}>
          {stateOptions().map((s) => (
            <NativeSelectOption key={s.code} value={s.code}>
              {s.name} ({s.code})
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {overridden ? (
        <>
          <Input value={reason} onChange={(e) => onReason(e.target.value)} placeholder={`Why ${value} and not ${derived?.code}?`} aria-label="Reason for changing the place of supply" aria-invalid={error ? true : undefined} />
          <p className={cn("text-sm", error ? "text-danger-text" : "text-text-muted")}>{error ?? `Changed from ${derived?.name} (${derived?.code}). A reason is required.`}</p>
        </>
      ) : (
        <p className="text-sm text-text-muted">{locked ? "As on the original invoice." : derived ? `Auto: ${source}.` : "Choose the client first."}</p>
      )}
    </div>
  )
}

