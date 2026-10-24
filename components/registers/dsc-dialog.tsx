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
import { todayIST } from "@/lib/domain/fy"
import {
  CUSTODY_KINDS,
  CUSTODY_LABEL,
  CreateDscSchema,
  DSC_CLASSES,
  DSC_CLASS_LABEL,
  DSC_ISSUERS,
  DSC_STATUS_VALUES,
  parseCustody,
  type CreateDscInput,
} from "@/lib/schemas/registers"
import type { DscRow } from "@/lib/data/registers"
import { createDsc, updateDsc } from "@/server/actions/dsc"
import { ClientPickerField } from "@/components/registers/shared"

const CLASS_OPTIONS = DSC_CLASSES.map((c) => ({ value: c, label: DSC_CLASS_LABEL[c] }))
const ISSUER_OPTIONS = DSC_ISSUERS.map((i) => ({ value: i, label: i }))
const STATUS_LABEL: Record<(typeof DSC_STATUS_VALUES)[number], string> = { active: "Active", expired: "Expired", revoked: "Revoked" }
const STATUS_OPTIONS = DSC_STATUS_VALUES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))
const CUSTODY_OPTIONS = CUSTODY_KINDS.map((k) => ({ value: k, label: CUSTODY_LABEL[k] }))

/**
 * Add or edit a DSC (§7.15.1): client, holder (name, PAN), class (Class 3 by default), serial,
 * issuer, issue and expiry dates, custody (the firm, the client or a named person) and status.
 * Alerts go 30, 15 and 7 days before expiry.
 */
export function DscDialog({ open, onOpenChange, row, fixedClient }: { open: boolean; onOpenChange: (open: boolean) => void; row?: DscRow | null; fixedClient?: { id: string; name: string } | null }) {
  const router = useRouter()
  const editing = Boolean(row)
  const custody = parseCustody(row?.custody)
  const submit = React.useCallback(
    async (input: CreateDscInput) => {
      if (row) {
        const r = await updateDsc({ ...input, id: row.id, updatedAt: row.updated_at })
        return r.ok ? { ...r, data: { id: r.data.id } } : r
      }
      return createDsc(input)
    },
    [row],
  )
  const f = useActionForm(CreateDscSchema, submit, {
    defaultValues: {
      clientId: row?.client_id ?? fixedClient?.id ?? "",
      holderName: row?.holder_name ?? "",
      holderPan: row?.holder_pan ?? "",
      dscClass: ((DSC_CLASSES as readonly string[]).includes(row?.dsc_class ?? "") ? row?.dsc_class : "class_3") as CreateDscInput["dscClass"],
      serialNumber: row?.serial_number ?? "",
      issuedBy: ((DSC_ISSUERS as readonly string[]).includes(row?.issued_by ?? "") ? row?.issued_by : "") as CreateDscInput["issuedBy"],
      issueDate: row?.issue_date ?? "",
      expiryDate: row?.expiry_date ?? "",
      custodyKind: custody.kind ?? "",
      custodyName: custody.name,
      status: (row?.status as CreateDscInput["status"]) ?? "active",
      notes: row?.notes ?? "",
    },
    successMessage: editing ? "DSC updated" : "DSC added",
    onSuccess: () => {
      onOpenChange(false)
      if (!editing) f.form.reset()
      router.refresh()
    },
  })
  const kind = useWatch({ control: f.control, name: "custodyKind" })
  const clientName = row?.client_name ?? fixedClient?.name ?? null
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit the DSC of ${row?.holder_name}` : "Add a DSC"}
      description={clientName ? `For ${clientName}` : "Alerts go to the client's owner and the Partners 30, 15 and 7 days before it expires."}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={editing ? "Save changes" : "Add DSC"}
    >
      <FormAlert state={f} />
      {clientName ? null : (
        <div className="mb-4">
          <ClientPickerField control={f.control} name="clientId" />
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField control={f.control} name="holderName" label="Holder name" required autoComplete="off" />
        <TextField control={f.control} name="holderPan" label="Holder PAN" autoCapitalize="characters" spellCheck={false} helper="10 characters, if on the certificate." />
        <SelectField control={f.control} name="dscClass" label="Class" options={CLASS_OPTIONS} />
        <SelectField control={f.control} name="issuedBy" label="Issued by" options={ISSUER_OPTIONS} placeholder="Choose the issuer" />
        <TextField control={f.control} name="serialNumber" label="Serial no." spellCheck={false} />
        <SelectField control={f.control} name="status" label="Status" options={STATUS_OPTIONS} helper="An Active DSC past its expiry shows as Expired by itself." />
        <DateField control={f.control} name="issueDate" label="Issue date" max={todayIST()} />
        <DateField control={f.control} name="expiryDate" label="Expiry date" required />
        <SelectField control={f.control} name="custodyKind" label="Custody" options={CUSTODY_OPTIONS} placeholder="Who holds the token" />
        {kind === "person" ? <TextField control={f.control} name="custodyName" label="Held by" required placeholder="Name of the person" /> : <div className="hidden md:block" />}
      </div>
      <TextareaField control={f.control} name="notes" label="Notes" className="mt-4" rows={3} helper="Where the token is kept, the PIN's custodian. Never the PIN itself." />
    </FormDialog>
  )
}

export function AddDscButton({ fixedClient, variant = "default" }: { fixedClient?: { id: string; name: string } | null; variant?: "default" | "outline" }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        Add DSC
      </Button>
      {open ? <DscDialog open={open} onOpenChange={setOpen} fixedClient={fixedClient} /> : null}
    </>
  )
}
