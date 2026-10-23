import type { Metadata } from "next"
import { requireClient } from "@/lib/auth/guards"
import { todayIST } from "@/lib/domain/fy"
import { DEADLINE_VIEWS, PORTAL_PAGE_SIZE, type DeadlineView } from "@/lib/schemas/portal"
import { getDeadlineCounts, listDeadlines, listOutstandingItemTitles } from "@/lib/data/portal"
import { readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { SectionCard } from "@/components/app/section-card"
import { attempt } from "@/components/portal/load"
import { PortalBlockError } from "@/components/portal/portal-ui"
import { DeadlineList } from "@/components/portal/deadline-list"
import { PageLinks } from "@/components/portal/page-links"
import { ViewTabs } from "@/components/portal/view-tabs"

export const metadata: Metadata = { title: "Deadlines" }

const VIEW_LABEL: Record<DeadlineView, string> = { open: "All to file", overdue: "Overdue", upcoming: "Upcoming" }

/**
 * Deadlines (§7.22): what is still to file, upcoming and overdue, each explained in plain language
 * ("GSTR-3B for September 2026: your monthly GST summary return"), with its due date and urgency,
 * where it stands, any government extension, and what we need from the client for the ones that
 * need attention. Paged in SQL (§2.3); the view is in the URL (?view=open|overdue|upcoming).
 */
export default async function PortalDeadlinesPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, supabase } = await requireClient()
  const sp = await props.searchParams
  const today = todayIST()
  const rawView = readParam(sp, "view")
  const view: DeadlineView = DEADLINE_VIEWS.includes(rawView as DeadlineView) ? (rawView as DeadlineView) : "open"
  const page = Math.max(1, Number.parseInt(readParam(sp, "page") ?? "1", 10) || 1)
  const from = (page - 1) * PORTAL_PAGE_SIZE

  const [list, counts, items] = await Promise.all([
    attempt("deadlines:list", user.id, () => listDeadlines(supabase, { view, from, to: from + PORTAL_PAGE_SIZE - 1, today })),
    attempt("deadlines:counts", user.id, () => getDeadlineCounts(supabase, today)),
    attempt("deadlines:items", user.id, () => listOutstandingItemTitles(supabase)),
  ])

  const c = counts.ok ? counts.data : null
  const description = c
    ? c.overdue + c.upcoming === 0
      ? "Nothing is waiting to be filed."
      : [c.overdue ? `${c.overdue} overdue` : null, c.upcoming ? `${c.upcoming} upcoming` : null, c.waitingOnYou ? `${c.waitingOnYou} waiting for your documents` : null].filter(Boolean).join(" · ")
    : "Upcoming and overdue filings, explained in plain language."

  const tabs = DEADLINE_VIEWS.map((v) => ({
    href: v === "open" ? "/portal/deadlines" : `/portal/deadlines?view=${v}`,
    label: VIEW_LABEL[v],
    count: c ? (v === "open" ? c.overdue + c.upcoming : v === "overdue" ? c.overdue : c.upcoming) : null,
    active: v === view,
  }))

  const empty =
    view === "overdue"
      ? "Nothing is overdue."
      : view === "upcoming"
        ? "No upcoming deadlines. We'll add them as your services start."
        : "Nothing is waiting to be filed. Filed returns are on the Compliance page."

  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader title="Deadlines" description={description} />
      <ViewTabs label="Which deadlines" items={tabs} className="mb-4" />
      {!list.ok ? (
        <PortalBlockError title={VIEW_LABEL[view]} message="Couldn't load your deadlines." errorRef={list.ref} />
      ) : (
        <SectionCard
          title={VIEW_LABEL[view]}
          description="Soonest first. Tap a status to see what it means."
          flush
        >
          <DeadlineList
            rows={list.data.rows}
            today={today}
            openRequestItems={items.ok ? items.data : []}
            showNeeds="attention"
            emptyMessage={empty}
            className="px-4 pb-3 md:px-5"
          />
          <PageLinks pathname="/portal/deadlines" params={{ view: view === "open" ? null : view }} page={page} pageSize={PORTAL_PAGE_SIZE} total={list.data.total} />
        </SectionCard>
      )}
    </div>
  )
}
