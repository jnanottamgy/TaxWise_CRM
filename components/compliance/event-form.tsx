"use client"

import { useRouter } from "next/navigation"
import { useWatch } from "react-hook-form"
import { FormSheet } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { ComboboxField, DateField, SelectField, SwitchField, TextField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { EventFormSchema, NONE } from "@/lib/schemas/compliance"
import { saveComplianceEvent } from "@/server/actions/compliance"
import { COMPLIANCE_TYPES, COMPLIANCE_TYPE_LABELS, type ComplianceType } from "@/lib/domain/enums"
import { formatDate } from "@/lib/format"

/**
 * Add or edit a deadline (§7.7 "Event form"): Client (or firm-level) · Type* · Form code · Title* ·
 * Description · FY · Filing period · Due date* · Reminder days (default from Settings → Reminders) ·
 * Linked task (create one automatically) · Notes; plus "Statutory deadline" (statutory ones show in
 * the client's portal, §7.22) and, for ROC events, the AGM date that fixes ADT-1 / AOC-4 / MGT-7
 * (§6.7). Planned deadlines (statutory calendar, ops templates) keep their type, form and period so
 * the generators never double up. Partners and Managers (RLS 0037).
 */

export interface EventFormEvent {
  id: string
  client_id: string | null
  type: ComplianceType
  form_code: string | null
  title: string
  description: string | null
  financial_year: string | null
  filing_period: string | null
  due_date: string
  reminder_days: number
  notes: string | null
  agm_date: string | null
  is_statutory: boolean
  source: string
  rule_code: string | null
  updated_at: string
}

/** The client picker's firm-level choice (the schema reads it as no client). */
const FIRM = NONE

export function EventForm({
  open,
  onOpenChange,
  event,
  clients,
  fixedClient,
  fyOptions,
  defaultFy,
  defaultDue,
  reminderDays,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Null = a new deadline. */
  event: EventFormEvent | null
  /** For the client picker (new deadlines without a fixed client). */
  clients?: Array<{ id: string; name: string; code: string }>
  /** Client 360: the client is given. */
  fixedClient?: { id: string; name: string; code: string } | null
  fyOptions: string[]
  defaultFy: string
  defaultDue?: string
  reminderDays: number
  onSaved?: (id: string) => void
}) {
  const router = useRouter()
  const planned = Boolean(event && event.source !== "manual")
  const f = useActionForm(EventFormSchema, saveComplianceEvent, {
    defaultValues: {
      id: event?.id ?? null,
      expectedUpdatedAt: event?.updated_at ?? null,
      clientId: event ? (event.client_id ?? FIRM) : (fixedClient?.id ?? null),
      type: event?.type ?? "custom",
      formCode: event?.form_code ?? "",
      title: event?.title ?? "",
      description: event?.description ?? "",
      financialYear: event?.financial_year ?? defaultFy,
      filingPeriod: event?.filing_period ?? "",
      dueDate: event?.due_date ?? defaultDue ?? "",
      reminderDays: event?.reminder_days ?? reminderDays,
      isStatutory: event?.is_statutory ?? true,
      createTask: false,
      notes: event?.notes ?? "",
      agmDate: event?.agm_date ?? "",
    },
    successMessage: event ? "Deadline saved" : "Deadline added",
    onSuccess: (d) => {
      onOpenChange(false)
      onSaved?.(d.id)
      router.refresh()
    },
  })

  const type = useWatch({ control: f.control, name: "type" })
  const clientId = useWatch({ control: f.control, name: "clientId" })
  const hasClient = Boolean(clientId) && clientId !== FIRM

  const clientOptions = [
    { value: FIRM, label: "Firm-level (no client)", description: "The firm's own deadlines" },
    ...(clients ?? []).map((c) => ({ value: c.id, label: c.name, description: c.code })),
  ]

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      width="lg"
      title={event ? "Edit deadline" : "New deadline"}
      description={
        event
          ? planned
            ? `Planned by the ${event.source === "ops_template" ? "ops templates" : "statutory calendar"}: the form and period stay as planned.`
            : `Added by hand · due ${formatDate(event.due_date)}`
          : fixedClient
            ? `${fixedClient.code} · ${fixedClient.name}`
            : "A statutory date, or a firm or internal step"
      }
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={event ? "Save deadline" : "Add deadline"}
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {fixedClient || event ? (
          <div className="md:col-span-2">
            <p className="text-sm font-medium text-text">Client</p>
            <p className="mt-1 text-base text-text">
              {event ? (event.client_id ? (fixedClient?.name ?? clients?.find((c) => c.id === event.client_id)?.name ?? "This client") : "Firm-level (no client)") : fixedClient?.name}
            </p>
          </div>
        ) : (
          <ComboboxField
            control={f.control}
            name="clientId"
            label="Client"
            required
            options={clientOptions}
            placeholder="Choose a client"
            searchPlaceholder="Search clients"
            clearable={false}
            className="md:col-span-2"
          />
        )}
        <SelectField
          control={f.control}
          name="type"
          label="Type"
          required
          disabled={planned}
          options={COMPLIANCE_TYPES.map((t) => ({ value: t, label: COMPLIANCE_TYPE_LABELS[t] }))}
        />
        <TextField control={f.control} name="formCode" label="Form code" disabled={planned} helper="GSTR-3B, 26Q, AOC-4, ITR-6…" autoCapitalize="characters" />
        <TextField control={f.control} name="title" label="Title" required className="md:col-span-2" placeholder="GSTR-3B for Sep 2026" />
        <TextareaField control={f.control} name="description" label="Description" rows={2} className="md:col-span-2" />
        <SelectField control={f.control} name="financialYear" label="Financial year" disabled={planned} options={fyOptions.map((fy) => ({ value: fy, label: fy }))} />
        <TextField control={f.control} name="filingPeriod" label="Filing period" disabled={planned} helper="Sep 2026, Q2 2026-27 or FY 2026-27." />
        <DateField control={f.control} name="dueDate" label="Due date" required />
        <TextField control={f.control} name="reminderDays" label="Reminder (days before)" type="number" inputMode="numeric" min={0} max={90} helper="Who is reminded: the owner and the preparer." />
        {type === "roc" ? (
          <DateField control={f.control} name="agmDate" label="AGM held on" helper="Fixes the ADT-1, AOC-4 and MGT-7 dates for this year." className="md:col-span-2" />
        ) : null}
        <SwitchField
          control={f.control}
          name="isStatutory"
          label="Statutory deadline"
          description="Shown to the client on the portal's Deadlines page. Turn off for firm and internal steps."
          disabled={planned}
          className="md:col-span-2"
        />
        {!event && (hasClient || fixedClient) ? (
          <SwitchField
            control={f.control}
            name="createTask"
            label="Create a linked task"
            description="Assigned to the client's owner, waiting for acceptance, due on the same date."
            className="md:col-span-2"
          />
        ) : null}
        <TextareaField control={f.control} name="notes" label="Notes" rows={3} className="md:col-span-2" />
      </div>
    </FormSheet>
  )
}
