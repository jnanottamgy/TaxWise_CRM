import { ArrowRightIcon } from "lucide-react"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { formatDateTime } from "@/lib/format"
import { getStatus } from "@/lib/status"
import type { ActivityRow, StatusHistoryRow } from "@/lib/data/tasks"

/**
 * Status history and activity (§7.6.6): every status change with its reason, who and when
 * (task_status_history, written only by change_task_status), and the task's other history
 * (activity_logs: edits, checklist, attachments, filings). The newest first; the first ten show,
 * the rest fold away. Server-safe.
 */

const SHOWN = 10

function StatusLine({ h }: { h: StatusHistoryRow }) {
  return (
    <li className="py-2">
      <p className="flex flex-wrap items-center gap-1.5 text-sm text-text">
        {h.from_status ? <span className="text-text-muted">{getStatus("task_status", h.from_status).label}</span> : null}
        {h.from_status ? <ArrowRightIcon aria-label="to" className="size-3.5 text-text-muted" /> : null}
        <span className="font-medium">{getStatus("task_status", h.to_status).label}</span>
      </p>
      {h.reason ? <p className="mt-0.5 text-sm whitespace-pre-wrap text-text">“{h.reason}”</p> : null}
      <p className="mt-0.5 text-xs text-text-muted">
        {h.changed_by_name ?? "Someone"} · {formatDateTime(h.changed_at)}
      </p>
    </li>
  )
}

function ActivityLine({ a }: { a: ActivityRow }) {
  return (
    <li className="py-2">
      <p className="text-sm text-text">{a.description}</p>
      <p className="mt-0.5 text-xs text-text-muted">
        {a.user_name ?? "The system"} · {formatDateTime(a.at)}
      </p>
    </li>
  )
}

export function TaskHistory({ history, activity }: { history: StatusHistoryRow[]; activity: ActivityRow[] }) {
  return (
    <SectionCard title="History">
      <h3 className="text-xs font-medium text-text-muted">Status changes</h3>
      {history.length ? (
        <>
          <ol className="divide-y divide-border/70">
            {history.slice(0, SHOWN).map((h) => (
              <StatusLine key={h.id} h={h} />
            ))}
          </ol>
          {history.length > SHOWN ? (
            <details>
              <summary className="cursor-pointer py-1 text-sm font-medium text-text-muted hover:text-text">{history.length - SHOWN} earlier changes</summary>
              <ol className="divide-y divide-border/70">
                {history.slice(SHOWN).map((h) => (
                  <StatusLine key={h.id} h={h} />
                ))}
              </ol>
            </details>
          ) : null}
        </>
      ) : (
        <EmptyState size="compact" message="No status changes yet." className="my-2" />
      )}
      <h3 className="mt-4 text-xs font-medium text-text-muted">Activity</h3>
      {activity.length ? (
        <>
          <ol className="divide-y divide-border/70">
            {activity.slice(0, SHOWN).map((a) => (
              <ActivityLine key={a.id} a={a} />
            ))}
          </ol>
          {activity.length > SHOWN ? (
            <details>
              <summary className="cursor-pointer py-1 text-sm font-medium text-text-muted hover:text-text">{activity.length - SHOWN} earlier entries</summary>
              <ol className="divide-y divide-border/70">
                {activity.slice(SHOWN).map((a) => (
                  <ActivityLine key={a.id} a={a} />
                ))}
              </ol>
            </details>
          ) : null}
        </>
      ) : (
        <EmptyState size="compact" message="Nothing else has happened on this task yet." className="my-2" />
      )}
    </SectionCard>
  )
}
