import type { Metadata } from "next"
import Link from "next/link"
import { DownloadIcon } from "lucide-react"
import { requirePartner } from "@/lib/auth/guards"
import { starterNotice } from "@/lib/domain/dpdp"
import { listNotices } from "@/lib/data/dpdp"
import { getFirmProfile, formatFirmAddress } from "@/server/firm"
import { SectionCard } from "@/components/app/section-card"
import { Button } from "@/components/ui/button"
import { loadSection, SectionHeader } from "@/components/settings/settings-page"
import { ErrorBlock } from "@/components/app/error-block"
import { NoticeEditor, NoticeVersions } from "@/components/dpdp/notices"

export const metadata: Metadata = { title: "Data · Settings" }

/**
 * Settings → Data (§7.21 "full export (ZIP of CSVs for every table + documents manifest); privacy
 * notice editor"; §6.10). The full export is built by /api/exports/full, which checks the Partner
 * and writes the export_run audit row. The privacy notice: the draft and its Publish, which makes
 * it the version portal users acknowledge at the welcome gate (§7.22), and every version with its
 * acknowledgements. Partners only (§7.21; RLS 0039 refuses anyone else's write).
 */
export default async function DataSettingsPage() {
  const { supabase } = await requirePartner()
  const [notices, firm] = await Promise.all([loadSection("data:notices", () => listNotices(supabase)), loadSection("data:firm", () => getFirmProfile(supabase))])
  const starter = starterNotice({
    name: firm.ok ? (firm.data.legalName ?? firm.data.firmName) : "TaxWise Consultants",
    email: firm.ok ? firm.data.email : null,
    address: firm.ok ? formatFirmAddress(firm.data) || null : null,
  })
  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-5">
      <SectionHeader title="Data" description="Everything the firm holds, exported in one file, and the privacy notice people acknowledge." />

      <SectionCard title="Full export" description="A ZIP of CSV files, one for every table, with a manifest of the documents in the vault.">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="text-sm text-text-muted">
            It holds personal data and fees, so keep it encrypted and delete it once it has served its purpose. The download is logged in the audit log.
          </p>
          <Button asChild variant="outline" className="flex-none">
            <a href="/api/exports/full">
              <DownloadIcon aria-hidden="true" />
              Download full export
            </a>
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title="Privacy notice"
        description="Shown when a portal account is first used and when a lead is captured. Publishing a new version asks portal users to acknowledge it again."
        action={
          <Link href="/quality?tab=consents" className="text-sm font-medium text-primary hover:underline">
            Consent records
          </Link>
        }
      >
        {notices.ok ? <NoticeEditor notices={notices.data} starter={starter} /> : <ErrorBlock message="Couldn't load the privacy notice." errorRef={notices.ref} size="compact" />}
      </SectionCard>

      <SectionCard title="Versions" description="Kept with the acknowledgements given against each; a published version is never changed." flush>
        {notices.ok ? <NoticeVersions notices={notices.data} /> : <ErrorBlock message="Couldn't load the versions." errorRef={notices.ref} size="compact" />}
      </SectionCard>
    </div>
  )
}
