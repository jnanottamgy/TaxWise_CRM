import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { FileWarningIcon } from "lucide-react"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { getNoticeFormContext, listClientNotices, type NoticeFormContextData, type NoticeListRow } from "@/lib/data/notices"
import { formatCount } from "@/components/app/data-table/params"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { ErrorBlock } from "@/components/app/error-block"
import { NextActionCell, NoticeStatusChip, noticeSubline } from "@/components/workpapers/notices/notice-ui"
import { NewNoticeButton } from "@/components/workpapers/notices/new-notice-button"

/**
 * Client 360 → Workpapers → Notices (§7.3.3, §7.8.4): the client's notices, open ones first by their
 * next date (an overdue reply in red), then closed ones; at most six, with "Log a notice" for this
 * client. Under the viewer's RLS (Employees: their own clients, §4.1). Never throws: a failed load
 * shows its Ref inside the card.
 */
export async function ClientNoticesList({ clientId, user, supabase, limit = 6 }: { clientId: string; user: CurrentUser; supabase: ServerSupabase; limit?: number }) {
  const today = todayIST()
  let page: { rows: NoticeListRow[]; total: number } | null = null
  let context: NoticeFormContextData | null = null
  let client: { id: string; label: string } | null = null
  let ref: string | null = null
  try {
    const [list, ctx, c] = await Promise.all([
      listClientNotices(supabase, clientId, limit),
      getNoticeFormContext(supabase, user, today),
      supabase.from("clients").select("id, display_name, client_code").eq("id", clientId).maybeSingle(),
    ])
    if (c.error) throw c.error
    page = list
    context = ctx
    client = c.data ? { id: c.data.id, label: `${c.data.client_code} · ${c.data.display_name}` } : null
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "client360:workpapers:notices", userId: user.id })
  }
  const mp = user.role === "partner" || user.role === "manager"
  const overdue = page?.rows.filter((r) => r.reply_overdue).length ?? 0
  return (
    <SectionCard
      title="Notices"
      description={overdue ? <span className="text-danger-text">{overdue === 1 ? "1 reply overdue" : `${overdue} replies overdue`}</span> : "Replies, hearings and appeals."}
      action={context && client ? <NewNoticeButton context={context} today={today} fixedClient={client} defaultAssignee={mp ? null : user.employeeId} variant="outline" label="Log a notice" /> : null}
      viewAll={page && page.total > page.rows.length ? { href: `/workpapers/notices?client=${clientId}`, label: `View all ${formatCount(page.total)}` } : undefined}
      flush
    >
      {ref ? (
        <ErrorBlock message="Couldn't load this client's notices." errorRef={ref} size="compact" />
      ) : !page || page.rows.length === 0 ? (
        <div className="px-4 pb-4 md:px-5">
          <EmptyState size="compact" icon={<FileWarningIcon />} message="No notices logged for this client." />
        </div>
      ) : (
        <ul>
          {page.rows.map((r) => {
            const sub = noticeSubline(r)
            return (
              <li key={r.id} className="border-t border-border first:border-t-0">
                <Link
                  href={`/workpapers/notices/${r.id}`}
                  className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 transition-colors duration-150 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5"
                >
                  <span className="flex min-w-0 flex-col leading-5">
                    <span className="text-base text-text">{r.notice_type}</span>
                    {sub ? <span className="truncate text-xs text-text-muted">{sub}</span> : null}
                  </span>
                  <span className="flex items-center gap-4">
                    <NextActionCell row={r} today={today} />
                    <NoticeStatusChip status={r.status} />
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </SectionCard>
  )
}
