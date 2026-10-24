"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AtSignIcon, PencilIcon, SendIcon, Trash2Icon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { formatDateTime, formatTimeAgo } from "@/lib/format"
import { COMMENT_MAX, mentionQueryAt, mentionToken, mentionsInBody } from "@/lib/schemas/tasks"
import { addTaskComment, deleteTaskComment, editTaskComment } from "@/server/actions/task-comments"
import { toastResult } from "@/components/tasks/task-ui"

/**
 * Comments on a task (§7.6.6): anyone who can see the task writes; typing @ suggests colleagues, and
 * each @mention left in the comment notifies that person (§9). Authors edit their own; authors,
 * Managers and Partners remove.
 */

export type CommentRow = { id: string; author_id: string; author_name: string | null; body: string; edited_at: string | null; created_at: string }
export type MentionPerson = { id: string; name: string; designation: string | null }

/** The comment body with @mentions of known people set in medium weight. */
function Body({ text, people }: { text: string; people: MentionPerson[] }) {
  const names = people.map((p) => mentionToken(p.name)).filter((t) => text.includes(t))
  if (!names.length) return <>{text}</>
  const pattern = new RegExp(`(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g")
  return (
    <>
      {text.split(pattern).map((part, i) =>
        names.includes(part) ? (
          <span key={i} className="font-medium text-primary">
            {part}
          </span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  )
}

function Composer({
  people,
  initial = "",
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  people: MentionPerson[]
  initial?: string
  submitLabel: string
  onSubmit: (body: string, mentions: string[]) => Promise<boolean>
  onCancel?: () => void
  autoFocus?: boolean
}) {
  const [body, setBody] = React.useState(initial)
  const [picked, setPicked] = React.useState<MentionPerson[]>(() => people.filter((p) => initial.includes(mentionToken(p.name))))
  const [query, setQuery] = React.useState<{ query: string; start: number } | null>(null)
  const [active, setActive] = React.useState(0)
  const [pending, setPending] = React.useState(false)
  const ref = React.useRef<HTMLTextAreaElement>(null)
  const listId = React.useId()

  const matches = query ? people.filter((p) => p.name.toLowerCase().includes(query.query.toLowerCase())).slice(0, 6) : []

  const pick = (p: MentionPerson) => {
    if (!query || !ref.current) return
    const caret = ref.current.selectionStart ?? body.length
    const next = `${body.slice(0, query.start)}${mentionToken(p.name)} ${body.slice(caret)}`
    setBody(next)
    setPicked((list) => (list.some((x) => x.id === p.id) ? list : [...list, p]))
    setQuery(null)
    const pos = query.start + mentionToken(p.name).length + 1
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(pos, pos)
    })
  }

  const submit = async () => {
    if (!body.trim()) return
    setPending(true)
    try {
      const ok = await onSubmit(body.trim(), mentionsInBody(body, picked))
      if (ok && !initial) {
        setBody("")
        setPicked([])
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="relative flex flex-col gap-2">
      <Textarea
        ref={ref}
        value={body}
        rows={3}
        maxLength={COMMENT_MAX}
        autoFocus={autoFocus}
        aria-label="Comment"
        aria-autocomplete="list"
        aria-controls={matches.length ? listId : undefined}
        aria-expanded={matches.length > 0}
        placeholder="Write a comment. Type @ to mention someone."
        onChange={(e) => {
          setBody(e.target.value)
          setQuery(mentionQueryAt(e.target.value, e.target.selectionStart ?? e.target.value.length))
          setActive(0)
        }}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === "ArrowDown") {
              e.preventDefault()
              setActive((a) => (a + 1) % matches.length)
              return
            }
            if (e.key === "ArrowUp") {
              e.preventDefault()
              setActive((a) => (a - 1 + matches.length) % matches.length)
              return
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault()
              pick(matches[active])
              return
            }
            if (e.key === "Escape") {
              setQuery(null)
              return
            }
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      {matches.length ? (
        <ul id={listId} role="listbox" aria-label="People to mention" className="absolute top-full left-0 z-20 mt-1 w-64 overflow-hidden rounded-md border border-border bg-surface py-1 shadow-2">
          {matches.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(p)
                }}
                className={cn("flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-left text-sm", i === active ? "bg-primary-soft text-text" : "text-text hover:bg-surface-2")}
              >
                <span className="truncate">{p.name}</span>
                {p.designation ? <span className="truncate text-xs text-text-muted">{p.designation}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs text-text-muted">
          <AtSignIcon aria-hidden="true" className="size-3.5" />
          Mentioned people are notified.
        </span>
        <span className="flex gap-2">
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
          ) : null}
          <Button type="button" size="sm" onClick={() => void submit()} disabled={pending || !body.trim()} aria-busy={pending}>
            {pending ? <Spinner /> : <SendIcon aria-hidden="true" />}
            {submitLabel}
          </Button>
        </span>
      </div>
    </div>
  )
}

export function TaskComments({
  taskId,
  comments,
  people,
  viewerId,
  canModerate,
  now: serverNow,
}: {
  taskId: string
  comments: CommentRow[]
  people: MentionPerson[]
  viewerId: string
  canModerate: boolean
  /** The server's render time (ISO), so "12 hours ago" hydrates to the same text. */
  now?: string
}) {
  const [now] = React.useState(() => (serverNow ? new Date(serverNow) : new Date()))
  const router = useRouter()
  const [editing, setEditing] = React.useState<string | null>(null)
  const [removing, setRemoving] = React.useState<CommentRow | null>(null)
  const others = people.filter((p) => p.id !== viewerId)

  return (
    <SectionCard title="Comments" description={comments.length ? `${comments.length} ${comments.length === 1 ? "comment" : "comments"}` : undefined} id="comments">
      {comments.length === 0 ? <EmptyState size="compact" message="No comments yet. Questions and decisions about this task go here." className="mb-4" /> : null}
      <ol className="mb-4 flex flex-col gap-4">
        {comments.map((c) => (
          <li key={c.id} id={`comment-${c.id}`} className="scroll-mt-24">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-sm font-medium text-text">{c.author_name ?? "A colleague"}</span>
              <span className="text-xs text-text-muted" title={formatDateTime(c.created_at)}>
                {formatTimeAgo(c.created_at, now)}
                {c.edited_at ? " · edited" : ""}
              </span>
            </div>
            {editing === c.id ? (
              <div className="mt-1.5">
                <Composer
                  people={others}
                  initial={c.body}
                  submitLabel="Save"
                  autoFocus
                  onCancel={() => setEditing(null)}
                  onSubmit={async (body, mentions) => {
                    const r = await editTaskComment({ id: c.id, body, mentions })
                    if (!toastResult(r)) return false
                    setEditing(null)
                    router.refresh()
                    return true
                  }}
                />
              </div>
            ) : (
              <p className="mt-0.5 text-base whitespace-pre-wrap text-text">
                <Body text={c.body} people={people} />
              </p>
            )}
            {editing !== c.id && (c.author_id === viewerId || canModerate) ? (
              <div className="mt-1 flex gap-1">
                {c.author_id === viewerId ? (
                  <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(c.id)}>
                    <PencilIcon aria-hidden="true" />
                    Edit
                  </Button>
                ) : null}
                <Button type="button" variant="ghost" size="xs" onClick={() => setRemoving(c)}>
                  <Trash2Icon aria-hidden="true" />
                  Remove
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <Composer
        people={others}
        submitLabel="Comment"
        onSubmit={async (body, mentions) => {
          const r = await addTaskComment({ task_id: taskId, body, mentions })
          if (!toastResult(r)) return false
          router.refresh()
          return true
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => (!o ? setRemoving(null) : undefined)}
        title="Remove this comment?"
        description="It disappears from the task for everyone. The audit log keeps a record that it was removed."
        confirmLabel="Remove comment"
        destructive
        onConfirm={async () => {
          if (!removing) return
          const r = await deleteTaskComment({ id: removing.id })
          if (!toastResult(r, "Comment removed.")) return false
          setRemoving(null)
          router.refresh()
        }}
      />
    </SectionCard>
  )
}
