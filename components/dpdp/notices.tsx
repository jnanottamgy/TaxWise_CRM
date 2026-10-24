"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useWatch } from "react-hook-form"
import { CheckIcon, FilePlus2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextField, TextareaField } from "@/components/app/form/fields"
import { StatusChip } from "@/components/app/status-chip"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { EmptyState } from "@/components/app/empty-state"
import { useActionForm } from "@/hooks/use-action-form"
import { cn } from "@/lib/utils"
import { formatDateTime } from "@/lib/format"
import { NOTICE_REQUIRED_TOPICS, NOTICE_STATE_INFO, nextNoticeVersion, noticeMissingTopics, noticeState } from "@/lib/domain/dpdp"
import { NoticeDraftSchema } from "@/lib/schemas/dpdp"
import { deleteNoticeDraft, publishNotice, saveNoticeDraft } from "@/server/actions/privacy-notices"
import { toastResult } from "@/components/quality/feedback"
import type { NoticeRow } from "@/lib/data/dpdp"

function TopicChecklist({ body }: { body: string }) {
  const missing = new Set(noticeMissingTopics(body))
  return (
    <ul className="flex flex-col gap-1 text-sm" aria-label="What the notice must cover">
      {NOTICE_REQUIRED_TOPICS.map((t) => {
        const ok = !missing.has(t.label)
        return (
          <li key={t.key} className={cn("flex items-center gap-2", ok ? "text-text" : "text-warning-text")}>
            <span aria-hidden="true" className={cn("inline-flex size-4 flex-none items-center justify-center rounded-full", ok ? "bg-success-soft text-success-text" : "ring-[1.5px] ring-inset ring-warning")}>
              {ok ? <CheckIcon className="size-3" /> : null}
            </span>
            {t.label}
            <span className="sr-only">{ok ? "(covered)" : "(not found)"}</span>
          </li>
        )
      })}
    </ul>
  )
}

function DraftForm({ draft, startBody, nextVersion, onCancel }: { draft: NoticeRow | null; startBody: string; nextVersion: string; onCancel?: () => void }) {
  const router = useRouter()
  const [publishing, setPublishing] = React.useState(false)
  const [approved, setApproved] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const f = useActionForm(NoticeDraftSchema, saveNoticeDraft, {
    defaultValues: { id: draft?.id ?? "", updatedAt: draft?.updated_at ?? "", body: draft?.body ?? startBody, changeSummary: draft?.change_summary ?? "" },
    successMessage: (d) => `Draft ${d.version} saved`,
    onSuccess: () => router.refresh(),
  })
  const body = (useWatch({ control: f.control, name: "body" }) as string) ?? ""
  const dirty = f.form.formState.isDirty
  return (
    <form noValidate onSubmit={f.onSubmit} className="flex flex-col gap-4">
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <TextareaField
          control={f.control}
          name="body"
          label={`Notice text (${draft?.version ?? nextVersion})`}
          required
          rows={18}
          helper="Plain text with # headings, as the portal shows it. Say what data, why, for how long, the person's rights, how to complain and who to contact."
          className="[&_textarea]:font-mono [&_textarea]:text-sm"
        />
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-text">It covers</p>
          <TopicChecklist body={body} />
          <p className="text-xs text-text-muted">A reminder of what a privacy notice must cover under the DPDP Rules, looked for in the text. It never blocks publishing.</p>
        </div>
      </div>
      <TextField control={f.control} name="changeSummary" label="What changed" placeholder="Added the retention periods for GST records" autoComplete="off" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          {draft ? (
            <Button type="button" variant="destructive-outline" size="sm" onClick={() => setDeleting(true)}>
              Delete draft
            </Button>
          ) : onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="outline" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? <Spinner /> : null}
            {draft ? "Save draft" : `Save as ${nextVersion}`}
          </Button>
          {draft ? (
            <Button type="button" disabled={dirty || f.pending} title={dirty ? "Save the draft first." : undefined} onClick={() => setPublishing(true)}>
              Publish {draft.version}
            </Button>
          ) : null}
        </div>
      </div>
      {publishing && draft ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setPublishing(false)
              setApproved(false)
            }
          }}
          title={`Publish ${draft.version}?`}
          description="It becomes the notice in force. Portal users acknowledge it the next time they sign in, and new leads see it. A published version can't be edited; a change is a new version."
          details={
            <label className="flex items-start gap-2 text-sm text-text">
              <Checkbox checked={approved} onCheckedChange={(v) => setApproved(v === true)} className="mt-0.5" />
              The Partners have approved this text.
            </label>
          }
          confirmLabel={`Publish ${draft.version}`}
          onConfirm={async () => {
            if (!approved) return false
            const r = await publishNotice({ id: draft.id, updatedAt: draft.updated_at, confirm: true })
            if (!toastResult(r, r.ok ? `${r.data.version} published` : undefined)) return false
            setPublishing(false)
            router.refresh()
          }}
        />
      ) : null}
      {deleting && draft ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => (!o ? setDeleting(false) : undefined)}
          title={`Delete draft ${draft.version}?`}
          description="The draft is removed. Published versions are never deleted."
          confirmLabel="Delete draft"
          destructive
          onConfirm={async () => {
            const r = await deleteNoticeDraft({ id: draft.id })
            if (!toastResult(r, "Draft deleted")) return false
            setDeleting(false)
            router.refresh()
          }}
        />
      ) : null}
    </form>
  )
}

/**
 * The privacy notice editor (§7.21 Settings → Data; §6.10): the open draft (or a new version started
 * from the one in force), with a check of what §6.10 says a notice covers, then Publish, which makes
 * it current for the portal's welcome gate (§7.22). Partners only.
 */
export function NoticeEditor({ notices, starter }: { notices: NoticeRow[]; starter: string }) {
  const draft = notices.find((n) => !n.published_at) ?? null
  const current = notices.find((n) => n.is_current && n.published_at) ?? null
  const [starting, setStarting] = React.useState(false)
  const next = nextNoticeVersion(notices.map((n) => n.version))
  if (draft) return <DraftForm key={draft.id} draft={draft} startBody={draft.body} nextVersion={next} />
  if (starting) return <DraftForm draft={null} startBody={current?.body ?? starter} nextVersion={next} onCancel={() => setStarting(false)} />
  return (
    <EmptyState
      size="compact"
      message={current ? `${current.version} is in force. Changes are made in a new version, which portal users acknowledge again.` : "No notice is published yet, so portal users have nothing to acknowledge."}
      action={
        <Button type="button" size="sm" onClick={() => setStarting(true)}>
          <FilePlus2Icon aria-hidden="true" />
          {current ? `Start ${next} from ${current.version}` : `Write ${next}`}
        </Button>
      }
    />
  )
}

/** Every version with its state, who published it and when, and how many acknowledged it. */
export function NoticeVersions({ notices }: { notices: NoticeRow[] }) {
  const [open, setOpen] = React.useState<string | null>(null)
  if (!notices.length) return <p className="px-4 pb-4 text-sm text-text-muted md:px-5">No versions yet.</p>
  return (
    <ul className="divide-y divide-border">
      {notices.map((n) => {
        const st = noticeState({ publishedAt: n.published_at, isCurrent: n.is_current })
        const info = NOTICE_STATE_INFO[st]
        const expanded = open === n.id
        return (
          <li key={n.id} className="px-4 py-3 md:px-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="num text-base font-medium text-text">{n.version}</span>
              <StatusChip label={info.label} tone={info.tone} meaning={info.meaning} />
              <span className="min-w-0 flex-1 text-sm text-text-muted">
                {n.published_at ? `Published ${formatDateTime(n.published_at)}${n.published_by_name ? ` by ${n.published_by_name}` : ""} · ${n.acknowledgements} ${n.acknowledgements === 1 ? "acknowledgement" : "acknowledgements"}` : `Drafted${n.created_by_name ? ` by ${n.created_by_name}` : ""}, ${formatDateTime(n.updated_at)}`}
              </span>
              <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : n.id)}>
                {expanded ? "Hide text" : "Read"}
              </Button>
            </div>
            {n.change_summary ? <p className="mt-1 text-sm text-text">{n.change_summary}</p> : null}
            {expanded ? <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-surface-2 px-3 py-2 font-sans text-sm whitespace-pre-wrap text-text">{n.body}</pre> : null}
          </li>
        )
      })}
    </ul>
  )
}
