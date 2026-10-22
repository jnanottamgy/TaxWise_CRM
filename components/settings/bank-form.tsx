"use client"

import * as React from "react"
import { useWatch } from "react-hook-form"
import { toDataURL } from "qrcode"
import { bankFromIfsc, normaliseIdentifier } from "@/lib/domain/india-validators"
import { isValidUpiId, upiPayUrl } from "@/lib/domain/messaging"
import { BankSchema, type BankInput } from "@/lib/schemas/settings"
import { saveBank } from "@/server/actions/settings"
import type { FirmSettingsRow, LastChange } from "@/lib/data/settings"
import { TextField } from "@/components/app/form/fields"
import { SettingsCard, SettingPreview, Wide } from "@/components/settings/settings-card"
import { SettingsForm, useSettingsForm } from "@/components/settings/settings-form"

/**
 * Settings → Bank & UPI (§7.21): the account printed on invoices and the UPI ID behind the portal's
 * Pay dialog QR code (§7.22). The preview draws the QR the way clients will scan it; the portal adds
 * each invoice's amount and number to it.
 */
export function BankForm({ row, lastChange, sampleInvoiceNumber }: { row: FirmSettingsRow; lastChange: LastChange; sampleInvoiceNumber: string }) {
  const defaults: BankInput = {
    updated_at: row.updated_at,
    bank_name: row.bank_name ?? "",
    bank_account_name: row.bank_account_name ?? "",
    bank_account_number: row.bank_account_number ?? "",
    bank_account_number_confirm: row.bank_account_number ?? "",
    bank_ifsc: row.bank_ifsc ?? "",
    bank_branch: row.bank_branch ?? "",
    upi_id: row.upi_id ?? "",
    upi_payee_name: row.upi_payee_name ?? row.firm_name ?? "",
  }
  const f = useSettingsForm(BankSchema, saveBank, defaults, { savedMessage: "Bank and UPI details saved" })
  const v = useWatch({ control: f.control }) as Partial<BankInput>

  const ifscBank = v.bank_ifsc ? bankFromIfsc(normaliseIdentifier(v.bank_ifsc)) : null
  const fillBankName = () => {
    if (ifscBank && !f.form.getValues("bank_name")) f.form.setValue("bank_name", ifscBank, { shouldDirty: true, shouldValidate: true })
  }

  const upiId = (v.upi_id ?? "").trim()
  const payee = (v.upi_payee_name ?? "").trim()
  const upiOk = upiId !== "" && isValidUpiId(upiId) && payee !== ""
  const link = upiOk ? upiPayUrl({ upiId, payee, note: sampleInvoiceNumber }) : null

  const [qr, setQr] = React.useState<string | null>(null)
  React.useEffect(() => {
    let cancelled = false
    if (!link) return
    toDataURL(link, { errorCorrectionLevel: "M", margin: 1, width: 176 })
      .then((url) => {
        if (!cancelled) setQr(url)
      })
      .catch(() => {
        if (!cancelled) setQr(null)
      })
    return () => {
      cancelled = true
    }
  }, [link])

  const account = (v.bank_account_number ?? "").replace(/[\s-]/g, "")

  return (
    <SettingsForm state={f} lastChange={lastChange} conflict={f.conflict} submitLabel="Save bank details">
      <SettingsCard title="Bank account" description="Printed in the payment section of every invoice and shown in the portal's Pay dialog.">
        <TextField control={f.control} name="bank_account_name" label="Account name" helper="Exactly as the bank has it." />
        <div onBlur={fillBankName} className="min-w-0">
          <TextField
            control={f.control}
            name="bank_ifsc"
            label="IFSC"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={11}
            helper={ifscBank ? `${ifscBank}, from the first four letters.` : "11 characters, e.g. HDFC0001234."}
          />
        </div>
        <TextField control={f.control} name="bank_account_number" label="Account number" inputMode="numeric" autoComplete="off" spellCheck={false} />
        <TextField
          control={f.control}
          name="bank_account_number_confirm"
          label="Account number again"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          helper="Typed twice so a slip doesn't send clients' money elsewhere."
        />
        <TextField control={f.control} name="bank_name" label="Bank" />
        <TextField control={f.control} name="bank_branch" label="Branch" />
        <SettingPreview label="On the invoice">
          {account || v.bank_ifsc ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5">
              <dt className="text-text-muted">Bank</dt>
              <dd className="min-w-0 break-words">{[v.bank_name, v.bank_branch].filter(Boolean).join(", ") || "—"}</dd>
              <dt className="text-text-muted">Account name</dt>
              <dd className="min-w-0 break-words">{v.bank_account_name || "—"}</dd>
              <dt className="text-text-muted">Account no.</dt>
              <dd className="num font-mono">{account || "—"}</dd>
              <dt className="text-text-muted">IFSC</dt>
              <dd className="font-mono">{v.bank_ifsc ? normaliseIdentifier(v.bank_ifsc) : "—"}</dd>
            </dl>
          ) : (
            <span className="text-text-muted">No bank details yet: invoices print without a payment section.</span>
          )}
        </SettingPreview>
      </SettingsCard>

      <SettingsCard title="UPI" description="Clients scan this in the portal's Pay dialog. Paying never marks an invoice paid: only a recorded receipt does.">
        <TextField control={f.control} name="upi_id" label="UPI ID" autoCapitalize="none" spellCheck={false} helper="e.g. taxwise@okhdfcbank" />
        <TextField control={f.control} name="upi_payee_name" label="Payee name" helper="The name the client's UPI app shows before they pay." />
        <Wide>
          <SettingPreview label="Pay dialog QR code" wide={false}>
            {upiOk && qr ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                {/* eslint-disable-next-line @next/next/no-img-element -- generated data: URL */}
                <img src={qr} alt={`UPI QR code for ${payee}`} width={176} height={176} className="size-44 flex-none rounded-md border border-border bg-white p-1" />
                <div className="min-w-0 text-sm">
                  <p>
                    Pays <span className="font-medium">{payee}</span> at <span className="font-mono">{upiId}</span>.
                  </p>
                  <p className="mt-1 text-text-muted">
                    In the portal the code also carries the invoice&apos;s amount and number (here {sampleInvoiceNumber}), so the client doesn&apos;t type them.
                  </p>
                  <p className="mt-2 font-mono text-xs break-all text-text-muted">{link}</p>
                </div>
              </div>
            ) : (
              <span className="text-text-muted">
                {upiId && !isValidUpiId(upiId) ? "That UPI ID doesn't look right yet." : "Enter the UPI ID and payee name to see the code clients will scan."}
              </span>
            )}
          </SettingPreview>
        </Wide>
      </SettingsCard>
    </SettingsForm>
  )
}
