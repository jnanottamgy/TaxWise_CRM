"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useController, useFieldArray, useWatch, type Control } from "react-hook-form"
import { toast } from "sonner"
import { HistoryIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { useActionForm } from "@/hooks/use-action-form"
import { clearDraft, readDraft, useAutosave, type StoredDraft } from "@/hooks/use-autosave"
import { fieldDomId } from "@/hooks/use-action-form"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { FormAlert } from "@/components/app/form/form-alert"
import { FieldShell } from "@/components/app/form/field-shell"
import { ComboboxField, DateField, TextField, TextareaField } from "@/components/app/form/fields"
import type { ComboOption } from "@/components/app/form/combobox"
import { SectionCard } from "@/components/app/section-card"
import { Money } from "@/components/app/money"
import { DraftStamp } from "@/components/app/draft-stamp"
import { UnsavedChangesGuard } from "@/components/app/unsaved-changes"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { cn } from "@/lib/utils"
import { formatDateTime, formatTime } from "@/lib/format"
import { addDays, compareDates, isDateString } from "@/lib/domain/fy"
import { formatINR, fromPaise, type Paise } from "@/lib/domain/money"
import { quotationNeedsApproval } from "@/lib/domain/approvals"
import { deriveFromGstin, stateOptions } from "@/lib/domain/india-validators"
import type { ServiceType } from "@/lib/domain/enums"
import {
  QuotationDraftSchema,
  SERVICE_LINE_DEFAULTS,
  derivedPlaceOfSupply,
  isSavableLine,
  newLine,
  placeOfSupplyLabel,
  quotationTotals,
  totalRows,
  type QuotationDraftValues,
  type QuotationLineValues,
  type QuotationParty,
} from "@/lib/schemas/quotations"
import { deleteQuotation, loadQuotationParty, saveQuotationDraft, searchQuotationParties, type SavedQuotation } from "@/server/actions/quotations"
import { LINE_GRID, QuotationLine } from "@/components/quotations/builder/quotation-line"

type Form = QuotationDraftValues

export type BuilderQuotation = {
  id: string
  number: string
  revisionNumber: number
  revises: { id: string; number: string } | null
  returnedAt: string | null
  returnNote: string | null
  updatedAt: string
}

export type BuilderContext = {
  today: string
  validityDays: number
  firmStateCode: string
  approvalLimitPaise: Paise | null
}

const noSubscription = () => () => undefined
const onClient = () => true
const onServer = () => false

const PARTY_LABELS: Record<QuotationParty, string> = { lead: "A lead", client: "An existing client", other: "Someone else" }

/** The form's content without the bookkeeping fields, to compare a stored draft with what is on screen. */
function contentOf(v: Partial<Form>): string {
  const { id: _id, updatedAt: _u, ...rest } = v
  void _id
  void _u
  const lines = (rest.lines ?? []).map((l) => ({ ...l, key: undefined }))
  return JSON.stringify({ ...rest, lines })
}

/** What the server draft can hold: the form with only the lines that are complete. */
function serverCandidate(v: Form): Form | null {
  const lines = (v.lines ?? []).filter(isSavableLine)
  const candidate = { ...v, lines }
  return QuotationDraftSchema.safeParse(candidate).success ? candidate : null
}

function isBlank(l: QuotationLineValues): boolean {
  return !String(l.description ?? "").trim() && !String(l.unit_price ?? "").trim()
}

/**
 * The quotation builder (§7.5.2), a full-page form that saves itself as a Draft (§3.4): who it's for
 * (a lead or an existing client, searched, which pre-fills the name, email, phone, company, GSTIN and
 * the place of supply; or someone typed in), the issue and valid-until dates, the lines (add, remove,
 * reorder; description, service, frequency, qty, unit price, GST %, line total), the totals with the
 * CGST/SGST or IGST split and the total in words, notes to the client and terms. Whether a Partner
 * must approve it shows as the total changes. "Review & send" saves and opens the quotation, where it
 * is submitted for approval or sent.
 *
 * Saves go through one queue carrying the id and updated_at of the last save (§13); the server
 * refuses, never overwrites, a draft someone else saved in between. The draft is kept on this device
 * too, and offered back when it is newer than the saved one.
 */
export function QuotationBuilder({
  initial,
  partyLabel,
  context,
  authorRole,
  quotation,
  storageKey,
}: {
  initial: Form
  partyLabel: string | null
  context: BuilderContext
  authorRole: "partner" | "manager"
  quotation: BuilderQuotation | null
  storageKey: string
}) {
  const router = useRouter()
  const idRef = React.useRef<string | null>(quotation?.id ?? null)
  const updatedAtRef = React.useRef<string | null>(quotation?.updatedAt ?? null)
  const [quotationId, setQuotationId] = React.useState<string | null>(quotation?.id ?? null)
  const [number, setNumber] = React.useState<string | null>(quotation?.number ?? null)
  const [key, setKey] = React.useState(storageKey)
  const [labels, setLabels] = React.useState<{ lead: string; client: string }>({
    lead: initial.party === "lead" ? (partyLabel ?? "") : "",
    client: initial.party === "client" ? (partyLabel ?? "") : "",
  })
  const [loadingParty, setLoadingParty] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [done, setDone] = React.useState(false)
  const [offer, setOffer] = React.useState<StoredDraft<Form> | null>(null)
  const [offerChecked, setOfferChecked] = React.useState(false)
  const intentRef = React.useRef<"save" | "review">("review")
  const chain = React.useRef<Promise<unknown>>(Promise.resolve())

  const queued = React.useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.current.then(fn, fn)
    chain.current = run.catch(() => undefined)
    return run
  }, [])

  const afterSave = React.useCallback(
    (r: SavedQuotation) => {
      const created = !idRef.current
      idRef.current = r.id
      updatedAtRef.current = r.updatedAt
      setQuotationId(r.id)
      if (r.quotationNumber) setNumber(r.quotationNumber)
      if (created) {
        clearDraft(key)
        setKey(`quotation:${r.id}`)
        if (typeof window !== "undefined") window.history.replaceState(null, "", `/quotations/${r.id}/edit`)
      }
    },
    [key],
  )

  const f = useActionForm(
    QuotationDraftSchema,
    (values: Form) =>
      queued(async () => {
        const r = await saveQuotationDraft({ ...values, id: idRef.current, updatedAt: updatedAtRef.current })
        if (r.ok) afterSave(r.data)
        return r
      }),
    {
      defaultValues: initial,
      onSuccess: (r) => {
        if (intentRef.current === "review") {
          setDone(true)
          draft.clear()
          router.push(`/quotations/${r.id}`)
        } else {
          toast.success(r.created ? `Draft ${r.quotationNumber} saved.` : "Draft saved.")
        }
      },
    },
  )
  const { control, setValue, getValues } = f.form
  const lines = useFieldArray({ control, name: "lines", keyName: "_k" as never })
  const watched = useWatch({ control }) as Form
  const watchedLines = (watched.lines ?? []) as QuotationLineValues[]
  const isDirty = f.form.formState.isDirty

  const draft = useAutosave<Form>({
    key,
    value: watched,
    enabled: isDirty && !done,
    onServerSave: async (v) => {
      const candidate = serverCandidate(v)
      if (!candidate) return { ok: false, error: "Kept on this device. It saves as a Draft once the name, email and dates are in." }
      const r = await queued(() => saveQuotationDraft({ ...candidate, id: idRef.current, updatedAt: updatedAtRef.current }))
      if (!r.ok) return { ok: false, error: r.code === "conflict" ? r.error : `Couldn't save the draft: ${r.error}` }
      afterSave(r.data)
      // What was saved is still what's on screen: the form is clean again (no "unsaved changes" prompt).
      const now = getValues()
      if (contentOf(now) === contentOf(v) && candidate.lines?.length === v.lines?.length) {
        f.form.reset(now, { keepErrors: true, keepTouched: true, keepIsSubmitted: true })
      }
      return { ok: true }
    },
  })

  // A draft on this device that is newer than what was loaded (the tab closed before it reached the
  // server): checked once, after hydration (this device's storage isn't there on the server).
  const hydrated = React.useSyncExternalStore(noSubscription, onClient, onServer)
  if (hydrated && !offerChecked) {
    setOfferChecked(true)
    const stored = readDraft<Form>(storageKey)
    const newer = stored && (!quotation || Date.parse(stored.at) > Date.parse(quotation.updatedAt))
    if (stored && newer && contentOf(stored.value) !== contentOf(initial)) setOffer(stored)
  }

  // ---- Who it's for ----------------------------------------------------------------------------
  const party = (watched.party ?? "other") as QuotationParty
  const gstin = String(watched.client_gstin ?? "").trim().toUpperCase()
  const fromGstin = gstin.length === 15 ? deriveFromGstin(gstin) : null
  const pos = derivedPlaceOfSupply(fromGstin ? gstin : null, String(watched.place_of_supply_code ?? ""), context.firmStateCode)

  React.useEffect(() => {
    if (fromGstin && getValues("place_of_supply_code") !== fromGstin.stateCode) {
      setValue("place_of_supply_code", fromGstin.stateCode, { shouldDirty: true, shouldValidate: true })
    }
  }, [fromGstin, getValues, setValue])

  const choose = (next: QuotationParty) => {
    if (next === party) return
    setValue("party", next, { shouldDirty: true })
    if (next !== "lead") setValue("lead_id", null, { shouldDirty: true })
    if (next !== "client") setValue("client_id", null, { shouldDirty: true })
  }

  const loadParty = async (kind: "lead" | "client", id: string | null) => {
    if (!id) return
    setLoadingParty(true)
    try {
      const r = await loadQuotationParty({ kind, id })
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      const p = r.data
      setValue("client_name", p.client_name, { shouldDirty: true, shouldValidate: Boolean(p.client_name) })
      setValue("client_email", p.client_email, { shouldDirty: true, shouldValidate: Boolean(p.client_email) })
      setValue("client_phone", p.client_phone, { shouldDirty: true })
      setValue("client_company", p.client_company, { shouldDirty: true })
      setValue("client_gstin", p.client_gstin, { shouldDirty: true })
      setValue("place_of_supply_code", derivedPlaceOfSupply(p.client_gstin, p.state_code, context.firmStateCode).code, { shouldDirty: true })
      // The services the lead asked for become the first lines, when nothing is typed yet.
      const current = getValues("lines") ?? []
      if (p.services.length && current.every(isBlank)) {
        lines.replace(p.services.map((s: ServiceType) => newLine({ service_type: s, description: SERVICE_LINE_DEFAULTS[s] })))
      }
    } finally {
      setLoadingParty(false)
    }
  }

  // ---- Dates: valid-until follows the issue date while it is still the default ------------------
  const issueDate = String(watched.issue_date ?? "")
  const prevIssue = React.useRef(issueDate)
  React.useEffect(() => {
    const before = prevIssue.current
    prevIssue.current = issueDate
    if (before === issueDate || !isDateString(issueDate) || !isDateString(before)) return
    if (getValues("valid_until") === addDays(before, Math.max(1, context.validityDays))) {
      setValue("valid_until", addDays(issueDate, Math.max(1, context.validityDays)), { shouldDirty: true })
    }
  }, [issueDate, context.validityDays, getValues, setValue])

  // ---- Totals and the approval gate --------------------------------------------------------------
  const totals = quotationTotals(watchedLines, pos.code, context.firmStateCode)
  const needsApproval = quotationNeedsApproval(authorRole, totals.totalPaise, context.approvalLimitPaise)
  const approvalNote =
    authorRole === "partner"
      ? "A Partner's quotation goes out without approval."
      : context.approvalLimitPaise === null
        ? "A Manager's quotation goes to a Partner for approval before it is sent."
        : context.approvalLimitPaise === 0
          ? "No approval is needed: you can send it yourself."
          : needsApproval
            ? `Over the quotation approval limit of ${formatINR(context.approvalLimitPaise)} incl. GST: submit it for a Partner's approval after reviewing it.`
            : `Within the quotation approval limit of ${formatINR(context.approvalLimitPaise)} incl. GST: you can send it yourself.`
  const lapsed = isDateString(String(watched.valid_until ?? "")) && compareDates(String(watched.valid_until), context.today) < 0

  const submitWith = (intent: "save" | "review", e?: React.BaseSyntheticEvent) => {
    intentRef.current = intent
    return f.onSubmit(e)
  }

  const title = number ? `Quotation ${number}` : "New quotation"

  return (
    <form onSubmit={(e) => void submitWith("review", e)} noValidate className="flex min-w-0 flex-col" aria-label={title}>
      <UnsavedChangesGuard when={isDirty && !done} />
      <FormAlert state={f} />

      {offer ? (
        <div role="note" className="mb-4 flex flex-col gap-2 rounded-md border border-info/40 bg-info-soft px-3 py-2.5 text-base text-text sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-2">
            <HistoryIcon className="size-4 flex-none text-info-text" aria-hidden="true" />
            This device has unsaved changes to this quotation from {formatDateTime(offer.at)}.
          </p>
          <div className="flex flex-none gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                clearDraft(key)
                setOffer(null)
              }}
            >
              Discard them
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                const { id: _i, updatedAt: _u, ...rest } = offer.value
                void _i
                void _u
                f.form.reset({ ...initial, ...rest, id: initial.id, updatedAt: initial.updatedAt }, { keepDefaultValues: true })
                setOffer(null)
                toast.info(`Restored your changes from ${formatTime(offer.at)}. They save as the draft in a few seconds.`)
              }}
            >
              Restore them
            </Button>
          </div>
        </div>
      ) : null}

      {quotation?.returnedAt && quotation.returnNote ? (
        <div role="note" className="mb-4 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-base text-text">
          <p className="font-medium">Returned with comments on {formatDateTime(quotation.returnedAt)}</p>
          <p className="mt-0.5 whitespace-pre-line">{quotation.returnNote}</p>
          <p className="mt-1 text-sm text-text-muted">Make the changes, then review it and submit it for approval again.</p>
        </div>
      ) : null}
      {quotation?.revises ? (
        <p className="mb-4 text-base text-text-muted">
          Revision {quotation.revisionNumber} of{" "}
          <Link href={`/quotations/${quotation.revises.id}`} className="font-medium text-text underline-offset-4 hover:underline">
            {quotation.revises.number}
          </Link>
          . The old link already tells the client it has been replaced; send this one when it is ready.
        </p>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-6">
        <SectionCard title="Who it's for">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span id="quotation-party-label" className="text-sm font-medium text-text">
                Quotation for
              </span>
              <ToggleGroup
                type="single"
                value={party}
                onValueChange={(v) => v && choose(v as QuotationParty)}
                variant="outline"
                className="w-full max-w-lg"
                aria-labelledby="quotation-party-label"
              >
                {(["lead", "client", "other"] as const).map((p) => (
                  <ToggleGroupItem key={p} value={p} className="flex-1">
                    {PARTY_LABELS[p]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            {party === "lead" ? (
              <ComboboxField
                control={control}
                name="lead_id"
                label="Lead"
                required
                placeholder="Search leads"
                searchPlaceholder="Name, company, email, phone or lead number"
                emptyText="No open lead matches."
                selectedLabel={labels.lead}
                loadOptions={async (q: string) => {
                  const r = await searchQuotationParties({ kind: "lead", q })
                  return r.ok ? r.data : []
                }}
                onSelectOption={(o?: ComboOption) => {
                  setLabels((l) => ({ ...l, lead: o?.label ?? "" }))
                  void loadParty("lead", o?.value ?? null)
                }}
                helper="Fills in the details below. Accepting the quotation moves the lead to Won."
              />
            ) : party === "client" ? (
              <ComboboxField
                control={control}
                name="client_id"
                label="Client"
                required
                placeholder="Search clients"
                searchPlaceholder="Name, code, PAN or GSTIN"
                emptyText="No client matches."
                selectedLabel={labels.client}
                loadOptions={async (q: string) => {
                  const r = await searchQuotationParties({ kind: "client", q })
                  return r.ok ? r.data : []
                }}
                onSelectOption={(o?: ComboOption) => {
                  setLabels((l) => ({ ...l, client: o?.label ?? "" }))
                  void loadParty("client", o?.value ?? null)
                }}
                helper="For extra work: it goes to the client's primary contact unless you change the email."
              />
            ) : null}
            {loadingParty ? (
              <p className="flex items-center gap-2 text-sm text-text-muted" role="status">
                <Spinner className="size-3.5" /> Filling in the details…
              </p>
            ) : null}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <TextField control={control} name="client_name" label="Client name" required autoComplete="off" helper="The person it is addressed to." />
              <TextField control={control} name="client_email" label="Email" required type="email" inputMode="email" autoComplete="off" helper="Where the quotation and its follow-ups go." />
              <TextField control={control} name="client_phone" label="Phone" type="tel" inputMode="tel" autoComplete="off" />
              <TextField control={control} name="client_company" label="Company" autoComplete="off" helper="Printed above the name, when there is one." />
              <TextField
                control={control}
                name="client_gstin"
                label="GSTIN"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={15}
                className="[&_input]:font-mono"
                helper={fromGstin ? `Registered in ${fromGstin.stateName} (${fromGstin.stateCode}).` : "15 characters, checked as you leave the field."}
              />
              <PlaceOfSupplyField control={control} locked={pos.locked} firmStateCode={context.firmStateCode} />
            </div>
          </div>
        </SectionCard>

        <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
          <SectionCard title="Dates">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1">
              <DateField control={control} name="issue_date" label="Issue date" required />
              <DateField
                control={control}
                name="valid_until"
                label="Valid until"
                required
                min={issueDate || undefined}
                helper={lapsed ? "This date has passed: the client couldn't accept it. Move it to a later date." : `${context.validityDays} days from the issue date by default.`}
              />
            </div>
          </SectionCard>
          <div role="note" className={cn("rounded-md border px-3 py-2.5 text-sm text-text", needsApproval ? "border-warning/40 bg-warning-soft" : "border-border bg-surface-2")}>
            <p className="font-medium">{needsApproval ? "Needs a Partner's approval" : "Approval"}</p>
            <p className="mt-0.5">{approvalNote}</p>
          </div>
        </div>
      </div>

      <SectionCard
        className="mt-4 lg:mt-6"
        title="Line items"
        description={`${watchedLines.length} ${watchedLines.length === 1 ? "line" : "lines"}`}
        flush
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => lines.append(newLine())} disabled={watchedLines.length >= 100}>
            <PlusIcon aria-hidden="true" />
            Add line
          </Button>
        }
      >
        <div className={cn("hidden border-b border-border bg-surface-2 px-5 py-2 text-xs font-medium text-text-muted lg:grid lg:gap-x-3", LINE_GRID)} aria-hidden="true">
          <span>Description *</span>
          <span>Service · frequency</span>
          <span className="text-right">Qty *</span>
          <span className="text-right">Unit price *</span>
          <span>GST % *</span>
          <span className="text-right">Line total</span>
          <span />
        </div>
        <ul aria-label="Line items">
          {lines.fields.map((field, index) => (
            <QuotationLine
              key={(field as unknown as { _k: string })._k}
              control={control}
              index={index}
              count={lines.fields.length}
              setValue={setValue}
              amountPaise={totals.lines[index]?.amountPaise ?? 0}
              taxPaise={totals.lines[index]?.taxPaise ?? 0}
              onRemove={() => lines.remove(index)}
              onMove={(to) => {
                if (to < 0 || to >= lines.fields.length) return
                lines.move(index, to)
              }}
            />
          ))}
        </ul>
        {f.form.formState.errors.lines?.message ? <p className="px-5 pb-3 text-sm text-danger-text">{String(f.form.formState.errors.lines.message)}</p> : null}
        <div className="flex flex-col-reverse gap-4 border-t border-border px-4 py-4 md:flex-row md:items-start md:justify-between md:px-5">
          <div className="min-w-0 md:max-w-[55%]">
            <p className="text-sm text-text-muted">Total in words</p>
            <p className="text-base font-medium text-text">{totals.words}</p>
            <p className="mt-1 text-sm text-text-muted">
              Place of supply {placeOfSupplyLabel(pos.code)}: {totals.intraState ? "CGST + SGST, the same state as the firm." : "IGST, another state."}
            </p>
          </div>
          <dl className="w-full md:w-80" aria-label="Totals">
            {totalRows(totals).map((r) => (
              <div key={r.label} className={cn("flex items-baseline justify-between gap-4 py-1", r.emphasis && "mt-1 border-t border-border pt-2")}>
                <dt className={cn("text-sm", r.emphasis ? "font-semibold text-text" : "text-text-muted")}>{r.label}</dt>
                <dd className={cn("num text-right tabular-nums", r.emphasis ? "text-lg font-semibold text-text" : "text-base text-text")}>
                  <Money value={fromPaise(r.paise)} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </SectionCard>

      <SectionCard className="mt-4 lg:mt-6" title="Notes and terms">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextareaField control={control} name="notes" label="Notes to client" rows={4} helper="Printed on the quotation: what the fee covers, what you need from them, timelines." />
          <TextareaField control={control} name="terms" label="Terms" rows={4} helper="From Settings; change them for this quotation if needed." />
        </div>
      </SectionCard>

      <div className="sticky bottom-0 z-10 -mx-4 mt-6 flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-surface px-4 py-3 md:-mx-6 md:px-6">
        <div className="mr-auto flex min-w-0 flex-col">
          <DraftStamp savedAt={draft.savedAt} saving={draft.saving} error={draft.error} />
          <p className="num text-sm text-text tabular-nums max-sm:sr-only">
            Total <Money value={fromPaise(totals.totalPaise)} /> incl. GST
          </p>
        </div>
        {quotationId ? (
          <Button type="button" variant="ghost" size="sm" className="text-danger-text" onClick={() => setConfirmDelete(true)}>
            <Trash2Icon aria-hidden="true" />
            <span className="max-sm:sr-only">Delete draft</span>
          </Button>
        ) : null}
        <Button type="button" variant="outline" asChild>
          <Link href={quotationId ? `/quotations/${quotationId}` : "/quotations"}>Cancel</Link>
        </Button>
        <Button type="button" variant="outline" disabled={f.pending} onClick={(e) => void submitWith("save", e)}>
          Save draft
        </Button>
        <Button type="submit" disabled={f.pending}>
          {f.pending ? <Spinner /> : null}
          Review &amp; send
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this draft?"
        description={`Draft ${number ?? ""} moves to the recycle bin. Nothing has gone to the client.`}
        confirmLabel="Delete draft"
        destructive
        onConfirm={async () => {
          const id = idRef.current
          const at = updatedAtRef.current
          if (!id || !at) return false
          const r = await queued(() => deleteQuotation({ id, updatedAt: at }))
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
            return false
          }
          setDone(true)
          draft.clear()
          toast.success("Draft deleted.")
          router.push("/quotations")
        }}
      />
    </form>
  )
}

/**
 * Place of supply (§6.4): the GSTIN's state when there is a valid GSTIN (locked), otherwise chosen.
 * It decides CGST + SGST (the firm's own state) or IGST.
 */
function PlaceOfSupplyField({ control, locked, firmStateCode }: { control: Control<Form>; locked: boolean; firmStateCode: string }) {
  const { field, fieldState } = useController({ control, name: "place_of_supply_code" })
  const id = fieldDomId(control, "place_of_supply_code")
  return (
    <FieldShell
      id={id}
      label="Place of supply"
      required
      error={fieldState.error?.message ?? null}
      helper={locked ? "From the GSTIN. Clear the GSTIN to choose another state." : `The client's state. ${placeOfSupplyLabel(firmStateCode)} means CGST + SGST; any other state, IGST.`}
    >
      {(aria) => (
        <div className="min-w-0 [&>[data-slot=native-select-wrapper]]:w-full">
          <NativeSelect {...aria} ref={field.ref} name={field.name} value={String(field.value ?? "")} onChange={(e) => field.onChange(e.target.value)} onBlur={field.onBlur} disabled={locked} className="w-full">
            {stateOptions().map((s) => (
              <NativeSelectOption key={s.code} value={s.code}>
                {s.name} ({s.code})
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      )}
    </FieldShell>
  )
}
