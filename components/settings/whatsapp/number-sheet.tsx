"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useWatch } from "react-hook-form"
import { FormSheet } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { CheckboxGroupField, SelectField, SwitchField, TextField } from "@/components/app/form/fields"
import { getDesktopBridge } from "@/components/shell/use-desktop"
import { useActionForm } from "@/hooks/use-action-form"
import { formatWhatsAppNumber, normalizeWhatsAppNumber } from "@/lib/domain/messaging"
import { DESKTOP_ROLES, DESKTOP_ROLE_LABEL, WHATSAPP_NUMBER_KINDS, WHATSAPP_NUMBER_KIND_LABEL, type WhatsAppNumberKind } from "@/lib/domain/whatsapp"
import { FirmNumberSchema, type FirmNumberInput } from "@/lib/schemas/whatsapp"
import type { FirmNumberRow, PersonOption } from "@/lib/data/whatsapp"
import { saveFirmWhatsAppNumber } from "@/server/actions/whatsapp-settings"

/** What each kind of number usually is (§5.13 defaults), applied when the kind is changed. */
const KIND_DEFAULTS: Record<WhatsAppNumberKind, { usable_by: string[]; group_admin: boolean; shared: boolean }> = {
  partner: { usable_by: ["partner"], group_admin: false, shared: false },
  managers_office: { usable_by: ["partner", "manager"], group_admin: true, shared: true },
  staff_office: { usable_by: ["partner", "manager", "employee"], group_admin: false, shared: true },
  other: { usable_by: ["partner"], group_admin: false, shared: true },
}

/**
 * Add or edit one of the firm's WhatsApp numbers (§5.13, §7.21): label, number (normalised as
 * WhatsApp needs it, §7.13.2), kind, the Partner whose number it is, the custodian who keeps the
 * phone, in every client group, admin, shared, who may use it in TaxWise Desktop, two-step
 * verification, and on/off. Partner only. Saving asks TaxWise Desktop to reload its numbers.
 */
export function NumberSheet({
  open,
  onOpenChange,
  number,
  partners,
  staff,
  countryCode,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null: a new number. */
  number: FirmNumberRow | null
  partners: PersonOption[]
  staff: PersonOption[]
  countryCode: string
}) {
  const router = useRouter()
  const defaults: FirmNumberInput = number
    ? {
        id: number.id,
        updated_at: number.updated_at,
        country_code: countryCode,
        label: number.label,
        number: number.number ? formatWhatsAppNumber(number.number) : "",
        kind: number.kind as WhatsAppNumberKind,
        employee_id: number.employee_id ?? "",
        custodian_employee_id: number.custodian_employee_id ?? "none",
        in_every_client_group: number.in_every_client_group,
        group_admin: number.group_admin,
        shared: number.shared,
        usable_by: number.usable_by as Array<(typeof DESKTOP_ROLES)[number]>,
        two_step_verification_on: number.two_step_verification_on,
        is_active: number.is_active,
      }
    : {
        id: "",
        updated_at: "",
        country_code: countryCode,
        label: "",
        number: "",
        kind: "other",
        employee_id: "",
        custodian_employee_id: "none",
        in_every_client_group: false,
        group_admin: false,
        shared: true,
        usable_by: ["partner"],
        two_step_verification_on: false,
        is_active: false,
      }
  const f = useActionForm(FirmNumberSchema, saveFirmWhatsAppNumber, {
    defaultValues: defaults,
    onSuccess: (data, values) => {
      toast.success(data.changed === 0 ? "Nothing had changed, so nothing was saved." : `${values.label} saved`)
      void getDesktopBridge()
        ?.refreshContext()
        .catch(() => undefined)
      onOpenChange(false)
      router.refresh()
    },
  })

  const kind = useWatch({ control: f.control, name: "kind" }) as WhatsAppNumberKind
  const raw = useWatch({ control: f.control, name: "number" }) as string | null | undefined
  const previousKind = React.useRef(kind)
  React.useEffect(() => {
    if (previousKind.current === kind) return
    previousKind.current = kind
    const d = KIND_DEFAULTS[kind]
    f.form.setValue("usable_by", d.usable_by as FirmNumberInput["usable_by"], { shouldDirty: true })
    f.form.setValue("group_admin", d.group_admin, { shouldDirty: true })
    f.form.setValue("shared", d.shared, { shouldDirty: true })
    if (kind !== "partner") f.form.setValue("employee_id", "", { shouldDirty: true })
  }, [kind, f.form])

  const normalised = raw ? normalizeWhatsAppNumber(raw, { countryCode }) : null
  const partner = kind === "partner"

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={number ? `Edit ${number.label}` : "Add a firm number"}
      description="The firm's own WhatsApp numbers: no personal staff numbers (house rule 1)."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={number ? "Save number" : "Add number"}
      width="lg"
    >
      <div className="flex flex-col gap-5">
        <FormAlert state={f} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField control={f.control} name="label" label="Label" required maxLength={80} helper={`For example "Staff office" or "CA Vinay H Karlagere (Partner)".`} />
          <TextField
            control={f.control}
            name="number"
            label="WhatsApp number"
            inputMode="tel"
            autoComplete="off"
            maxLength={30}
            helper={raw ? (normalised ? `WhatsApp uses ${formatWhatsAppNumber(normalised)}.` : "This isn't a mobile number WhatsApp can use.") : "Like +91 98765 43210."}
          />
          <SelectField control={f.control} name="kind" label="Kind" required options={WHATSAPP_NUMBER_KINDS.map((k) => ({ value: k, label: WHATSAPP_NUMBER_KIND_LABEL[k] }))} />
          {partner ? (
            <SelectField
              control={f.control}
              name="employee_id"
              label="Partner"
              required
              options={partners.map((p) => ({ value: p.id, label: p.name }))}
              helper="Only this Partner may use the number in TaxWise Desktop, and only on their own PC."
            />
          ) : (
            <div className="hidden md:block" aria-hidden="true" />
          )}
          <SelectField
            control={f.control}
            name="custodian_employee_id"
            label="Custodian"
            options={[{ value: "none", label: "Nobody yet" }, ...staff.map((p) => ({ value: p.id, label: p.name }))]}
            helper="Who keeps the phone. They get the weekly linked-devices reminder."
          />
        </div>

        <div className="flex flex-col gap-1 border-t border-border pt-4">
          <SwitchField control={f.control} name="in_every_client_group" label="In every client group" description="Added to each new client group by the setup checklist." />
          <SwitchField control={f.control} name="group_admin" label="Group admin" description="Made an admin in each group (the Managers' office is, so no group depends on one Partner's phone)." />
          <SwitchField control={f.control} name="shared" label="Shared number" description="Several people use it, so staff sign their messages." />
          <SwitchField control={f.control} name="two_step_verification_on" label="Two-step verification on" description="WhatsApp → Settings → Account → Two-step verification (house rule 3)." />
        </div>

        <CheckboxGroupField
          control={f.control}
          name="usable_by"
          label="Who may use it in TaxWise Desktop"
          required
          columns={3}
          options={DESKTOP_ROLES.map((r) => ({ value: r, label: DESKTOP_ROLE_LABEL[r], disabled: partner && r !== "partner" }))}
          helper={partner ? "A Partner's own number is that Partner's alone." : "Employees use the Staff office; Managers the Managers' office, and the Staff office if you tick Managers here."}
        />

        <div className="border-t border-border pt-4">
          <SwitchField
            control={f.control}
            name="is_active"
            label="Switched on"
            description="Staff can use it in TaxWise Desktop and the setup checklist adds it to new groups. Needs the number."
          />
        </div>
      </div>
    </FormSheet>
  )
}
