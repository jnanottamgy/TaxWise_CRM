"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { MessageSquareTextIcon, PlusIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDate, formatDateTime } from "@/lib/format"
import { formatINR, type Paise } from "@/lib/domain/money"
import { reminderSlotLabel } from "@/lib/domain/collections"
import { FOLLOW_UP_CHANNEL_LABEL } from "@/lib/schemas/collections"
import type { FollowUpRow, ReminderRow } from "@/lib/data/collections"
import { completeReminderHandoff, dismissReminder } from "@/server/actions/collections"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState } from "@/components/app/empty-state"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { WhatsAppButton, type MessageTemplateOption, type WhatsAppAttachment } from "@/components/app/messaging/whatsapp-button"
import { PromiseChip, ReminderChip, reminderLine } from "@/components/collections/ui"
import { FollowUpDialog } from "@/components/collections/follow-up-dialog"

/**
 * The inside of the invoice's Collections panel (§7.9.5): Log follow-up, the latest promise, the
 * payment reminders waiting to be sent (Send on WhatsApp with the reminder filled in and the
 * invoice PDF, or "Not needed" with a reason), the follow-up log, and the reminders that went.
 * Plain data in; the server renders it.
 */

export type PendingReminderView = {
  id: string
  key: string | null
  reason: string | null
  ownerName: string | null
  createdAt: string
  contactId: string | null
  contactName: string
  whatsappNumber: string | null
  whatsappTemplateId: string | null
  whatsappDraft: string
  /** The firm's payment-reminder templates, filled in for this reminder. */
  templates: MessageTemplateOption[]
}

export function FollowUpPanelBody(props: {
  invoiceId: string
  invoiceNumber: string | null
  canLog: boolean
  clientOnHold: boolean
  disputed: boolean
  today: string
  promise: { date: string; promisedPaise: Paise; status: "kept" | "missed" | "open"; settledSincePaise: Paise } | null
  nextFollowUp: string | null
  followUps: FollowUpRow[]
  reminders: ReminderRow[]
  pending: PendingReminderView[]
  /** The invoice PDF, downloaded as WhatsApp opens. */
  attachment?: WhatsAppAttachment
}) {
  const { invoiceId, canLog, promise, nextFollowUp, followUps, reminders, pending } = props
  const [open, setOpen] = React.useState(false)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1 text-sm">
          {promise ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-text">
              <PromiseChip status={promise.status} />
              <span>
                {formatINR(promise.promisedPaise)} promised for <span className="num">{formatDate(promise.date)}</span>
                {promise.settledSincePaise > 0 ? <span className="text-text-muted"> · {formatINR(promise.settledSincePaise)} received since</span> : null}
              </span>
            </p>
          ) : (
            <p className="text-text-muted">No payment date promised yet.</p>
          )}
          {nextFollowUp ? (
            <p className="text-text-muted">
              Next follow-up <span className="num text-text">{formatDate(nextFollowUp)}</span>
            </p>
          ) : null}
          {props.clientOnHold ? <p className="text-warning-text">The client is on hold, so reminders are paused.</p> : null}
          {props.disputed ? <p className="text-violet-text">The invoice is disputed, so reminders are paused.</p> : null}
        </div>
        {canLog ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            <PlusIcon aria-hidden="true" />
            Log follow-up
          </Button>
        ) : null}
      </div>

      {pending.length ? (
        <ul className="flex flex-col gap-2" aria-label="Reminders to send on WhatsApp">
          {pending.map((p) => (
            <PendingReminder key={p.id} p={p} invoiceNumber={props.invoiceNumber} attachment={props.attachment} />
          ))}
        </ul>
      ) : null}

      <div>
        <h3 className="mb-2 text-sm font-medium text-text">Follow-up log</h3>
        {followUps.length ? (
          <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
            {followUps.map((f) => (
              <li key={f.id} className="flex flex-col gap-1 px-3 py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span className="font-medium text-text">
                    {FOLLOW_UP_CHANNEL_LABEL[f.channel] ?? f.channel}
                    {f.byName ? <span className="font-normal text-text-muted"> · {f.byName}</span> : null}
                  </span>
                  <span className="num text-text-muted tabular-nums">{formatDateTime(f.createdAt)}</span>
                </div>
                <p className="text-base whitespace-pre-line text-text">{f.notes}</p>
                {f.promisedPaymentDate || f.nextFollowUpAt ? (
                  <p className="text-sm text-text-muted">
                    {f.promisedPaymentDate ? (
                      <>
                        Promised to pay by <span className="num text-text">{formatDate(f.promisedPaymentDate)}</span>
                      </>
                    ) : null}
                    {f.promisedPaymentDate && f.nextFollowUpAt ? " · " : null}
                    {f.nextFollowUpAt ? (
                      <>
                        Follow up on <span className="num text-text">{formatDate(f.nextFollowUpAt)}</span>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState
            size="compact"
            icon={<MessageSquareTextIcon />}
            message={canLog ? "No follow-ups yet. Log a call, a WhatsApp chat or a visit to record what the client said." : "No follow-ups were logged."}
          />
        )}
      </div>

      {reminders.length ? (
        <div>
          <h3 className="mb-2 text-sm font-medium text-text">Reminders</h3>
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {reminders.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className="min-w-0 text-text">
                  {reminderLine(r.reminderKey, r.channel)}
                  {r.recipient ? <span className="text-text-muted"> · {r.recipient}</span> : null}
                  {r.status === "dismissed" && r.dismissReason ? <span className="block text-text-muted">{r.dismissReason}</span> : null}
                </span>
                <span className="flex flex-none items-center gap-3">
                  <ReminderChip status={r.status} />
                  <span className="num text-text-muted tabular-nums">{formatDate(r.sentAt ?? r.handedOffAt ?? r.dismissedAt ?? r.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canLog ? <FollowUpDialog open={open} onOpenChange={setOpen} invoiceId={invoiceId} invoiceNumber={props.invoiceNumber} today={props.today} /> : null}
    </div>
  )
}

function PendingReminder({ p, invoiceNumber, attachment }: { p: PendingReminderView; invoiceNumber: string | null; attachment?: WhatsAppAttachment }) {
  const router = useRouter()
  const [dismissing, setDismissing] = React.useState(false)
  const [reason, setReason] = React.useState("")
  const [reasonError, setReasonError] = React.useState<string | null>(null)
  const reasonId = React.useId()

  const handedOff = async (recipient: string, body: string, templateId: string | null) => {
    const r = await completeReminderHandoff({ reminderId: p.id, channel: "whatsapp_handoff", contactId: p.contactId, recipient, body, templateId })
    if (!r.ok) throw new Error(r.error)
    router.refresh()
  }

  return (
    <li className={cn("flex flex-col gap-2 rounded-md border border-warning/40 bg-warning-soft/40 px-3 py-2.5")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-medium text-text">Payment reminder to send: {reminderSlotLabel(p.key).toLowerCase()}</p>
        <ReminderChip status="handoff_pending" />
      </div>
      {p.reason ? <p className="text-sm text-text-muted">{p.reason}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <WhatsAppButton
          recipientName={p.contactName}
          number={p.whatsappNumber}
          draft={p.whatsappDraft}
          templates={p.templates}
          attachment={attachment}
          label="Send on WhatsApp"
          variant="outline"
          onHandedOff={({ number, text, templateId }) => handedOff(number, text, templateId ?? p.whatsappTemplateId)}
        />
        <Button type="button" variant="ghost" size="sm" onClick={() => setDismissing(true)}>
          Not needed
        </Button>
      </div>
      <ConfirmDialog
        open={dismissing}
        onOpenChange={(o) => {
          setDismissing(o)
          if (!o) {
            setReason("")
            setReasonError(null)
          }
        }}
        title="Don't send this reminder?"
        description={`The reminder for invoice ${invoiceNumber ?? ""} is marked not sent, with your reason. The next one still goes on its day.`}
        confirmLabel="Don't send it"
        details={
          <div className="flex flex-col gap-1.5">
            <label htmlFor={reasonId} className="text-sm font-medium text-text">
              Why not? <span className="text-danger-text">*</span>
            </label>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={500}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={reasonError ? `${reasonId}-error` : undefined}
              placeholder="Spoke to the accountant on the phone; paying on Friday"
            />
            {reasonError ? (
              <p id={`${reasonId}-error`} className="text-sm text-danger-text">
                {reasonError}
              </p>
            ) : null}
          </div>
        }
        onConfirm={async () => {
          if (!reason.trim()) {
            setReasonError("Say why this reminder isn't needed.")
            return false
          }
          const r = await dismissReminder({ reminderId: p.id, reason })
          if (!r.ok) {
            setReasonError(r.fieldErrors?.reason?.[0] ?? r.error)
            return false
          }
          toast.success("Reminder marked not sent.")
          router.refresh()
        }}
      />
    </li>
  )
}
