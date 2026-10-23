import Link from "next/link"
import { ReceiptTextIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/app/empty-state"
import { Money } from "@/components/app/money"
import { formatDate, formatMinutes } from "@/lib/format"
import type { UnbilledEntryRow } from "@/lib/data/timesheet"

/**
 * One client's unbilled entries, newest first (§7.10 → §7.9.2): who, when, on what, how long, at
 * what rate and for how much, with the way into a new invoice for the client. Partners and Managers
 * only (the view returns nothing to anyone else). Server-safe.
 */
export function UnbilledEntries({
  client,
  entries,
  limit,
  closeHref,
}: {
  client: { id: string; name: string }
  entries: UnbilledEntryRow[]
  limit: number
  closeHref: string
}) {
  return (
    <section aria-labelledby="unbilled-entries-title" className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between md:px-5">
        <div className="min-w-0">
          <h2 id="unbilled-entries-title" className="truncate text-base font-semibold text-text">
            {client.name}: unbilled entries
          </h2>
          <p className="text-sm text-text-muted">{entries.length >= limit ? `The latest ${limit} entries.` : "Billable time not on an invoice yet."}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="sm">
            <Link href={`/invoices/new?client=${client.id}`}>
              <ReceiptTextIcon aria-hidden="true" />
              New invoice
            </Link>
          </Button>
          <Button asChild size="icon-sm" variant="ghost" aria-label="Close the entries">
            <Link href={closeHref} scroll={false}>
              <XIcon aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </div>
      {entries.length === 0 ? (
        <EmptyState size="compact" className="m-4 md:m-5" message="Nothing unbilled for this client now." />
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Unbilled entries for {client.name}</caption>
              <thead className="bg-surface-2">
                <tr className="border-b border-border text-xs text-text-muted">
                  <th scope="col" className="px-4 py-2 text-left font-medium md:px-5">
                    Date
                  </th>
                  <th scope="col" className="px-2 py-2 text-left font-medium">
                    Person
                  </th>
                  <th scope="col" className="px-2 py-2 text-left font-medium">
                    Work
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Time
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Rate per hour
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium md:px-5">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-b border-border/70 last:border-b-0">
                    <td className="num px-4 py-2 whitespace-nowrap tabular-nums md:px-5">{formatDate(e.started_at)}</td>
                    <td className="px-2 py-2">{e.employee_name ?? <span className="text-text-muted">—</span>}</td>
                    <td className="max-w-[22rem] px-2 py-2">
                      <span className="block truncate text-text">{e.task_title ?? e.description ?? <span className="text-text-muted">No task</span>}</span>
                      {e.task_number || (e.task_title && e.description) ? (
                        <span className="block truncate text-xs text-text-muted">{[e.task_number, e.task_title ? e.description : null].filter(Boolean).join(" · ")}</span>
                      ) : null}
                    </td>
                    <td className="num px-2 py-2 text-right tabular-nums">{formatMinutes(e.minutes)}</td>
                    <td className="px-2 py-2 text-right">
                      {e.billing_rate_per_hour === null ? <span className="text-xs text-text-muted">No rate</span> : <Money value={e.billing_rate_per_hour} />}
                    </td>
                    <td className="px-4 py-2 text-right md:px-5">
                      <Money value={e.amount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-border/70 md:hidden">
            {entries.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text">{e.task_title ?? e.description ?? "No task"}</p>
                  <p className="truncate text-xs text-text-muted">
                    {formatDate(e.started_at)}
                    {e.employee_name ? ` · ${e.employee_name}` : ""}
                    {` · ${formatMinutes(e.minutes)}`}
                  </p>
                </div>
                <Money value={e.amount} className="text-sm" />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
