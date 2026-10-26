"use client"

import * as React from "react"
import { CalendarCheckIcon, InboxIcon, UsersRoundIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/app/empty-state"
import { StatusChip } from "@/components/app/status-chip"
import type { AppRole } from "@/lib/auth/roles"
import { LEAVE_TYPE_LABELS } from "@/lib/domain/enums"
import { formatLeaveRange } from "@/lib/domain/leave"
import type { LeaveRow } from "@/lib/data/leave"
import type { PersonOption } from "@/lib/data/people"
import { DecideLeaveButtons } from "@/components/leave/leave-decision"
import { CoverDialog } from "@/components/covers/cover-dialog"
import { PersonLink } from "@/components/people/people-bits"

function daysText(n: number): string {
  return `${n} working ${n === 1 ? "day" : "days"}`
}

/** Requests waiting for this approver (§7.11.3), each with Approve / Decline. */
export function PendingLeaveList({ rows, actorRole, staff }: { rows: LeaveRow[]; actorRole: AppRole; staff: PersonOption[] }) {
  if (rows.length === 0) return <EmptyState icon={<InboxIcon />} message="Nothing waiting for you. New requests appear here, and in your Inbox." />
  return (
    // Sized by its container: in a narrow card (Firm today's Approvals) the buttons sit under the request.
    <ul className="@container divide-y divide-border/70">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-col gap-2 px-4 py-3 @lg:flex-row @lg:items-center @lg:justify-between md:px-5">
          <div className="min-w-0">
            <p className="text-base text-text">
              <PersonLink id={r.employee_id} name={r.employee_name} className="font-medium" /> · {LEAVE_TYPE_LABELS[r.type]} leave {formatLeaveRange(r.start_date, r.end_date, r.half_day)}
            </p>
            <p className="text-sm text-text-muted">
              {daysText(r.working_days)}
              {r.reason ? ` · ${r.reason}` : ""}
            </p>
          </div>
          <DecideLeaveButtons leave={r} actorRole={actorRole} staff={staff} />
        </li>
      ))}
    </ul>
  )
}

export interface AwayRow extends LeaveRow {
  /** Names of people covering for this leave (covers linked to it). */
  coveredBy: string[]
}

/** Who is away soon (§7.11.3): approved leave in the next 30 days, with its cover (§4.7). */
export function AwayList({ rows, actorRole, today }: { rows: AwayRow[]; actorRole: AppRole; today: string }) {
  const [cover, setCover] = React.useState<AwayRow | null>(null)
  if (rows.length === 0) return <EmptyState icon={<CalendarCheckIcon />} message="Nobody has approved leave in the next 30 days." />
  return (
    <>
      <ul className="divide-y divide-border/70">
        {rows.map((r) => {
          const now = r.start_date <= today && r.end_date >= today
          return (
            <li key={r.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between md:px-5">
              <div className="min-w-0">
                <p className="text-base text-text">
                  <PersonLink id={r.employee_id} name={r.employee_name} className="font-medium" /> · {formatLeaveRange(r.start_date, r.end_date, r.half_day)}
                </p>
                <p className="text-sm text-text-muted">
                  {LEAVE_TYPE_LABELS[r.type]} · {daysText(r.working_days)}
                  {r.coveredBy.length ? ` · Covered by ${r.coveredBy.join(", ")}` : r.no_cover_needed ? " · No cover needed" : ""}
                </p>
              </div>
              <div className="flex flex-none items-center gap-2">
                {now ? <StatusChip label="Away now" tone="violet" meaning="Away now: the leave covers today." /> : null}
                {!r.coveredBy.length && !r.no_cover_needed ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => setCover(r)}>
                    <UsersRoundIcon aria-hidden="true" />
                    Set up cover
                  </Button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
      {cover ? (
        <CoverDialog
          target={{ kind: "person", employeeId: cover.employee_id, name: cover.employee_name, leave: { id: cover.id, start: cover.start_date, end: cover.end_date } }}
          actorRole={actorRole}
          open
          onOpenChange={(o) => !o && setCover(null)}
        />
      ) : null}
    </>
  )
}
