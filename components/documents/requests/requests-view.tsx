"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ChevronDownIcon, ClipboardListIcon, SendIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/app/empty-state"
import { EmailSetupBanner } from "@/components/settings/email/email-setup-banner"
import type { RequestRow, RequestContext } from "@/lib/data/document-requests"
import type { DocumentOption } from "@/lib/data/documents"
import type { HandoffMessaging } from "@/components/documents/requests/request-handoff"
import { CreateRequestDialog } from "@/components/documents/requests/request-dialog"
import { RequestCard, type RequestCardContext } from "@/components/documents/requests/request-card"

/**
 * Client 360 → Documents → Requests (§7.14 PBC lists, staff side): "What have we asked this client
 * for, and what is still outstanding?" Open requests first, each with its items and what to do next;
 * completed and cancelled ones below, folded. Request documents is the one primary action.
 */
export function RequestsView({
  rows,
  counts,
  context,
  documents,
  messaging,
  portalBase,
  emailReady,
  canManage,
  canSetUpEmail,
  today,
  focusRequestId,
  openCreate = false,
}: {
  rows: RequestRow[]
  counts: { open: number; completed: number; cancelled: number }
  context: RequestContext
  documents: DocumentOption[]
  messaging: HandoffMessaging
  portalBase: string
  emailReady: boolean
  canManage: boolean
  canSetUpEmail: boolean
  today: string
  focusRequestId: string | null
  /** Reached with `?request=new` (Client 360's "Request documents"): the dialog opens at once. */
  openCreate?: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [creating, setCreating] = React.useState(openCreate)

  // Take `request=new` out of the address once the dialog is open, so a reload doesn't reopen it.
  React.useEffect(() => {
    if (!openCreate) return
    const p = new URLSearchParams(searchParams.toString())
    p.delete("request")
    p.set("docs", "requests")
    router.replace(`${pathname}?${p.toString()}`, { scroll: false })
  }, [openCreate, pathname, router, searchParams])
  const open = rows.filter((r) => r.status === "open")
  const closed = rows.filter((r) => r.status !== "open")
  const focusedClosed = closed.some((r) => r.id === focusRequestId)
  const toReview = open.reduce((n, r) => n + r.progress.toReview, 0)
  const ctx: RequestCardContext = {
    clientId: context.client.id,
    clientName: context.client.display_name,
    clientCode: context.client.client_code,
    client: context.client,
    contacts: context.contacts,
    documents,
    messaging,
    portalBase,
    emailReady,
    canManage,
    today,
  }

  const summary =
    rows.length === 0
      ? null
      : [`${counts.open} open`, toReview ? `${toReview} ${toReview === 1 ? "upload" : "uploads"} to review` : null, counts.completed ? `${counts.completed} completed` : null, counts.cancelled ? `${counts.cancelled} cancelled` : null]
          .filter(Boolean)
          .join(" · ")

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-muted" aria-live="polite">
          {summary ?? "What the client has to send, item by item."}
        </p>
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          <SendIcon aria-hidden="true" />
          Request documents
        </Button>
      </div>

      {!emailReady ? <EmailSetupBanner canSetUp={canSetUpEmail} /> : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState
            icon={<ClipboardListIcon />}
            message={`No document requests for ${context.client.display_name} yet. List what you need and the client uploads each item from the portal.`}
            action={
              <Button type="button" onClick={() => setCreating(true)}>
                Request documents
              </Button>
            }
          />
        </div>
      ) : null}

      {open.length === 0 && rows.length > 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-text-muted">No open requests. Everything asked for has been received or cancelled.</div>
      ) : null}

      {open.map((r) => (
        <RequestCard key={r.id} request={r} ctx={ctx} focused={r.id === focusRequestId} />
      ))}

      {closed.length ? (
        <details className="group rounded-lg border border-border bg-surface" open={focusedClosed || undefined}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-base font-medium text-text outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5 [&::-webkit-details-marker]:hidden">
            Closed requests
            <span className="flex items-center gap-2 text-sm font-normal text-text-muted">
              <span className="num tabular-nums">{closed.length}</span>
              <ChevronDownIcon aria-hidden="true" className="size-4 transition-transform duration-150 group-open:rotate-180" />
            </span>
          </summary>
          <div className="flex flex-col gap-3 border-t border-border p-3 md:p-4">
            {closed.map((r) => (
              <RequestCard key={r.id} request={r} ctx={ctx} focused={r.id === focusRequestId} />
            ))}
          </div>
        </details>
      ) : null}

      {creating ? (
        <CreateRequestDialog
          open={creating}
          onOpenChange={setCreating}
          clientId={context.client.id}
          clientName={context.client.display_name}
          clientCode={context.client.client_code}
          client={context.client}
          contacts={context.contacts}
          defaultEveryDays={context.defaultEveryDays}
          emailReady={emailReady}
          messaging={messaging}
        />
      ) : null}
    </div>
  )
}
