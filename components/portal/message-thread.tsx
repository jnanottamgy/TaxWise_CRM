"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CheckCheckIcon, CheckIcon, MessageSquareIcon, PaperclipIcon, SendIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState } from "@/components/app/empty-state"
import { FormAlert } from "@/components/app/form/form-alert"
import type { FormError } from "@/hooks/use-action-form"
import { formatDate, formatDateTime, formatTime } from "@/lib/format"
import { istDateOf } from "@/lib/domain/fy"
import { formatFileSize } from "@/lib/domain/files"
import { MESSAGE_LIMITS } from "@/lib/schemas/portal"
import { markPortalMessagesRead, sendPortalMessage } from "@/server/actions/portal"
import type { PortalMessage } from "@/lib/data/portal"
import { FileTypeMark } from "@/components/documents/file-type-mark"
import { PortalDropzone } from "@/components/portal/portal-dropzone"
import { PendingFileList } from "@/components/portal/pending-file-list"
import { usePendingUploads } from "@/components/portal/use-pending-uploads"

/**
 * The thread with the firm (§7.22 Messages): every portal message, oldest first, grouped by day;
 * the firm's on the left with the sender's name, the client's own on the right with a read receipt
 * ("Seen by the firm"); attachments open through the RLS-checked file route. Opening the page marks
 * the firm's messages read, which is the read receipt the firm sees. Staff reply from the Client 360
 * Communication tab. No WhatsApp here, ever (§7.25).
 */

function Attachment({ a }: { a: PortalMessage["attachments"][number] }) {
  return (
    <a
      href={`/api/files/documents/${a.documentId}`}
      className="flex min-w-0 items-center gap-2.5 rounded-md border border-border bg-surface px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <FileTypeMark mimeType={a.mimeType} fileName={a.fileName} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-text">{a.title}</span>
        <span className="num block text-xs text-text-muted tabular-nums">{formatFileSize(a.fileSize)}</span>
      </span>
    </a>
  )
}

function Bubble({ m, firmName }: { m: PortalMessage; firmName: string }) {
  const mine = m.direction === "inbound"
  const at = m.sentAt ?? m.createdAt
  return (
    <li className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div className={cn("flex max-w-[min(36rem,88%)] flex-col gap-1", mine ? "items-end" : "items-start")}>
        <p className="text-xs text-text-muted">
          {mine ? "You" : m.senderName ? `${m.senderName}, ${firmName}` : firmName} · <time dateTime={at}>{formatTime(at)}</time>
        </p>
        <div className={cn("rounded-lg border px-3.5 py-2.5 text-base text-text", mine ? "border-primary/20 bg-primary-soft" : "border-border bg-surface")}>
          {m.subject ? <p className="mb-1 font-medium">{m.subject}</p> : null}
          <p className="break-words whitespace-pre-wrap">{m.body}</p>
        </div>
        {m.attachments.length > 0 ? (
          <div className="grid w-full gap-1.5 sm:grid-cols-2">
            {m.attachments.map((a) => (
              <Attachment key={a.documentId} a={a} />
            ))}
          </div>
        ) : null}
        {mine ? (
          <p className="inline-flex items-center gap-1 text-xs text-text-muted">
            {m.readAt ? (
              <>
                <CheckCheckIcon aria-hidden="true" className="size-3.5 text-success-text" />
                Seen by the firm {formatDateTime(m.readAt)}
              </>
            ) : (
              <>
                <CheckIcon aria-hidden="true" className="size-3.5" />
                Sent, not seen yet
              </>
            )}
          </p>
        ) : null}
      </div>
    </li>
  )
}

function groupByDay(messages: PortalMessage[]): Array<{ day: string; items: PortalMessage[] }> {
  const out: Array<{ day: string; items: PortalMessage[] }> = []
  for (const m of messages) {
    let day: string
    try {
      day = istDateOf(m.sentAt ?? m.createdAt)
    } catch {
      day = ""
    }
    const last = out[out.length - 1]
    if (last && last.day === day) last.items.push(m)
    else out.push({ day, items: [m] })
  }
  return out
}

export function MessageThread({
  messages,
  hasEarlier,
  earlierHref,
  atLatest,
  firmName,
  clientId,
  ownerName,
  unreadFromFirm,
}: {
  messages: PortalMessage[]
  hasEarlier: boolean
  earlierHref: string | null
  /** Showing the latest messages (not an earlier page): open at the composer. */
  atLatest: boolean
  firmName: string
  clientId: string
  ownerName: string | null
  unreadFromFirm: number
}) {
  const router = useRouter()
  const [body, setBody] = React.useState("")
  const [error, setError] = React.useState<FormError | null>(null)
  const [fieldError, setFieldError] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)
  const [attachOpen, setAttachOpen] = React.useState(false)
  const files = usePendingUploads({ clientId, max: MESSAGE_LIMITS.attachments, category: "other" })
  const alertRef = React.useRef<HTMLDivElement | null>(null)
  const composerRef = React.useRef<HTMLFormElement | null>(null)
  const bodyId = React.useId()
  const hintId = React.useId()

  // Opening the thread is reading the firm's messages: their read receipts (§7.22).
  const marked = React.useRef(false)
  React.useEffect(() => {
    if (marked.current || unreadFromFirm === 0) return
    marked.current = true
    void markPortalMessagesRead({}).catch(() => undefined)
  }, [unreadFromFirm])

  // The latest messages and the composer in view, as a chat opens; not when reading earlier pages.
  React.useEffect(() => {
    if (atLatest && messages.length > 0) composerRef.current?.scrollIntoView({ block: "end" })
  }, [atLatest, messages.length])

  const busy = sending || files.busy
  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setFieldError(null)
    const text = body.trim()
    if (!text) {
      setFieldError("Write your message.")
      return
    }
    if (text.length > MESSAGE_LIMITS.body) {
      setFieldError(`Keep the message under ${MESSAGE_LIMITS.body.toLocaleString("en-IN")} characters.`)
      return
    }
    setSending(true)
    try {
      const up = await files.uploadAll()
      if (!up.ok) {
        setError({ message: up.error, ref: up.ref })
        requestAnimationFrame(() => alertRef.current?.focus())
        return
      }
      const res = await sendPortalMessage({ body: text, uploadIds: up.uploadIds })
      if (!res.ok) {
        const bodyErr = res.fieldErrors?.body?.[0]
        if (bodyErr) setFieldError(bodyErr)
        setError({ message: res.error, ref: res.ref })
        requestAnimationFrame(() => alertRef.current?.focus())
        return
      }
      for (const w of res.warnings ?? []) toast.warning(w, { duration: 12_000 })
      setBody("")
      files.reset()
      setAttachOpen(false)
      router.refresh()
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setSending(false)
    }
  }

  const groups = groupByDay(messages)
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section aria-label="Messages with the firm" className="rounded-lg border border-border bg-surface">
        {hasEarlier && earlierHref ? (
          <div className="border-b border-border px-4 py-2 text-center">
            <Link href={earlierHref} className="text-sm font-medium text-primary hover:underline">
              Show earlier messages
            </Link>
          </div>
        ) : null}
        {messages.length === 0 ? (
          <EmptyState
            icon={<MessageSquareIcon />}
            message={`No messages yet. Ask ${ownerName ? `${ownerName} or the team` : "the team"} anything below, and attach files if you need to.`}
          />
        ) : (
          <div className="flex flex-col gap-4 px-3 py-4 sm:px-5">
            {groups.map((g) => (
              <div key={g.day || "undated"} className="flex flex-col gap-3">
                {g.day ? (
                  <p className="text-center text-xs font-medium text-text-muted">
                    <span className="num tabular-nums">{formatDate(g.day)}</span>
                  </p>
                ) : null}
                <ol className="flex flex-col gap-3">
                  {g.items.map((m) => (
                    <Bubble key={m.id} m={m} firmName={firmName} />
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </section>

      <form ref={composerRef} onSubmit={send} noValidate aria-label="Write to the firm" className="rounded-lg border border-border bg-surface p-3 sm:p-4">
        <FormAlert error={error} state={{ formError: error, alertRef }} className="mb-3" />
        <label htmlFor={bodyId} className="mb-1 block text-sm font-medium text-text">
          Message
        </label>
        <Textarea
          id={bodyId}
          value={body}
          onChange={(e) => {
            setBody(e.target.value)
            if (fieldError) setFieldError(null)
          }}
          rows={3}
          maxLength={MESSAGE_LIMITS.body + 200}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={hintId}
          disabled={busy}
          placeholder="Write to your accountant"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              e.currentTarget.form?.requestSubmit()
            }
          }}
        />
        <p id={hintId} className={cn("mt-1 text-sm", fieldError ? "text-danger-text" : "text-text-muted")}>
          {fieldError ?? "Your accountant replies here. Don't share passwords or OTPs in messages."}
        </p>
        {attachOpen || files.files.length > 0 ? (
          <div className="mt-3 flex flex-col gap-2">
            <PendingFileList uploads={files} />
            {files.files.length < MESSAGE_LIMITS.attachments ? <PortalDropzone onFiles={files.add} multiple compact disabled={busy} /> : null}
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          {!attachOpen && files.files.length === 0 ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setAttachOpen(true)} disabled={busy} className="-ml-2">
              <PaperclipIcon aria-hidden="true" />
              Attach files
            </Button>
          ) : (
            <span className="text-sm text-text-muted">Up to {MESSAGE_LIMITS.attachments} files, 25 MB each.</span>
          )}
          <Button type="submit" disabled={busy || files.checking} aria-busy={busy} className="ml-auto">
            {busy ? <Spinner /> : <SendIcon aria-hidden="true" />}
            {files.busy ? "Uploading" : "Send"}
          </Button>
        </div>
      </form>
    </div>
  )
}
