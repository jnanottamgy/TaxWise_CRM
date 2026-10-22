import type { Metadata } from "next"
import { requirePartner } from "@/lib/auth/guards"
import { financialYearOf, todayIST } from "@/lib/domain/fy"
import { SERIES } from "@/lib/domain/numbering"
import { getFirmSettings, getNumberSeries } from "@/lib/data/settings"
import { NumberingForm, type SeriesView } from "@/components/settings/numbering-form"
import { loadSection, SectionHeader, SectionLoadError, SettingsMissing } from "@/components/settings/settings-page"

export const metadata: Metadata = { title: "Numbering · Settings" }

/** Settings → Numbering (§7.21): prefixes, the next number per series, the 16-character rule. */
export default async function NumberingSettingsPage() {
  const { supabase } = await requirePartner()
  const fy = financialYearOf(todayIST())
  const result = await loadSection("numbering", async () => {
    const [settings, series] = await Promise.all([getFirmSettings(supabase), getNumberSeries(supabase)])
    return { settings, series }
  })

  return (
    <div className="min-w-0">
      <SectionHeader title="Numbering" description={`Prefixes and the next number of each document series for FY ${fy}.`} />
      {!result.ok ? (
        <SectionLoadError what="the numbering settings" errorRef={result.ref} />
      ) : !result.data.settings ? (
        <SettingsMissing />
      ) : (
        (() => {
          const { row, lastChange } = result.data.settings
          const views: SeriesView[] = result.data.series.map((s) => ({
            key: s.key,
            // The counter's next number: an FY-scoped series not yet used this FY restarts at 1.
            next_value: !s.exists ? 1 : SERIES[s.key].fyScoped && s.financial_year !== fy ? 1 : s.next_value,
            updated_at: s.updated_at,
            financial_year: s.financial_year,
          }))
          const key = [row.updated_at, ...views.map((s) => s.updated_at ?? "")].join("|")
          return <NumberingForm key={key} row={row} series={views} lastChange={lastChange} fy={fy} />
        })()
      )}
    </div>
  )
}
