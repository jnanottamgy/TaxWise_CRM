"use client"

import Link from "next/link"
import { useWatch } from "react-hook-form"
import { SelectField, SwitchField, TextField, TextareaField } from "@/components/app/form/fields"
import { SettingsCard, SettingPreview, Wide } from "@/components/settings/settings-card"
import { SettingsForm, useSettingsForm } from "@/components/settings/settings-form"
import { getDesktopBridge } from "@/components/shell/use-desktop"
import { applySignature, firstNameOf } from "@/lib/domain/messaging"
import { renderGroupName, validateGroupNameFormat } from "@/lib/domain/whatsapp"
import { WhatsAppSettingsSchema, type WhatsAppSettingsInput } from "@/lib/schemas/whatsapp"
import type { WhatsAppSettingsRow } from "@/lib/data/whatsapp"
import type { LastChange } from "@/lib/data/settings"
import { saveWhatsAppSettings } from "@/server/actions/whatsapp-settings"

const SAMPLE = { clientCode: "TW-C-0142", displayName: "XYZ Traders Private Limited" }

/**
 * Settings → WhatsApp (§7.21), the firm-wide part: the default country code, the group name format
 * (with a live example) and the signature format; client mode, Employee notifications, WhatsApp in
 * a browser window for Employees and the linked device limit; the installer link; the house rules
 * (§7.25.10). Partner only; one Save for the panel. After a save, TaxWise Desktop is asked to
 * reload its context so client mode and notifications change at once (docs/DESKTOP-API.md (c)).
 */
export function WhatsAppGeneralForm({
  row,
  lastChange,
  viewerName,
  welcomeTemplateHref,
  envDownloadUrl,
}: {
  row: WhatsAppSettingsRow
  lastChange: LastChange
  viewerName: string
  welcomeTemplateHref: string
  envDownloadUrl: string | null
}) {
  const defaults: WhatsAppSettingsInput = {
    updated_at: row.updated_at,
    whatsapp_country_code: row.whatsapp_country_code,
    whatsapp_group_name_format: row.whatsapp_group_name_format,
    whatsapp_signature: row.whatsapp_signature,
    whatsapp_client_mode: row.whatsapp_client_mode,
    whatsapp_employee_notifications: row.whatsapp_employee_notifications,
    whatsapp_employee_browser_window: row.whatsapp_employee_browser_window,
    whatsapp_linked_device_limit: String(row.whatsapp_linked_device_limit),
    desktop_download_url: row.desktop_download_url ?? "",
    whatsapp_house_rules: row.whatsapp_house_rules ?? "",
  }
  const f = useSettingsForm(WhatsAppSettingsSchema, saveWhatsAppSettings, defaults, {
    savedMessage: "WhatsApp settings saved",
    onSaved: () => {
      void getDesktopBridge()
        ?.refreshContext()
        .catch(() => undefined)
    },
  })
  const v = useWatch({ control: f.control }) as Partial<WhatsAppSettingsInput>
  const format = String(v.whatsapp_group_name_format ?? "")
  const formatCheck = validateGroupNameFormat(format)
  const example = formatCheck.ok ? renderGroupName(format, SAMPLE) : null
  const first = firstNameOf(viewerName) || "Ravi"
  const signed = applySignature("Hi Ramesh, your GSTR-3B for September is filed. The acknowledgement is on the portal.", String(v.whatsapp_signature ?? ""), first)

  return (
    <SettingsForm state={f} lastChange={lastChange} conflict={f.conflict} submitLabel="Save WhatsApp settings">
      <SettingsCard id="names" title="Numbers and names" description="How the app reads phone numbers, names client groups and signs WhatsApp drafts from the shared numbers.">
        <TextField
          control={f.control}
          name="whatsapp_country_code"
          label="Default country code"
          required
          inputMode="numeric"
          maxLength={5}
          helper="Added to 10-digit mobile numbers typed without one (91 for India)."
        />
        <div className="hidden md:block" aria-hidden="true" />
        <TextField
          control={f.control}
          name="whatsapp_group_name_format"
          label="Group name format"
          required
          maxLength={80}
          helper="Placeholders: {client_code} (required), {short_name}, {client_name}."
        />
        <SettingPreview wide={false} label="Example">
          {example ? <span className="font-mono text-[13px] [overflow-wrap:anywhere]">{example}</span> : <span className="text-text-muted">Fix the format to see an example.</span>}
          <span className="mt-1 block text-xs text-text-muted">For {SAMPLE.displayName}, client code {SAMPLE.clientCode}. Existing groups keep their names.</span>
        </SettingPreview>
        <TextField control={f.control} name="whatsapp_signature" label="Signature format" required maxLength={40} helper="Added to WhatsApp drafts on the shared numbers. {first_name} is the sender's first name." />
        <SettingPreview wide={false} label="A draft signed by you">
          <span className="whitespace-pre-line">{signed}</span>
        </SettingPreview>
      </SettingsCard>

      <SettingsCard id="desktop" title="TaxWise Desktop" description="WhatsApp Web inside the CRM, beside the client's page." columns={1}>
        <SwitchField
          control={f.control}
          name="whatsapp_client_mode"
          label="Client mode for Employees"
          description="Employees see only the chat they open from the CRM, for clients they are on or covering. Turn it off only while TaxWise Desktop is being fixed after WhatsApp changed its page: then Employees see the whole Staff office WhatsApp."
        />
        <SwitchField
          control={f.control}
          name="whatsapp_employee_notifications"
          label="Employee notifications"
          description="WhatsApp notifications on Employees' PCs. Off by default, because a notification preview could show another client's message."
        />
        <SwitchField
          control={f.control}
          name="whatsapp_employee_browser_window"
          label="Allow WhatsApp in a browser window for Employees"
          description="Shows Employees the Open chat button outside TaxWise Desktop. Off by default, because client mode can't run in a plain browser."
        />
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
          <SelectField
            control={f.control}
            name="whatsapp_linked_device_limit"
            label="Linked device limit"
            required
            options={[
              { value: "4", label: "4 PCs per number (WhatsApp's limit)" },
              { value: "10", label: "10 PCs per number (Meta Verified multi-agent)" },
            ]}
            helper="Each PC with a number linked in TaxWise Desktop uses one of the number's linked devices."
          />
          <TextField
            control={f.control}
            name="desktop_download_url"
            label="Installer link"
            inputMode="url"
            maxLength={500}
            helper={envDownloadUrl ? `Leave empty to use ${envDownloadUrl}.` : "The latest signed installer, shown as Download TaxWise Desktop."}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        id="house-rules"
        title="House rules"
        description={
          <>
            Shown to staff on every client&apos;s WhatsApp group tab. The welcome message posted in each new group is the{" "}
            <Link href={welcomeTemplateHref} className="font-medium text-primary hover:underline">
              WhatsApp group welcome
            </Link>{" "}
            template.
          </>
        }
        columns={1}
      >
        <Wide>
          <TextareaField control={f.control} name="whatsapp_house_rules" label="House rules" required rows={14} maxLength={8000} />
        </Wide>
      </SettingsCard>
    </SettingsForm>
  )
}
