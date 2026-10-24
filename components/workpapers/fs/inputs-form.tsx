"use client"

import * as React from "react"
import { useFieldArray, useWatch, type Control } from "react-hook-form"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DateField, MoneyField, SelectField, SwitchField, TextField } from "@/components/app/form/fields"
import { MSME_DISCLOSURE_ITEMS, PAYABLE_CATEGORIES, PAYABLE_CATEGORY_LABELS, RECEIVABLE_CATEGORIES, RECEIVABLE_CATEGORY_LABELS } from "@/lib/domain/schedule3"
import { paiseToDecimalString, parseAmount, type Paise } from "@/lib/domain/money"
import { PROFIT_TO_LABELS, type FsInputsForm, type StoredLedger } from "@/lib/schemas/financial-statements"
import { PaiseAmount } from "@/components/workpapers/shared/amount"

function Card({ title, description, children, action }: { title: string; description?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-3 md:px-5">
        <div className="min-w-0">
          <h3 className="text-md font-semibold text-text">{title}</h3>
          {description ? <p className="mt-0.5 text-sm text-text-muted">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="flex flex-col gap-4 px-4 pb-4 md:px-5">{children}</div>
    </section>
  )
}

function sumRupees(values: Array<{ amount?: string | number | null } | undefined>): Paise {
  let total = 0
  for (const v of values) {
    const p = parseAmount(String(v?.amount ?? ""))
    if (p.ok) total += p.paise
  }
  return total
}

function AgeingRows({ control, name, categories, labels, against, againstLabel, disabled }: {
  control: Control<FsInputsForm>
  name: "receivables" | "payables"
  categories: readonly string[]
  labels: Record<string, string>
  against: Paise
  againstLabel: string
  disabled: boolean
}) {
  const arr = useFieldArray({ control, name })
  const rows = useWatch({ control, name }) ?? []
  const total = sumRupees(rows)
  const options = categories.map((c) => ({ value: c, label: labels[c] }))
  return (
    <div className="flex flex-col gap-3">
      {arr.fields.length === 0 ? <p className="text-sm text-text-muted">No balances entered yet. Add each outstanding balance with its due date (or the date of the transaction).</p> : null}
      {arr.fields.map((f, i) => (
        <fieldset key={f.id} className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
          <legend className="sr-only">Balance {i + 1}</legend>
          <TextField control={control} name={`${name}.${i}.party`} label="Party" placeholder="Name" />
          <SelectField control={control} name={`${name}.${i}.category`} label="Category" required options={options} />
          <MoneyField control={control} name={`${name}.${i}.amount`} label="Amount" required />
          <DateField control={control} name={`${name}.${i}.dueDate`} label="Due date" />
          <DateField control={control} name={`${name}.${i}.transactionDate`} label="Transaction date" />
          <Button type="button" variant="ghost" size="icon" aria-label={`Remove balance ${i + 1}`} disabled={disabled} onClick={() => arr.remove(i)} className="justify-self-end">
            <Trash2Icon aria-hidden="true" />
          </Button>
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => arr.append({ party: "", category: categories[0] as never, amount: "", dueDate: "", transactionDate: "" })}>
          <PlusIcon aria-hidden="true" />
          Add a balance
        </Button>
        <p className="text-sm text-text-muted">
          Adds up to <PaiseAmount value={total} /> of {againstLabel} <PaiseAmount value={against} />
          {total !== against ? <span className="text-warning-text"> · differs by <PaiseAmount value={Math.abs(total - against)} /></span> : null}
        </p>
      </div>
    </div>
  )
}

/**
 * The inputs besides the trial balance (§6.13): where the year's profit goes, closing stock entered
 * as an adjustment, other movements in capital (for the profit-to-reserves check), the trade
 * receivables and payables ageing schedules and the MSME dues disclosure (Schedule III as amended
 * in 2021). The accounting policies (note 1) and the text under other notes are written on the
 * Notes tab. Rupees as typed; the server turns them into paise and rebuilds the statements on save.
 */
export function InputsForm({ control, ledgers, tradeReceivables, tradePayables, readOnly }: {
  control: Control<FsInputsForm>
  ledgers: StoredLedger[]
  tradeReceivables: Paise
  tradePayables: Paise
  readOnly: boolean
}) {
  const adjustments = useFieldArray({ control, name: "equityAdjustments" })
  const receivablesOn = useWatch({ control, name: "receivablesAgeing" })
  const payablesOn = useWatch({ control, name: "payablesAgeing" })
  const msmeOn = useWatch({ control, name: "msmeEnabled" })
  const drawings = ledgers.filter((l) => /drawing/i.test(l.name) && l.debit > l.credit)
  const drawingsTotal = drawings.reduce((s, l) => s + (l.debit - l.credit), 0)
  const current = useWatch({ control, name: "equityAdjustments" }) ?? []
  const hasDrawings = current.some((a) => /drawing/i.test(a?.label ?? ""))

  return (
    <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-4">
      <legend className="sr-only">Inputs and disclosures</legend>
      <Card title="Profit and closing stock">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SelectField
            control={control}
            name="profitTo"
            label="The year's profit goes to"
            required
            options={(["reserves_surplus", "share_capital"] as const).map((v) => ({ value: v, label: PROFIT_TO_LABELS[v] }))}
          />
          <MoneyField
            control={control}
            name="closingStock"
            label="Closing stock"
            helper="Only when the trial balance doesn't carry it: it is added to inventories and taken off the change in inventories."
          />
        </div>
      </Card>

      <Card
        title="Other movements in capital and reserves"
        description="Capital introduced (+), drawings and dividends (−) for the year, so the profit ties to the movement in capital and reserves."
        action={
          drawings.length > 0 && !hasDrawings && !readOnly ? (
            <Button type="button" variant="outline" size="sm" onClick={() => adjustments.append({ label: "Drawings", amount: `-${paiseToDecimalString(drawingsTotal)}` })}>
              Add drawings of <PaiseAmount value={drawingsTotal} />
            </Button>
          ) : null
        }
      >
        {adjustments.fields.length === 0 ? <p className="text-sm text-text-muted">None entered.</p> : null}
        {adjustments.fields.map((f, i) => (
          <div key={f.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto] items-end gap-3">
            <TextField control={control} name={`equityAdjustments.${i}.label`} label="Movement" required placeholder="Capital introduced" />
            <MoneyField control={control} name={`equityAdjustments.${i}.amount`} label="Amount" required allowNegative />
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove movement ${i + 1}`} onClick={() => adjustments.remove(i)}>
              <Trash2Icon aria-hidden="true" />
            </Button>
          </div>
        ))}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => adjustments.append({ label: "", amount: "" })}>
            <PlusIcon aria-hidden="true" />
            Add a movement
          </Button>
        </div>
      </Card>

      <Card title="Trade receivables ageing" description="Schedule III (2021): outstanding from the due date of payment, in four categories.">
        <SwitchField control={control} name="receivablesAgeing" label="Include the receivables ageing schedule" description="Adds the schedule as a note and checks it against trade receivables." />
        {receivablesOn ? (
          <AgeingRows control={control} name="receivables" categories={RECEIVABLE_CATEGORIES} labels={RECEIVABLE_CATEGORY_LABELS} against={tradeReceivables} againstLabel="trade receivables" disabled={readOnly} />
        ) : null}
      </Card>

      <Card title="Trade payables ageing" description="Schedule III (2021): MSME and others, and disputed dues of each.">
        <SwitchField control={control} name="payablesAgeing" label="Include the payables ageing schedule" description="Adds the schedule as a note, splits trade payables into MSME and others, and checks it." />
        {payablesOn ? (
          <AgeingRows control={control} name="payables" categories={PAYABLE_CATEGORIES} labels={PAYABLE_CATEGORY_LABELS} against={tradePayables} againstLabel="trade payables" disabled={readOnly} />
        ) : null}
      </Card>

      <Card title="Dues to micro and small enterprises" description="The MSMED Act, 2006 disclosure Schedule III asks for.">
        <SwitchField control={control} name="msmeEnabled" label="Include the MSME disclosure" />
        {msmeOn ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {MSME_DISCLOSURE_ITEMS.map((item) => (
              <MoneyField key={item.key} control={control} name={`msme.${item.key}`} label={item.label} />
            ))}
          </div>
        ) : null}
      </Card>
    </fieldset>
  )
}
