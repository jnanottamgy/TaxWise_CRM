"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CalendarOffIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { isoWeekday } from "@/lib/domain/fy"
import { formatDate } from "@/lib/format"
import { HolidaySchema, WEEKDAY_LABELS } from "@/lib/schemas/settings"
import { addHoliday, removeHoliday } from "@/server/actions/settings"
import type { HolidayRow } from "@/lib/data/settings"
import { Button } from "@/components/ui/button"
import { DateField, TextField } from "@/components/app/form/fields"
import { FormAlert } from "@/components/app/form/form-alert"
import { FormDialog } from "@/components/app/form-dialog"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { EmptyState } from "@/components/app/empty-state"
import { useActionForm } from "@/hooks/use-action-form"

/**
 * The firm's holidays (§5.2 holidays table): non-working days for capacity and attendance. Each row
 * is added or removed on its own, so this card sits under the working-hours form with its own
 * actions rather than the form's Save.
 */
export function HolidaysCard({ holidays, today, workingWeekdays }: { holidays: HolidayRow[]; today: string; workingWeekdays: number[] }) {
  const router = useRouter()
  const [adding, setAdding] = React.useState(false)
  const [removing, setRemoving] = React.useState<HolidayRow | null>(null)

  const f = useActionForm(HolidaySchema, addHoliday, {
    defaultValues: { date: "", name: "" },
    successMessage: (d) => `${formatDate(d.date)} added as a holiday`,
    onSuccess: () => {
      setAdding(false)
      f.form.reset({ date: "", name: "" })
      router.refresh()
    },
  })

  const upcoming = holidays.filter((h) => h.date >= today)
  const past = holidays.filter((h) => h.date < today)

  return (
    <section aria-labelledby="holidays-title" className="min-w-0 rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5 md:px-5">
        <div className="min-w-0">
          <h2 id="holidays-title" className="font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text">
            Holidays
          </h2>
          <p className="mt-0.5 text-sm text-text-muted">
            Office closed: left out of capacity and never marked Absent. Statutory due dates don&apos;t move for a holiday.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
          <PlusIcon aria-hidden="true" />
          Add holiday
        </Button>
      </div>

      {holidays.length === 0 ? (
        <EmptyState
          icon={<CalendarOffIcon />}
          message="No holidays yet. Add the year's office holidays so capacity and attendance leave them out."
          action={
            <Button type="button" onClick={() => setAdding(true)}>
              Add holiday
            </Button>
          }
        />
      ) : (
        <div className="min-w-0">
          {upcoming.length === 0 ? <p className="px-4 py-3 text-sm text-text-muted md:px-5">No holidays ahead. Past ones are listed below.</p> : null}
          <HolidayList rows={upcoming} workingWeekdays={workingWeekdays} onRemove={setRemoving} />
          {past.length ? (
            <details className="group border-t border-border">
              <summary className="flex min-h-10 cursor-pointer items-center px-4 text-sm font-medium text-text hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-5 pointer-coarse:min-h-11">
                Past holidays ({past.length})
              </summary>
              <HolidayList rows={[...past].reverse()} workingWeekdays={workingWeekdays} onRemove={setRemoving} muted />
            </details>
          ) : null}
        </div>
      )}

      <FormDialog
        open={adding}
        onOpenChange={(o) => {
          setAdding(o)
          if (!o) f.form.reset({ date: "", name: "" })
        }}
        title="Add a holiday"
        description="A day the office is closed."
        onSubmit={f.onSubmit}
        pending={f.pending}
        dirty={f.form.formState.isDirty}
        submitLabel="Add holiday"
        size="sm"
      >
        <FormAlert state={f} />
        <div className="flex flex-col gap-4">
          <DateField control={f.control} name="date" label="Date" required />
          <TextField control={f.control} name="name" label="Holiday" required placeholder="e.g. Deepavali" maxLength={80} />
        </div>
      </FormDialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => {
          if (!o) setRemoving(null)
        }}
        title={removing ? `Remove ${removing.name}?` : "Remove holiday?"}
        description={removing ? `${formatDate(removing.date)} becomes a normal working day again for capacity and attendance.` : ""}
        confirmLabel="Remove holiday"
        destructive
        onConfirm={async () => {
          if (!removing) return
          const r = await removeHoliday({ date: removing.date })
          if (!r.ok) {
            toast.error(r.error)
            return false
          }
          toast.success(`${formatDate(removing.date)} removed`)
          setRemoving(null)
          router.refresh()
        }}
      />
    </section>
  )
}

function HolidayList({
  rows,
  workingWeekdays,
  onRemove,
  muted = false,
}: {
  rows: HolidayRow[]
  workingWeekdays: number[]
  onRemove: (row: HolidayRow) => void
  muted?: boolean
}) {
  if (rows.length === 0) return null
  return (
    <ul className="divide-y divide-border">
      {rows.map((h) => {
        const wd = isoWeekday(h.date)
        const offDay = !workingWeekdays.includes(wd)
        return (
          <li key={h.date} className="flex min-h-11 items-center gap-4 px-4 py-2 md:px-5">
            <span className={`num w-28 flex-none text-base ${muted ? "text-text-muted" : "text-text"}`}>{formatDate(h.date)}</span>
            <span className="w-10 flex-none text-sm text-text-muted">{WEEKDAY_LABELS[wd]}</span>
            <span className="min-w-0 flex-1 truncate text-base text-text">
              {h.name}
              {offDay ? <span className="ml-2 text-sm text-text-muted">· already a non-working day</span> : null}
            </span>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${h.name}, ${formatDate(h.date)}`} onClick={() => onRemove(h)}>
              <Trash2Icon aria-hidden="true" className="text-text-muted" />
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
