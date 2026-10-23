"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ImageIcon, Trash2Icon, UploadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { DefinitionList } from "@/components/app/definition-list"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextField } from "@/components/app/form/fields"
import { RoleBadge } from "@/components/app/role-badge"
import { UnsavedChangesGuard } from "@/components/app/unsaved-changes"
import { useActionForm } from "@/hooks/use-action-form"
import { createClient } from "@/lib/supabase/browser"
import type { AppRole } from "@/lib/auth/roles"
import { formatDate } from "@/lib/format"
import { MembershipSchema, PROFILE_IMAGE_LIMITS, ProfileDetailsSchema, checkProfileImage, type ProfileImageKind } from "@/lib/schemas/profile"
import { confirmImage, removeImage, requestImageUpload, saveMyMembershipNumber, updateMyDetails } from "@/server/actions/profile"
import { PersonInitials } from "@/components/people/people-bits"
import { ProfileCard } from "@/components/people/profile-card"

/**
 * Profile → Your details (§7.1): photo, name and phone, with the sign-in email, role and job shown
 * (People changes those). Partners also keep their ICAI membership number and signature image
 * (§7.1: optional, used on PDFs).
 */

export interface StoredImage {
  path: string | null
  /** A short-lived signed URL (private bucket). */
  url: string | null
}

// -------------------------------------------------------------------------------------------------
// Photo / signature uploader
// -------------------------------------------------------------------------------------------------

const BUCKET = "profile-images"

/**
 * A photo or signature: checked in the browser (size and real type from the first bytes), uploaded
 * straight to the private bucket through a signed URL, then checked again on the server before the
 * profile points at it (server/actions/profile.ts confirmImage).
 */
export function ImageUploader({
  kind,
  image,
  name,
  onChange,
}: {
  kind: ProfileImageKind
  image: StoredImage
  /** For the initials fallback and alt text. */
  name: string
  onChange: (image: StoredImage) => void
}) {
  const router = useRouter()
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = React.useState<"upload" | "remove" | null>(null)
  const [preview, setPreview] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const errorId = React.useId()
  const limits = PROFILE_IMAGE_LIMITS[kind]
  const what = kind === "avatar" ? "photo" : "signature"
  const shown = preview ?? image.url

  const upload = async (file: File) => {
    setError(null)
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer())
    const check = checkProfileImage(kind, head, file.size)
    if (!check.ok) {
      setError(check.error)
      return
    }
    const local = URL.createObjectURL(file)
    setPreview(local)
    setBusy("upload")
    try {
      const req = await requestImageUpload({ kind, format: check.format, size: file.size })
      if (!req.ok) throw new Error(req.ref ? `${req.error} (Ref ${req.ref})` : req.error)
      const supabase = createClient()
      const up = await supabase.storage.from(BUCKET).uploadToSignedUrl(req.data.path, req.data.token, file, { contentType: req.data.contentType })
      if (up.error) throw new Error("The upload didn't go through. Check your connection and try again.")
      const done = await confirmImage({ kind, path: req.data.path, was_path: image.path })
      if (!done.ok) throw new Error(done.ref ? `${done.error} (Ref ${done.ref})` : done.error)
      for (const w of done.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(kind === "avatar" ? "Photo saved." : "Signature saved. It prints on the PDFs you sign.")
      onChange({ path: done.data.path, url: done.data.url })
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : `The ${what} couldn't be saved. Try again.`)
    } finally {
      setPreview(null)
      URL.revokeObjectURL(local)
      setBusy(null)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  const remove = async () => {
    setError(null)
    setBusy("remove")
    try {
      const r = await removeImage({ kind, was_path: image.path })
      if (!r.ok) {
        setError(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return false
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success(kind === "avatar" ? "Photo removed." : "Signature removed.")
      onChange({ path: null, url: null })
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-4">
        <div
          className={
            kind === "avatar"
              ? "flex size-20 flex-none items-center justify-center overflow-hidden rounded-full border border-border bg-surface-2"
              : "flex h-20 w-40 flex-none items-center justify-center overflow-hidden rounded-md border border-border bg-surface"
          }
        >
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL from the private bucket
            <img src={shown} alt={kind === "avatar" ? `Photo of ${name}` : `${name}'s signature`} className={kind === "avatar" ? "size-full object-cover" : "max-h-16 max-w-36 object-contain"} />
          ) : kind === "avatar" ? (
            <PersonInitials name={name} size="lg" className="size-full border-0 text-lg" />
          ) : (
            <ImageIcon aria-hidden="true" className="size-5 text-text-muted" />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={busy !== null} aria-describedby={error ? errorId : undefined}>
              {busy === "upload" ? <Spinner /> : <UploadIcon aria-hidden="true" />}
              {busy === "upload" ? "Uploading…" : image.path ? `Replace ${what}` : `Upload ${what}`}
            </Button>
            {image.path ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(true)} disabled={busy !== null}>
                <Trash2Icon aria-hidden="true" />
                Remove
              </Button>
            ) : null}
          </div>
          <p className="text-sm text-text-muted">
            {kind === "avatar" ? "PNG, JPG or WebP, at most 2 MB. A square photo looks best." : "PNG or JPG, at most 1 MB. A dark signature on a white or transparent background prints best."}
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={limits.accept}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void upload(file)
          }}
        />
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={kind === "avatar" ? "Remove your photo?" : "Remove your signature?"}
        description={kind === "avatar" ? "Your initials show instead. You can upload a photo again at any time." : "PDFs you sign show your name and “Authorised Signatory” without an image. You can upload it again at any time."}
        confirmLabel="Remove"
        destructive
        onConfirm={remove}
      />
    </div>
  )
}

// -------------------------------------------------------------------------------------------------
// Your details
// -------------------------------------------------------------------------------------------------

export function ProfileDetailsCard({
  fullName,
  phone,
  email,
  role,
  designation,
  department,
  dateOfJoining,
  avatar,
}: {
  fullName: string
  phone: string | null
  email: string
  role: AppRole
  designation: string | null
  department: string | null
  dateOfJoining: string | null
  avatar: StoredImage
}) {
  const router = useRouter()
  const [photo, setPhoto] = React.useState<StoredImage>(avatar)
  const f = useActionForm(ProfileDetailsSchema, updateMyDetails, {
    defaultValues: { was_full_name: fullName, was_phone: phone ?? "", full_name: fullName, phone: phone ?? "" },
    resetOnSuccess: false,
    onSuccess: (data) => {
      f.form.reset({ was_full_name: data.full_name, was_phone: data.phone ?? "", full_name: data.full_name, phone: data.phone ?? "" })
      toast.success(data.changed ? "Details saved." : "Nothing had changed, so nothing was saved.")
      if (data.changed) router.refresh()
    },
  })
  const dirty = f.form.formState.isDirty
  const name = f.form.watch("full_name") || fullName

  return (
    <ProfileCard id="details" title="Your details" description="How you appear to the team and on what you send.">
      <div className="flex flex-col gap-6">
        <ImageUploader kind="avatar" image={photo} name={name} onChange={setPhoto} />
        <form noValidate onSubmit={f.onSubmit} className="flex flex-col gap-4">
          <UnsavedChangesGuard when={dirty && !f.pending} />
          <FormAlert state={f} />
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
            <TextField control={f.control} name="full_name" label="Full name" required autoComplete="name" />
            <TextField control={f.control} name="phone" label="Phone" type="tel" autoComplete="tel" inputMode="tel" helper="Your own number, for the team. Clients don't see it." />
          </div>
          <div className="flex items-center justify-end gap-2">
            {dirty ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => f.form.reset()} disabled={f.pending}>
                Discard
              </Button>
            ) : null}
            <Button type="submit" size="sm" disabled={!dirty || f.pending}>
              {f.pending ? <Spinner /> : null}
              Save details
            </Button>
          </div>
        </form>
        <div className="border-t border-border pt-4">
          <DefinitionList
            columns={2}
            items={[
              {
                term: "Sign-in email",
                value: (
                  <span className="flex flex-col gap-0.5">
                    <span className="break-all">{email}</span>
                    <span className="text-sm text-text-muted">A Partner or Manager changes it from People.</span>
                  </span>
                ),
              },
              { term: "Role", value: <RoleBadge role={role} /> },
              { term: "Designation", value: designation },
              { term: "Department", value: department },
              { term: "Joined", value: dateOfJoining ? formatDate(dateOfJoining) : null },
            ]}
          />
        </div>
      </div>
    </ProfileCard>
  )
}

// -------------------------------------------------------------------------------------------------
// Partners: ICAI membership number and signature
// -------------------------------------------------------------------------------------------------

export function PartnerDetailsCard({ icaiMembershipNo, signature, name }: { icaiMembershipNo: string | null; signature: StoredImage; name: string }) {
  const router = useRouter()
  const [sig, setSig] = React.useState<StoredImage>(signature)
  const f = useActionForm(MembershipSchema, saveMyMembershipNumber, {
    defaultValues: { was_icai_membership_no: icaiMembershipNo ?? "", icai_membership_no: icaiMembershipNo ?? "" },
    resetOnSuccess: false,
    onSuccess: (data) => {
      f.form.reset({ was_icai_membership_no: data.icai_membership_no ?? "", icai_membership_no: data.icai_membership_no ?? "" })
      toast.success(data.changed ? "Membership number saved." : "Nothing had changed, so nothing was saved.")
      if (data.changed) router.refresh()
    },
  })
  const dirty = f.form.formState.isDirty
  return (
    <ProfileCard id="partner" title="Partner details" description="Printed with your name when you sign reports, invoices and letters, and used for UDINs.">
      <div className="flex flex-col gap-6">
        <form noValidate onSubmit={f.onSubmit} className="flex flex-col gap-4">
          <UnsavedChangesGuard when={dirty && !f.pending} />
          <FormAlert state={f} />
          <div className="grid grid-cols-1 items-end gap-x-6 gap-y-4 md:grid-cols-2">
            <TextField control={f.control} name="icai_membership_no" label="ICAI membership number" inputMode="numeric" autoComplete="off" helper="6 digits, as on your ICAI certificate." className="num" />
            <div className="flex justify-end md:justify-start">
              <Button type="submit" size="sm" variant="outline" disabled={!dirty || f.pending}>
                {f.pending ? <Spinner /> : null}
                Save number
              </Button>
            </div>
          </div>
        </form>
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <h3 className="text-sm font-medium text-text">Signature image</h3>
          <p className="text-sm text-text-muted">Optional. Without it, PDFs show your name and &ldquo;Authorised Signatory&rdquo;. Only you can see the file.</p>
          <ImageUploader kind="signature" image={sig} name={name} onChange={setSig} />
        </div>
      </div>
    </ProfileCard>
  )
}
