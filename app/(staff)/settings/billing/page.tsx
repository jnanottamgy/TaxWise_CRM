import type { Metadata } from "next"
import { requirePartner } from "@/lib/auth/guards"
import { todayIST } from "@/lib/domain/fy"
import { getFirmSettings } from "@/lib/data/settings"
import { BillingForm } from "@/components/settings/billing-form"
import { loadSection, SectionHeader, SectionLoadError, SettingsMissing } from "@/components/settings/settings-page"

export const metadata: Metadata = { title: "Billing · Settings" }

/** Settings → Billing (§7.21, §6.4). */
export default async function BillingSettingsPage() {
  const { supabase } = await requirePartner()
  const result = await loadSection("billing", () => getFirmSettings(supabase))

  return (
    <div className="min-w-0">
      <SectionHeader title="Billing" description="GST defaults, payment terms, approval limits and quotation terms for new documents." />
      {!result.ok ? (
        <SectionLoadError what="the billing settings" errorRef={result.ref} />
      ) : !result.data ? (
        <SettingsMissing />
      ) : (
        <BillingForm key={result.data.row.updated_at} row={result.data.row} lastChange={result.data.lastChange} today={todayIST()} />
      )}
    </div>
  )
}
