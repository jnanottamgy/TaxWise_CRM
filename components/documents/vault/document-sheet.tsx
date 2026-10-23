"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { DownloadIcon, ExternalLinkIcon, FileUpIcon, PencilIcon, RotateCcwIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { FormSheet } from "@/components/app/form-dialog"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { DefinitionList } from "@/components/app/definition-list"
import { DateText } from "@/components/app/date-text"
import { ErrorBlock } from "@/components/app/error-block"
import { StatusChip } from "@/components/app/status-chip"
import { DOCUMENT_CATEGORY_LABELS } from "@/lib/domain/enums"
import { formatFileSize, previewKind } from "@/lib/domain/files"
import { formatDate, formatDateTime } from "@/lib/format"
import { DOCUMENT_SOURCE_LABEL } from "@/lib/schemas/documents"
import type { DocumentDetail } from "@/lib/data/documents"
import { deleteDocument, restoreDocument } from "@/server/actions/documents"
import { documentsHref, fileHref } from "@/components/documents/doc-urls"
import { useVaultActions } from "@/components/documents/vault/vault-actions"
import { ConfidentialBadge } from "@/components/documents/vault/vault-list"
import { DocumentEditDialog } from "@/components/documents/vault/document-edit-dialog"

/**
 * One document (§7.14): the preview for PDFs and images, its facts, tags, where it is linked, every
 * version (each downloadable) and its history of uploads, views and downloads. Opened by `?doc=`, so
 * a notification or a colleague's link lands on it. The preview and every download go through
 * /api/files (a 60-second signed URL, logged).
 */

const ACTIVITY_LABEL: Record<string, string> = {
  uploaded: "uploaded it",
  downloaded: "downloaded it",
  viewed: "viewed it",
  renamed: "renamed it",
  deleted: "moved it to the recycle bin",
  version_created: "added a new version",
  tag_added: "added a tag",
  tag_removed: "removed a tag",
}

function activityDetail(a: DocumentDetail["activities"][number]): string | null {
  const m = a.metadata ?? {}
  if (a.activity === "renamed" && typeof m.from === "string" && typeof m.to === "string") return `“${m.from}” → “${m.to}”`
  if ((a.activity === "tag_added" || a.activity === "tag_removed") && typeof m.tag === "string") return m.tag
  if (a.activity === "version_created" && typeof m.version === "number") return `version ${m.version}${typeof m.change_note === "string" && m.change_note ? `: ${m.change_note}` : ""}`
  if ((a.activity === "downloaded" || a.activity === "viewed") && typeof m.version === "number") return `version ${m.version}`
  return null
}

type PreviewState = { status: "loading" } | { status: "ready"; url: string; kind: "pdf" | "image" } | { status: "error"; message: string; ref?: string }

function Preview({ documentId, title, mimeType }: { documentId: string; title: string; mimeType: string }) {
  const kind = previewKind(mimeType)
  const [state, setState] = React.useState<PreviewState>({ status: "loading" })
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    if (!kind) return
    let cancelled = false
    fetch(fileHref(documentId, { mode: "preview", json: true }), { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as { ok: boolean; data?: { url: string }; error?: string; ref?: string }
        if (cancelled) return
        if (!body.ok || !body.data) setState({ status: "error", message: body.error ?? "Couldn't load the preview.", ref: body.ref })
        else setState({ status: "ready", url: body.data.url, kind })
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: "Couldn't load the preview. Check your connection." })
      })
    return () => {
      cancelled = true
    }
  }, [documentId, kind, attempt])

  if (!kind) {
    return (
      <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-text-muted">
        There’s no preview for this type of file. Download it to open it.
      </div>
    )
  }
  if (state.status === "loading") return <Skeleton className="h-[min(56dvh,30rem)] w-full rounded-lg" />
  if (state.status === "error") {
    return (
      <div className="rounded-lg border border-border">
        <ErrorBlock
          message={state.message}
          errorRef={state.ref}
          onRetry={() => {
            setState({ status: "loading" })
            setAttempt((a) => a + 1)
          }}
        />
      </div>
    )
  }
  return state.kind === "pdf" ? (
    <iframe src={state.url} title={`Preview of ${title}`} className="h-[min(56dvh,30rem)] w-full rounded-lg border border-border bg-surface-2" />
  ) : (
    // A signed, short-lived URL from Storage: next/image can't optimise it, and must not cache it.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={state.url} alt={title} className="max-h-[min(56dvh,30rem)] w-full rounded-lg border border-border bg-surface-2 object-contain" />
  )
}

export function DocumentSheet({
  clientId,
  detail,
  canManage,
  canEdit,
  fyOptions,
  today,
}: {
  clientId: string
  detail: DocumentDetail
  /** Partner or Manager: delete, restore, confidentiality, sharing, retention. */
  canManage: boolean
  /** Staff who can see the client: edit the description, add a version. */
  canEdit: boolean
  fyOptions: string[]
  today: string
}) {
  const router = useRouter()
  const sp = useSearchParams()
  const { openVersion } = useVaultActions()
  const [open, setOpen] = React.useState(true)
  const [editing, setEditing] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [restoring, setRestoring] = React.useState(false)
  const doc = detail.document
  const inBin = Boolean(doc.deleted_at)

  const close = (next: boolean) => {
    if (next) return
    setOpen(false)
    router.push(documentsHref(clientId, { doc: null }, new URLSearchParams(sp?.toString() ?? "")), { scroll: false })
  }

  const facts = [
    { term: "File", value: <span className="break-all">{doc.file_name}</span> },
    { term: "Size", value: <span className="num tabular-nums">{formatFileSize(doc.file_size)}</span> },
    { term: "Version", value: doc.version > 1 ? `Version ${doc.version} of ${detail.versions.length}` : "Version 1" },
    { term: "Category", value: DOCUMENT_CATEGORY_LABELS[doc.category] },
    { term: "Financial year", value: doc.financial_year ? `FY ${doc.financial_year}` : null },
    { term: "Period", value: doc.period },
    { term: "Uploaded", value: `${formatDate(doc.created_at)} by ${doc.source === "client_portal" ? "the client" : (doc.uploaded_by_name ?? "the firm")}` },
    { term: "Source", value: DOCUMENT_SOURCE_LABEL[doc.source] ?? doc.source },
    { term: "Expires on", value: doc.expiry_date ? <DateText date={doc.expiry_date} withRelative today={today} /> : null },
    { term: "Renew by", value: doc.renewal_date ? <DateText date={doc.renewal_date} withRelative today={today} /> : null },
    { term: "Keep until", value: doc.retention_until ? formatDate(doc.retention_until) : null },
    { term: "Description", value: doc.description, wide: true },
  ]

  const footer = (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap gap-2">
        {canManage && !inBin ? (
          <Button type="button" variant="destructive-outline" size="sm" onClick={() => setConfirmDelete(true)}>
            <Trash2Icon aria-hidden="true" />
            Move to recycle bin
          </Button>
        ) : null}
        {canManage && inBin ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={restoring}
            onClick={async () => {
              setRestoring(true)
              try {
                const r = await restoreDocument({ id: doc.id, clientId })
                if (!r.ok) {
                  toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
                  return
                }
                for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
                toast.success(`${doc.title} is back in the vault.`)
                router.refresh()
              } finally {
                setRestoring(false)
              }
            }}
          >
            <RotateCcwIcon aria-hidden="true" />
            Restore
          </Button>
        ) : null}
      </div>
      <div className="ml-auto flex flex-wrap gap-2">
        {canEdit && !inBin ? (
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
              <PencilIcon aria-hidden="true" />
              Edit
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => openVersion({ id: doc.id, title: doc.title })}>
              <FileUpIcon aria-hidden="true" />
              New version
            </Button>
          </>
        ) : null}
        <Button asChild size="sm">
          <a href={fileHref(doc.id)}>
            <DownloadIcon aria-hidden="true" />
            Download
          </a>
        </Button>
      </div>
    </div>
  )

  return (
    <>
      <FormSheet
        open={open}
        onOpenChange={close}
        width="lg"
        title={doc.title}
        description={[DOCUMENT_CATEGORY_LABELS[doc.category], doc.financial_year ? `FY ${doc.financial_year}` : null, doc.period].filter(Boolean).join(" · ")}
        footer={footer}
      >
        <div className="flex flex-col gap-5">
          {doc.is_confidential || doc.shareable_with_client || inBin ? (
            <div className="flex flex-wrap gap-2">
              {inBin ? <StatusChip label="In the recycle bin" tone="muted" variant="pill" meaning={`In the recycle bin since ${formatDate(doc.deleted_at)}. Restore it to use it again.`} /> : null}
              {doc.is_confidential ? <ConfidentialBadge /> : null}
              {doc.shareable_with_client ? <StatusChip label="Shared with the client" tone="info" variant="pill" meaning="The client sees it under Documents in the portal and can download it." /> : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <Preview key={`${doc.id}:${doc.version}`} documentId={doc.id} title={doc.title} mimeType={doc.mime_type} />
            {previewKind(doc.mime_type) ? (
              <a href={fileHref(doc.id, { mode: "preview" })} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-start text-sm font-medium text-primary hover:underline">
                <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                Open in a new tab
              </a>
            ) : null}
          </div>

          <DefinitionList items={facts} columns={2} />

          {doc.tags.length ? (
            <section aria-labelledby="doc-tags">
              <h3 id="doc-tags" className="text-sm font-medium text-text-muted">
                Tags
              </h3>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {doc.tags.map((t) => (
                  <li key={t} className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-sm text-text">
                    {t}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {detail.requestItems.length || detail.checklistItems.length ? (
            <section aria-labelledby="doc-links">
              <h3 id="doc-links" className="text-sm font-medium text-text-muted">
                Linked to
              </h3>
              <ul className="mt-1.5 flex flex-col gap-1 text-base">
                {detail.requestItems.map((i) => (
                  <li key={i.id}>
                    Request “{i.request_title}”: {i.title}
                  </li>
                ))}
                {detail.checklistItems.map((c) => (
                  <li key={c.id}>Checklist: {c.label}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="doc-versions">
            <h3 id="doc-versions" className="text-md font-semibold text-text">
              Versions
            </h3>
            <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
              {detail.versions.map((v) => (
                <li key={v.version} className="flex items-start justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-base text-text">
                      <span className="font-medium">Version {v.version}</span>
                      {v.is_current ? <span className="text-text-muted"> · current</span> : null}
                    </p>
                    <p className="truncate text-sm text-text-muted">
                      {formatDate(v.created_at)} · {v.uploaded_by_name ?? (doc.source === "client_portal" ? "the client" : "the firm")} · <span className="num tabular-nums">{formatFileSize(v.file_size)}</span>
                    </p>
                    {v.change_note ? <p className="mt-0.5 text-sm text-text">{v.change_note}</p> : null}
                  </div>
                  <Button asChild variant="ghost" size="icon-sm">
                    <a href={fileHref(doc.id, { version: v.is_current ? null : v.version })} aria-label={`Download version ${v.version}`}>
                      <DownloadIcon aria-hidden="true" />
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="doc-history">
            <h3 id="doc-history" className="text-md font-semibold text-text">
              History
            </h3>
            {detail.activities.length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">No views or downloads yet.</p>
            ) : (
              <ol className="mt-2 flex flex-col gap-2">
                {detail.activities.map((a) => {
                  const extra = activityDetail(a)
                  return (
                    <li key={a.id} className="flex flex-col text-base sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                      <span className="min-w-0 text-text">
                        {a.user_name ?? (a.activity === "uploaded" && doc.source === "client_portal" ? "The client" : "Someone")} {ACTIVITY_LABEL[a.activity] ?? a.activity}
                        {extra ? <span className="text-text-muted"> · {extra}</span> : null}
                      </span>
                      <span className="num flex-none text-sm text-text-muted tabular-nums">{formatDateTime(a.created_at)}</span>
                    </li>
                  )
                })}
              </ol>
            )}
          </section>
        </div>
      </FormSheet>

      {editing ? <DocumentEditDialog open={editing} onOpenChange={setEditing} clientId={clientId} doc={doc} canManage={canManage} fyOptions={fyOptions} /> : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Move ${doc.title} to the recycle bin?`}
        description={`It leaves the vault${doc.shareable_with_client ? " and the client's portal" : ""}. A Partner or Manager can restore it from the recycle bin.${doc.retention_until ? ` It is kept until ${formatDate(doc.retention_until)} under the retention rules and can't be purged before then.` : ""}`}
        confirmLabel="Move to recycle bin"
        destructive
        onConfirm={async () => {
          const r = await deleteDocument({ id: doc.id, clientId, updatedAt: doc.updated_at })
          if (!r.ok) {
            toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
            return false
          }
          for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
          toast.success(`${doc.title} moved to the recycle bin.`)
          close(false)
        }}
      />
    </>
  )
}
