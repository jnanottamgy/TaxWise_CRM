"use client"

import * as React from "react"
import Link from "next/link"
import { z } from "zod"
import { toast } from "sonner"
import { fail, ok, unexpectedMessage, type ActionResult } from "@/lib/result"
import { parseAmount } from "@/lib/domain/money"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useActionForm } from "@/hooks/use-action-form"
import { useAutosave } from "@/hooks/use-autosave"
import { FormAlert } from "@/components/app/form/form-alert"
import {
  CheckboxGroupField,
  ComboboxField,
  DateField,
  MoneyField,
  PasswordField,
  PercentField,
  SelectField,
  SwitchField,
  TagField,
  TextareaField,
  TextField,
} from "@/components/app/form/fields"
import { PasswordChecklist } from "@/components/app/form/password-input"
import type { ComboOption } from "@/components/app/form/combobox"
import { FormDialog, FormSheet } from "@/components/app/form-dialog"
import { WizardDialog } from "@/components/app/wizard"
import { DraftStamp } from "@/components/app/draft-stamp"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { UnsavedChangesGuard } from "@/components/app/unsaved-changes"
import { SectionCard } from "@/components/app/section-card"
import { KIT_CLIENTS, KIT_OWNERS } from "@/components/app/kit/sample-data"

const ENTITY_OPTIONS = [
  { value: "proprietorship", label: "Proprietorship" },
  { value: "partnership", label: "Partnership firm" },
  { value: "llp", label: "LLP" },
  { value: "pvt_ltd", label: "Private limited company" },
  { value: "huf", label: "HUF" },
  { value: "individual", label: "Individual" },
  { value: "trust", label: "Trust" },
]

const SERVICE_OPTIONS = [
  { value: "gst", label: "GST returns", description: "GSTR-1, GSTR-3B, annual return" },
  { value: "income_tax", label: "Income tax", description: "ITR, advance tax, notices" },
  { value: "tds", label: "TDS", description: "24Q, 26Q, certificates" },
  { value: "audit", label: "Audit", description: "Tax audit, statutory audit" },
  { value: "bookkeeping", label: "Bookkeeping" },
  { value: "payroll", label: "Payroll" },
]

const KitClientSchema = z.object({
  name: z.string().trim().min(2, { error: "Enter the client's name." }),
  pan: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/, { error: "Enter a valid PAN, like AAKFS1234C." }),
  entity_type: z.string().min(1, { error: "Choose the entity type." }),
  owner: z.string({ error: "Choose who looks after this client." }).min(1, { error: "Choose who looks after this client." }),
  onboarded_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Enter a date like 22 Oct 2026." }),
  fee: z.string().refine((v) => v === "" || parseAmount(v).ok, { error: "Enter the fee in rupees, like 12,500." }),
  discount: z.string(),
  services: z.array(z.string()).min(1, { error: "Choose at least one service." }),
  tags: z.array(z.string()),
  notes: z.string().max(500, { error: "Keep notes under 500 characters." }),
  send_welcome: z.boolean(),
})
type KitClientInput = z.input<typeof KitClientSchema>

const DEFAULTS: KitClientInput = {
  name: "",
  pan: "",
  entity_type: "",
  owner: "",
  onboarded_on: "2026-10-22",
  fee: "",
  discount: "",
  services: [],
  tags: [],
  notes: "",
  send_welcome: true,
}

/**
 * Stands in for a server action so every outcome can be seen. Try:
 * PAN AAKFS1234C → field error from the server; a name containing "timeout" → unexpected error with
 * a Ref; "warn" → saved with a warning toast; notes containing "contact" → a field error with no field on screen.
 */
async function kitSaveClient(input: KitClientInput): Promise<ActionResult<{ id: string; code: string }>> {
  await new Promise((r) => setTimeout(r, 700))
  if (input.pan.toUpperCase() === "AAKFS1234C") {
    return fail("Please check the highlighted fields.", {
      code: "validation",
      fieldErrors: { pan: ["A client with this PAN already exists: TW-C-0001 · Sharma Traders."] },
    })
  }
  if (input.name.toLowerCase().includes("timeout")) {
    return fail(unexpectedMessage("7KQ2M9XD"), { code: "unexpected", ref: "7KQ2M9XD" })
  }
  if (input.notes.toLowerCase().includes("contact")) {
    return fail("Please check the highlighted fields.", {
      code: "validation",
      fieldErrors: { "contacts.0.email": ["The primary contact's email is already used by another client."] },
    })
  }
  const saved = ok({ id: "kit-new", code: "TW-C-0058" })
  if (input.name.toLowerCase().includes("warn")) {
    return { ...saved, warnings: ["The welcome email didn't go through. Please send it by hand. (Ref 3HF8WQ2L)"] }
  }
  return saved
}

const ownerOptions: ComboOption[] = KIT_OWNERS.map((o, i) => ({ value: o, label: o, description: i === 0 ? "Manager" : "Employee" }))

async function searchKitClients(q: string): Promise<ComboOption[]> {
  await new Promise((r) => setTimeout(r, 350))
  const needle = q.trim().toLowerCase()
  return KIT_CLIENTS.filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.code.toLowerCase().includes(needle))
    .slice(0, 8)
    .map((c) => ({ value: c.id, label: c.name, description: c.code }))
}

function ClientFields({ control, compact = false }: { control: ReturnType<typeof useActionForm<typeof KitClientSchema, { id: string; code: string }>>["control"]; compact?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <TextField control={control} name="name" label="Client name" required autoComplete="organization" />
      <TextField
        control={control}
        name="pan"
        label="PAN"
        required
        helper="10 characters, like AAKFS1234C."
        autoCapitalize="characters"
        spellCheck={false}
        className="[&_input]:font-mono [&_input]:uppercase"
      />
      <SelectField control={control} name="entity_type" label="Entity type" required options={ENTITY_OPTIONS} />
      <ComboboxField control={control} name="owner" label="Assigned to" required options={ownerOptions} placeholder="Choose a person" />
      <DateField control={control} name="onboarded_on" label="Onboarded on" required min="2020-04-01" max="2027-03-31" />
      <MoneyField control={control} name="fee" label="Monthly fee" helper="Excluding GST. Leave blank if billed per job." />
      {compact ? null : (
        <>
          <PercentField control={control} name="discount" label="Discount" helper="Applied to every retainer invoice." />
          <TagField control={control} name="tags" label="Tags" suggestions={["Retainer", "Referral", "Priority", "Exporter"]} />
          <CheckboxGroupField control={control} name="services" label="Services" required options={SERVICE_OPTIONS} columns={2} className="md:col-span-2" />
          <TextareaField control={control} name="notes" label="Notes" helper="Visible to the team, never to the client." className="md:col-span-2" />
          <SwitchField
            control={control}
            name="send_welcome"
            label="Send the welcome email"
            description="Invites the primary contact to the client portal."
            className="md:col-span-2"
          />
        </>
      )}
    </div>
  )
}

export function KitFormDemos() {
  const inline = useActionForm(KitClientSchema, kitSaveClient, {
    defaultValues: DEFAULTS,
    successMessage: (d) => `Client added as ${d.code}`,
  })

  return (
    <div className="flex flex-col gap-6">
      <SectionCard
        title="Fields"
        description="Label above, helper below, * for required, error under the field. Validates on blur and on submit."
        action={
          <Button variant="outline" size="sm" onClick={() => void inline.form.trigger()}>
            Show validation
          </Button>
        }
      >
        <form onSubmit={inline.onSubmit} noValidate>
          <FormAlert state={inline} />
          <ClientFields control={inline.control} />
          <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
            <p className="mr-auto text-sm text-text-muted">
              Try PAN AAKFS1234C, a name with “timeout” or “warn”, or notes mentioning “contact”.
            </p>
            <Button type="button" variant="outline" onClick={() => inline.form.reset(DEFAULTS)}>
              Reset
            </Button>
            <Button type="submit" disabled={inline.pending}>
              Save client
            </Button>
          </div>
        </form>
      </SectionCard>
      <KitStandaloneFields />
      <KitDialogs />
    </div>
  )
}

const PasswordSchema = z.object({ password: z.string().min(12, { error: "Use at least 12 characters." }) })

function KitStandaloneFields() {
  const f = useActionForm(PasswordSchema, async () => ok(null), { defaultValues: { password: "" }, successMessage: "Password changed" })
  const clientSearch = useActionForm(z.object({ client: z.string().min(1, { error: "Choose a client." }) }), async () => ok(null), {
    defaultValues: { client: "" },
  })
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <SectionCard title="Password with policy checklist">
        <form onSubmit={f.onSubmit} noValidate className="flex flex-col gap-4">
          <PasswordField
            control={f.control}
            name="password"
            label="New password"
            required
            autoComplete="new-password"
            checklist={(v) => (
              <PasswordChecklist
                items={[
                  { label: "At least 12 characters", met: v.length >= 12 },
                  { label: "A capital letter and a small letter", met: /[A-Z]/.test(v) && /[a-z]/.test(v) },
                  { label: "A number or a symbol", met: /[\d\W]/.test(v) },
                ]}
              />
            )}
          />
          <div>
            <Button type="submit" disabled={f.pending}>
              Change password
            </Button>
          </div>
        </form>
      </SectionCard>
      <SectionCard title="Combobox with server search">
        <ComboboxField
          control={clientSearch.control}
          name="client"
          label="Client"
          required
          helper="Searches as you type (sample list, 350 ms delay)."
          loadOptions={searchKitClients}
          placeholder="Search by name or code"
        />
      </SectionCard>
    </div>
  )
}

function KitDialogs() {
  const [dialog, setDialog] = React.useState(false)
  const [longDialog, setLongDialog] = React.useState(false)
  const [sheet, setSheet] = React.useState(false)
  const [wizard, setWizard] = React.useState(false)
  const [guard, setGuard] = React.useState(false)

  const d = useActionForm(KitClientSchema, kitSaveClient, {
    defaultValues: DEFAULTS,
    successMessage: "Client added",
    onSuccess: () => setDialog(false),
  })
  const long = useActionForm(KitClientSchema, kitSaveClient, {
    defaultValues: DEFAULTS,
    successMessage: "Client added",
    onSuccess: () => setLongDialog(false),
  })
  const s = useActionForm(KitClientSchema.pick({ name: true, notes: true }), async () => {
    await new Promise((r) => setTimeout(r, 600))
    return ok(null)
  }, { defaultValues: { name: "Rakesh Sharma", notes: "" }, successMessage: "Contact saved", onSuccess: () => setSheet(false) })

  return (
    <SectionCard title="Dialogs, sheets, wizard and confirmations" description="Footers stay on screen at 1366×768 and 390×844. Close with unsaved changes to see the guard.">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setDialog(true)}>New client (dialog)</Button>
        <Button variant="outline" onClick={() => setLongDialog(true)}>
          Long form (sticky footer)
        </Button>
        <Button variant="outline" onClick={() => setSheet(true)}>
          Edit contact (sheet)
        </Button>
        <Button variant="outline" onClick={() => setWizard(true)}>
          Add client (wizard)
        </Button>
        <ConfirmDialog
          trigger={<Button variant="outline">Send quotation</Button>}
          title="Send quotation TW/Q/26-27/0031 to Sharma Traders?"
          description="Rakesh Sharma gets an email with a link to the quotation. The link works for 30 days, and you'll see when it's opened."
          confirmLabel="Send to client"
          onConfirm={async () => {
            await new Promise((r) => setTimeout(r, 700))
            toast.success("Quotation sent to rakesh@sharmatraders.in")
          }}
        />
        <ConfirmDialog
          trigger={<Button variant="destructive-outline">Delete client</Button>}
          title="Delete Sharma Traders?"
          description="The client, its 14 open tasks and 3 document requests move to the recycle bin. A Partner can restore them for 30 days."
          confirmLabel="Delete client"
          destructive
          onConfirm={() => {
            toast.success("Sharma Traders moved to the recycle bin")
          }}
        />
        <ConfirmDialog
          trigger={<Button variant="destructive">Purge recycle bin</Button>}
          title="Permanently delete 12 items?"
          description="12 clients, tasks and documents are erased for good. This can't be undone, and the audit log keeps only that they were purged."
          confirmLabel="Purge 12 items"
          destructive
          typeToConfirm="PURGE"
          onConfirm={() => {
            toast.success("12 items purged")
          }}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <Switch checked={guard} onCheckedChange={setGuard} aria-label="Pretend this page has unsaved changes" />
          Pretend this page has unsaved changes
        </label>
        <Link href="/dashboard" className="rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
          Then try leaving to the dashboard
        </Link>
        <UnsavedChangesGuard when={guard} />
      </div>

      <FormDialog
        open={dialog}
        onOpenChange={setDialog}
        title="New client"
        description="The client code is assigned when you save."
        onSubmit={d.onSubmit}
        pending={d.pending}
        dirty={d.form.formState.isDirty}
        submitLabel="Add client"
      >
        <FormAlert state={d} />
        <ClientFields control={d.control} compact />
      </FormDialog>

      <FormDialog
        open={longDialog}
        onOpenChange={setLongDialog}
        size="lg"
        title="New client, every field"
        description="A long body scrolls; the footer never moves."
        onSubmit={long.onSubmit}
        pending={long.pending}
        dirty={long.form.formState.isDirty}
        submitLabel="Add client"
        footerStart={<span>All fields are saved together.</span>}
      >
        <FormAlert state={long} />
        <ClientFields control={long.control} />
      </FormDialog>

      <FormSheet
        open={sheet}
        onOpenChange={setSheet}
        title="Edit contact"
        description="Sharma Traders · TW-C-0001"
        onSubmit={s.onSubmit}
        pending={s.pending}
        dirty={s.form.formState.isDirty}
        submitLabel="Save contact"
      >
        <FormAlert state={s} />
        <div className="flex flex-col gap-4">
          <TextField control={s.control} name="name" label="Name" required />
          <TextareaField control={s.control} name="notes" label="Notes" />
        </div>
      </FormSheet>

      <KitWizard open={wizard} onOpenChange={setWizard} />
    </SectionCard>
  )
}

const STEP_FIELDS: Array<Array<keyof KitClientInput>> = [
  ["name", "pan", "entity_type"],
  ["owner", "onboarded_on"],
  ["services", "fee", "discount"],
  ["notes", "send_welcome"],
]

function KitWizard({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [step, setStep] = React.useState(0)
  const w = useActionForm(KitClientSchema, kitSaveClient, {
    defaultValues: DEFAULTS,
    successMessage: (r) => `Client added as ${r.code}`,
    onSuccess: () => {
      draft.clear()
      onOpenChange(false)
      setStep(0)
    },
  })
  const values = w.form.watch()
  const draft = useAutosave({ key: "kit-client-wizard", value: values, enabled: open && w.form.formState.isDirty })

  const stepValid = STEP_FIELDS.map((fields) => {
    const shape = Object.fromEntries(fields.map((k) => [k, true])) as Record<keyof KitClientInput, true>
    return KitClientSchema.pick(shape).safeParse(values).success
  })

  return (
    <WizardDialog
      open={open}
      onOpenChange={onOpenChange}
      dirty={w.form.formState.isDirty}
      title="Add client"
      steps={[
        { id: "identity", title: "Identity", description: "Name, PAN and entity type", valid: stepValid[0] },
        { id: "team", title: "Team", description: "Who looks after them, and since when", valid: stepValid[1] },
        { id: "services", title: "Services and fees", description: "What we do and what we charge", valid: stepValid[2] },
        { id: "review", title: "Review", description: "Notes and the welcome email", valid: stepValid[3] },
      ]}
      current={step}
      onStepChange={setStep}
      onContinue={() => w.form.trigger(STEP_FIELDS[step])}
      onComplete={() => w.onSubmit()}
      onSaveDraft={() => draft.saveNow()}
      draftStatus={<DraftStamp savedAt={draft.savedAt} saving={draft.saving} error={draft.error} />}
      completeLabel="Create client"
      pending={w.pending}
    >
      <FormAlert state={w} />
      {step === 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField control={w.control} name="name" label="Client name" required className="md:col-span-2" />
          <TextField control={w.control} name="pan" label="PAN" required helper="10 characters, like AAKFS1234C." />
          <SelectField control={w.control} name="entity_type" label="Entity type" required options={ENTITY_OPTIONS} />
        </div>
      ) : step === 1 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ComboboxField control={w.control} name="owner" label="Assigned to" required options={ownerOptions} />
          <DateField control={w.control} name="onboarded_on" label="Onboarded on" required />
        </div>
      ) : step === 2 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <CheckboxGroupField control={w.control} name="services" label="Services" required options={SERVICE_OPTIONS} columns={2} className="md:col-span-2" />
          <MoneyField control={w.control} name="fee" label="Monthly fee" />
          <PercentField control={w.control} name="discount" label="Discount" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <TextareaField control={w.control} name="notes" label="Notes" />
          <SwitchField control={w.control} name="send_welcome" label="Send the welcome email" description="Invites the primary contact to the client portal." />
        </div>
      )}
    </WizardDialog>
  )
}
