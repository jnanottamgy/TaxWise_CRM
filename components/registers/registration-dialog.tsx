"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWatch } from "react-hook-form"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, SelectField, TextareaField, TextField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { formatDate } from "@/lib/format"
import { isFinancialYear, recentFinancialYears, todayIST } from "@/lib/domain/fy"
import {
  CreateRegistrationSchema,
  REGISTRATION_STATUS_VALUES,
  REGISTRATION_TYPES,
  REGISTRATION_TYPE_LABEL,
  checkRegistrationNumber,
  dir3KycNextDue,
  type CreateRegistrationInput,
  type RegistrationType,
} from "@/lib/schemas/registers"
import type { RegistrationRow } from "@/lib/data/registers"
import { createRegistration, updateRegistration } from "@/server/actions/registrations"
import { ClientPickerField } from "@/components/registers/shared"

const TYPE_OPTIONS = REGISTRATION_TYPES.map((t) => ({ value: t, label: REGISTRATION_TYPE_LABEL[t] }))
const STATUS_LABEL: Record<(typeof REGISTRATION_STATUS_VALUES)[number], string> = { active: "Active", expired: "Expired", surrendered: "Surrendered", cancelled: "Cancelled" }
const STATUS_OPTIONS = REGISTRATION_STATUS_VALUES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))

const NUMBER_HINT: Partial<Record<RegistrationType, string>> = {
  GST: "15-character GSTIN, checked with its checksum.",
  DIN: "8 digits.",
  CIN: "21 characters, e.g. U72200KA2015PTC012345.",
  LLPIN: "Like AAB-1234.",
  TAN: "10 characters, e.g. BLRT12345A.",
  MSME_UDYAM: "Like UDYAM-KR-03-0012345.",
  FSSAI: "14 digits.",
  ESIC: "17-digit employer code.",
}

/**
 * Add or edit a statutory registration (§7.15.1): client, type, number (checked for its type, §6.2),
 * jurisdiction, issue and expiry dates, "remind N days before" (default 30), status, notes; a DIN also
 * holds the FY of its last DIR-3 KYC Web, and shows when the next is due (every third FY, by 30 June).
 */
export function RegistrationDialog({
  open,
  onOpenChange,
  row,
  fixedClient,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Edit this row; omit to add one. */
  row?: RegistrationRow | null
  fixedClient?: { id: string; name: string } | null
}) {
  const router = useRouter()
  const editing = Boolean(row)
  const submit = React.useCallback(
    async (input: CreateRegistrationInput) => {
      if (row) {
        const r = await updateRegistration({ ...input, id: row.id, updatedAt: row.updated_at })
        return r.ok ? { ...r, data: { id: r.data.id } } : r
      }
      return createRegistration(input)
    },
    [row],
  )
  const f = useActionForm(CreateRegistrationSchema, submit, {
    defaultValues: {
      clientId: row?.client_id ?? fixedClient?.id ?? "",
      registrationType: ((row?.registration_type as RegistrationType | undefined) ?? "GST") as RegistrationType,
      registrationNumber: row?.registration_number ?? "",
      jurisdiction: row?.jurisdiction ?? "",
      issueDate: row?.issue_date ?? "",
      expiryDate: row?.expiry_date ?? "",
      reminderDays: row?.reminder_days ?? 30,
      status: (row?.status as CreateRegistrationInput["status"]) ?? "active",
      lastDir3KycFy: row?.last_dir3_kyc_fy ?? "",
      notes: row?.notes ?? "",
    },
    successMessage: editing ? "Registration updated" : "Registration added",
    onSuccess: () => {
      onOpenChange(false)
      if (!editing) f.form.reset()
      router.refresh()
    },
  })
  const type = useWatch({ control: f.control, name: "registrationType" }) as RegistrationType
  const number = useWatch({ control: f.control, name: "registrationNumber" }) as string
  const kycFy = useWatch({ control: f.control, name: "lastDir3KycFy" }) as string | null | undefined
  const numberCheck = number?.trim() ? checkRegistrationNumber(type, number) : null
  const next = type === "DIN" && kycFy && isFinancialYear(kycFy) ? dir3KycNextDue(kycFy) : null
  const fyOptions = recentFinancialYears(todayIST(), 6).map((fy) => ({ value: fy, label: `FY ${fy}` }))

  const clientName = row?.client_name ?? fixedClient?.name ?? null
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${REGISTRATION_TYPE_LABEL[(row?.registration_type as RegistrationType) ?? "OTHER"] ?? "the"} registration` : "Add a registration"}
      description={clientName ? `For ${clientName}` : "GST, PT, IEC, Udyam, FSSAI, Shops & Establishment, PF, ESIC, DIN, LLPIN, CIN, TAN"}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={editing ? "Save changes" : "Add registration"}
    >
      <FormAlert state={f} />
      {clientName ? null : (
        <div className="mb-4">
          <ClientPickerField control={f.control} name="clientId" />
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SelectField control={f.control} name="registrationType" label="Type" required options={TYPE_OPTIONS} />
        <TextField
          control={f.control}
          name="registrationNumber"
          label="Number"
          required
          autoCapitalize="characters"
          spellCheck={false}
          helper={numberCheck && numberCheck.ok && numberCheck.warning ? <span className="text-warning-text">{numberCheck.warning}</span> : NUMBER_HINT[type]}
        />
        <TextField control={f.control} name="jurisdiction" label="Jurisdiction" placeholder="Ward, range or office" />
        <SelectField control={f.control} name="status" label="Status" options={STATUS_OPTIONS} helper="An Active registration past its expiry shows as Expired by itself." />
        <DateField control={f.control} name="issueDate" label="Issue date" max={todayIST()} />
        <DateField control={f.control} name="expiryDate" label="Expiry or renewal date" />
        <TextField control={f.control} name="reminderDays" label="Remind this many days before" type="number" inputMode="numeric" min={0} max={365} helper="The owner and Partners are told once, when the window opens." />
        {type === "DIN" ? (
          <SelectField
            control={f.control}
            name="lastDir3KycFy"
            label="Last DIR-3 KYC Web filed (FY)"
            options={fyOptions}
            placeholder="Not on record"
            helper={next ? `Next due in FY ${next.fy}, by ${formatDate(next.due)}.` : "DIR-3 KYC Web is due every third FY, by 30 June."}
          />
        ) : null}
      </div>
      <TextareaField control={f.control} name="notes" label="Notes" className="mt-4" rows={3} />
    </FormDialog>
  )
}

/** "Add a registration" for page headers and empty states. */
export function AddRegistrationButton({ fixedClient, variant = "default", label = "Add registration" }: { fixedClient?: { id: string; name: string } | null; variant?: "default" | "outline"; label?: string }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <AddButton variant={variant} onClick={() => setOpen(true)} label={label} />
      {open ? <RegistrationDialog open={open} onOpenChange={setOpen} fixedClient={fixedClient} /> : null}
    </>
  )
}

function AddButton({ variant, onClick, label }: { variant: "default" | "outline"; onClick: () => void; label: string }) {
  return (
    <Button variant={variant} onClick={onClick}>
      <PlusIcon aria-hidden="true" />
      {label}
    </Button>
  )
}
