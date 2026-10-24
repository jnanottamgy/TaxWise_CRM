"use client"

import * as React from "react"
import { flushSync } from "react-dom"
import { useRouter } from "next/navigation"
import { useWatch, type Control } from "react-hook-form"
import { Tabs as TabsPrimitive } from "radix-ui"
import { FileSpreadsheetIcon, PlusIcon, RotateCwIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { KpiStrip } from "@/components/app/kpi-strip"
import { DraftStamp } from "@/components/app/draft-stamp"
import { UnsavedChangesGuard } from "@/components/app/unsaved-changes"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextareaField } from "@/components/app/form/fields"
import { formatCount } from "@/components/app/data-table/params"
import { useActionForm } from "@/hooks/use-action-form"
import { clearDraft as forgetDraft, useAutosave } from "@/hooks/use-autosave"
import type { ActionResult } from "@/lib/result"
import type { FinancialYear } from "@/lib/domain/fy"
import type { BucketCode } from "@/lib/domain/buckets"
import type { StatementFigures } from "@/lib/domain/schedule3"
import {
  FS_TABS,
  FS_TAB_LABELS,
  FsInputsFormSchema,
  formFromInputs,
  previewInputs,
  rebuildStatements,
  type FsInputs,
  type FsInputsForm,
  type FsStatus,
  type FsTab,
  type StoredLedger,
  yearEndedLabel,
} from "@/lib/schemas/financial-statements"
import { saveFinancialStatement, type SavedStatement } from "@/server/actions/financial-statements"
import { PaiseAmount } from "@/components/workpapers/shared/amount"
import { ChecksPanel } from "@/components/workpapers/fs/checks-panel"
import { StatementTable, NoteView } from "@/components/workpapers/fs/statement-tables"
import { LedgerMapping, effectiveLedger } from "@/components/workpapers/fs/ledger-mapping"
import { InputsForm } from "@/components/workpapers/fs/inputs-form"
import { StatusActions } from "@/components/workpapers/fs/status-actions"
import { ReplaceTrialBalanceButton } from "@/components/workpapers/fs/replace-tb-dialog"

export type StatementEditorProps = {
  id: string
  clientId: string
  financialYear: FinancialYear
  status: FsStatus
  updatedAt: string
  ledgers: StoredLedger[]
  inputs: FsInputs
  /** Last year's saved figures (the comparatives), or null when there is no statement with figures. */
  previousFigures: Partial<StatementFigures> | null
  previousYear: FinancialYear | null
  viewer: { id: string; role: "partner" | "manager" | "employee" }
  preparedBy: string | null
  initialTab: FsTab
  sourceFile: { documentId: string; fileName: string } | null
}

type Version = { status: FsStatus; updatedAt: string }

/** The tab that holds a form field: the note texts on Notes, everything else on Inputs and disclosures. */
function tabOfField(name: string): FsTab {
  return name === "policies" || name.startsWith("noteTexts") ? "notes" : "disclosures"
}

function newer(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b)
}

/** Server field errors keyed as the form names them ("inputs.closingStock" → "closingStock"). */
function unprefixed<T>(r: ActionResult<T>): ActionResult<T> {
  if (r.ok || !r.fieldErrors) return r
  return { ...r, fieldErrors: Object.fromEntries(Object.entries(r.fieldErrors).map(([k, v]) => [k.startsWith("inputs.") ? k.slice(7) : k, v])) }
}

const TAB_CLASS =
  "relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium whitespace-nowrap text-text-muted transition-colors duration-150 outline-none hover:text-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-[state=active]:border-primary data-[state=active]:text-text pointer-coarse:h-11"

/**
 * The financial statements editor (§6.13, §7.8.3 steps 4–8). The figures lead (profit or loss,
 * total income, total assets, ledgers mapped), then the checks, then the tabs: the ledger mapping
 * (fix what isn't mapped; choices are remembered for the client), the balance sheet and the
 * statement of profit and loss in Schedule III order with last year's figures, the notes (the
 * accounting policies and text under each note), and the inputs and disclosures (closing stock,
 * capital movements, the ageing schedules and the MSME dues).
 *
 * Everything on screen is a live preview computed in the browser with the same function the server
 * uses; the server rebuilds the statements from the stored ledgers on every save and never takes
 * figures from here. A draft autosaves to the server every 5 seconds (§3.4); a reviewed statement
 * saves on demand and goes back to Draft; a final one is read-only. Each save carries the version
 * it was based on, so two people can't overwrite each other (§13).
 */
export function StatementEditor(props: StatementEditorProps) {
  const { id, clientId, financialYear, ledgers, inputs, previousFigures, previousYear, viewer, preparedBy, sourceFile } = props
  const router = useRouter()

  // ---- Version: what the next save is checked against -------------------------------------------
  const [local, setLocal] = React.useState<Version | null>(null)
  const current: Version = !local || !newer(local.updatedAt, props.updatedAt) ? { status: props.status, updatedAt: props.updatedAt } : local
  const status = current.status
  const versionRef = React.useRef(props.updatedAt)
  React.useEffect(() => {
    if (newer(props.updatedAt, versionRef.current)) versionRef.current = props.updatedAt
  }, [props.updatedAt])
  const getUpdatedAt = React.useCallback(() => versionRef.current, [])
  const chain = React.useRef<Promise<unknown>>(Promise.resolve())
  const queued = React.useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.current.then(fn, fn)
    chain.current = run.catch(() => undefined)
    return run
  }, [])
  const [conflict, setConflict] = React.useState<string | null>(null)
  const readOnly = status === "final"

  const afterSave = (r: SavedStatement) => {
    versionRef.current = r.updatedAt
    setLocal({ status: r.status, updatedAt: r.updatedAt })
  }

  // ---- Ledger mapping ---------------------------------------------------------------------------
  const [buckets, setBuckets] = React.useState<Array<BucketCode | null>>(() => ledgers.map((l) => l.bucket))
  const [savedBuckets, setSavedBuckets] = React.useState<Array<BucketCode | null>>(() => ledgers.map((l) => l.bucket))
  const bucketsDirty = buckets.some((b, i) => b !== savedBuckets[i])
  const choices = (list: Array<BucketCode | null>) => list.map((bucket, index) => ({ index, bucket }))

  // ---- Inputs -----------------------------------------------------------------------------------
  const draftKey = `financial-statement:${id}`
  const clearDraft = () => forgetDraft(draftKey)
  const f = useActionForm(
    FsInputsFormSchema,
    (values: FsInputsForm) => {
      const sent = buckets
      return queued(async () => {
        const r = unprefixed(await saveFinancialStatement({ id, updatedAt: versionRef.current, buckets: choices(sent), inputs: values, rememberBuckets: true, autosave: false }))
        if (r.ok) {
          afterSave(r.data)
          setSavedBuckets(sent)
        } else if (r.code === "conflict") {
          setConflict(r.error)
        }
        return r
      })
    },
    {
      defaultValues: formFromInputs(inputs),
      successMessage: (d) => (d.sentBackToDraft ? "Saved. Back in Draft for a fresh review." : "Statement saved"),
      onSuccess: (): void => {
        clearDraft()
        router.refresh()
      },
    },
  )
  const control = f.control as unknown as Control<FsInputsForm>
  const watched = useWatch({ control }) as FsInputsForm
  const formDirty = f.form.formState.isDirty
  const dirty = (formDirty || bucketsDirty) && !readOnly

  const draft = useAutosave({
    key: draftKey,
    value: { buckets, inputs: watched },
    enabled: status === "draft" && dirty && !conflict,
    onServerSave: async (v) => {
      if (!FsInputsFormSchema.safeParse(v.inputs).success) return { ok: false, error: "Draft not saved yet: an amount or a date isn't complete." }
      const r = await queued(() => saveFinancialStatement({ id, updatedAt: versionRef.current, buckets: choices(v.buckets), inputs: v.inputs, rememberBuckets: true, autosave: true }))
      if (r.ok) {
        afterSave(r.data)
        setSavedBuckets(v.buckets)
        // What was saved becomes the baseline; anything typed since stays dirty.
        f.form.reset(v.inputs, { keepValues: true, keepErrors: true, keepTouched: true, keepIsSubmitted: true })
        return { ok: true }
      }
      if (r.code === "conflict") setConflict(r.error)
      return { ok: false, error: r.code === "conflict" ? r.error : `Couldn't save the draft: ${r.error}` }
    },
  })

  // ---- Live preview -----------------------------------------------------------------------------
  const deferredBuckets = React.useDeferredValue(buckets)
  const deferredValues = React.useDeferredValue(watched)
  const effective = React.useMemo(() => ledgers.map((l, i) => effectiveLedger(l, deferredBuckets[i] ?? null)), [ledgers, deferredBuckets])
  const previewIn = React.useMemo(() => previewInputs(deferredValues, inputs.tb), [deferredValues, inputs.tb])
  const preview = React.useMemo(() => rebuildStatements(effective, previewIn, { financialYear, previous: previousFigures }), [effective, previewIn, financialYear, previousFigures])
  const years = { current: financialYear, previous: previousYear }
  const mapped = effective.filter((l) => l.bucket !== null).length
  const t = preview.totals

  // ---- Tabs -------------------------------------------------------------------------------------
  const [tab, setTab] = React.useState<FsTab>(props.initialTab)
  const changeTab = (next: FsTab) => {
    setTab(next)
    try {
      const url = new URL(window.location.href)
      if (next === "balance-sheet") url.searchParams.delete("tab")
      else url.searchParams.set("tab", next)
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash)
    } catch {
      // The tab still changes; only the address bar doesn't follow.
    }
  }
  const openNote = (n: number) => {
    flushSync(() => changeTab("notes"))
    document.getElementById(`note-${n}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }
  const [openNotes, setOpenNotes] = React.useState<Set<string>>(() => new Set(Object.keys(inputs.noteTexts)))
  const tabCount: Partial<Record<FsTab, string>> = {
    ledgers: ledgers.length - mapped > 0 ? `${formatCount(ledgers.length - mapped)} unmapped` : undefined,
    notes: formatCount(preview.notes.length),
  }

  const save = async (e?: React.FormEvent<HTMLFormElement>) => {
    // A dialog's own form (status, trial balance) is portalled, but its submit still bubbles here.
    if (e && e.target !== e.currentTarget) return
    if (!dirty) {
      e?.preventDefault()
      return
    }
    await f.onSubmit(e)
    // A field that fails validation may sit on a tab that isn't open: open the tab that holds it.
    const failed = Object.keys(f.form.formState.errors)
    if (failed.length > 0 && !failed.some((k) => tabOfField(k) === tab)) changeTab(tabOfField(failed[0]))
  }

  return (
    <form noValidate onSubmit={(e) => void save(e)} className="flex min-w-0 flex-col">
      <UnsavedChangesGuard when={dirty} />
      <FormAlert state={f} />
      {conflict ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-base text-text">
          <span>{conflict} Reload to see the current statement; the changes made here since your last save will be lost.</span>
          <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
            <RotateCwIcon aria-hidden="true" />
            Reload
          </Button>
        </div>
      ) : null}

      {ledgers.length === 0 ? (
        <div className="mb-4 flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-4 md:flex-row md:items-center md:justify-between md:px-5">
          <div className="min-w-0">
            <h2 className="text-md font-semibold text-text">No trial balance on this statement yet</h2>
            <p className="mt-0.5 text-sm text-text-muted">Load the client&apos;s closing trial balance for FY {financialYear}; every ledger is then mapped to a Schedule III line and the statements are built.</p>
          </div>
          {!readOnly ? <ReplaceTrialBalanceButton id={id} clientId={clientId} fy={financialYear} getUpdatedAt={getUpdatedAt} dirty={dirty} /> : null}
        </div>
      ) : null}

      <KpiStrip
        lead
        className="mb-4"
        aria-label="The statements in figures"
        items={[
          {
            label: t.current.profit < 0 ? "Loss for the year" : "Profit for the year",
            value: <PaiseAmount value={t.current.profit} brackets compact />,
            sub: t.previous ? (
              <>
                FY {previousYear}: <PaiseAmount value={t.previous.profit} brackets compact />
              </>
            ) : (
              "No comparatives"
            ),
          },
          { label: "Total income", value: <PaiseAmount value={t.current.totalIncome} compact />, sub: <>Expenses <PaiseAmount value={t.current.totalExpenses} compact /></> },
          {
            label: "Total assets",
            value: <PaiseAmount value={t.current.assets} compact />,
            sub:
              t.current.assets === t.current.equityAndLiabilities ? (
                "Equal to equity and liabilities"
              ) : (
                <span className="text-danger-text">
                  Differs by <PaiseAmount value={Math.abs(t.current.assets - t.current.equityAndLiabilities)} compact />
                </span>
              ),
          },
          {
            label: "Ledgers mapped",
            value: `${formatCount(mapped)} / ${formatCount(ledgers.length)}`,
            sub: ledgers.length - mapped > 0 ? <span className="text-danger-text">{formatCount(ledgers.length - mapped)} need a Schedule III line</span> : "Every ledger mapped",
          },
        ]}
      />

      <ChecksPanel checks={preview.checks} warnings={preview.warnings} preview={dirty} />

      <TabsPrimitive.Root value={tab} onValueChange={(v) => changeTab(FS_TABS.includes(v as FsTab) ? (v as FsTab) : "balance-sheet")} className="mt-6 flex min-w-0 flex-col">
        <div className="-mx-4 mb-4 overflow-x-auto px-4 [scrollbar-width:thin] md:mx-0 md:px-0">
          <TabsPrimitive.List aria-label="Financial statements" className="flex min-w-max items-center gap-0.5 border-b border-border">
            {(["balance-sheet", "profit-loss", "notes", "ledgers", "disclosures"] as const).map((k) => (
              <TabsPrimitive.Trigger key={k} value={k} className={TAB_CLASS}>
                {FS_TAB_LABELS[k]}
                {tabCount[k] ? <span className={cn("num text-xs tabular-nums", k === "ledgers" ? "text-danger-text" : "text-text-muted")}>{tabCount[k]}</span> : null}
              </TabsPrimitive.Trigger>
            ))}
          </TabsPrimitive.List>
        </div>

        <TabsPrimitive.Content value="balance-sheet" className="min-w-0 outline-none">
          <StatementTable title={`Balance sheet as at ${yearEndedLabel(financialYear)}`} lines={preview.balanceSheet} years={years} onNote={openNote} />
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="profit-loss" className="min-w-0 outline-none">
          <StatementTable title={`Statement of profit and loss for the year ended ${yearEndedLabel(financialYear)}`} lines={preview.profitAndLoss} years={years} onNote={openNote} />
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="notes" className="flex min-w-0 flex-col gap-4 outline-none">
          {preview.notes.map((n) => {
            const isPolicies = n.kind === "text"
            const name = isPolicies ? "policies" : (`noteTexts.${n.key}` as const)
            const saved = isPolicies ? (watched.policies ?? "") : (watched.noteTexts?.[n.key] ?? "")
            if (readOnly) return <NoteView key={n.key} note={n} years={years} extra={saved ? String(saved) : isPolicies ? "Not written." : null} />
            const showField = isPolicies || openNotes.has(n.key) || String(saved).trim() !== ""
            return (
              <NoteView key={n.key} note={n} years={years}>
                {showField ? (
                  <TextareaField
                    control={control}
                    name={name}
                    label={isPolicies ? "Accounting policies" : `Text under note ${n.number}`}
                    hideLabel={isPolicies}
                    rows={isPolicies ? 8 : 3}
                    placeholder={
                      isPolicies
                        ? "Basis of preparation, revenue recognition, property, plant and equipment and depreciation, inventories, employee benefits, taxes on income, provisions and contingent liabilities."
                        : "Security, terms of repayment, or anything else this note discloses."
                    }
                  />
                ) : (
                  <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => setOpenNotes((s) => new Set(s).add(n.key))}>
                    <PlusIcon aria-hidden="true" />
                    Add text under this note
                  </Button>
                )}
              </NoteView>
            )
          })}
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="ledgers" className="min-w-0 outline-none">
          <LedgerMapping
            ledgers={ledgers}
            buckets={buckets}
            readOnly={readOnly}
            onChange={(index, bucket) => setBuckets((b) => b.map((v, i) => (i === index ? bucket : v)))}
            source={
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-muted">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <FileSpreadsheetIcon aria-hidden="true" className="size-4 flex-none" />
                  {sourceFile ? (
                    <a href={`/api/files/documents/${sourceFile.documentId}`} className="truncate text-primary hover:underline" title={sourceFile.fileName}>
                      {sourceFile.fileName}
                    </a>
                  ) : (
                    <span>{inputs.tb?.fileName ?? "Trial balance"}</span>
                  )}
                  {inputs.tb?.sheet ? <span className="truncate">· sheet “{inputs.tb.sheet}”</span> : null}
                  {inputs.tb?.headerRow ? <span className="whitespace-nowrap">· header on row {inputs.tb.headerRow}</span> : null}
                </span>
                {!readOnly ? <ReplaceTrialBalanceButton id={id} clientId={clientId} fy={financialYear} getUpdatedAt={getUpdatedAt} dirty={dirty} /> : null}
              </div>
            }
          />
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="disclosures" className="min-w-0 outline-none">
          <InputsForm control={control} ledgers={effective} tradeReceivables={preview.figures.buckets.trade_receivables ?? 0} tradePayables={preview.figures.buckets.trade_payables ?? 0} readOnly={readOnly} />
        </TabsPrimitive.Content>
      </TabsPrimitive.Root>

      <div className="sticky bottom-0 z-10 -mx-4 mt-6 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-border bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:-mx-6 md:px-6">
        <div className="mr-auto min-w-0">
          {status === "draft" ? (
            draft.savedAt || draft.saving || draft.error ? (
              <DraftStamp savedAt={draft.savedAt} saving={draft.saving} error={draft.error} />
            ) : (
              <p className="text-sm text-text-muted">{dirty ? "Unsaved changes. A draft saves itself every few seconds." : "Every change is saved."}</p>
            )
          ) : status === "reviewed" ? (
            <p className="text-sm text-text-muted">{dirty ? "Saving sends it back to Draft for a fresh review." : "Reviewed. Changing a figure sends it back to Draft."}</p>
          ) : (
            <p className="text-sm text-text-muted">Final and locked.</p>
          )}
        </div>
        <StatusActions id={id} status={status} getUpdatedAt={getUpdatedAt} viewer={viewer} preparedBy={preparedBy} checksPass={!dirty && preview.allChecksPassed} dirty={dirty} />
        {!readOnly ? (
          <Button type="submit" disabled={!dirty || f.pending || Boolean(conflict)} aria-busy={f.pending}>
            {f.pending ? <Spinner /> : null}
            {status === "reviewed" ? "Save and send back" : "Save"}
          </Button>
        ) : null}
      </div>
    </form>
  )
}
