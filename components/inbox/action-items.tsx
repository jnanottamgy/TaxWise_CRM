"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowRightIcon, CheckCheckIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Explain } from "@/components/app/explain"
import { DateText } from "@/components/app/date-text"
import { formatNumber } from "@/lib/format"
import { ACTION_KIND_META, describeActionItem, type ActionGroup, type ActionItem } from "@/lib/schemas/inbox"
import { openActionItem } from "@/server/actions/inbox"
import { announceInboxChanged } from "@/components/comms/comms-ui"

/**
 * "Needs your action" (§7.17): approvals, reviews, tasks to accept, declined tasks to reassign,
 * client messages and data requests, grouped by kind, each with a deep link to the exact record
 * and "View all" into the filtered list behind it. Items come from the records themselves, so one
 * disappears as soon as it is dealt with. A dot marks an item whose notification you haven't read;
 * opening the item reads it.
 */
export function ActionItems({ groups, unread, today }: { groups: ActionGroup[]; unread: Record<string, number>; today: string }) {
  const [seen, setSeen] = React.useState<Set<string>>(() => new Set())
  const [now] = React.useState(() => new Date())
  const total = groups.reduce((n, g) => n + g.total, 0)

  const open = (item: ActionItem) => {
    const key = `${item.entity_type}:${item.entity_id}`
    if (!unread[key] || seen.has(key)) return
    setSeen((s) => new Set(s).add(key))
    void openActionItem({ entityType: item.entity_type, entityId: item.entity_id })
      .then((r) => {
        if (r.ok && r.data.count > 0) announceInboxChanged()
      })
      .catch(() => undefined)
  }

  return (
    <section aria-labelledby="needs-action-heading" className="rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pt-4 pb-3 md:px-5">
        <h2 id="needs-action-heading" className="text-md leading-6 font-semibold text-text">
          Needs your action
        </h2>
        <p className="num text-sm text-text-muted tabular-nums">{total ? `${formatNumber(total)} waiting` : "All clear"}</p>
      </div>
      {groups.length === 0 ? (
        <div className="px-4 pb-4 md:px-5">
          <p className="flex min-h-10 items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-text-muted">
            <CheckCheckIcon aria-hidden="true" className="size-4 flex-none" />
            Nothing needs your action right now. Approvals, reviews, new tasks and client messages land here.
          </p>
        </div>
      ) : (
        <div className="flex flex-col">
          {groups.map((g) => {
            const meta = ACTION_KIND_META[g.kind]
            return (
              <div key={g.kind} className="border-t border-border">
                <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-1 md:px-5">
                  <Explain content={<p>{meta.explain}</p>}>
                    <h3 tabIndex={0} className="cursor-help text-sm font-medium text-text-muted outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                      {meta.label} <span className="num tabular-nums">· {formatNumber(g.total)}</span>
                    </h3>
                  </Explain>
                  {g.total > g.items.length ? (
                    <Link href={meta.viewAll} className="inline-flex flex-none items-center gap-1 text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                      View all {formatNumber(g.total)}
                      <ArrowRightIcon aria-hidden="true" className="size-3.5" />
                    </Link>
                  ) : null}
                </div>
                <ul>
                  {g.items.map((item) => {
                    const view = describeActionItem(item, now)
                    const key = `${item.entity_type}:${item.entity_id}`
                    const isNew = Boolean(unread[key]) && !seen.has(key)
                    return (
                      <li key={key}>
                        <Link
                          href={item.link_url}
                          onClick={() => open(item)}
                          aria-label={`${view.primary}. ${view.secondary}. ${view.verb}.${isNew ? " New." : ""}`}
                          title={view.verb}
                          className="flex min-h-14 items-center gap-3 px-4 py-2 outline-none hover:bg-surface-2/60 focus-visible:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5"
                        >
                          <span aria-hidden="true" className={cn("size-2 flex-none rounded-full", isNew ? "bg-primary" : "bg-transparent")} />
                          <span className="min-w-0 flex-1">
                            <span className={cn("block truncate text-base text-text", isNew && "font-semibold")}>{view.primary}</span>
                            <span className="block truncate text-sm text-text-muted">{view.secondary || view.verb}</span>
                          </span>
                          <span className="flex flex-none flex-col items-end gap-0.5 text-right">
                            {view.trailing?.kind === "due" ? (
                              <DateText date={view.trailing.date} withRelative stacked today={today} className="text-sm" />
                            ) : view.trailing ? (
                              <span className="num text-sm text-text tabular-nums">{view.trailing.text}</span>
                            ) : null}
                          </span>
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
