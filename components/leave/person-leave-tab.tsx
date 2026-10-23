import { unstable_rethrow } from "next/navigation"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { ServerSupabase } from "@/lib/supabase/server"
import { logUnexpected } from "@/lib/log"
import { formatNumber } from "@/lib/format"
import { todayIST } from "@/lib/domain/fy"
import { LEAVE_TYPE_LABELS, LEAVE_TYPES } from "@/lib/domain/enums"
import { getSelectedFy } from "@/lib/fy-context"
import { parseTableParams } from "@/components/app/data-table/params"
import { KpiStrip } from "@/components/app/kpi-strip"
import { ErrorBlock } from "@/components/app/error-block"
import { LEAVE_FILTERS, LEAVE_SORTABLE, getLeaveSummary, listLeave } from "@/lib/data/leave"
import { listActiveStaff, type PersonOption } from "@/lib/data/people"
import { LeaveTable } from "@/components/leave/leave-table"
import { RequestLeaveDialog } from "@/components/leave/request-leave-dialog"

function days(n: number): string {
  return `${formatNumber(n, { maxDecimals: 1 })} ${n === 1 ? "day" : "days"}`
}

/**
 * One person's leave (§7.11.2 "Leave: balance and history"): the firm keeps no allowance, so the
 * balance is what was taken this financial year (working days, by type), what is approved ahead and
 * what waits for a decision; then every request, newest first. The person may request leave here.
 */
export async function PersonLeaveTab({
  employeeId,
  viewer,
  supabase,
  searchParams,
}: {
  employeeId: string
  viewer: CurrentUser
  supabase: ServerSupabase
  searchParams: Record<string, string | string[] | undefined>
}) {
  const today = todayIST()
  const fy = await getSelectedFy()
  const t = parseTableParams(searchParams, { sortable: LEAVE_SORTABLE, defaultSort: { sort: "start_date", dir: "desc" }, filters: LEAVE_FILTERS })
  const manager = viewer.role === "partner" || viewer.role === "manager"
  let summary: Awaited<ReturnType<typeof getLeaveSummary>> | null = null
  let list: Awaited<ReturnType<typeof listLeave>> | null = null
  let staff: PersonOption[] = []
  let ref: string | null = null
  try {
    ;[summary, list, staff] = await Promise.all([
      getLeaveSummary(supabase, employeeId, fy, today),
      listLeave(supabase, t, today, { employeeId }),
      manager ? listActiveStaff(supabase) : Promise.resolve([]),
    ])
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "page:person-leave-tab", userId: viewer.id, role: viewer.role })
  }
  if (!summary || !list) {
    return (
      <div className="rounded-lg border border-border bg-surface">
        <ErrorBlock message="Couldn't load the leave." errorRef={ref} />
      </div>
    )
  }
  const byType = LEAVE_TYPES.filter((ty) => (summary.takenByType[ty] ?? 0) > 0)
    .map((ty) => `${LEAVE_TYPE_LABELS[ty]} ${formatNumber(summary.takenByType[ty] ?? 0, { maxDecimals: 1 })}`)
    .join(" · ")
  const self = viewer.employeeId === employeeId
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <KpiStrip
          className="min-w-0 flex-1"
          aria-label={`Leave in FY ${fy}`}
          items={[
            { label: `Taken in FY ${fy}`, value: days(summary.taken), sub: byType || "working days, by type" },
            { label: "Approved ahead", value: days(summary.upcoming) },
            { label: "Waiting for a decision", value: days(summary.pending) },
          ]}
        />
        {self ? <RequestLeaveDialog variant="outline" /> : null}
      </div>
      <LeaveTable
        rows={list.rows}
        total={list.total}
        page={t.page}
        pageSize={t.pageSize}
        sort={t.sort}
        dir={t.dir}
        viewer={{ role: viewer.role, employeeId: viewer.employeeId, today }}
        staff={staff}
        showPerson={false}
        emptyMessage={self ? "No leave yet. Request leave when you plan time off." : "No leave recorded."}
      />
    </div>
  )
}
