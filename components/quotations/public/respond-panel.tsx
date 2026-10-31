"use client"

import * as React from "react"
import { CircleAlertIcon, CircleCheckIcon, CircleXIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { FieldShell } from "@/components/app/form/field-shell"
import { formatDateTime } from "@/lib/format"
import { RespondSchema, type RespondInput, type RespondResult } from "@/lib/schemas/quotations"

type Mode = "choose" | "accept" | "decline"
type Done = { kind: "accepted"; name: string; at: string | null } | { kind: "declined"; at: string | null } | { kind: "closed"; message: string }

/**
 * Accept or Decline on the client's link (§7.23): Accept asks for their full name (the e-acceptance)
 * and an optional note; Decline asks for a reason. Each ends on a confirmation screen. When the
 * quotation changed meanwhile (accepted, declined, expired or replaced), the message says so and
 * the buttons go. Validated here and again on the server.
 */
export function RespondPanel({
  token,
  number,
  total,
  validUntil,
  respond,
}: {
  token: string
  number: string
  /** "₹56,050.54". */
  total: string
  /** "22 Nov 2026". */
  validUntil: string
  respond: (token: string, input: RespondInput) => Promise<RespondResult>
}) {
  const [mode, setMode] = React.useState<Mode>("choose")
  const [name, setName] = React.useState("")
  const [note, setNote] = React.useState("")
  const [reason, setReason] = React.useState("")
  const [errors, setErrors] = React.useState<{ name?: string; note?: string; reason?: string }>({})
  const [formError, setFormError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [done, setDone] = React.useState<Done | null>(null)
  const headingRef = React.useRef<HTMLHeadingElement | null>(null)
  const alertRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (done) headingRef.current?.focus()
  }, [done])

  React.useEffect(() => {
    if (mode === "accept") document.getElementById("respond-name")?.focus()
    if (mode === "decline") document.getElementById("respond-reason")?.focus()
  }, [mode])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    const input: RespondInput = mode === "accept" ? { response: "accept", name, note } : { response: "decline", reason }
    const parsed = RespondSchema.safeParse(input)
    if (!parsed.success) {
      const next: typeof errors = {}
      for (const issue of parsed.error.issues) {
        const k = issue.path[0]
        if ((k === "name" || k === "note" || k === "reason") && !next[k]) next[k] = issue.message
      }
      setErrors(next)
      return
    }
    setErrors({})
    setPending(true)
    try {
      const r = await respond(token, input)
      if (r.ok) {
        setDone(r.outcome === "accepted" ? { kind: "accepted", name: r.acceptedByName ?? name.trim(), at: r.respondedAt } : { kind: "declined", at: r.respondedAt })
        return
      }
      if (r.field) {
        setErrors({ [r.field]: r.error })
        return
      }
      if (r.outcome && r.outcome !== "invalid") {
        setDone({ kind: "closed", message: r.error })
        return
      }
      setFormError(r.error)
      requestAnimationFrame(() => alertRef.current?.focus())
    } catch {
      setFormError("We couldn't reach TaxWise. Check your connection and try again.")
      requestAnimationFrame(() => alertRef.current?.focus())
    } finally {
      setPending(false)
    }
  }

  if (done) {
    const accepted = done.kind === "accepted"
    return (
      <section aria-live="polite" className="rounded-lg border border-border bg-surface px-4 py-5 md:px-6">
        <div className="flex items-start gap-3">
          {done.kind === "accepted" ? (
            <CircleCheckIcon className="mt-1 size-5 flex-none text-success-text" aria-hidden="true" />
          ) : done.kind === "declined" ? (
            <CircleXIcon className="mt-1 size-5 flex-none text-text-muted" aria-hidden="true" />
          ) : (
            <CircleAlertIcon className="mt-1 size-5 flex-none text-warning-text" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-text outline-none">
              {done.kind === "accepted" ? "Thank you. Quotation accepted." : done.kind === "declined" ? "Thank you for letting us know." : "This quotation can't take a response"}
            </h2>
            {done.kind === "accepted" ? (
              <>
                <p className="mt-1 text-base text-text">
                  You accepted quotation <span className="font-mono text-[13px]">{number}</span> ({total} including GST) electronically as <span className="font-semibold">{done.name}</span>
                  {done.at ? ` on ${formatDateTime(done.at)}` : ""}.
                </p>
                <p className="mt-2 text-base text-text-muted">We&apos;ll be in touch shortly to get started.</p>
              </>
            ) : done.kind === "declined" ? (
              <p className="mt-1 text-base text-text">
                You declined quotation <span className="font-mono text-[13px]">{number}</span>
                {done.at ? ` on ${formatDateTime(done.at)}` : ""}. Your reason has reached us; if something changes, we&apos;re happy to send an updated quotation.
              </p>
            ) : (
              <p className="mt-1 text-base text-text">{done.message}</p>
            )}
            {!accepted && done.kind === "closed" ? <p className="mt-2 text-sm text-text-muted">Reload the page to see where it stands.</p> : null}
          </div>
        </div>
      </section>
    )
  }

  return (
    <section aria-labelledby="respond-title" className="rounded-lg border border-border bg-surface px-4 py-5 md:px-6">
      <h2 id="respond-title" className="text-lg font-semibold text-text">
        {mode === "accept" ? "Accept this quotation" : mode === "decline" ? "Decline this quotation" : "Your response"}
      </h2>
      {mode === "choose" ? (
        <>
          <p className="mt-1 text-base text-text-muted">
            {total} including GST, valid until {validUntil}. Accepting takes a minute and needs only your name.
          </p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <Button type="button" size="lg" className="sm:min-w-44" onClick={() => setMode("accept")}>
              <CircleCheckIcon aria-hidden="true" />
              Accept
            </Button>
            <Button type="button" size="lg" variant="outline" className="sm:min-w-44" onClick={() => setMode("decline")}>
              Decline
            </Button>
          </div>
        </>
      ) : (
        <form onSubmit={submit} noValidate className="mt-3 flex flex-col gap-4">
          {formError ? (
            <div ref={alertRef} tabIndex={-1} role="alert" className="flex gap-2.5 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-base text-text outline-none">
              <CircleAlertIcon className="mt-0.5 size-4 flex-none text-danger-text" aria-hidden="true" />
              <p className="min-w-0">{formError}</p>
            </div>
          ) : null}
          {mode === "accept" ? (
            <>
              <FieldShell id="respond-name" label="Your full name" required error={errors.name ?? null} helper="Typing your name is your electronic acceptance of this quotation and its terms.">
                {(aria) => <Input {...aria} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} />}
              </FieldShell>
              <FieldShell id="respond-note" label="Note for us" error={errors.note ?? null} helper="Optional: a start date, a contact person, anything we should know.">
                {(aria) => <Textarea {...aria} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} />}
              </FieldShell>
            </>
          ) : (
            <FieldShell id="respond-reason" label="Why are you declining?" required error={errors.reason ?? null} helper="A line is enough. It helps us send a better quotation next time.">
              {(aria) => <Textarea {...aria} value={reason} onChange={(e) => setReason(e.target.value)} rows={4} maxLength={2000} />}
            </FieldShell>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              size="lg"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setMode("choose")
                setErrors({})
                setFormError(null)
              }}
            >
              Back
            </Button>
            <Button type="submit" size="lg" variant={mode === "decline" ? "destructive-outline" : "default"} disabled={pending} className="sm:min-w-48">
              {pending ? <Spinner /> : null}
              {mode === "accept" ? "Accept quotation" : "Decline quotation"}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}
