"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWatch, type Control } from "react-hook-form"
import { ShieldCheckIcon } from "lucide-react"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { PasswordField, SelectField, TextareaField, TextField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { CreateCredentialSchema, PORTALS, PORTAL_LABEL, PORTAL_SIGN_IN_URL, UpdateCredentialSchema, type CreateCredentialInput, type Portal } from "@/lib/schemas/registers"
import { createCredential, updateCredential } from "@/server/actions/credentials"
import { ClientPickerField } from "@/components/registers/shared"
import type { CredentialRow } from "@/lib/data/registers"

const PORTAL_OPTIONS = PORTALS.map((p) => ({ value: p, label: PORTAL_LABEL[p] }))

type FieldsInput = Omit<CreateCredentialInput, "clientId" | "password"> & { password?: string | null }

/** Portal, name for Other, username, password, login URL and notes. Changing the portal offers its official sign-in page. */
function CredentialFields({ control, setLoginUrl, editing }: { control: Control<FieldsInput>; setLoginUrl: (url: string) => void; editing: boolean }) {
  const portal = useWatch({ control, name: "portal" }) as Portal | undefined
  const loginUrl = useWatch({ control, name: "loginUrl" }) as string | null | undefined
  const prev = React.useRef(portal)
  React.useEffect(() => {
    if (!portal || portal === prev.current) return
    const wasDefault = !loginUrl || Object.values(PORTAL_SIGN_IN_URL).includes(loginUrl)
    if (wasDefault) setLoginUrl(PORTAL_SIGN_IN_URL[portal] ?? "")
    prev.current = portal
  }, [portal, loginUrl, setLoginUrl])
  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SelectField control={control} name="portal" label="Portal" required options={PORTAL_OPTIONS} />
        {portal === "OTHER" ? <TextField control={control} name="portalLabel" label="Portal name" required placeholder="For example, Karnataka Labour" /> : <div className="hidden md:block" />}
        <TextField control={control} name="username" label="Username or login ID" required autoComplete="off" spellCheck={false} />
        <PasswordField
          control={control}
          name="password"
          label="Password"
          required={!editing}
          autoComplete="new-password"
          helper={editing ? "Leave blank to keep the stored password." : "Encrypted before it is stored. It never shows in a list."}
        />
      </div>
      <TextField control={control} name="loginUrl" label="Login URL" className="mt-4" inputMode="url" placeholder="https://" />
      <TextareaField control={control} name="notes" label="Notes" className="mt-4" rows={3} helper="Security questions, the registered mobile, who resets it. Not the password." />
    </>
  )
}

/** Add a stored portal login (Partners and Managers). */
export function CreateCredentialDialog({ open, onOpenChange, fixedClient }: { open: boolean; onOpenChange: (open: boolean) => void; fixedClient?: { id: string; name: string } | null }) {
  const router = useRouter()
  const f = useActionForm(CreateCredentialSchema, createCredential, {
    defaultValues: { clientId: fixedClient?.id ?? "", portal: "GST", portalLabel: "", username: "", password: "", loginUrl: PORTAL_SIGN_IN_URL.GST ?? "", notes: "" },
    successMessage: "Login stored in the vault",
    onSuccess: () => {
      onOpenChange(false)
      f.form.reset()
      router.refresh()
    },
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a portal login"
      description="The password is encrypted on save. Revealing it later is logged with who, when and from where."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Store login"
      footerStart={
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheckIcon aria-hidden="true" className="size-3.5" />
          AES-256-GCM
        </span>
      }
    >
      <FormAlert state={f} />
      {fixedClient ? (
        <p className="mb-4 text-sm text-text-muted">
          For <span className="font-medium text-text">{fixedClient.name}</span>
        </p>
      ) : (
        <div className="mb-4">
          <ClientPickerField control={f.control} name="clientId" />
        </div>
      )}
      <CredentialFields control={f.control as unknown as Control<FieldsInput>} setLoginUrl={(url) => f.form.setValue("loginUrl", url, { shouldDirty: true })} editing={false} />
    </FormDialog>
  )
}

/** Change a stored login: portal, username, URL, notes, and (only if typed) the password. */
export function EditCredentialDialog({ open, onOpenChange, row }: { open: boolean; onOpenChange: (open: boolean) => void; row: CredentialRow }) {
  const router = useRouter()
  const f = useActionForm(UpdateCredentialSchema, updateCredential, {
    defaultValues: {
      id: row.id,
      updatedAt: row.updated_at,
      portal: (PORTALS as readonly string[]).includes(row.portal) ? (row.portal as Portal) : "OTHER",
      portalLabel: row.portal_label ?? "",
      username: row.username,
      password: "",
      loginUrl: row.login_url ?? "",
      notes: row.notes ?? "",
    },
    successMessage: (d) => (d.passwordChanged ? "Login and password updated" : "Login updated"),
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit the login of ${row.client_name}`}
      description="Changing the password replaces the stored one; the old one can't be recovered."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save changes"
    >
      <FormAlert state={f} />
      <CredentialFields control={f.control as unknown as Control<FieldsInput>} setLoginUrl={(url) => f.form.setValue("loginUrl", url, { shouldDirty: true })} editing />
    </FormDialog>
  )
}
