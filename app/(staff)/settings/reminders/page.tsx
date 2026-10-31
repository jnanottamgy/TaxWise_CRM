import type { Metadata } from "next"
import { requirePartner } from "@/lib/auth/guards"
import { todayIST } from "@/lib/domain/fy"
import { getFirmSettings } from "@/lib/data/settings"
import { RemindersForm } from "@/components/settings/reminders-form"
import { loadSection, SectionHeader, SectionLoadError, SettingsMissing } from "@/components/settings/settings-page"

export const metadata: Metadata = { title: "Reminders · Settings" }

/** Settings → Reminders (§7.21, §8). */
export default async function RemindersSettingsPage() {
  const { supabase } = await requirePartner()
  const result = await loadSection("reminders", () => getFirmSettings(supabase))

  return (
    <div className="min-w-0">
      <SectionHeader title="Reminders" description="When deadlines, invoices, document requests and quotations are chased, and how new clients are told." />
      {!result.ok ? (
        <SectionLoadError what="the reminder settings" errorRef={result.ref} />
      ) : !result.data ? (
        <SettingsMissing />
      ) : (
        <RemindersForm key={result.data.row.updated_at} row={result.data.row} lastChange={result.data.lastChange} today={todayIST()} />
      )}
    </div>
  )
}
