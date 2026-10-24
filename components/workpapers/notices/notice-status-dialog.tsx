"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useController, useWatch } from "react-hook-form"
import { toast } from "sonner"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, TextareaField } from "@/components/app/form/fields"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Button } from "@/components/ui/button"
import { useActionForm } from "@/hooks/use-action-form"
import { cn } from "@/lib/utils"
import { formatDate } from "@/lib/format"
import { getStatus } from "@/lib/status"
import type { NoticeStatus } from "@/lib/domain/enums"
import type { AppealForum, LimitationPeriod } from "@/lib/domain/escalation"
import {
  APPEAL_FORUM_LABEL,
  NoticeStatusSchema,
  appealForumsFor,
  isClosed,
  limitationPeriodText,
  limitationPreview,
  needsAppealDecision,
  noticeMoves,
  splitHearing,
  type NoticeAppealForum,
  type NoticeStatusInput,
  type TaxArea,
} from "@/lib/schemas/notices"
import { setNoticeStatus } from "@/server/actions/notices"
import { NativeSelectField, TimeField } from "@/components/workpapers/notices/fields"

export type StatusDialogNotice = {
  id: string
  updatedAt: string
  status: NoticeStatus
  taxArea: TaxArea | null
  hearingDate: string | null
  noticeDate: string | null
  orderDate: string | null
  appealDecision: "appeal" | "no_appeal" | null
  appealForum: NoticeAppealForum | null
  limitationDate: string | null
  limitationManual: boolean
  appealNote: string | null
}

/**
 * Change a notice's status (§3.6, §7.8.4): the next step with what it needs (when the reply went
 * in, the hearing's date and time, the order date), and, closing against the client, whether they
 * will appeal: the forum and the limitation date worked out from the Law & rules periods (or
 * entered by hand when the order was served late, or for another forum), or the reason for not
 * appealing. The database checks it all again and creates the appeal task.
 */
export function NoticeStatusDialog({
  notice,
  role,
  initialStatus,
  appealPeriods,
  periodsUnverified,
  today,
  onClose,
}: {
  notice: StatusDialogNotice
  role: "partner" | "manager" | "employee"
  initialStatus?: NoticeStatus
  appealPeriods: Record<AppealForum, LimitationPeriod>
  periodsUnverified: boolean
  today: string
  onClose: () => void
}) {
  const router = useRouter()
  const moves = noticeMoves(notice.status, role)
  const start = initialStatus && moves.includes(initialStatus) ? initialStatus : (moves[0] ?? notice.status)
  const hearing = splitHearing(notice.hearingDate)
  const defaults: NoticeStatusInput = {
    id: notice.id,
    updatedAt: notice.updatedAt,
    status: start,
    from_status: notice.status,
    note: "",
    replied_on: today,
    hearing_date: hearing.date,
    hearing_time: hearing.time,
    order_date: notice.orderDate ?? "",
    appeal_decision: notice.appealDecision ?? "",
    appeal_forum: notice.appealForum ?? "",
    limitation_date: notice.limitationManual || notice.appealForum === "other" ? (notice.limitationDate ?? "") : "",
    appeal_note: notice.appealNote ?? "",
  }
  const f = useActionForm(NoticeStatusSchema, setNoticeStatus, {
    defaultValues: defaults,
    onSuccess: (r) => {
      onClose()
      if (r.taskCreated && r.appealTaskId) {
        toast.success("Status changed. An appeal task was created.", {
          action: { label: "Open task", onClick: () => router.push(`/work/${r.appealTaskId}`) },
        })
      } else toast.success("Status changed.")
      router.refresh()
    },
  })
  const { control, setValue } = f.form
  const to = useWatch({ control, name: "status" }) as NoticeStatus
  const decision = useWatch({ control, name: "appeal_decision" }) as string
  const forum = useWatch({ control, name: "appeal_forum" }) as string
  const orderDate = useWatch({ control, name: "order_date" }) as string
  const manualDate = useWatch({ control, name: "limitation_date" }) as string
  const [byHand, setByHand] = React.useState(Boolean(notice.limitationManual && notice.limitationDate))
  const computed = limitationPreview((forum || null) as NoticeAppealForum | null, orderDate, appealPeriods)
  const reopening = isClosed(notice.status) && !isClosed(to)
  const updatingAppeal = to === notice.status

  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="md"
      title={updatingAppeal ? "Update the appeal" : "Change status"}
      description={`Now: ${getStatus("notice_status", notice.status).label}`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={updatingAppeal ? "Save appeal details" : reopening ? "Reopen notice" : "Change status"}
    >
      <FormAlert state={f} />
      {moves.length === 0 ? (
        <p className="text-base text-text-muted">This notice is closed. A Manager or Partner can reopen it.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <StatusPicker control={control} moves={moves} current={notice.status} />

          {to === "replied" ? <DateField control={control} name="replied_on" label="Replied on" required max={today} /> : null}
          {to === "hearing" ? (
            <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
              <DateField control={control} name="hearing_date" label="Hearing date" required />
              <TimeField control={control} name="hearing_time" label="Time" />
            </div>
          ) : null}
          {isClosed(to) ? <DateField control={control} name="order_date" label="Date of the order" required={needsAppealDecision(to)} max={today} min={notice.noticeDate ?? undefined} /> : null}

          {needsAppealDecision(to) ? (
            <fieldset className="flex flex-col gap-3 rounded-md border border-border px-4 pt-3 pb-4">
              <legend className="px-1 text-sm font-medium text-text">Appeal</legend>
              <DecisionPicker control={control} />
              {decision === "appeal" ? (
                <>
                  <NativeSelectField
                    control={control}
                    name="appeal_forum"
                    label="Forum"
                    required
                    emptyLabel="Choose…"
                    options={appealForumsFor(notice.taxArea).map((x) => ({ value: x, label: APPEAL_FORUM_LABEL[x] }))}
                    onValueChange={(v) => {
                      if (v === "other") setByHand(true)
                    }}
                  />
                  {forum && forum !== "other" && !byHand ? (
                    <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
                      <p className="text-sm text-text-muted">Last day to appeal</p>
                      <p className="num text-base font-medium text-text">{computed ? formatDate(computed) : "Enter the order date"}</p>
                      <p className="text-xs text-text-muted">
                        {limitationPeriodText(appealPeriods[forum as AppealForum])} from the order, per the Law &amp; rules page
                        {periodsUnverified ? " (awaiting a Partner's confirmation)" : ""}.
                      </p>
                      <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => setByHand(true)}>
                        The order was served later: enter the date by hand
                      </Button>
                    </div>
                  ) : null}
                  {forum && (forum === "other" || byHand) ? (
                    <DateField
                      control={control}
                      name="limitation_date"
                      label="Last day to appeal"
                      required
                      min={orderDate || undefined}
                      helper={
                        forum === "other" ? (
                          "No period is recorded for another forum; enter the last day."
                        ) : (
                          <>
                            Worked out: {computed ? formatDate(computed) : "—"}.{" "}
                            <button
                              type="button"
                              className="font-medium text-text underline-offset-4 hover:underline"
                              onClick={() => {
                                setByHand(false)
                                setValue("limitation_date", "", { shouldDirty: true })
                              }}
                            >
                              Use that date
                            </button>
                          </>
                        )
                      }
                    />
                  ) : null}
                  {manualDate && forum !== "other" && byHand && computed && manualDate !== computed ? (
                    <p className="text-sm text-warning-text">The date differs from the period on the Law &amp; rules page; the log records that it was entered by hand.</p>
                  ) : null}
                  <p className="text-sm text-text-muted">An appeal task is created with the limitation date as its due date, for the person the notice is assigned to.</p>
                </>
              ) : decision === "no_appeal" ? (
                <TextareaField control={control} name="appeal_note" label="Why no appeal?" required rows={2} placeholder="For example: demand accepted and paid on 12 Nov 2026." />
              ) : null}
            </fieldset>
          ) : null}

          <TextareaField
            control={control}
            name="note"
            label={reopening ? "Why is it reopened?" : "Note for the log"}
            required={reopening}
            rows={2}
            placeholder={reopening ? "For example: the order was set aside and remanded." : "Optional: what happened."}
          />
        </div>
      )}
    </FormDialog>
  )
}

function StatusPicker({ control, moves, current }: { control: unknown; moves: NoticeStatus[]; current: NoticeStatus }) {
  const { field } = useController({ control: control as never, name: "status" as never })
  const id = React.useId()
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium text-text">New status</legend>
      <RadioGroup value={field.value as string} onValueChange={(v) => field.onChange(v)} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {moves.map((s) => {
          const info = getStatus("notice_status", s)
          return (
            <label
              key={s}
              htmlFor={`${id}-${s}`}
              className={cn("flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 text-base has-[[data-state=checked]]:border-primary")}
            >
              <RadioGroupItem id={`${id}-${s}`} value={s} />
              <span>{s === current ? `${info.label}: update the appeal` : info.label}</span>
            </label>
          )
        })}
      </RadioGroup>
    </fieldset>
  )
}

function DecisionPicker({ control }: { control: unknown }) {
  const { field, fieldState } = useController({ control: control as never, name: "appeal_decision" as never })
  const id = React.useId()
  return (
    <div>
      <RadioGroup value={(field.value as string) ?? ""} onValueChange={(v) => field.onChange(v)} className="flex flex-wrap gap-x-6 gap-y-2" aria-label="Will the client appeal?">
        {[
          { value: "appeal", label: "The client will appeal" },
          { value: "no_appeal", label: "No appeal" },
        ].map((o) => (
          <label key={o.value} htmlFor={`${id}-${o.value}`} className="flex min-h-11 cursor-pointer items-center gap-2 text-base">
            <RadioGroupItem id={`${id}-${o.value}`} value={o.value} />
            {o.label}
          </label>
        ))}
      </RadioGroup>
      {fieldState.error ? <p className="mt-1 text-sm text-danger-text">{fieldState.error.message}</p> : null}
    </div>
  )
}

/** A link to the appeal task, for the notice page. */
export function AppealTaskLink({ id, number }: { id: string; number: string | null }) {
  return (
    <Link href={`/work/${id}`} className="font-medium text-text underline-offset-4 hover:underline">
      {number ?? "Appeal task"}
    </Link>
  )
}
