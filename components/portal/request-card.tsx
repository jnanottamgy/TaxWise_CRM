import { FileTextIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { DateText } from "@/components/app/date-text"
import { formatDate } from "@/lib/format"
import { outstandingItemCount, requestItemStatus } from "@/lib/domain/portal-copy"
import type { PortalRequest, PortalRequestItem } from "@/lib/data/portal"
import { PortalStatusChip } from "@/components/portal/portal-ui"
import { RequestItemUpload } from "@/components/portal/request-item-upload"

/**
 * One document request (§7.14 PBC list, §7.22 Documents): what the firm asked for, by when, its
 * notes for the client, and each item with its status, the reason when the firm couldn't use a
 * file, and the upload (or re-upload). Server-safe; the upload is a client island.
 */

function ItemRow({ item, clientId, open }: { item: PortalRequestItem; clientId: string; open: boolean }) {
  const status = requestItemStatus(item.status)
  const canUpload = open && item.status !== "accepted"
  return (
    <li className="flex flex-col gap-2 py-3.5 first:pt-2 last:pb-1">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-medium text-text">
            {item.title}
            {!item.isRequired ? <span className="ml-1.5 text-sm font-normal text-text-muted">(optional)</span> : null}
          </p>
          {item.helpText ? <p className="mt-0.5 text-sm text-text-muted">{item.helpText}</p> : null}
        </div>
        <PortalStatusChip status={status} />
      </div>
      {item.status === "rejected" && item.rejectionReason ? (
        <p className="rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-text">
          <span className="font-medium text-danger-text">Why we couldn&apos;t use it: </span>
          {item.rejectionReason}
        </p>
      ) : null}
      {item.document && item.status !== "pending" ? (
        <p className="flex min-w-0 items-center gap-1.5 text-sm text-text-muted">
          <FileTextIcon aria-hidden="true" className="size-3.5 flex-none" />
          <a href={`/api/files/documents/${item.document.id}`} className="min-w-0 truncate font-medium text-primary hover:underline">
            {item.document.fileName}
          </a>
          {item.uploadedAt ? (
            <span className="flex-none">
              · uploaded <span className="num tabular-nums">{formatDate(item.uploadedAt)}</span>
            </span>
          ) : null}
        </p>
      ) : null}
      {canUpload ? <RequestItemUpload clientId={clientId} itemId={item.id} itemTitle={item.title} replacing={item.status !== "pending"} itemState={`${item.status}:${item.uploadedAt ?? ""}`} /> : null}
    </li>
  )
}

export function RequestCard({ request, clientId, today, className }: { request: PortalRequest; clientId: string; today: string; className?: string }) {
  const open = request.status === "open"
  const todo = outstandingItemCount(request.items)
  const accepted = request.items.filter((i) => i.status === "accepted").length
  return (
    <section aria-labelledby={`req-${request.id}`} className={cn("rounded-lg border border-border bg-surface", className)}>
      <div className="flex flex-col gap-1 border-b border-border px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4 md:px-5">
        <div className="min-w-0">
          <h3 id={`req-${request.id}`} className="text-md font-semibold text-text">
            {request.title}
          </h3>
          <p className="mt-0.5 text-sm text-text-muted">
            {open ? (
              <>
                {todo > 0 ? `${todo} of ${request.items.length} to upload` : "Everything is uploaded; we're checking it"}
                {request.dueDate ? (
                  <>
                    {" "}
                    · needed by <DateText date={request.dueDate} withRelative={todo > 0} today={today} />
                  </>
                ) : null}
              </>
            ) : (
              <>
                Completed{request.completedAt ? ` ${formatDate(request.completedAt)}` : ""} · {accepted} of {request.items.length} accepted
              </>
            )}
          </p>
        </div>
      </div>
      {request.notes ? <p className="border-b border-border px-4 py-3 text-base whitespace-pre-wrap text-text md:px-5">{request.notes}</p> : null}
      <ul className="divide-y divide-border/70 px-4 pb-3 md:px-5">
        {request.items.map((item) => (
          <ItemRow key={item.id} item={item} clientId={clientId} open={open} />
        ))}
      </ul>
    </section>
  )
}
