import { DefinitionList } from "@/components/app/definition-list"
import { SettingsCard } from "@/components/settings/settings-card"
import { HouseRulesText } from "@/components/whatsapp/house-rules"
import { renderGroupName } from "@/lib/domain/whatsapp"
import type { WhatsAppSettingsRow } from "@/lib/data/whatsapp"

/**
 * Settings → WhatsApp for Managers and Employees (§4.1: "read"): the same settings as the Partner's
 * form, as facts. Server-safe.
 */
export function WhatsAppGeneralSummary({ row }: { row: WhatsAppSettingsRow }) {
  const onOff = (v: boolean) => (v ? "On" : "Off")
  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-5">
      <SettingsCard id="names" title="Numbers and names" description="How the app reads phone numbers, names client groups and signs WhatsApp drafts from the shared numbers." columns={1}>
        <DefinitionList
          items={[
            { term: "Default country code", value: <span className="num">+{row.whatsapp_country_code}</span> },
            { term: "Group name format", value: <span className="font-mono text-[13px]">{row.whatsapp_group_name_format}</span> },
            { term: "Example", value: <span className="font-mono text-[13px]">{renderGroupName(row.whatsapp_group_name_format, { clientCode: "TW-C-0142", displayName: "XYZ Traders" })}</span> },
            { term: "Signature", value: row.whatsapp_signature },
          ]}
        />
      </SettingsCard>
      <SettingsCard id="desktop" title="TaxWise Desktop" description="WhatsApp Web inside the CRM, beside the client's page." columns={1}>
        <DefinitionList
          items={[
            { term: "Client mode for Employees", value: onOff(row.whatsapp_client_mode) },
            { term: "Employee notifications", value: onOff(row.whatsapp_employee_notifications) },
            { term: "WhatsApp in a browser window for Employees", value: row.whatsapp_employee_browser_window ? "Allowed" : "Not allowed" },
            { term: "Linked device limit", value: <span className="num">{row.whatsapp_linked_device_limit} PCs per number</span> },
          ]}
        />
      </SettingsCard>
      <SettingsCard id="house-rules" title="House rules" description="What everyone at the firm follows on WhatsApp. A Partner keeps them up to date." columns={1}>
        {row.whatsapp_house_rules ? <HouseRulesText text={row.whatsapp_house_rules} /> : <p className="text-sm text-text-muted">No house rules are written down yet.</p>}
      </SettingsCard>
    </div>
  )
}
