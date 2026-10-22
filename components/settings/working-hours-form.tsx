"use client"

import { useWatch } from "react-hook-form"
import { formatMinutes } from "@/lib/format"
import { WEEKDAY_LABELS, WEEKDAYS, WorkingHoursSchema, type WorkingHoursInput } from "@/lib/schemas/settings"
import { saveWorkingHours } from "@/server/actions/settings"
import type { FirmSettingsRow, LastChange } from "@/lib/data/settings"
import { CheckboxGroupField, TextField } from "@/components/app/form/fields"
import { SettingsCard, SettingPreview, Wide } from "@/components/settings/settings-card"
import { SettingsForm, useSettingsForm } from "@/components/settings/settings-form"

const WEEKDAY_OPTIONS = WEEKDAYS.map((d) => ({ value: String(d), label: WEEKDAY_LABELS[d] }))

/** The §7.11.4 defaults, used when the stored thresholds are unreadable. */
const DEFAULT_THRESHOLDS = { busy: 1.5, tight: 2.5, over: 4 }

function addMinutesToTime(hhmm: string, minutes: number): string | null {
  const m = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(hhmm)
  if (!m || !Number.isFinite(minutes)) return null
  const total = Number(m[1]) * 60 + Number(m[2]) + minutes
  if (total >= 24 * 60) return null
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}

/**
 * Settings → Working hours (§7.21, §7.12, §7.11.4): when the day starts, what counts as late and as a
 * half day, the working week and its hours target, and the capacity bands. Holidays are listed
 * below the form (they are rows of their own and save as they are added).
 */
export function WorkingHoursForm({ row, lastChange }: { row: FirmSettingsRow; lastChange: LastChange }) {
  const t = row.capacity_thresholds ?? {}
  const num = (x: unknown, d: number) => (typeof x === "number" || (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) ? String(Number(x)) : String(d))
  const defaults: WorkingHoursInput = {
    updated_at: row.updated_at,
    work_day_start: (row.work_day_start ?? "09:30").slice(0, 5),
    late_grace_minutes: String(row.late_grace_minutes),
    half_day_minutes: String(row.half_day_minutes),
    working_weekdays: (row.working_weekdays ?? []).map(String),
    weekly_hours_target: String(row.weekly_hours_target),
    capacity_thresholds: { busy: num(t.busy, DEFAULT_THRESHOLDS.busy), tight: num(t.tight, DEFAULT_THRESHOLDS.tight), over: num(t.over, DEFAULT_THRESHOLDS.over) },
  }
  const f = useSettingsForm(WorkingHoursSchema, saveWorkingHours, defaults, { savedMessage: "Working hours saved" })
  const v = useWatch({ control: f.control }) as Partial<WorkingHoursInput>

  const grace = Number(v.late_grace_minutes)
  const lateAfter = v.work_day_start ? addMinutesToTime(String(v.work_day_start).slice(0, 5), Number.isFinite(grace) ? grace : 0) : null
  const halfDay = Number(v.half_day_minutes)
  const days = (v.working_weekdays ?? []).length
  const target = Number(v.weekly_hours_target)
  const perDay = days > 0 && Number.isFinite(target) ? (target / days).toFixed(1).replace(/\.0$/, "") : null
  const th: { busy?: unknown; tight?: unknown; over?: unknown } = v.capacity_thresholds ?? {}
  const show = (x: unknown) => (x === undefined || x === null || String(x).trim() === "" ? "—" : String(x))

  return (
    <SettingsForm state={f} lastChange={lastChange} conflict={f.conflict} submitLabel="Save working hours">
      <SettingsCard title="The working day" description="Attendance reads these when it marks yesterday's Present, Late login and Half day.">
        <TextField control={f.control} name="work_day_start" label="Day starts at" required type="time" step={300} />
        <TextField control={f.control} name="late_grace_minutes" label="Late grace (minutes)" required inputMode="numeric" />
        <TextField control={f.control} name="half_day_minutes" label="Half day below (minutes of activity)" required inputMode="numeric" />
        <SettingPreview wide={false} label="What counts">
          <ul className="flex flex-col gap-0.5">
            <li>{lateAfter ? <>A first sign-in after <span className="num font-medium">{lateAfter}</span> is a Late login.</> : <span className="text-text-muted">Enter the start time and grace.</span>}</li>
            <li>
              {Number.isFinite(halfDay) && halfDay >= 0 ? (
                <>
                  Less than <span className="num font-medium">{formatMinutes(halfDay)}</span> of activity is a Half day.
                </>
              ) : (
                <span className="text-text-muted">Enter the half-day minutes.</span>
              )}
            </li>
          </ul>
        </SettingPreview>
      </SettingsCard>

      <SettingsCard title="The working week" description="Capacity counts only working days: weekends, holidays and leave are left out.">
        <Wide>
          <CheckboxGroupField control={f.control} name="working_weekdays" label="Working days" required options={WEEKDAY_OPTIONS} columns={3} />
        </Wide>
        <TextField control={f.control} name="weekly_hours_target" label="Weekly hours target" required inputMode="numeric" helper="Shown against each person's logged time." />
        <SettingPreview wide={false} label="Per working day">
          {perDay ? (
            <>
              <span className="num font-medium">{target}</span> hours over <span className="num">{days}</span> day{days === 1 ? "" : "s"} is about <span className="num font-medium">{perDay} h</span> a day.
            </>
          ) : (
            <span className="text-text-muted">Choose the days and the target.</span>
          )}
        </SettingPreview>
      </SettingsCard>

      <SettingsCard
        title="Capacity bands"
        description="Open tasks due in the window, per working day left. Shown on the Manager dashboard, on People and when assigning work."
      >
        <TextField control={f.control} name="capacity_thresholds.busy" label="Busy from (tasks a day)" required inputMode="decimal" />
        <TextField control={f.control} name="capacity_thresholds.tight" label="Tight from (tasks a day)" required inputMode="decimal" />
        <TextField control={f.control} name="capacity_thresholds.over" label="Over capacity from (tasks a day)" required inputMode="decimal" />
        <SettingPreview wide={false} label="Bands">
          <ul className="num flex flex-col gap-0.5">
            <li>Clear: below {show(th.busy)}</li>
            <li>Busy: {show(th.busy)} up to {show(th.tight)}</li>
            <li>Tight: {show(th.tight)} up to {show(th.over)}</li>
            <li>Over: {show(th.over)} or more</li>
          </ul>
        </SettingPreview>
      </SettingsCard>
    </SettingsForm>
  )
}
