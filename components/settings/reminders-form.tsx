"use client"

import { useWatch } from "react-hook-form"
import { addDays } from "@/lib/domain/fy"
import { formatDate, formatDateShort } from "@/lib/format"
import { RemindersSchema, type RemindersInput } from "@/lib/schemas/settings"
import { saveReminders } from "@/server/actions/settings"
import type { FirmSettingsRow, LastChange } from "@/lib/data/settings"
import { SwitchField, TextField } from "@/components/app/form/fields"
import { SettingsCard, SettingPreview, Wide } from "@/components/settings/settings-card"
import { SettingsForm, useSettingsForm } from "@/components/settings/settings-form"

function dayList(text: unknown): number[] | null {
  const parts = String(text ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.some((p) => !/^\d+$/.test(p))) return null
  return [...new Set(parts.map(Number))].sort((a, b) => a - b)
}

function whole(text: unknown): number | null {
  const s = String(text ?? "").trim()
  return /^\d+$/.test(s) ? Number(s) : null
}

/**
 * Settings → Reminders (§7.21, §8): how early deadlines are flagged, when invoice and document
 * reminders go out, quotation follow-ups and the Partner digest. Each preview works the schedule
 * out from today, so the Partner sees the dates the jobs will use.
 */
export function RemindersForm({ row, lastChange, today }: { row: FirmSettingsRow; lastChange: LastChange; today: string }) {
  const defaults: RemindersInput = {
    updated_at: row.updated_at,
    compliance_reminder_days: String(row.compliance_reminder_days),
    invoice_reminder_before_days: String(row.invoice_reminder_before_days),
    invoice_reminder_after_days: (row.invoice_reminder_after_days ?? []).join(", "),
    document_request_reminder_every_days: String(row.document_request_reminder_every_days),
    quotation_follow_up_days: (row.quotation_follow_up_days ?? []).join(", "),
    digest_enabled: row.digest_enabled,
  }
  const f = useSettingsForm(RemindersSchema, saveReminders, defaults, { savedMessage: "Reminders saved" })
  const v = useWatch({ control: f.control }) as Partial<RemindersInput>

  const lead = whole(v.compliance_reminder_days)
  const sampleDeadline = addDays(today, 30)
  const due = addDays(today, row.payment_terms_days)
  const before = whole(v.invoice_reminder_before_days)
  const after = dayList(v.invoice_reminder_after_days)
  const every = whole(v.document_request_reminder_every_days)
  const follow = dayList(v.quotation_follow_up_days)

  return (
    <SettingsForm state={f} lastChange={lastChange} conflict={f.conflict} submitLabel="Save reminders">
      <SettingsCard title="Compliance deadlines" description="New compliance events take this lead time; staff are reminded in the app and clients through the reminder queue.">
        <TextField control={f.control} name="compliance_reminder_days" label="Remind this many days before" required inputMode="numeric" />
        <SettingPreview wide={false} label="Example">
          {lead !== null ? (
            <>
              A deadline on <span className="num">{formatDate(sampleDeadline)}</span> is first flagged on <span className="num font-medium">{formatDate(addDays(sampleDeadline, -lead))}</span>.
            </>
          ) : (
            <span className="text-text-muted">Enter the days.</span>
          )}
        </SettingPreview>
      </SettingsCard>

      <SettingsCard title="Invoice reminders" description="Sent to the client for invoices that are still outstanding. Drafts and paid invoices are never chased.">
        <TextField control={f.control} name="invoice_reminder_before_days" label="Before the due date (days)" required inputMode="numeric" helper="0 for none." />
        <TextField control={f.control} name="invoice_reminder_after_days" label="After the due date (days)" required helper="Up to 6, separated by commas, e.g. 1, 7, 15." />
        <SettingPreview label={`An invoice dated today, due ${formatDate(due)} (${row.payment_terms_days}-day terms)`}>
          {before !== null && after ? (
            <span className="num">
              {before > 0 ? <>Reminder on {formatDateShort(addDays(due, -before))} · </> : null}
              {after.length ? <>then {after.map((d) => formatDateShort(addDays(due, d))).join(", ")}</> : "no reminders after the due date"}
            </span>
          ) : (
            <span className="text-text-muted">Enter whole days to see the dates.</span>
          )}
        </SettingPreview>
      </SettingsCard>

      <SettingsCard title="Document requests and quotations" description="How often an open document request is chased, and when a sent quotation gets a follow-up.">
        <TextField control={f.control} name="document_request_reminder_every_days" label="Chase open requests every (days)" required inputMode="numeric" helper="New requests start with this; each can be changed." />
        <TextField control={f.control} name="quotation_follow_up_days" label="Quotation follow-ups (days after sending)" helper="e.g. 3, 7, 14. Leave empty for none." />
        <SettingPreview label="Starting today">
          <ul className="num flex flex-col gap-0.5">
            <li>
              {every !== null && every > 0 ? (
                <>Document request reminders: {[1, 2, 3].map((n) => formatDateShort(addDays(today, every * n))).join(", ")} …</>
              ) : (
                <span className="text-text-muted">Enter the request cadence.</span>
              )}
            </li>
            <li>
              {follow === null ? (
                <span className="text-text-muted">Quotation follow-ups must be whole days.</span>
              ) : follow.length ? (
                <>Quotation follow-ups: {follow.map((d) => formatDateShort(addDays(today, d))).join(", ")}</>
              ) : (
                "No quotation follow-ups."
              )}
            </li>
          </ul>
        </SettingPreview>
      </SettingsCard>

      <SettingsCard title="Partner digest" columns={1}>
        <Wide>
          <SwitchField
            control={f.control}
            name="digest_enabled"
            label="Email Partners a daily digest at 08:00"
            description="Today's deadlines, approvals waiting, overdue receivables and unassigned work. Each Partner can still turn it off in their notification preferences."
          />
        </Wide>
      </SettingsCard>
    </SettingsForm>
  )
}
