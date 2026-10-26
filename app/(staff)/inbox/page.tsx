import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { applyTablePatch, hasActiveFilters, parseTableParams, readParam } from "@/components/app/data-table/params"
import { PageHeader } from "@/components/app/page-header"
import { FilterBar } from "@/components/app/filter-bar"
import { ErrorBlock } from "@/components/app/error-block"
import { PageGuide } from "@/components/shell/page-slots"
import { INBOX_FILTERS, INBOX_SHOW, NOTIFICATION_GROUP_SLUGS, groupActionItems, notificationGroupsFor, type InboxShow } from "@/lib/schemas/inbox"
import { getActionItems, getInboxCounts, getUnreadActionNotifications, listUpdates } from "@/lib/data/inbox"
import { ActionItems } from "@/components/inbox/action-items"
import { UpdatesList } from "@/components/inbox/updates-list"
import { MarkAllReadButton, NotificationSettingsLink, UpdatesTabs } from "@/components/inbox/inbox-controls"

export const metadata: Metadata = { title: "Inbox" }

type SearchParams = Record<string, string | string[] | undefined>

async function attempt<T>(source: string, userId: string, load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; ref: string }> {
  try {
    return { ok: true, data: await load() }
  } catch (err) {
    unstable_rethrow(err)
    return { ok: false, ref: logUnexpected(err, { source: `page:/inbox:${source}`, userId }) }
  }
}

/**
 * The Inbox (§7.17): "What needs me, and what happened since I last looked?" The bell in the top
 * bar opens it. "Needs your action" is worked out from the records (approvals, reviews, tasks to
 * accept or reassign, client messages, data requests), so it is never stale; "Updates" is every
 * other notification, with read / unread, archive, delete and Mark all read. In-app notices are
 * always on; email per event type is set in Profile → Notifications. Each person sees only their
 * own (RLS).
 */
export default async function InboxPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, supabase } = await requireStaff()
  const sp = await searchParams
  const rawShow = readParam(sp, "show")
  const show: InboxShow = (INBOX_SHOW as readonly string[]).includes(rawShow ?? "") ? (rawShow as InboxShow) : "inbox"
  const t = parseTableParams(sp, { sortable: ["created_at"], defaultSort: { sort: "created_at", dir: "desc" }, filters: INBOX_FILTERS })
  const today = todayIST()
  // One clock for the page: client lists compute "2 hours ago" from it, so hydration matches the server.
  const now = new Date().toISOString()

  const [actions, marks, updates, counts] = await Promise.all([
    attempt("actions", user.id, () => getActionItems(supabase)),
    attempt("marks", user.id, () => getUnreadActionNotifications(supabase)),
    attempt("updates", user.id, () => listUpdates(supabase, user, t, show)),
    attempt("counts", user.id, () => getInboxCounts(supabase)),
  ])

  const unread: Record<string, number> = {}
  if (marks.ok) for (const [k, v] of marks.data) unread[k] = v.length
  const groups = actions.ok ? groupActionItems(actions.data.items) : []
  const tabHref = (s: InboxShow) => {
    const qs = applyTablePatch(sp, { page: null })
    const params = new URLSearchParams(qs)
    if (s === "inbox") params.delete("show")
    else params.set("show", s)
    const out = params.toString()
    return out ? `/inbox?${out}` : "/inbox"
  }
  const groupOptions = notificationGroupsFor(user.role).map((g) => ({ value: g, label: NOTIFICATION_GROUP_SLUGS[g] }))

  return (
    <div className="flex min-w-0 flex-col">
      <PageGuide title="Inbox">
        <p>Needs your action lists what is waiting for you right now: approvals, work to review, tasks to accept or reassign, client messages and data requests. An item leaves the list as soon as it is dealt with, by you or anyone else.</p>
        <p className="mt-2">Updates is everything else the app told you. Open one to go to the record. Archive what you&apos;re done with; delete what you don&apos;t need.</p>
        <p className="mt-2">Notices always appear here. Choose which ones also come by email in Profile → Notifications.</p>
      </PageGuide>
      <PageHeader
        title="Inbox"
        description="What's waiting for you, then everything else that happened."
        actions={
          <>
            <NotificationSettingsLink />
            <MarkAllReadButton unread={counts.ok ? counts.data.unreadAll : 0} />
          </>
        }
      />

      {actions.ok ? (
        <ActionItems groups={groups} unread={unread} today={today} now={now} />
      ) : (
        <section aria-label="Needs your action" className="rounded-lg border border-border bg-surface">
          <ErrorBlock message="Couldn't load what needs your action." errorRef={actions.ref} />
        </section>
      )}

      <section aria-labelledby="updates-heading" className="mt-6 flex flex-col">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="updates-heading" className="font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text">
            Updates
          </h2>
          <UpdatesTabs
            show={show}
            counts={{ unread: counts.ok ? counts.data.unreadUpdates : 0, archived: counts.ok ? counts.data.archived : 0 }}
            hrefFor={{ inbox: tabHref("inbox"), unread: tabHref("unread"), archived: tabHref("archived") }}
          />
        </div>
        <FilterBar searchLabel="Search updates" searchPlaceholder="Words in the title or message" filters={[{ id: "group", label: "About", options: groupOptions }]} />
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          {updates.ok ? (
            <UpdatesList rows={updates.data.rows} total={updates.data.total} page={t.page} pageSize={t.pageSize} show={show} filtered={hasActiveFilters(sp, ["group"])} now={now} />
          ) : (
            <ErrorBlock message="Couldn't load your updates." errorRef={updates.ref} />
          )}
        </div>
      </section>
    </div>
  )
}
