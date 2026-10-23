"use client"

import * as React from "react"
import { Trash2Icon } from "lucide-react"
import { useController, useWatch, type Control, type UseFormSetValue } from "react-hook-form"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { MoneyInput } from "@/components/app/form/money-input"
import { Money } from "@/components/app/money"
import { fieldDomId } from "@/hooks/use-action-form"
import { SERVICE_TYPES, SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import { fromPaise } from "@/lib/domain/money"
import { reimbursementDescription, type RateOption } from "@/lib/domain/gst"
import { sacForService, type InvoiceFormInput } from "@/lib/schemas/invoices"
import type { EditorSettings } from "@/components/invoices/editor/types"

type Form = InvoiceFormInput & { intent?: string }

function useLineField(control: Control<Form>, index: number, name: string) {
  const path = `lines.${index}.${name}` as never
  const { field, fieldState } = useController({ control, name: path })
  return { field, error: fieldState.error?.message ?? null, id: fieldDomId(control, `lines.${index}.${name}`) }
}

function Err({ id, children }: { id: string; children: string | null }) {
  if (!children) return null
  return (
    <p id={id} className="mt-1 text-xs text-danger-text">
      {children}
    </p>
  )
}

/**
 * One invoice line (§7.9.2): description, service (fills the SAC from the firm's map), SAC, quantity,
 * rate, GST % (18 default; 0 for a reimbursement; "other" needs a reason), the Reimbursement (pure
 * agent) toggle, and the line amount. A grid row on desktop, a stacked card on phones.
 */
export function LineRow({
  control,
  index,
  setValue,
  settings,
  rateOptions,
  amountPaise,
  onRemove,
  canRemove,
}: {
  control: Control<Form>
  index: number
  setValue: UseFormSetValue<Form>
  settings: EditorSettings
  rateOptions: RateOption[]
  amountPaise: number
  onRemove: () => void
  canRemove: boolean
}) {
  const { field: descriptionField, error: descriptionError, id: descriptionId } = useLineField(control, index, "description")
  const { field: serviceField, id: serviceId } = useLineField(control, index, "service_type")
  const { field: sacField, error: sacError, id: sacId } = useLineField(control, index, "sac_code")
  const { field: qtyField, error: qtyError, id: qtyId } = useLineField(control, index, "quantity")
  const { field: rateField, error: rateError, id: rateId } = useLineField(control, index, "rate")
  const { field: taxField, error: taxError, id: taxId } = useLineField(control, index, "tax_rate")
  const { field: reasonField, error: reasonError, id: reasonId } = useLineField(control, index, "tax_rate_reason")
  const { field: reimbField } = useLineField(control, index, "is_reimbursement")
  const sourceLabel = useWatch({ control, name: `lines.${index}.source_label` as never }) as string | undefined
  const isReimb = Boolean(reimbField.value)
  const taxValue = String(taxField.value ?? "")
  const listed = rateOptions.some((o) => typeof o.value === "number" && String(o.value) === taxValue)
  const [other, setOther] = React.useState(!listed && taxValue !== "")
  const n = index + 1

  return (
    <li className="border-b border-border/70 px-4 py-3 last:border-b-0 md:px-5">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 md:grid-cols-[minmax(0,1fr)_9rem_6.5rem] lg:grid-cols-[minmax(0,1fr)_9rem_6.5rem_4.5rem_8.5rem_7rem_7.5rem_2.25rem] lg:items-start">
        <div className="col-span-2 md:col-span-1">
          <label htmlFor={descriptionId} className="text-xs font-medium text-text-muted lg:sr-only">
            Line {n}: description
          </label>
          <Textarea
            id={descriptionId}
            rows={1}
            value={String(descriptionField.value ?? "")}
            onChange={descriptionField.onChange}
            onBlur={() => {
              if (isReimb) descriptionField.onChange(reimbursementDescription(String(descriptionField.value ?? "")))
              descriptionField.onBlur()
            }}
            aria-invalid={descriptionError ? true : undefined}
            aria-describedby={descriptionError ? `${descriptionId}-err` : undefined}
            aria-label={`Line ${n} description`}
            placeholder="GST compliance for September 2026"
            className="min-h-9 resize-y py-1.5"
          />
          <Err id={`${descriptionId}-err`}>{descriptionError}</Err>
          {sourceLabel ? <p className="mt-1 text-xs text-text-muted">{sourceLabel}</p> : null}
        </div>
        <div>
          <label htmlFor={serviceId} className="text-xs font-medium text-text-muted lg:sr-only">
            Service
          </label>
          <div className="[&>[data-slot=native-select-wrapper]]:w-full">
            <NativeSelect
              id={serviceId}
              value={String(serviceField.value ?? "")}
              aria-label={`Line ${n} service`}
              onChange={(e) => {
                const next = e.target.value
                const prevAuto = sacForService(String(serviceField.value ?? ""), settings.sacByService, settings.defaultSac)
                serviceField.onChange(next)
                const cur = String(sacField.value ?? "")
                if (cur === "" || cur === prevAuto) setValue(`lines.${index}.sac_code` as never, sacForService(next, settings.sacByService, settings.defaultSac) as never, { shouldDirty: true })
              }}
            >
              <NativeSelectOption value="">No service</NativeSelectOption>
              {SERVICE_TYPES.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {SERVICE_TYPE_LABELS[s]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
        <div>
          <label htmlFor={sacId} className="text-xs font-medium text-text-muted lg:sr-only">
            SAC
          </label>
          <Input
            id={sacId}
            inputMode="numeric"
            value={String(sacField.value ?? "")}
            onChange={(e) => sacField.onChange(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
            onBlur={sacField.onBlur}
            aria-label={`Line ${n} SAC`}
            aria-invalid={sacError ? true : undefined}
            placeholder={settings.defaultSac}
            className="num tabular-nums"
          />
          <Err id={`${sacId}-err`}>{sacError}</Err>
        </div>
        <div>
          <label htmlFor={qtyId} className="text-xs font-medium text-text-muted lg:sr-only">
            Qty
          </label>
          <Input
            id={qtyId}
            inputMode="decimal"
            value={String(qtyField.value ?? "")}
            onChange={(e) => qtyField.onChange(e.target.value.replace(/[^\d.]/g, ""))}
            onBlur={qtyField.onBlur}
            aria-label={`Line ${n} quantity`}
            aria-invalid={qtyError ? true : undefined}
            className="num text-right tabular-nums"
          />
          <Err id={`${qtyId}-err`}>{qtyError}</Err>
        </div>
        <div>
          <label htmlFor={rateId} className="text-xs font-medium text-text-muted lg:sr-only">
            Rate (₹)
          </label>
          <MoneyInput
            id={rateId}
            value={rateField.value as string}
            onChange={rateField.onChange}
            onBlur={rateField.onBlur}
            aria-label={`Line ${n} rate in rupees`}
            aria-invalid={rateError ? true : undefined}
          />
          <Err id={`${rateId}-err`}>{rateError}</Err>
        </div>
        <div>
          <label htmlFor={taxId} className="text-xs font-medium text-text-muted lg:sr-only">
            GST
          </label>
          {isReimb ? (
            <p className="flex h-9 items-center text-sm text-text-muted" title="A reimbursement (pure agent, Rule 33) carries no GST">
              No GST
            </p>
          ) : (
            <div className="[&>[data-slot=native-select-wrapper]]:w-full">
              <NativeSelect
                id={taxId}
                aria-label={`Line ${n} GST rate`}
                value={other ? "other" : taxValue}
                onChange={(e) => {
                  if (e.target.value === "other") {
                    setOther(true)
                    return
                  }
                  setOther(false)
                  taxField.onChange(e.target.value)
                  setValue(`lines.${index}.tax_rate_reason` as never, "" as never)
                }}
              >
                {rateOptions.map((o) => (
                  <NativeSelectOption key={String(o.value)} value={String(o.value)}>
                    {o.value === "other" ? "Other" : o.value === 0 ? "0% / exempt" : `${o.value}%`}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          <Err id={`${taxId}-err`}>{taxError}</Err>
        </div>
        <div className="flex flex-col items-end justify-center lg:h-9">
          <span className="text-xs font-medium text-text-muted lg:sr-only">Amount</span>
          <span className="num text-base text-text tabular-nums">
            <Money value={fromPaise(amountPaise)} />
          </span>
        </div>
        <div className="col-span-2 flex items-center justify-end md:col-span-3 lg:col-span-1 lg:h-9">
          <Button type="button" variant="ghost" size="icon-sm" onClick={onRemove} disabled={!canRemove} aria-label={`Remove line ${n}`} className="text-text-muted hover:text-danger-text">
            <Trash2Icon aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2">
        <label className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-sm text-text">
          <Checkbox
            checked={isReimb}
            onCheckedChange={(v) => {
              const on = v === true
              reimbField.onChange(on)
              if (on) {
                setOther(false)
                setValue(`lines.${index}.tax_rate` as never, "0" as never, { shouldDirty: true })
                setValue(`lines.${index}.tax_rate_reason` as never, "" as never)
                setValue(`lines.${index}.description` as never, reimbursementDescription(String(descriptionField.value ?? "")) as never, { shouldDirty: true })
              } else {
                setValue(`lines.${index}.tax_rate` as never, "18" as never, { shouldDirty: true })
              }
            }}
            aria-label={`Line ${n}: reimbursement of expenses as pure agent`}
          />
          Reimbursement (pure agent, no GST)
        </label>
        {other && !isReimb ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              inputMode="decimal"
              value={taxValue}
              onChange={(e) => taxField.onChange(e.target.value.replace(/[^\d.]/g, ""))}
              aria-label={`Line ${n} other GST rate in percent`}
              className={cn("num w-20 text-right tabular-nums")}
              placeholder="%"
            />
            <Input
              id={reasonId}
              value={String(reasonField.value ?? "")}
              onChange={reasonField.onChange}
              onBlur={reasonField.onBlur}
              aria-label={`Line ${n}: reason for the other GST rate`}
              aria-invalid={reasonError ? true : undefined}
              placeholder="Reason for this rate"
              className="w-64 max-w-full"
            />
            <Err id={`${reasonId}-err`}>{reasonError}</Err>
          </div>
        ) : null}
      </div>
    </li>
  )
}
