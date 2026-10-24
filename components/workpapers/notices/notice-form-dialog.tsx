"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWatch } from "react-hook-form"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { ComboboxField, DateField, MoneyField, TextField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { taxYearLabel } from "@/lib/domain/fy"
import {
  NOTICE_TYPE_PRESETS,
  NoticeFormSchema,
  OTHER_TYPE,
  TAX_AREAS,
  TAX_AREA_LABEL,
  presetFor,
  type NoticeFormInput,
  type TaxArea,
} from "@/lib/schemas/notices"
import { saveNotice, searchNoticeClients } from "@/server/actions/notices"
import { NativeSelectField, TimeField, type NativeOption } from "@/components/workpapers/notices/fields"

export type NoticeFormContext = {
  /** Who the notice can be assigned to: everyone active (Partner/Manager) or just the viewer (Employee). */
  staff: NativeOption[]
  /** The financial years a notice can be about, newest first. */
  years: string[]
  canAssignOthers: boolean
}

const STATUS_AT_LOGGING: NativeOption[] = [
  { value: "open", label: "Open: not answered yet" },
  { value: "reply_drafted", label: "Reply drafted" },
  { value: "replied", label: "Replied" },
  { value: "hearing", label: "Hearing fixed" },
]

const TYPE_GROUPS = (["gst", "income_tax", "tds"] as const).map((area) => ({
  label: TAX_AREA_LABEL[area],
  options: NOTICE_TYPE_PRESETS.filter((p) => p.area === area).map((p) => ({ value: p.value, label: `${p.value} · ${p.hint}` })),
}))

/**
 * Log or edit a notice (§7.8.4): the client, the type (a common one from the list, or typed), the
 * section, authority and reference/DIN, the dates (reply due is required; the hearing has a time),
 * the demand, a description and who it is assigned to. A new notice can be logged at the step it
 * has reached (a notice already replied to when the client came to the firm). The footer stays
 * visible (§0.1 rule 4).
 */
export function NoticeFormDialog({
  open,
  onOpenChange,
  initial,
  fixedClient,
  context,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: NoticeFormInput
  /** The client is fixed (editing, or logging from Client 360). */
  fixedClient?: { id: string; label: string } | null
  context: NoticeFormContext
  onSaved?: (id: string, created: boolean) => void
}) {
  const router = useRouter()
  const editing = Boolean(initial.id)
  const f = useActionForm(NoticeFormSchema, saveNotice, {
    defaultValues: initial,
    successMessage: editing ? "Notice saved." : "Notice logged.",
    onSuccess: (r) => {
      onOpenChange(false)
      if (onSaved) onSaved(r.id, r.created)
      else if (r.created) router.push(`/workpapers/notices/${r.id}`)
      else router.refresh()
    },
  })
  const { control, setValue, getValues } = f.form
  const choice = useWatch({ control, name: "type_choice" }) as string
  const status = useWatch({ control, name: "status" }) as string

  const onChoice = (value: string) => {
    if (value === OTHER_TYPE || value === "") {
      if (presetFor(String(getValues("notice_type") ?? ""))) setValue("notice_type", "", { shouldDirty: true })
      return
    }
    const p = presetFor(value)
    setValue("notice_type", value, { shouldDirty: true, shouldValidate: true })
    if (p) {
      setValue("tax_area", p.area, { shouldDirty: true })
      if (!String(getValues("section") ?? "").trim() && p.section) setValue("section", p.section, { shouldDirty: true })
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={editing ? "Edit notice" : "Log a notice"}
      description={fixedClient ? fixedClient.label : "Enter it as received. Reminders go 7 and 2 days before the reply due date and the hearing."}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={editing ? "Save notice" : "Log notice"}
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {fixedClient ? null : (
          <ComboboxField
            control={control}
            name="client_id"
            label="Client"
            required
            className="md:col-span-2"
            placeholder="Choose a client"
            searchPlaceholder="Name, code, PAN or GSTIN"
            emptyText="No client matches. Employees see only their own clients."
            loadOptions={async (q: string) => {
              const r = await searchNoticeClients({ q })
              return r.ok ? r.data : []
            }}
          />
        )}
        <NativeSelectField control={control} name="type_choice" label="Notice type" required groups={[...TYPE_GROUPS, { label: "Other", options: [{ value: OTHER_TYPE, label: "Another notice (type it)" }] }]} emptyLabel="Choose…" onValueChange={onChoice} />
        <TextField
          control={control}
          name="notice_type"
          label={choice === OTHER_TYPE || !presetFor(choice) ? "Type it as it reads" : "Notice type, as recorded"}
          required
          placeholder="For example: GST DRC-01 or IT 148A"
          helper="Edit it if the notice reads differently."
        />
        <NativeSelectField
          control={control}
          name="tax_area"
          label="Area"
          options={TAX_AREAS.map((a: TaxArea) => ({ value: a, label: TAX_AREA_LABEL[a] }))}
          emptyLabel="Not set"
          helper="Decides the appeal forums."
        />
        <TextField control={control} name="section" label="Section" placeholder="143(2)" helper="Under the Act of the year the notice is about." />
        <TextField control={control} name="authority" label="Authority" placeholder="For example: ACIT, Circle 4(1), Bengaluru" />
        <TextField control={control} name="reference_no" label="Reference / DIN" placeholder="Document identification number" />
        <NativeSelectField control={control} name="financial_year" label="Year it is about" options={context.years.map((y) => ({ value: y, label: `FY ${y} · ${taxYearLabel(y)}` }))} emptyLabel="Not about one year" />
        <DateField control={control} name="notice_date" label="Notice date" />
        <DateField control={control} name="received_date" label="Received on" />
        <DateField control={control} name="reply_due_date" label="Reply due date" required />
        <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
          <DateField control={control} name="hearing_date" label="Hearing date" />
          <TimeField control={control} name="hearing_time" label="Time" />
        </div>
        <MoneyField control={control} name="demand_amount" label="Demand (₹)" helper="Tax, interest and penalty demanded, if any." />
        <NativeSelectField
          control={control}
          name="assigned_employee_id"
          label="Assigned to"
          options={context.staff}
          emptyLabel="Unassigned"
          disabled={editing && !context.canAssignOthers}
          helper={context.canAssignOthers ? "They get the reminders." : editing ? "A Manager or Partner reassigns a notice." : "Take it yourself, or leave it for a Manager to assign."}
        />
        {editing ? null : (
          <NativeSelectField control={control} name="status" label="Where it stands" options={STATUS_AT_LOGGING} helper="For a notice already in progress when it reaches the firm." />
        )}
        {!editing && status === "replied" ? <DateField control={control} name="replied_on" label="Replied on" /> : null}
        <TextareaField control={control} name="description" label="Description" rows={4} className="md:col-span-2" placeholder="What the notice asks for, the issues raised and what the client has said." />
      </div>
    </FormDialog>
  )
}
