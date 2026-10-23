"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, MoneyField, SelectField, SwitchField, TextField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { SERVICE_FREQUENCIES, SERVICE_FREQUENCY_LABELS, SERVICE_TYPES, SERVICE_TYPE_LABELS, type ServiceFrequency, type ServiceType } from "@/lib/domain/enums"
import { todayIST } from "@/lib/domain/fy"
import {
  AddServiceSchema,
  BILLING_SAME,
  EndServiceSchema,
  RepriceServiceSchema,
  UpdateServiceSchema,
  serviceName,
  type AddServiceInput,
  type UpdateServiceInput,
} from "@/lib/schemas/client-services"
import { addClientService, endClientService, repriceClientService, updateClientService } from "@/server/actions/client-services"
import type { ServiceRow } from "@/lib/data/client360"

const SAME = BILLING_SAME
const FREQ_OPTIONS = SERVICE_FREQUENCIES.map((f) => ({ value: f, label: SERVICE_FREQUENCY_LABELS[f] }))
const BILLING_OPTIONS = [{ value: SAME, label: "Same as filing" }, ...FREQ_OPTIONS]

function useRefreshClose(onOpenChange: (o: boolean) => void) {
  const router = useRouter()
  return () => {
    onOpenChange(false)
    router.refresh()
  }
}

/** "Leave empty to use 998231 (Settings → Billing)." */
function sacHelper(sac: string) {
  return `Leave empty to use ${sac} from Settings → Billing.`
}

// -------------------------------------------------------------------------------------------------
// Add a service
// -------------------------------------------------------------------------------------------------

export function AddServiceDialog({
  open,
  onOpenChange,
  clientId,
  clientName,
  defaultSacFor,
  existing,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  clientId: string
  clientName: string
  defaultSacFor: Record<string, string>
  /** Active services, so the list doesn't offer them again. */
  existing: Array<{ service_type: ServiceType; custom_name: string | null; is_active: boolean }>
}) {
  const done = useRefreshClose(onOpenChange)
  const today = todayIST()
  const defaults: AddServiceInput = {
    clientId,
    serviceType: undefined as unknown as ServiceType,
    customName: "",
    frequency: undefined as unknown as ServiceFrequency,
    nextDueDate: "",
    billingFrequency: SAME,
    sacCode: "",
    autoInvoice: false,
    nextBillingDate: "",
    agreedFee: "",
    feeAgreedOn: today,
  }
  const f = useActionForm(AddServiceSchema, addClientService, {
    defaultValues: defaults,
    successMessage: (d) => (d.resumed ? "The ended service is active again with these terms." : "Service added."),
    onSuccess: done,
  })
  React.useEffect(() => {
    if (open) f.form.reset(defaults)
    // Reset each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const type = f.form.watch("serviceType") as ServiceType | undefined
  const auto = f.form.watch("autoInvoice")
  const fee = f.form.watch("agreedFee")
  const activeTypes = new Set(existing.filter((s) => s.is_active && s.service_type !== "other").map((s) => s.service_type))
  const ended = new Set(existing.filter((s) => !s.is_active && s.service_type !== "other").map((s) => s.service_type))

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a service"
      description={`A new engagement for ${clientName}: what is done, how often, and what is billed for it (excl. GST).`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Add service"
      size="lg"
    >
      <div className="flex flex-col gap-5">
        <FormAlert state={f} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SelectField
            control={f.control}
            name="serviceType"
            label="Service"
            required
            options={SERVICE_TYPES.map((s) => ({
              value: s,
              label: `${SERVICE_TYPE_LABELS[s]}${ended.has(s) ? " (ended: resumes it)" : ""}`,
              disabled: activeTypes.has(s),
            }))}
          />
          {type === "other" ? <TextField control={f.control} name="customName" label="Name of the service" required maxLength={80} placeholder="Trademark filing" /> : null}
          <SelectField control={f.control} name="frequency" label="Filing frequency" required options={FREQ_OPTIONS} />
          <DateField control={f.control} name="nextDueDate" label="Next due date" helper="Generate deadlines on the Compliance tab fills statutory dates." />
        </div>
        <fieldset className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <legend className="mb-3 text-base font-semibold text-text">Fee and billing</legend>
          <MoneyField control={f.control} name="agreedFee" label="Agreed fee (₹, excl. GST)" helper="Per billing occurrence. Leave empty if not agreed yet." />
          <DateField control={f.control} name="feeAgreedOn" label="Fee agreed on" max={today} />
          <SelectField control={f.control} name="billingFrequency" label="Billing frequency" options={BILLING_OPTIONS} />
          <TextField control={f.control} name="sacCode" label="SAC override" inputMode="numeric" maxLength={6} helper={sacHelper(type ? (defaultSacFor[type] ?? defaultSacFor.default) : defaultSacFor.default)} />
          <SwitchField
            control={f.control}
            name="autoInvoice"
            label="Raise invoices automatically"
            description={fee ? "A draft is raised on each billing date at 09:30; a Partner or Manager issues it." : "Agree a fee first: automatic invoices bill the agreed fee."}
            className="md:col-span-2"
          />
          {auto ? <DateField control={f.control} name="nextBillingDate" label="First billing date" required /> : null}
        </fieldset>
      </div>
    </FormDialog>
  )
}

// -------------------------------------------------------------------------------------------------
// Change terms
// -------------------------------------------------------------------------------------------------

export function EditServiceDialog({ open, onOpenChange, clientId, service, defaultSac }: { open: boolean; onOpenChange: (o: boolean) => void; clientId: string; service: ServiceRow; defaultSac: string }) {
  const done = useRefreshClose(onOpenChange)
  const defaults: UpdateServiceInput = {
    id: service.id,
    clientId,
    updatedAt: service.updated_at,
    hasAgreedFee: service.agreed_fee !== null,
    frequency: service.frequency,
    nextDueDate: service.next_due_date ?? "",
    billingFrequency: service.billing_frequency ?? SAME,
    sacCode: service.sac_code ?? "",
    autoInvoice: service.auto_invoice,
    nextBillingDate: service.next_billing_date ?? "",
  }
  const f = useActionForm(UpdateServiceSchema, updateClientService, { defaultValues: defaults, successMessage: "Service terms saved.", onSuccess: done })
  React.useEffect(() => {
    if (open) f.form.reset(defaults)
    // Reset when the dialog opens with the row as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, service.updated_at])
  const auto = f.form.watch("autoInvoice")
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Terms: ${serviceName(service.service_type, service.custom_name)}`}
      description="Frequency, dates and billing. The fee changes through Re-price, so its history is kept."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save terms"
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SelectField control={f.control} name="frequency" label="Filing frequency" required options={FREQ_OPTIONS} />
          <DateField control={f.control} name="nextDueDate" label="Next due date" />
          <SelectField control={f.control} name="billingFrequency" label="Billing frequency" options={BILLING_OPTIONS} />
          <TextField control={f.control} name="sacCode" label="SAC override" inputMode="numeric" maxLength={6} helper={sacHelper(defaultSac)} />
        </div>
        <SwitchField
          control={f.control}
          name="autoInvoice"
          label="Raise invoices automatically"
          description={service.agreed_fee === null ? "Agree a fee first (Re-price): automatic invoices bill the agreed fee." : "A draft is raised on each billing date at 09:30; a Partner or Manager issues it."}
        />
        {auto ? <DateField control={f.control} name="nextBillingDate" label="Next billing date" required /> : null}
      </div>
    </FormDialog>
  )
}

// -------------------------------------------------------------------------------------------------
// Re-price
// -------------------------------------------------------------------------------------------------

export function RepriceDialog({ open, onOpenChange, clientId, service, perCycle }: { open: boolean; onOpenChange: (o: boolean) => void; clientId: string; service: ServiceRow; perCycle: string }) {
  const done = useRefreshClose(onOpenChange)
  const today = todayIST()
  const defaults = { id: service.id, clientId, updatedAt: service.updated_at, agreedFee: service.agreed_fee === null ? "" : String(service.agreed_fee), feeAgreedOn: today, note: "" }
  const f = useActionForm(RepriceServiceSchema, repriceClientService, { defaultValues: defaults, successMessage: "New fee recorded.", onSuccess: done })
  React.useEffect(() => {
    if (open) f.form.reset(defaults)
    // Reset when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, service.updated_at])
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Re-price ${serviceName(service.service_type, service.custom_name)}`}
      description={`The new fee, excl. GST, ${perCycle}. The old fee stays in the fee history; invoices already raised don't change.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save new fee"
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <MoneyField control={f.control} name="agreedFee" label="Agreed fee (₹, excl. GST)" required />
        <DateField control={f.control} name="feeAgreedOn" label="Agreed on" required max={today} />
        <TextareaField control={f.control} name="note" label="Note" rows={2} maxLength={500} placeholder="Revised after the April review" />
      </div>
    </FormDialog>
  )
}

// -------------------------------------------------------------------------------------------------
// End
// -------------------------------------------------------------------------------------------------

export function EndServiceDialog({ open, onOpenChange, clientId, service }: { open: boolean; onOpenChange: (o: boolean) => void; clientId: string; service: ServiceRow }) {
  const done = useRefreshClose(onOpenChange)
  const today = todayIST()
  const defaults = { id: service.id, clientId, updatedAt: service.updated_at, endedOn: today, reason: "" }
  const f = useActionForm(EndServiceSchema, endClientService, { defaultValues: defaults, successMessage: "Service ended.", onSuccess: done })
  React.useEffect(() => {
    if (open) f.form.reset(defaults)
    // Reset when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, service.updated_at])
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`End ${serviceName(service.service_type, service.custom_name)}?`}
      description="It stops being billed (automatic invoices are switched off) and leaves the client's active services. Deadlines already on the calendar stay until you cancel them. You can resume it later."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="End service"
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <DateField control={f.control} name="endedOn" label="Ended on" required />
        <TextareaField control={f.control} name="reason" label="Reason" required rows={3} maxLength={500} placeholder="Client moved bookkeeping in-house" />
      </div>
    </FormDialog>
  )
}
