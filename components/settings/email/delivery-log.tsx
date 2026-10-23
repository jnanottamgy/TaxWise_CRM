import Link from "next/link"
import { MailIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDateTime } from "@/lib/format"
import { StatusChip } from "@/components/app/status-chip"
import { EmptyState } from "@/components/app/empty-state"
import { DELIVERY_STATUS_INFO, emailKindLabel } from "@/server/email/policy"
import type { DeliveryLogRow } from "@/server/email/settings-data"

/**
 * Settings → Email → Delivery log (§7.21, §7.13.5): the latest 50 emails the app handed to Resend,
 * with what happened to each (Sent, Delivered, Opened, Bounced, Marked as spam, Failed) and the
 * error where there is one. "Problems" narrows it to bounces, complaints and failures (server-side).
 * Server component: rows are rendered on the server, so no data reaches the browser twice.
 */

function Filter({ problemsOnly }: { problemsOnly: boolean }) {
  const item = (active: boolean) =>
    cn(
      "inline-flex h-8 items-center rounded-md px-3 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
      active ? "bg-primary-soft font-medium text-primary" : "text-text-muted hover:bg-surface-2 hover:text-text"
    )
  return (
    <nav aria-label="Filter the delivery log" className="flex items-center gap-1">
      <Link href="/settings/email#delivery-log" scroll={false} className={item(!problemsOnly)} aria-current={!problemsOnly ? "page" : undefined}>
        All
      </Link>
      <Link href="/settings/email?log=problems#delivery-log" scroll={false} className={item(problemsOnly)} aria-current={problemsOnly ? "page" : undefined}>
        Problems
      </Link>
    </nav>
  )
}

function Status({ row }: { row: DeliveryLogRow }) {
  const info = DELIVERY_STATUS_INFO[row.status]
  return (
    <div className="min-w-0">
      <StatusChip label={info.label} tone={info.tone} meaning={info.meaning} />
      {row.error ? <p className="mt-0.5 line-clamp-3 text-sm break-words text-danger-text">{row.error}</p> : null}
      {row.attempts > 1 ? <p className="mt-0.5 text-xs text-text-muted">{row.attempts} attempts</p> : null}
    </div>
  )
}

function What({ row }: { row: DeliveryLogRow }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-base text-text" title={row.subject}>
        {row.subject}
      </p>
      <p className="truncate text-sm text-text-muted">
        {emailKindLabel(row.kind)}
        {row.clientName ? (
          <>
            {" · "}
            {row.clientId ? (
              <Link href={`/clients/${row.clientId}?tab=communication`} className="hover:text-text hover:underline">
                {row.clientName}
              </Link>
            ) : (
              row.clientName
            )}
          </>
        ) : null}
      </p>
    </div>
  )
}

export function DeliveryLog({ rows, problemsOnly, anyAtAll }: { rows: DeliveryLogRow[]; problemsOnly: boolean; anyAtAll: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-muted">
          {problemsOnly ? `Bounces, spam reports and failures among the latest 50 emails: ${rows.length}` : `The latest ${rows.length === 50 ? 50 : rows.length} emails, newest first`}
        </p>
        {anyAtAll ? <Filter problemsOnly={problemsOnly} /> : null}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-border">
          {problemsOnly && anyAtAll ? (
            <EmptyState
              size="compact"
              icon={<MailIcon />}
              message="No bounces, spam reports or failures among the latest 50 emails."
              action={
                <Link href="/settings/email#delivery-log" scroll={false} className="text-sm font-medium text-primary hover:underline">
                  Show all emails
                </Link>
              }
            />
          ) : (
            <EmptyState
              size="compact"
              icon={<MailIcon />}
              message="No emails sent yet. Once the domain is verified, every email the app sends appears here with what happened to it."
            />
          )}
        </div>
      ) : (
        <>
          {/* Wide screens */}
          <div className="hidden max-h-[min(36rem,70dvh)] overflow-auto rounded-md border border-border md:block">
            <table className="w-full min-w-[44rem] border-collapse text-left">
              <caption className="sr-only">{problemsOnly ? "Emails with delivery problems" : "Latest emails sent"}</caption>
              <thead className="sticky top-0 z-[1] bg-surface-2">
                <tr className="text-sm text-text-muted">
                  <th scope="col" className="px-3 py-2 font-normal">Email</th>
                  <th scope="col" className="w-[24%] px-3 py-2 font-normal">To</th>
                  <th scope="col" className="w-[22%] px-3 py-2 font-normal">Status</th>
                  <th scope="col" className="w-[17%] px-3 py-2 text-right font-normal">Sent</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="max-w-0 px-3 py-2.5">
                      <What row={r} />
                    </td>
                    <td className="max-w-0 px-3 py-2.5">
                      <p className="truncate text-base text-text" title={r.recipient}>
                        {r.recipient}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <Status row={r} />
                    </td>
                    <td className="num px-3 py-2.5 text-right text-sm whitespace-nowrap text-text">{formatDateTime(r.sentAt ?? r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phones */}
          <ul className="flex flex-col gap-2 md:hidden" aria-label={problemsOnly ? "Emails with delivery problems" : "Latest emails sent"}>
            {rows.map((r) => (
              <li key={r.id} className="rounded-md border border-border p-3">
                <What row={r} />
                <p className="mt-1 truncate text-sm text-text">{r.recipient}</p>
                <div className="mt-2 flex items-start justify-between gap-3">
                  <Status row={r} />
                  <span className="num flex-none text-sm text-text-muted">{formatDateTime(r.sentAt ?? r.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
