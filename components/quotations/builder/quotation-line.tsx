"use client"

import * as React from "react"
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from "lucide-react"
import { useController, type Control, type UseFormSetValue } from "react-hook-form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { MoneyInput } from "@/components/app/form/money-input"
import { Money } from "@/components/app/money"
import { fieldDomId } from "@/hooks/use-action-form"
import { SERVICE_FREQUENCIES, SERVICE_FREQUENCY_LABELS, SERVICE_TYPES, SERVICE_TYPE_LABELS, type ServiceType } from "@/lib/domain/enums"
import { fromPaise } from "@/lib/domain/money"
import { QUOTATION_TAX_RATES, SERVICE_LINE_DEFAULTS, type QuotationDraftValues } from "@/lib/schemas/quotations"

type Form = QuotationDraftValues

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

/** The grid the header row and every line share (desktop): description, service + frequency, qty, unit price, GST, line total, actions. */
export const LINE_GRID = "lg:grid-cols-[minmax(0,1fr)_9.5rem_4.5rem_8.5rem_6.5rem_7.5rem_6.25rem]"

const RATE_SHORT: Record<string, string> = { "18": "18%", "5": "5%", "0": "0% exempt", "40": "40%" }

/**
 * One quotation line (§7.5.2): description*, service, frequency, qty* (1), unit price* (₹), GST %*
 * (18 default) and the line total (computed, before GST, with the GST under it). Choosing a service
 * on an empty line fills its usual description. Reordered with the up / down buttons (keyboard and
 * touch alike). A grid row on desktop, a stacked card on phones.
 */
export function QuotationLine({
  control,
  index,
  count,
  setValue,
  amountPaise,
  taxPaise,
  onRemove,
  onMove,
}: {
  control: Control<Form>
  index: number
  count: number
  setValue: UseFormSetValue<Form>
  amountPaise: number
  taxPaise: number
  onRemove: () => void
  onMove: (to: number) => void
}) {
  const { field: descriptionField, error: descriptionError, id: descriptionId } = useLineField(control, index, "description")
  const { field: serviceField, id: serviceId } = useLineField(control, index, "service_type")
  const { field: frequencyField, id: frequencyId } = useLineField(control, index, "frequency")
  const { field: qtyField, error: qtyError, id: qtyId } = useLineField(control, index, "quantity")
  const { field: priceField, error: priceError, id: priceId } = useLineField(control, index, "unit_price")
  const { field: taxField, error: taxError, id: taxId } = useLineField(control, index, "tax_rate")
  const n = index + 1

  return (
    <li className="border-b border-border/70 px-4 py-3 last:border-b-0 md:px-5">
      <div className={`grid grid-cols-2 gap-x-3 gap-y-2 md:grid-cols-4 ${LINE_GRID} lg:items-start`}>
        <div className="col-span-2 md:col-span-4 lg:col-span-1">
          <label htmlFor={descriptionId} className="text-xs font-medium text-text-muted lg:sr-only">
            Line {n}: description <span aria-hidden="true">*</span>
          </label>
          <Textarea
            id={descriptionId}
            rows={1}
            value={String(descriptionField.value ?? "")}
            onChange={descriptionField.onChange}
            onBlur={descriptionField.onBlur}
            aria-invalid={descriptionError ? true : undefined}
            aria-describedby={descriptionError ? `${descriptionId}-err` : undefined}
            aria-required
            placeholder="GST compliance: GSTR-1, GSTR-3B and reconciliation"
            className="min-h-9 resize-y py-1.5"
          />
          <Err id={`${descriptionId}-err`}>{descriptionError}</Err>
        </div>
        <div className="col-span-2 grid grid-cols-2 gap-2 lg:col-span-1 lg:grid-cols-1 lg:gap-1.5">
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
                  const prev = String(serviceField.value ?? "")
                  serviceField.onChange(next)
                  const current = String(descriptionField.value ?? "").trim()
                  const prevDefault = prev ? SERVICE_LINE_DEFAULTS[prev as ServiceType] : ""
                  if (next && (current === "" || current === prevDefault)) {
                    setValue(`lines.${index}.description` as never, SERVICE_LINE_DEFAULTS[next as ServiceType] as never, { shouldDirty: true })
                  }
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
            <label htmlFor={frequencyId} className="text-xs font-medium text-text-muted lg:sr-only">
              Frequency
            </label>
            <div className="[&>[data-slot=native-select-wrapper]]:w-full">
              <NativeSelect id={frequencyId} value={String(frequencyField.value ?? "")} aria-label={`Line ${n} frequency`} onChange={(e) => frequencyField.onChange(e.target.value)}>
                <NativeSelectOption value="">No frequency</NativeSelectOption>
                {SERVICE_FREQUENCIES.map((f) => (
                  <NativeSelectOption key={f} value={f}>
                    {SERVICE_FREQUENCY_LABELS[f]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </div>
        </div>
        <div>
          <label htmlFor={qtyId} className="text-xs font-medium text-text-muted lg:sr-only">
            Qty <span aria-hidden="true">*</span>
          </label>
          <Input
            id={qtyId}
            inputMode="decimal"
            value={String(qtyField.value ?? "")}
            onChange={(e) => qtyField.onChange(e.target.value.replace(/[^\d.]/g, ""))}
            onBlur={qtyField.onBlur}
            aria-label={`Line ${n} quantity`}
            aria-invalid={qtyError ? true : undefined}
            aria-describedby={qtyError ? `${qtyId}-err` : undefined}
            aria-required
            className="num text-right tabular-nums"
          />
          <Err id={`${qtyId}-err`}>{qtyError}</Err>
        </div>
        <div>
          <label htmlFor={priceId} className="text-xs font-medium text-text-muted lg:sr-only">
            Unit price (₹) <span aria-hidden="true">*</span>
          </label>
          <MoneyInput
            id={priceId}
            value={priceField.value as string}
            onChange={priceField.onChange}
            onBlur={priceField.onBlur}
            aria-label={`Line ${n} unit price in rupees`}
            aria-invalid={priceError ? true : undefined}
            aria-describedby={priceError ? `${priceId}-err` : undefined}
            aria-required
          />
          <Err id={`${priceId}-err`}>{priceError}</Err>
        </div>
        <div>
          <label htmlFor={taxId} className="text-xs font-medium text-text-muted lg:sr-only">
            GST % <span aria-hidden="true">*</span>
          </label>
          <div className="[&>[data-slot=native-select-wrapper]]:w-full">
            <NativeSelect id={taxId} value={String(taxField.value ?? "18")} aria-label={`Line ${n} GST rate`} onChange={(e) => taxField.onChange(e.target.value)}>
              {QUOTATION_TAX_RATES.map((r) => (
                <NativeSelectOption key={r} value={r}>
                  {RATE_SHORT[r] ?? `${r}%`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <Err id={`${taxId}-err`}>{taxError}</Err>
        </div>
        <div className="flex flex-col items-end justify-center md:col-span-2 lg:col-span-1 lg:min-h-9">
          <span className="text-xs font-medium text-text-muted lg:sr-only">Line total</span>
          <span className="num text-base text-text tabular-nums">
            <Money value={fromPaise(amountPaise)} />
          </span>
          {taxPaise > 0 ? (
            <span className="num text-xs text-text-muted tabular-nums">
              + GST <Money value={fromPaise(taxPaise)} />
            </span>
          ) : null}
        </div>
        <div className="col-span-2 flex items-center justify-end gap-0.5 md:col-span-1 lg:h-9">
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => onMove(index - 1)} disabled={index === 0} aria-label={`Move line ${n} up`} className="text-text-muted">
            <ArrowUpIcon aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => onMove(index + 1)} disabled={index >= count - 1} aria-label={`Move line ${n} down`} className="text-text-muted">
            <ArrowDownIcon aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onRemove} disabled={count <= 1} aria-label={`Remove line ${n}`} className="text-text-muted hover:text-danger-text">
            <Trash2Icon aria-hidden="true" />
          </Button>
        </div>
      </div>
    </li>
  )
}
