import type { Metadata } from "next"
import { requirePartner } from "@/lib/auth/guards"
import { financialYearOf, todayIST } from "@/lib/domain/fy"
import { checkSeriesPrefix } from "@/lib/domain/numbering"
import { getFirmSettings, getPartners, logoPublicUrl } from "@/lib/data/settings"
import { FirmDetailsForm } from "@/components/settings/firm-details-form"
import { loadSection, SectionHeader, SectionLoadError, SettingsMissing } from "@/components/settings/settings-page"

export const metadata: Metadata = { title: "Firm details · Settings" }

/** Settings → Firm details (§1, §7.21): identity, address, registrations, Partners' numbers, logo. */
export default async function FirmSettingsPage() {
  const { supabase } = await requirePartner()
  const today = todayIST()
  const result = await loadSection("firm", async () => {
    const [settings, partners] = await Promise.all([getFirmSettings(supabase), getPartners(supabase)])
    return { settings, partners }
  })

  return (
    <div className="min-w-0">
      <SectionHeader title="Firm details" description="Who the firm is on every invoice, quotation, email and portal page." />
      {!result.ok ? (
        <SectionLoadError what="the firm details" errorRef={result.ref} />
      ) : !result.data.settings ? (
        <SettingsMissing />
      ) : (
        (() => {
          const { row, lastChange } = result.data.settings
          const prefix = checkSeriesPrefix("invoice", row.invoice_prefix, { fy: financialYearOf(today) })
          return (
            <FirmDetailsForm
              key={row.updated_at}
              row={row}
              partners={result.data.partners}
              lastChange={lastChange}
              logoUrl={logoPublicUrl(supabase, row)}
              sampleInvoiceNumber={prefix.ok ? prefix.sample : row.invoice_prefix}
              today={today}
            />
          )
        })()
      )}
    </div>
  )
}
