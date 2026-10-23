"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useFieldArray, useWatch } from "react-hook-form"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { SwitchField, TextField, TextareaField } from "@/components/app/form/fields"
import { NativeSelectField } from "@/components/tasks/native-select-field"
import { useActionForm } from "@/hooks/use-action-form"
import { SERVICE_OPTIONS } from "@/lib/schemas/tasks"
import { JobTemplateSchema, TEMPLATE_STEP_MAX, offsetLabel } from "@/lib/schemas/job-templates"
import type { ServiceType } from "@/lib/domain/enums"
import { saveJobTemplate } from "@/server/actions/job-templates"

/**
 * A job template (§5.5, §7.6.2): name, service, what it covers, how many days before the due date
 * the job usually starts (lead days), and its steps, each a number of days before (or after) the
 * job's due date. Applying it to a task adds the steps to the checklist with those dates. Saved
 * in one go with optimistic concurrency.
 */

export type TemplateForEdit = {
  id: string
  name: string
  service_type: ServiceType
  description: string | null
  default_lead_days: number | null
  is_active: boolean
  updated_at: string
  items: Array<{ id: string; title: string; description: string | null; offset_days: number }>
}

type Side = "before" | "after"

function splitOffset(offset: number): { days: string; side: Side } {
  return { days: String(Math.abs(offset)), side: offset < 0 ? "after" : "before" }
}

export function TemplateDialog({ open, onOpenChange, template }: { open: boolean; onOpenChange: (open: boolean) => void; template?: TemplateForEdit | null }) {
  const router = useRouter()
  const f = useActionForm(JobTemplateSchema, saveJobTemplate, {
    defaultValues: {
      id: template?.id ?? "",
      expected_updated_at: template?.updated_at ?? null,
      name: template?.name ?? "",
      service_type: template?.service_type ?? "gst",
      description: template?.description ?? "",
      default_lead_days: template?.default_lead_days === null || template?.default_lead_days === undefined ? "" : String(template.default_lead_days),
      is_active: template?.is_active ?? true,
      items: template?.items.length ? template.items.map((i) => ({ id: i.id, title: i.title, description: i.description ?? "", offset_days: i.offset_days })) : [{ id: "", title: "", description: "", offset_days: 0 }],
    },
    successMessage: template ? "Template saved." : "Template created.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  const items = useFieldArray({ control: f.control, name: "items" })
  const values = useWatch({ control: f.control, name: "items" })
  const itemErrors = f.form.formState.errors.items

  const setOffset = (i: number, days: string, side: Side) => {
    const n = Number(days)
    const v = days === "" || !Number.isFinite(n) ? "" : side === "after" ? -Math.abs(n) : Math.abs(n)
    f.form.setValue(`items.${i}.offset_days`, v as never, { shouldDirty: true, shouldValidate: true })
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={template ? "Edit job template" : "New job template"}
      description="Steps get their dates from the job's due date when the template is applied to a task."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={template ? "Save template" : "Create template"}
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField control={f.control} name="name" label="Name" required maxLength={120} placeholder="Monthly GST filing" />
        <NativeSelectField control={f.control} name="service_type" label="Service" required options={SERVICE_OPTIONS} />
        <TextareaField control={f.control} name="description" label="What it covers" rows={2} className="md:col-span-2" />
        <TextField
          control={f.control}
          name="default_lead_days"
          label="Lead days"
          inputMode="numeric"
          placeholder="10"
          helper="How many days before the due date the job usually starts. Recurring tasks are created this early."
        />
        <SwitchField control={f.control} name="is_active" label="Active" description="Inactive templates stay on the tasks that used them but can't be applied again." className="self-end" />
      </div>

      <fieldset className="mt-6">
        <legend className="mb-2 text-sm font-semibold text-text">Steps</legend>
        {typeof itemErrors?.message === "string" ? <p className="mb-2 text-sm text-danger-text">{itemErrors.message}</p> : null}
        <ol className="flex flex-col gap-3">
          {items.fields.map((field, i) => {
            const raw = values?.[i]?.offset_days
            const offset = typeof raw === "number" ? raw : Number(raw ?? 0) || 0
            const { days, side } = splitOffset(offset)
            const err = Array.isArray(itemErrors) ? itemErrors[i] : undefined
            return (
              <li key={field.id} className="rounded-md border border-border p-3">
                <div className="flex items-start gap-2">
                  <span className="num mt-2 w-5 flex-none text-sm text-text-muted tabular-nums">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <Input aria-label={`Step ${i + 1}`} placeholder="What needs doing" maxLength={300} aria-invalid={err?.title ? true : undefined} {...f.form.register(`items.${i}.title` as const)} />
                    {err?.title?.message ? <p className="mt-1 text-sm text-danger-text">{err.title.message}</p> : null}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Input
                        aria-label={`Days for step ${i + 1}`}
                        inputMode="numeric"
                        className="w-20"
                        value={days}
                        onChange={(e) => setOffset(i, e.target.value.replace(/[^\d]/g, ""), side)}
                      />
                      <div className="[&>[data-slot=native-select-wrapper]]:w-auto">
                        <NativeSelect aria-label={`Before or after the due date, step ${i + 1}`} value={side} onChange={(e) => setOffset(i, days, e.target.value as Side)} size="sm">
                          <NativeSelectOption value="before">days before the due date</NativeSelectOption>
                          <NativeSelectOption value="after">days after the due date</NativeSelectOption>
                        </NativeSelect>
                      </div>
                      <span className="text-sm text-text-muted">{offsetLabel(offset)}</span>
                    </div>
                    {err?.offset_days?.message ? <p className="mt-1 text-sm text-danger-text">{err.offset_days.message}</p> : null}
                    <Input className="mt-2" aria-label={`Note for step ${i + 1}`} placeholder="Note (optional)" maxLength={2000} {...f.form.register(`items.${i}.description` as const)} />
                  </div>
                  <div className="flex flex-none flex-col">
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => items.move(i, i - 1)}>
                      <ArrowUpIcon aria-hidden="true" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move step ${i + 1} down`} disabled={i === items.fields.length - 1} onClick={() => items.move(i, i + 1)}>
                      <ArrowDownIcon aria-hidden="true" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove step ${i + 1}`} disabled={items.fields.length === 1} onClick={() => items.remove(i)}>
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
        <Button type="button" variant="outline" size="sm" className="mt-3" disabled={items.fields.length >= TEMPLATE_STEP_MAX} onClick={() => items.append({ id: "", title: "", description: "", offset_days: 0 })}>
          <PlusIcon aria-hidden="true" />
          Add step
        </Button>
      </fieldset>
    </FormDialog>
  )
}

/** "New template" for the page header. */
export function NewTemplateButton() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        New template
      </Button>
      {open ? <TemplateDialog open={open} onOpenChange={setOpen} /> : null}
    </>
  )
}
