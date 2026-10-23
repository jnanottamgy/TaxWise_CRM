"use client"

import * as React from "react"
import type { Control, FieldPath, FieldValues } from "react-hook-form"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { PlusIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { CheckboxGroupField, MoneyField, SelectField, TextField, TextareaField } from "@/components/app/form/fields"
import { DateTimeField } from "@/components/client360/form/datetime-field"
import { useActionForm } from "@/hooks/use-action-form"
import { LEAD_SOURCES, LEAD_SOURCE_LABELS, SERVICE_TYPES, SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import { getStatus } from "@/lib/status"
import { CONTACT_METHOD_MESSAGE, LeadFormSchema, OPEN_LEAD_STATUSES, UpdateLeadSchema, emptyLeadValues, type LeadFormValues, type UpdateLeadInput } from "@/lib/schemas/leads"
import { createLead, updateLead } from "@/server/actions/leads"
import type { LeadListRow } from "@/lib/data/leads"

export type StaffChoice = { value: string; label: string }

const SOURCE_OPTIONS = LEAD_SOURCES.map((s) => ({ value: s, label: LEAD_SOURCE_LABELS[s] }))
const SERVICE_OPTIONS = SERVICE_TYPES.map((s) => ({ value: s, label: SERVICE_TYPE_LABELS[s] }))
const STAGE_OPTIONS = OPEN_LEAD_STATUSES.map((s) => ({ value: s, label: getStatus("lead_status", s).label }))

/**
 * The lead form (§7.5.1): who (name*, company, email, phone, WhatsApp: at least one way to reach
 * them), what they need (services, notes), where they came from (source*, referred by) and how it
 * is handled (estimated value ₹/yr, assigned to, next follow-up, stage). Assignees are Partners and
 * Managers: Employees never see leads (§4.1). Edits carry updated_at (§13).
 */
function LeadFields<T extends FieldValues>({ control, staff, closed }: { control: Control<T, unknown, unknown>; staff: StaffChoice[]; closed: boolean }) {
  const n = (name: string) => name as FieldPath<T>
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="lead-who" className="flex flex-col gap-4">
        <h3 id="lead-who" className="text-sm font-semibold text-text">
          Who
        </h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField control={control} name={n("name")} label="Name" required maxLength={120} autoComplete="off" />
          <TextField control={control} name={n("company")} label="Company" maxLength={160} autoComplete="off" />
          <TextField control={control} name={n("email")} label="Email" type="email" autoComplete="off" />
          <TextField control={control} name={n("phone")} label="Phone" type="tel" inputMode="tel" />
          <TextField control={control} name={n("whatsapp")} label="WhatsApp" type="tel" inputMode="tel" helper="A 10-digit mobile, or + and the country code." />
        </div>
        <p className="text-sm text-text-muted">{CONTACT_METHOD_MESSAGE}</p>
      </section>
      <section aria-labelledby="lead-what" className="flex flex-col gap-4 border-t border-border pt-5">
        <h3 id="lead-what" className="text-sm font-semibold text-text">
          What they need
        </h3>
        <CheckboxGroupField control={control} name={n("services_required")} label="Services needed" options={SERVICE_OPTIONS} columns={3} />
        <TextareaField control={control} name={n("requirement_notes")} label="Requirement notes" rows={3} maxLength={4000} />
      </section>
      <section aria-labelledby="lead-origin" className="flex flex-col gap-4 border-t border-border pt-5">
        <h3 id="lead-origin" className="text-sm font-semibold text-text">
          Origin
        </h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SelectField control={control} name={n("source")} label="Source" required options={SOURCE_OPTIONS} />
          <TextField control={control} name={n("source_detail")} label="Referred by / source detail" maxLength={200} helper="Who referred them, or which campaign." />
        </div>
      </section>
      <section aria-labelledby="lead-handling" className="flex flex-col gap-4 border-t border-border pt-5">
        <h3 id="lead-handling" className="text-sm font-semibold text-text">
          Handling
        </h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <MoneyField control={control} name={n("estimated_value")} label="Estimated value (₹/yr)" helper="Fees a year, excluding GST." />
          <SelectField control={control} name={n("assigned_to")} label="Assigned to" options={[{ value: "none", label: "Not assigned" }, ...staff]} placeholder="Not assigned" />
          <DateTimeField control={control} name={n("next_follow_up_at")} label="Next follow-up" helper="A reminder goes to the person it's assigned to at this time." />
          {closed ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm leading-5 font-medium text-text">Stage</span>
              <p className="text-sm text-text-muted">Won and Lost are changed from the board or the lead&apos;s page.</p>
            </div>
          ) : (
            <SelectField control={control} name={n("status")} label="Stage" required options={STAGE_OPTIONS} />
          )}
        </div>
      </section>
    </div>
  )
}

export function NewLeadButton({ staff, defaultOpen = false, size = "default" }: { staff: StaffChoice[]; defaultOpen?: boolean; size?: "default" | "sm" }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [open, setOpen] = React.useState(defaultOpen)
  const f = useActionForm(LeadFormSchema, createLead, {
    defaultValues: emptyLeadValues(),
    onSuccess: (data) => {
      toast.success(`Lead ${data.leadNumber ?? ""} added.`.replace("  ", " "), { action: { label: "Open", onClick: () => router.push(`/leads/${data.id}`) } })
      close(false)
      router.refresh()
    },
  })
  const close = (o: boolean) => {
    setOpen(o)
    if (o) {
      f.form.reset(emptyLeadValues())
      f.clearFormError()
    }
    if (!o && searchParams.get("new")) {
      const p = new URLSearchParams(searchParams.toString())
      p.delete("new")
      router.replace(p.toString() ? `${pathname}?${p}` : pathname, { scroll: false })
    }
  }
  return (
    <>
      <Button size={size} onClick={() => close(true)}>
        <PlusIcon aria-hidden="true" />
        New lead
      </Button>
      <FormDialog
        open={open}
        onOpenChange={close}
        size="lg"
        title="New lead"
        description="Someone who may become a client. Add at least one way to reach them."
        onSubmit={f.onSubmit}
        pending={f.pending}
        dirty={f.form.formState.isDirty}
        submitLabel="Add lead"
      >
        <div className="flex flex-col gap-4">
          <FormAlert state={f} />
          <LeadFields control={f.control} staff={staff} closed={false} />
        </div>
      </FormDialog>
    </>
  )
}

function editValues(lead: LeadListRow & { requirement_notes: string | null }): UpdateLeadInput {
  const base: LeadFormValues = emptyLeadValues({
    name: lead.name,
    company: lead.company ?? "",
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    whatsapp: lead.whatsapp ?? "",
    services_required: lead.services_required,
    requirement_notes: lead.requirement_notes ?? "",
    source: lead.source,
    source_detail: lead.source_detail ?? "",
    estimated_value: lead.estimated_value === null ? "" : String(lead.estimated_value),
    assigned_to: lead.assigned_to ?? "",
    next_follow_up_at: lead.next_follow_up_at ?? "",
    status: lead.status === "won" || lead.status === "lost" ? "new_lead" : lead.status,
  })
  return { ...base, id: lead.id, updatedAt: lead.updated_at } as UpdateLeadInput
}

export function EditLeadDialog({
  open,
  onOpenChange,
  lead,
  staff,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  lead: LeadListRow & { requirement_notes: string | null }
  staff: StaffChoice[]
}) {
  const router = useRouter()
  const f = useActionForm(UpdateLeadSchema, updateLead, {
    defaultValues: editValues(lead),
    successMessage: "Lead saved.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  React.useEffect(() => {
    if (open) f.form.reset(editValues(lead))
    // Reset when the dialog opens with the lead as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lead.updated_at])
  const closed = lead.status === "won" || lead.status === "lost"
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={`Edit ${lead.company || lead.name}`}
      description={lead.lead_number ? `Lead ${lead.lead_number}` : undefined}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save lead"
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <LeadFields control={f.control} staff={staff} closed={closed} />
      </div>
    </FormDialog>
  )
}
