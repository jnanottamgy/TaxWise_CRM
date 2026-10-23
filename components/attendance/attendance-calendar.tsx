"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PencilLineIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { SelectField, TextareaField } from "@/components/app/form/fields"
import { toneClasses } from "@/components/app/tones"
import { useActionForm } from "@/hooks/use-action-form"
import { getStatus } from "@/lib/status"
import { formatDate, formatMinutes, formatTime } from "@/lib/format"
import { isoWeekday } from "@/lib/domain/fy"
import { ATTENDANCE_STATUS_LABELS } from "@/lib/domain/attendance"
import { ATTENDANCE_STATUSES, type AttendanceStatus } from "@/lib/domain/enums"
import { AttendanceCorrectionSchema } from "@/lib/schemas/leave"
import type { AttendanceDay } from "@/lib/data/attendance"
import { correctAttendance } from "@/server/actions/attendance"

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/**
 * A person's month as a calendar (§7.11.2 "Attendance: calendar with statuses", §7.12). Each
 * working day shows its status (dot + label, explained on hover through the day's title and the
 * legend); holidays and non-working days are marked; days ahead are blank. Partners and Managers
 * click a day to correct it, with a reason (the correction is shown on the day and in the audit log).
 */
export function AttendanceCalendar({
  employeeId,
  days,
  today,
  canCorrect,
}: {
  employeeId: string
  days: AttendanceDay[]
  today: string
  canCorrect: boolean
}) {
  const [editing, setEditing] = React.useState<AttendanceDay | null>(null)
  const lead = days.length ? isoWeekday(days[0].date) - 1 : 0
  const cells: Array<AttendanceDay | null> = [...Array.from({ length: lead }, () => null), ...days]
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: Array<Array<AttendanceDay | null>> = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))

  const renderDay = (d: AttendanceDay) => {
    const future = d.date > today
    const info = d.status ? getStatus("attendance_status", d.status) : null
    const tone = info ? toneClasses(info.tone) : null
    const correctable = canCorrect && !future && (d.working || d.status !== null)
    const label = info
      ? `${formatDate(d.date)}: ${info.label}${d.corrected ? `, corrected by ${d.corrected_by_name ?? "a Partner or Manager"} (${d.correction_reason})` : ""}`
      : d.holiday
        ? `${formatDate(d.date)}: holiday, ${d.holiday}`
        : !d.working
          ? `${formatDate(d.date)}: not a working day`
          : future
            ? `${formatDate(d.date)}: ahead`
            : d.date === today
              ? `${formatDate(d.date)}: today, not finished yet`
              : `${formatDate(d.date)}: no record`
    const body = (
      <>
        <span className={cn("num text-sm", d.date === today ? "font-semibold text-text" : "text-text-muted")}>{Number(d.date.slice(8))}</span>
        {info && tone ? (
          <span className={cn("mt-1 flex max-w-full items-center gap-1 text-xs font-medium", tone.text)}>
            <span aria-hidden="true" className={cn("size-1.5 flex-none rounded-full", tone.dot)} />
            <span className="truncate">{info.label}</span>
          </span>
        ) : d.holiday ? (
          <span className="mt-1 max-w-full truncate text-xs text-text-muted">{d.holiday}</span>
        ) : !d.working ? (
          <span className="mt-1 text-xs text-text-muted">Off</span>
        ) : null}
        {d.work_minutes ? <span className="num mt-auto text-xs text-text-muted">{formatMinutes(d.work_minutes)}</span> : null}
        {d.corrected ? <PencilLineIcon aria-hidden="true" className="absolute top-1.5 right-1.5 size-3 text-text-muted" /> : null}
      </>
    )
    const cellClass = cn("relative flex h-full min-h-16 w-full flex-col items-start p-1.5 text-left md:min-h-20 md:p-2", !d.working && !info ? "bg-surface-2/60" : "bg-surface")
    return correctable ? (
      <button
        type="button"
        aria-label={`${label}. Correct this day`}
        title={label}
        onClick={() => setEditing(d)}
        className={cn(cellClass, "cursor-pointer transition-colors duration-150 hover:bg-bg focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring")}
      >
        {body}
      </button>
    ) : (
      <div aria-label={label} title={label} className={cellClass}>
        {body}
      </div>
    )
  }

  return (
    <>
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full table-fixed border-collapse">
          <caption className="sr-only">Attendance calendar</caption>
          <thead>
            <tr>
              {WEEKDAYS.map((d) => (
                <th key={d} scope="col" className="border-b border-border bg-surface-2 px-1 py-1.5 text-center text-xs font-medium text-text-muted">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((w, i) => (
              <tr key={i}>
                {w.map((d, j) => (
                  <td key={d?.date ?? `pad-${i}-${j}`} className={cn("h-16 border-border p-0 align-top md:h-20", j > 0 && "border-l", i > 0 && "border-t", !d && "bg-surface-2/40")}>
                    {d ? renderDay(d) : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul aria-label="What the statuses mean" className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-text-muted">
        {(ATTENDANCE_STATUSES as readonly AttendanceStatus[]).map((s) => {
          const info = getStatus("attendance_status", s)
          const t = toneClasses(info.tone)
          return (
            <li key={s} className="flex items-center gap-1.5" title={info.meaning}>
              <span aria-hidden="true" className={cn("size-2 rounded-full", t.dot)} />
              {info.label}
            </li>
          )
        })}
        <li className="flex items-center gap-1.5">
          <PencilLineIcon aria-hidden="true" className="size-3" />
          Corrected
        </li>
      </ul>
      {editing ? <CorrectionDialog employeeId={employeeId} day={editing} onOpenChange={(o) => !o && setEditing(null)} /> : null}
    </>
  )
}

function CorrectionDialog({ employeeId, day, onOpenChange }: { employeeId: string; day: AttendanceDay; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const f = useActionForm(AttendanceCorrectionSchema, correctAttendance, {
    defaultValues: { employee_id: employeeId, date: day.date, status: day.status ?? "present", reason: "", updated_at: day.record_updated_at },
    successMessage: "Attendance corrected.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  const recorded = day.status ? ATTENDANCE_STATUS_LABELS[day.status] : "No record"
  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      size="sm"
      title={`Correct ${formatDate(day.date)}`}
      description={`Recorded: ${recorded}${day.first_login_at ? ` · first activity ${formatTime(day.first_login_at)}` : ""}${day.work_minutes ? ` · ${formatMinutes(day.work_minutes)} active` : ""}. The reason is kept on the day and in the audit log.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save correction"
    >
      <FormAlert state={f} />
      <div className="flex flex-col gap-4">
        <SelectField
          control={f.control}
          name="status"
          label="Status"
          required
          options={(ATTENDANCE_STATUSES as readonly AttendanceStatus[]).map((s) => ({ value: s, label: ATTENDANCE_STATUS_LABELS[s] }))}
        />
        <TextareaField control={f.control} name="reason" label="Reason" required rows={3} helper="For example: worked at the client's office; signed in on another device." />
      </div>
    </FormDialog>
  )
}
