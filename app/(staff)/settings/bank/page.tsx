import type { Metadata } from "next"
import { requirePartner } from "@/lib/auth/guards"
import { financialYearOf, todayIST } from "@/lib/domain/fy"
import { checkSeriesPrefix } from "@/lib/domain/numbering"
import { getFirmSettings } from "@/lib/data/settings"
import { BankForm } from "@/components/settings/bank-form"
import { loadSection, SectionHeader, SectionLoadError, SettingsMissing } from "@/components/settings/settings-page"

export const metadata: Metadata = { title: "Bank & UPI · Settings" }

/** Settings → Bank & UPI (§7.21). */
export default async function BankSettingsPage() {
  const { supabase } = await requirePartner()
  const result = await loadSection("bank", () => getFirmSettings(supabase))
  const fy = financialYearOf(todayIST())

  return (
    <div className="min-w-0">
      <SectionHeader title="Bank & UPI" description="Where clients pay: printed on invoices and offered in the portal's Pay dialog." />
      {!result.ok ? (
        <SectionLoadError what="the bank details" errorRef={result.ref} />
      ) : !result.data ? (
        <SettingsMissing />
      ) : (
        (() => {
          const { row, lastChange } = result.data
          const prefix = checkSeriesPrefix("invoice", row.invoice_prefix, { fy })
          return <BankForm key={row.updated_at} row={row} lastChange={lastChange} sampleInvoiceNumber={prefix.ok ? prefix.sample : row.invoice_prefix} />
        })()
      )}
    </div>
  )
}
