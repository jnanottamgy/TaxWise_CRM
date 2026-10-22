import type { Metadata } from "next"
import { requirePartner } from "@/lib/auth/guards"
import { addDays, todayIST } from "@/lib/domain/fy"
import { getFirmSettings, getHolidays } from "@/lib/data/settings"
import { WorkingHoursForm } from "@/components/settings/working-hours-form"
import { HolidaysCard } from "@/components/settings/holidays-card"
import { loadSection, SectionHeader, SectionLoadError, SettingsMissing } from "@/components/settings/settings-page"

export const metadata: Metadata = { title: "Working hours · Settings" }

/** Settings → Working hours (§7.21): the working day and week, capacity bands, holidays. */
export default async function WorkingHoursSettingsPage() {
  const { supabase } = await requirePartner()
  const today = todayIST()
  const [settings, holidays] = await Promise.all([
    loadSection("working-hours", () => getFirmSettings(supabase)),
    // This year's past holidays stay visible for reference; older ones drop off.
    loadSection("holidays", () => getHolidays(supabase, { fromDate: addDays(today, -365) })),
  ])

  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-5">
      <SectionHeader title="Working hours" description="The working day and week that attendance, timesheets and capacity are measured against." />
      {!settings.ok ? (
        <SectionLoadError what="the working hours" errorRef={settings.ref} />
      ) : !settings.data ? (
        <SettingsMissing />
      ) : (
        <WorkingHoursForm key={settings.data.row.updated_at} row={settings.data.row} lastChange={settings.data.lastChange} />
      )}
      {!holidays.ok ? (
        <SectionLoadError what="the holidays" errorRef={holidays.ref} />
      ) : (
        <HolidaysCard holidays={holidays.data} today={today} workingWeekdays={settings.ok && settings.data ? settings.data.row.working_weekdays : [1, 2, 3, 4, 5, 6]} />
      )}
    </div>
  )
}
