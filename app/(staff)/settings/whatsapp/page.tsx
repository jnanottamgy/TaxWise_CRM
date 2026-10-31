import type { Metadata } from "next"
import { requireStaff } from "@/lib/auth/guards"
import { PageGuide } from "@/components/shell/page-slots"
import { loadSection, SectionHeader, SectionLoadError, SettingsMissing } from "@/components/settings/settings-page"
import { getNumberPeople, getWelcomeTemplate, getWhatsAppSettingsRow, listFirmNumbers } from "@/lib/data/whatsapp"
import { WELCOME_TEMPLATE_NAME } from "@/lib/domain/whatsapp"
import { WhatsAppGeneralForm } from "@/components/settings/whatsapp/general-form"
import { WhatsAppGeneralSummary } from "@/components/settings/whatsapp/general-summary"
import { NumbersCard } from "@/components/settings/whatsapp/numbers-card"

export const metadata: Metadata = { title: "WhatsApp · Settings" }

/**
 * Settings → WhatsApp (§7.21, §7.25): the firm's WhatsApp numbers, how groups are named and drafts
 * signed, whether Employees may open WhatsApp in a browser window, and the house rules. Partners
 * change everything (and only they: the actions and RLS refuse anyone else); Managers and Employees
 * read it (§4.1 "read"). Each block loads on its own and shows its own error with a Ref.
 */
export default async function WhatsAppSettingsPage() {
  const { user, supabase } = await requireStaff()
  const isPartner = user.role === "partner"

  const [settings, numbers, people, welcome] = await Promise.all([
    loadSection("whatsapp", () => getWhatsAppSettingsRow(supabase)),
    loadSection("whatsapp:numbers", () => listFirmNumbers(supabase)),
    isPartner ? loadSection("whatsapp:people", () => getNumberPeople(supabase)) : Promise.resolve(null),
    loadSection("whatsapp:welcome", () => getWelcomeTemplate(supabase)),
  ])

  const row = settings.ok ? settings.data?.row ?? null : null
  const welcomeHref = welcome.ok && welcome.data.id ? `/templates/messages?q=${encodeURIComponent(WELCOME_TEMPLATE_NAME)}` : "/templates/messages"
  const countryCode = row?.whatsapp_country_code ?? "91"

  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-5">
      <PageGuide title="WhatsApp">
        <p>
          Every client gets one WhatsApp group with the same firm numbers: the three Partners&apos; own numbers, the Managers&apos; office and the Staff office, plus the
          client&apos;s people. Fill in the numbers here first; the setup checklist on each client&apos;s WhatsApp group tab adds them.
        </p>
        <p className="mt-2">
          Open chat opens WhatsApp Web in a browser window beside the CRM and copies the group&apos;s name for its search; on a phone it opens the WhatsApp app. Employees
          get it only if a Partner allows WhatsApp in a browser window. Each browser signed in to WhatsApp Web with a firm number is one of that phone&apos;s linked
          devices, which its custodian checks every week.
        </p>
      </PageGuide>
      <SectionHeader
        title="WhatsApp"
        description={
          isPartner
            ? "The firm's WhatsApp numbers, how client groups are named, who may open WhatsApp in a browser window, and the house rules."
            : "The firm's WhatsApp numbers and rules. A Partner changes them; you can see them here."
        }
      />

      {numbers.ok ? (
        <NumbersCard
          numbers={numbers.data}
          canEdit={isPartner}
          viewerEmployeeId={user.employeeId}
          partners={people && people.ok ? people.data.partners : []}
          staff={people && people.ok ? people.data.staff : []}
          countryCode={countryCode}
        />
      ) : (
        <SectionLoadError what="the firm's WhatsApp numbers" errorRef={numbers.ref} />
      )}
      {people && !people.ok ? <SectionLoadError what="the list of Partners and staff for the numbers" errorRef={people.ref} /> : null}

      {!settings.ok ? (
        <SectionLoadError what="the WhatsApp settings" errorRef={settings.ref} />
      ) : !settings.data ? (
        <SettingsMissing />
      ) : isPartner ? (
        <WhatsAppGeneralForm
          key={settings.data.row.updated_at}
          row={settings.data.row}
          lastChange={settings.data.lastChange}
          viewerName={user.fullName}
          welcomeTemplateHref={welcomeHref}
        />
      ) : (
        <WhatsAppGeneralSummary row={settings.data.row} />
      )}
    </div>
  )
}
