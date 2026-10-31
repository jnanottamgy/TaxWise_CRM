"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { applySignature, firstNameOf } from "@/lib/domain/messaging"
import { isTemplateVariable, type TemplateValues } from "@/lib/domain/templates"
import { TEMPLATE_CHANNEL_LABELS, type TemplateChannel } from "@/lib/schemas/message-templates"

/**
 * A template rendered with the sample client (§7.13.4 "Preview renders with a sample client").
 * Filled-in variables are tinted so you can see where each lands; a variable that isn't in the
 * list, or a malformed placeholder, is shown as written in red (it can't be saved). WhatsApp
 * previews end with the sender's signature when they add one on the shared numbers (§7.13.2).
 */

const TOKEN = /\{\{([^{}]*)\}\}/g
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

type Segment = { kind: "text"; text: string } | { kind: "value"; text: string; name: string } | { kind: "empty"; name: string } | { kind: "bad"; raw: string }

function segments(text: string, values: TemplateValues): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) })
    const name = m[1].trim()
    if (!NAME.test(name) || !isTemplateVariable(name)) out.push({ kind: "bad", raw: m[0] })
    else {
      const v = values[name]
      if (v === null || v === undefined || v === "") out.push({ kind: "empty", name })
      else out.push({ kind: "value", text: String(v), name })
    }
    last = at + m[0].length
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) })
  return out
}

export function RenderedText({ text, values, className }: { text: string; values: TemplateValues; className?: string }) {
  const parts = segments(text, values)
  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {parts.map((p, i) => {
        switch (p.kind) {
          case "text":
            return <React.Fragment key={i}>{p.text}</React.Fragment>
          case "value":
            return (
              <span key={i} title={`{{${p.name}}}`} className="rounded-sm bg-primary-soft px-0.5 text-text">
                {p.text}
              </span>
            )
          case "empty":
            return (
              <span key={i} title={`{{${p.name}}} has no value in this preview`} className="rounded-sm bg-surface-2 px-0.5 text-text-muted">
                [{p.name}]
              </span>
            )
          case "bad":
            return (
              <span key={i} title="Not an available variable. Pick variables from the list." className="rounded-sm bg-danger-soft px-0.5 font-medium text-danger-text">
                {p.raw}
              </span>
            )
        }
      })}
    </span>
  )
}

export function TemplatePreview({
  channel,
  subject,
  body,
  values,
  signature,
  senderName,
  className,
}: {
  channel: TemplateChannel
  subject: string | null | undefined
  body: string
  values: TemplateValues
  /** The sender's WhatsApp signature format, when they add it (null = they don't). */
  signature: string | null
  senderName: string
  className?: string
}) {
  const showSubject = channel === "email"
  const showSignature = channel !== "email" && signature !== null && body.trim().length > 0
  const signed = showSignature ? applySignature("", signature, firstNameOf(senderName)) : ""
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-text">Preview</p>
        <p className="text-xs text-text-muted">Sample client · {TEMPLATE_CHANNEL_LABELS[channel]}</p>
      </div>
      <div className="rounded-lg border border-border bg-surface-2/50 p-3 text-base text-text">
        {showSubject ? (
          <p className="mb-2 border-b border-border pb-2 text-sm">
            <span className="text-text-muted">Subject: </span>
            {subject?.trim() ? <RenderedText text={subject} values={values} className="font-medium" /> : <span className="text-text-muted">No subject yet</span>}
          </p>
        ) : null}
        {body.trim() ? (
          <p className="text-base leading-6 break-words whitespace-pre-wrap">
            <RenderedText text={body.replace(/\s+$/, "")} values={values} />
            {showSignature && signed ? (
              <>
                {"\n\n"}
                <span className="text-text-muted" title="Your signature on the shared office numbers (Profile → WhatsApp drafts)">
                  {signed}
                </span>
              </>
            ) : null}
          </p>
        ) : (
          <p className="text-sm text-text-muted">The message shows here as you write it.</p>
        )}
      </div>
      <p className="text-xs text-text-muted">
        Filled in for {String(values.client_name ?? "the sample client")}
        {values.contact_name ? ` (contact ${String(values.contact_name)})` : ""}. Real messages use each client&apos;s own details.
      </p>
    </div>
  )
}
