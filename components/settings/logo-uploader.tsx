"use client"

import * as React from "react"
import { toast } from "sonner"
import { Trash2Icon, UploadIcon } from "lucide-react"
import { createClient } from "@/lib/supabase/browser"
import { checkLogoBytes, LOGO_ACCEPT, LOGO_CONTENT_TYPE } from "@/lib/schemas/settings"
import { confirmLogo, removeLogo, requestLogoUpload } from "@/server/actions/settings"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { TaxWiseShield } from "@/components/brand/taxwise-logo"

/**
 * The firm logo. TaxWise's own logo is built in (lib/brand.ts) and prints on every document; a file
 * uploaded here replaces it on screen and on paper (§1: PNG, SVG or JPG, at most 1 MB, transparent
 * background preferred), and removing it brings the built-in one back. The file is checked in the
 * browser first (size, magic bytes, SVG safety), uploaded straight to the branding bucket through a
 * signed URL, then checked again on the server before firm_settings points at it. While it uploads,
 * the invoice preview already shows the chosen file.
 */
export function LogoUploader({
  logoUrl,
  updatedAt,
  onPreview,
  onSaved,
}: {
  logoUrl: string | null
  /** firm_settings.updated_at as the form holds it (the concurrency token). */
  updatedAt: string
  /** A local preview URL while uploading (null to go back to the saved logo). */
  onPreview: (url: string | null) => void
  /** After the server saved (or removed) the logo: the new token and URL. */
  onSaved: (result: { updated_at: string; logoUrl: string | null }) => void
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = React.useState<"upload" | "remove" | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const errorId = React.useId()

  const pick = () => inputRef.current?.click()

  const upload = async (file: File) => {
    setError(null)
    const head = new Uint8Array(await file.slice(0, file.type === "image/svg+xml" || /\.svg$/i.test(file.name) ? file.size : 4096).arrayBuffer())
    const check = checkLogoBytes(head, file.size)
    if (!check.ok) {
      setError(check.error)
      return
    }
    const local = URL.createObjectURL(file)
    onPreview(local)
    setBusy("upload")
    try {
      const req = await requestLogoUpload({ kind: check.kind, size: file.size })
      if (!req.ok) throw new Error(req.error)
      const supabase = createClient()
      const up = await supabase.storage.from("branding").uploadToSignedUrl(req.data.path, req.data.token, file, {
        contentType: LOGO_CONTENT_TYPE[check.kind],
        cacheControl: "31536000",
      })
      if (up.error) throw new Error("The upload didn't go through. Check your connection and try again.")
      const done = await confirmLogo({ path: req.data.path, updated_at: updatedAt })
      if (!done.ok) throw new Error(done.error)
      for (const w of done.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success("Logo saved. It now prints on invoices and quotations in place of the built-in one.")
      onSaved({ updated_at: done.data.updated_at, logoUrl: done.data.logoUrl })
    } catch (err) {
      setError(err instanceof Error ? err.message : "The logo couldn't be saved. Try again.")
    } finally {
      onPreview(null)
      URL.revokeObjectURL(local)
      setBusy(null)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  const remove = async () => {
    setError(null)
    setBusy("remove")
    try {
      const r = await removeLogo({ updated_at: updatedAt })
      if (!r.ok) {
        setError(r.error)
        return false
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      toast.success("Logo removed. Documents show the built-in TaxWise logo again.")
      onSaved({ updated_at: r.data.updated_at, logoUrl: null })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 md:col-span-2">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex size-20 flex-none items-center justify-center overflow-hidden rounded-md border border-border bg-surface-2">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- public branding URL
            <img src={logoUrl} alt="Current logo" className="max-h-16 max-w-16 object-contain" />
          ) : (
            <TaxWiseShield title="Built-in TaxWise logo" className="h-14" />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={pick} disabled={busy !== null} aria-describedby={error ? errorId : undefined}>
              {busy === "upload" ? <Spinner /> : <UploadIcon aria-hidden="true" />}
              {busy === "upload" ? "Uploading…" : logoUrl ? "Replace logo" : "Use a different logo"}
            </Button>
            {logoUrl ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(true)} disabled={busy !== null}>
                <Trash2Icon aria-hidden="true" />
                Remove
              </Button>
            ) : null}
          </div>
          <p className="text-sm text-text-muted">
            {logoUrl
              ? "Your uploaded logo prints on every document. Remove it to go back to the built-in TaxWise logo."
              : "The TaxWise logo is built in and prints on every document. Upload a file only to use a different one: PNG, JPG or SVG, at most 1 MB."}
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={LOGO_ACCEPT}
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
        title="Remove the logo?"
        description="Invoices, quotations and the portal will show the built-in TaxWise logo again. You can upload a logo again at any time."
        confirmLabel="Remove logo"
        destructive
        onConfirm={remove}
      />
    </div>
  )
}
