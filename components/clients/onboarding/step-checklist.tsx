"use client"

import * as React from "react"
import { useController } from "react-hook-form"
import { LockIcon, PaperclipIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import { ATTACHMENT_ACCEPT, checkAttachment } from "@/lib/schemas/clients"
import { customChecklistItem, suggestedChecklist, type ChecklistItemValue, type OnboardingValues } from "@/lib/schemas/onboarding"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { fieldDomId } from "@/hooks/use-action-form"
import type { OnboardingControl } from "@/components/clients/onboarding/types"

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Step 4, Document checklist (§7.3.2): the engagement letter and authorisation letter always, the
 * suggestions for each selected service (pre-ticked, removable), the audit acceptance steps
 * (locked), custom items, "collected" with an optional file, and "I've reviewed this checklist".
 * Files are kept in the browser and filed in the client's vault right after Complete.
 */
export function StepChecklist({
  control,
  values,
  onChange,
  files,
  onFile,
}: {
  control: OnboardingControl
  values: OnboardingValues
  onChange: (next: ChecklistItemValue[]) => void
  files: Record<string, File>
  onFile: (key: string, file: File | null) => void
}) {
  const items = (values.checklist ?? []) as ChecklistItemValue[]
  const services = (values.services ?? []).map((s) => s.service_type)
  const suggestions = suggestedChecklist(services)
  const [custom, setCustom] = React.useState("")
  const [fileError, setFileError] = React.useState<{ key: string; message: string } | null>(null)
  const customId = React.useId()
  const { field: reviewedField, fieldState: reviewedState } = useController({ control, name: "checklist_reviewed" })
  const { ref: reviewedRef, value: reviewedValue, onChange: setReviewed, onBlur: blurReviewed } = reviewedField
  const reviewedId = fieldDomId(control, "checklist_reviewed")

  const update = (key: string, patch: Partial<ChecklistItemValue>) => {
    onChange(items.map((i) => (i.key === key ? { ...i, ...patch } : i)))
  }

  const originLabel = (item: ChecklistItemValue): string => {
    if (item.origin === "always") return "Always"
    if (item.origin === "acceptance") return "Audit acceptance"
    if (item.origin === "custom") return "Added by you"
    const s = suggestions.find((x) => x.key === item.key)
    return s ? s.services.map((t) => SERVICE_TYPE_LABELS[t]).join(", ") : "Suggested"
  }

  const addCustom = () => {
    const item = customChecklistItem(custom, items)
    if (!item) return
    onChange([...items, item])
    setCustom("")
  }

  const included = items.filter((i) => i.included).length
  const collected = items.filter((i) => i.included && i.collected).length

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-text-muted">
        <span className="num tabular-nums">{included}</span> {included === 1 ? "item" : "items"} on the checklist,{" "}
        <span className="num tabular-nums">{collected}</span> already collected. Untick a suggestion to leave it off.
      </p>
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
        {items.map((item) => {
          const cid = `chk-${item.key}`
          const file = files[item.key]
          return (
            <li key={item.key} className={cn("flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4", !item.included && "bg-surface-2/50")}>
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <Checkbox
                  id={`${cid}-inc`}
                  checked={item.included}
                  disabled={item.locked}
                  onCheckedChange={(v) => update(item.key, { included: v === true, collected: v === true ? item.collected : false })}
                  className="mt-0.5"
                  aria-describedby={`${cid}-origin`}
                />
                <label htmlFor={`${cid}-inc`} className={cn("min-w-0 cursor-pointer", item.locked && "cursor-default")}>
                  <span className={cn("block text-base", item.included ? "text-text" : "text-text-muted line-through")}>{item.label}</span>
                  <span id={`${cid}-origin`} className="flex items-center gap-1 text-sm text-text-muted">
                    {item.locked ? <LockIcon aria-hidden="true" className="size-3" /> : null}
                    {originLabel(item)}
                    {item.locked ? " · can't be removed" : ""}
                  </span>
                </label>
              </div>
              {item.included ? (
                <div className="flex flex-wrap items-center gap-3 pl-7 sm:pl-0">
                  <label className="flex cursor-pointer items-center gap-2 text-base text-text">
                    <Checkbox
                      checked={item.collected}
                      onCheckedChange={(v) => {
                        update(item.key, { collected: v === true })
                        if (v !== true) onFile(item.key, null)
                      }}
                    />
                    Collected
                  </label>
                  {item.collected ? (
                    file ? (
                      <span className="inline-flex max-w-56 items-center gap-1 rounded-full border border-border bg-surface-2 py-0.5 pr-1 pl-2.5 text-sm text-text">
                        <PaperclipIcon aria-hidden="true" className="size-3 flex-none text-text-muted" />
                        <span className="truncate">{file.name}</span>
                        <span className="num flex-none text-text-muted tabular-nums">{formatBytes(file.size)}</span>
                        <button
                          type="button"
                          onClick={() => onFile(item.key, null)}
                          aria-label={`Remove ${file.name}`}
                          className="inline-flex size-5 flex-none cursor-pointer items-center justify-center rounded-full text-text-muted hover:bg-surface hover:text-text focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-8"
                        >
                          <XIcon aria-hidden="true" className="size-3" />
                        </button>
                      </span>
                    ) : (
                      <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm font-medium text-text hover:bg-surface-2 focus-within:outline-2 focus-within:outline-ring">
                        <PaperclipIcon aria-hidden="true" className="size-4 text-text-muted" />
                        Attach file
                        <input
                          type="file"
                          accept={ATTACHMENT_ACCEPT}
                          className="sr-only"
                          aria-label={`Attach the file for ${item.label}`}
                          onChange={(e) => {
                            const f = e.target.files?.[0]
                            e.target.value = ""
                            if (!f) return
                            const check = checkAttachment({ name: f.name, size: f.size })
                            if (!check.ok) {
                              setFileError({ key: item.key, message: check.error })
                              return
                            }
                            setFileError(null)
                            onFile(item.key, f)
                          }}
                        />
                      </label>
                    )
                  ) : null}
                  {item.origin === "custom" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${item.label}`}
                      onClick={() => {
                        onFile(item.key, null)
                        onChange(items.filter((i) => i.key !== item.key))
                      }}
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
              ) : item.origin === "custom" ? (
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${item.label}`} onClick={() => onChange(items.filter((i) => i.key !== item.key))}>
                  <Trash2Icon aria-hidden="true" />
                </Button>
              ) : null}
              {fileError?.key === item.key ? (
                <p role="alert" className="text-sm text-danger-text sm:basis-full">
                  {fileError.message}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={customId} className="text-sm leading-5 font-medium text-text">
          Add custom item
        </label>
        <div className="flex gap-2">
          <Input
            id={customId}
            value={custom}
            maxLength={200}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addCustom()
              }
            }}
            placeholder="For example: Partnership deed"
            className="min-w-0 flex-1"
          />
          <Button type="button" variant="outline" onClick={addCustom} disabled={!custom.trim()}>
            <PlusIcon aria-hidden="true" />
            Add
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface px-4 py-3">
        <div className="flex items-start gap-3">
          <Checkbox
            id={reviewedId}
            ref={reviewedRef}
            checked={!!reviewedValue}
            onCheckedChange={(v) => {
              setReviewed(v === true)
              blurReviewed()
            }}
            aria-invalid={reviewedState.error ? true : undefined}
            aria-describedby={reviewedState.error ? `${reviewedId}-error` : undefined}
            className="mt-0.5"
          />
          <label htmlFor={reviewedId} className="cursor-pointer text-base font-medium text-text">
            I&apos;ve reviewed this checklist<span aria-hidden="true" className="ml-0.5 text-danger-text">*</span>
            <span className="block text-sm font-normal text-text-muted">The items still to collect go into the first tasks, due in 14 days.</span>
          </label>
        </div>
        {reviewedState.error ? (
          <p id={`${reviewedId}-error`} className="mt-1 pl-7 text-sm text-danger-text">
            {reviewedState.error.message}
          </p>
        ) : null}
      </div>
    </div>
  )
}

