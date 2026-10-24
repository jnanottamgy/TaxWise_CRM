"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowRightIcon, GripVerticalIcon, MoreHorizontalIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { StatusChip } from "@/components/app/status-chip"
import { Money } from "@/components/app/money"
import { FullValueHint } from "@/components/app/full-value-hint"
import { formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format"
import { formatINR, formatINRCompact, type Paise } from "@/lib/domain/money"
import { LEAD_STATUSES, type LeadStatus } from "@/lib/domain/enums"
import { getStatus } from "@/lib/status"
import { leadMoveCheck, lostCategoryLabel } from "@/lib/schemas/leads"
import type { LeadListRow } from "@/lib/data/leads"
import { useLeadMover } from "@/components/leads/lead-mover"

type Column = { status: LeadStatus; total: number; valuePaise: Paise; rows: LeadListRow[] }

/**
 * The pipeline board (§7.5.1 "columns = stages; drag to move, with a reason required when moving
 * to Lost"). Drag a card to another column, or use its Move menu: the single-pointer and keyboard
 * alternative (WCAG 2.2 "Dragging movements"). Each column shows its count and the estimated yearly
 * value of the leads in it; follow-ups due and untouched leads are marked on the card.
 */
export function LeadBoard({ columns, now, viewAllHref }: { columns: Column[]; now: string; viewAllHref: Record<string, string> }) {
  const [dragging, setDragging] = React.useState<LeadListRow | null>(null)
  const [over, setOver] = React.useState<LeadStatus | null>(null)
  const mover = useLeadMover()
  const nowDate = React.useMemo(() => new Date(now), [now])

  return (
    <>
      <div className="relative -mx-4 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0" role="region" aria-label="Pipeline by stage">
        {/* Fixed-width stages that scroll sideways, so most of the pipeline shows at 1366px. min-w-max
            sized every stage to its longest card line and left room for two and a half. */}
        <div className="grid auto-cols-[16rem] grid-flow-col gap-3 max-md:snap-x max-md:snap-mandatory md:auto-cols-[minmax(15rem,1fr)]">
          {columns.map((col) => {
            const info = getStatus("lead_status", col.status)
            const canDrop = dragging ? leadMoveCheck(dragging, col.status).ok : false
            return (
              <section
                key={col.status}
                aria-label={`${info.label}: ${col.total} leads`}
                onDragOver={(e) => {
                  if (!dragging || !canDrop) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = "move"
                  if (over !== col.status) setOver(col.status)
                }}
                onDragLeave={() => setOver((o) => (o === col.status ? null : o))}
                onDrop={(e) => {
                  e.preventDefault()
                  setOver(null)
                  const row = dragging
                  setDragging(null)
                  if (row && row.status !== col.status) mover.move(row, col.status)
                }}
                className={cn(
                  "flex max-h-[max(28rem,calc(100dvh-17rem))] min-h-48 w-[16rem] flex-col rounded-lg border border-border bg-surface-2/60 max-md:snap-start md:w-auto",
                  dragging && canDrop && "border-dashed border-primary/50",
                  over === col.status && "bg-primary-soft",
                )}
              >
                <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                  <StatusChip kind="lead_status" value={col.status} />
                  <span className="flex items-baseline gap-2 text-sm text-text-muted">
                    <span className="num tabular-nums">{formatNumber(col.total)}</span>
                    {col.valuePaise > 0 ? (
                      <FullValueHint short={formatINRCompact(col.valuePaise)} full={`${formatINR(col.valuePaise)} estimated a year`} className="num text-xs tabular-nums" />
                    ) : null}
                  </span>
                </header>
                <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                  {col.rows.length === 0 ? (
                    <li className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-text-muted">
                      {col.status === "lost" ? "Nothing lost. Drag a lead here to close it with a reason." : "No leads at this stage."}
                    </li>
                  ) : null}
                  {col.rows.map((row) => (
                    <LeadCard
                      key={row.id}
                      row={row}
                      now={nowDate}
                      busy={mover.busy === row.id}
                      onDragStart={() => setDragging(row)}
                      onDragEnd={() => {
                        setDragging(null)
                        setOver(null)
                      }}
                      onMove={(to) => mover.move(row, to)}
                    />
                  ))}
                </ul>
                {col.total > col.rows.length ? (
                  <Link
                    href={viewAllHref[col.status] ?? "/leads?view=table"}
                    className="border-t border-border px-3 py-2 text-sm font-medium text-text hover:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  >
                    View all {formatNumber(col.total)} in the table
                  </Link>
                ) : null}
              </section>
            )
          })}
        </div>
      </div>
      {mover.dialogs}
    </>
  )
}

function LeadCard({
  row,
  now,
  busy,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  row: LeadListRow
  now: Date
  busy: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onMove: (to: LeadStatus) => void
}) {
  const draggable = !row.converted_client_id
  const options = LEAD_STATUSES.filter((s) => s !== row.status).map((s) => ({ status: s, check: leadMoveCheck(row, s) }))
  return (
    <li
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", row.id)
        e.dataTransfer.effectAllowed = "move"
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      aria-busy={busy || undefined}
      className={cn("rounded-md border border-border bg-surface p-3 transition-opacity duration-150", busy && "opacity-60", draggable && "cursor-grab active:cursor-grabbing")}
    >
      <div className="flex items-start gap-2">
        {draggable ? <GripVerticalIcon aria-hidden="true" className="mt-0.5 size-3.5 flex-none text-text-muted/60" /> : null}
        <div className="min-w-0 flex-1">
          <Link href={`/leads/${row.id}`} className="line-clamp-2 text-base leading-5 font-medium text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {row.company || row.name}
          </Link>
          <p className="mt-0.5 truncate text-xs text-text-muted">
            {row.company ? row.name : null}
            {row.company && row.lead_number ? " · " : null}
            {row.lead_number ? <span className="font-mono">{row.lead_number}</span> : null}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={`Move ${row.company || row.name}`} className="flex-none">
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="text-xs font-medium text-text-muted">Move to</DropdownMenuLabel>
            {options.map((o) => (
              <DropdownMenuItem key={o.status} disabled={!o.check.ok} onSelect={() => onMove(o.status)} className="flex-col items-start gap-0.5">
                <span className="flex items-center gap-2">
                  <ArrowRightIcon aria-hidden="true" className="size-3.5 text-text-muted" />
                  {getStatus("lead_status", o.status).label}
                  {o.status === "lost" ? <span className="text-xs text-text-muted">(asks why)</span> : null}
                </span>
                {!o.check.ok ? <span className="pl-5.5 text-xs text-text-muted">{o.check.error}</span> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-text-muted">
        <span className="truncate">{row.assigned_name ?? "Not assigned"}</span>
        {row.estimated_value !== null ? <Money value={row.estimated_value} className="text-xs text-text" /> : null}
      </div>
      {row.status === "lost" ? (
        <p className="mt-1.5 line-clamp-2 text-xs text-danger-text">
          {lostCategoryLabel(row.lost_category)}
          {row.lost_reason ? `: ${row.lost_reason}` : ""}
        </p>
      ) : row.status === "won" ? (
        <p className="mt-1.5 text-xs text-success-text">{row.converted_client_name ? `Client: ${row.converted_client_name}` : "Won: convert to a client"}</p>
      ) : row.follow_up_overdue && row.next_follow_up_at ? (
        <p className="mt-1.5 text-xs text-warning-text" title={formatDateTime(row.next_follow_up_at)}>
          Follow-up was due {formatTimeAgo(row.next_follow_up_at, now)}
        </p>
      ) : row.is_stale ? (
        <p className="mt-1.5 text-xs text-warning-text">Untouched since {formatTimeAgo(row.last_activity_at, now)}</p>
      ) : row.next_follow_up_at ? (
        <p className="mt-1.5 text-xs text-text-muted">Follow up {formatDateTime(row.next_follow_up_at)}</p>
      ) : null}
      {row.open_quotations ? (
        <p className="mt-1 text-xs text-text-muted">
          {row.open_quotations === 1 ? "1 open quotation" : `${row.open_quotations} open quotations`}
          {row.latest_quotation_status ? ` · ${getStatus("quotation_status", row.latest_quotation_status).label}` : ""}
        </p>
      ) : null}
    </li>
  )
}
