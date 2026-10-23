"use client"

import * as React from "react"
import { ArrowLeftIcon, CheckIcon, CircleAlertIcon, CircleDashedIcon, ExternalLinkIcon, MessageCircleIcon, RotateCwIcon, SkipForwardIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { FormDialog } from "@/components/app/form-dialog"
import { NO_WHATSAPP_NUMBER_MESSAGE, formatWhatsAppNumber, waMeUrl } from "@/lib/domain/messaging"
import { formatNumber } from "@/lib/format"
import type { QueueSkip, QueueStep } from "@/lib/schemas/inbox"
import { logHandoff } from "@/server/actions/messages"
import { currentItem, initQueue, isQueueDone, queueProgressLabel, queueReducer, queueTally, type StepStatus } from "@/components/bulk-queue/queue-state"

/**
 * BulkWhatsAppQueue (§7.13.2 bulk reminders): steps through personalised drafts one client at a
 * time: "Open WhatsApp" opens the chat with the draft, the person presses Send in WhatsApp, then
 * "Mark handed off" logs it (`whatsapp_handoff / handed_off`, never "delivered") and moves to the
 * next. Nothing is sent by the app. A draft can be edited before opening; a client with no WhatsApp
 * number can only be skipped. Closing with a chat opened but not marked asks first.
 *
 *   <BulkWhatsAppQueue open={open} onOpenChange={setOpen} steps={steps} onFinished={() => router.refresh()} />
 */

const STATUS_LABEL: Record<StepStatus, string> = {
  pending: "To do",
  opened: "Opened, not marked",
  logging: "Logging",
  handed_off: "Handed off",
  skipped: "Skipped",
  failed: "Not logged",
}

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === "handed_off") return <CheckIcon aria-hidden="true" className="size-3.5 text-success-text" />
  if (status === "failed") return <CircleAlertIcon aria-hidden="true" className="size-3.5 text-danger-text" />
  if (status === "skipped") return <SkipForwardIcon aria-hidden="true" className="size-3.5 text-text-muted" />
  if (status === "opened" || status === "logging") return <MessageCircleIcon aria-hidden="true" className="size-3.5 text-info-text" />
  return <CircleDashedIcon aria-hidden="true" className="size-3.5 text-text-muted" />
}

export function BulkWhatsAppQueue({
  open,
  onOpenChange,
  steps,
  title = "WhatsApp reminders",
  skipped = [],
  truncated = false,
  templates,
  templateId = "",
  onTemplateChange,
  preparing = false,
  onFinished,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  steps: QueueStep[]
  title?: string
  /** Records left out of the queue, and why (a client on hold). */
  skipped?: QueueSkip[]
  /** More matched than one queue holds. */
  truncated?: boolean
  /** Templates the drafts can be rebuilt from (before anything is handed off). */
  templates?: Array<{ id: string; name: string }>
  templateId?: string
  onTemplateChange?: (templateId: string) => void
  preparing?: boolean
  /** After the dialog closes with at least one hand-off logged (refresh the page's history). */
  onFinished?: () => void
}) {
  const [state, dispatch] = React.useReducer(queueReducer, steps, initQueue)
  const [shownSteps, setShownSteps] = React.useState(steps)
  if (shownSteps !== steps) {
    setShownSteps(steps)
    dispatch({ type: "reset", steps })
  }
  const tally = queueTally(state)
  const done = isQueueDone(state)
  const item = currentItem(state)
  const draftId = React.useId()
  const tplId = React.useId()

  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next && tally.handedOff > 0) onFinished?.()
  }

  const openChat = () => {
    if (!item?.step.number) return
    window.open(waMeUrl(item.step.number, item.draft), "_blank", "noopener,noreferrer")
    dispatch({ type: "opened" })
  }

  const markHandedOff = async () => {
    if (!item?.step.number) return
    dispatch({ type: "logging" })
    try {
      const r = await logHandoff({
        clientId: item.step.clientId,
        contactId: item.step.contactId,
        channel: "whatsapp_handoff",
        recipient: item.step.number,
        body: item.draft,
        templateId: item.step.templateId,
        related: item.step.related,
      })
      if (!r.ok) dispatch({ type: "log_failed", error: r.ref ? `${r.error} (Ref ${r.ref})` : r.error })
      else dispatch({ type: "logged" })
    } catch {
      dispatch({ type: "log_failed", error: "We couldn't reach the server. Check your connection and try again." })
    }
  }

  const progress = tally.total ? Math.round(((tally.handedOff + tally.skipped) / tally.total) * 100) : 0
  const canRebuild = Boolean(onTemplateChange && templates && tally.handedOff === 0 && tally.opened === 0)

  const footer = done ? (
    <div className="ml-auto flex items-center gap-2">
      <Button type="button" onClick={() => close(false)}>
        Done
      </Button>
    </div>
  ) : (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={() => dispatch({ type: "back" })} disabled={state.index === 0 || item?.status === "logging"}>
        <ArrowLeftIcon aria-hidden="true" />
        Back
      </Button>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={() => dispatch({ type: "skip" })} disabled={item?.status === "logging"}>
          <SkipForwardIcon aria-hidden="true" />
          Skip
        </Button>
        {item?.status === "opened" || item?.status === "failed" || item?.status === "logging" ? (
          <>
            <Button type="button" variant="ghost" onClick={openChat} disabled={item.status === "logging"}>
              <RotateCwIcon aria-hidden="true" />
              Open again
            </Button>
            <Button type="button" onClick={() => void markHandedOff()} disabled={item.status === "logging"}>
              {item.status === "logging" ? <Spinner /> : <CheckIcon aria-hidden="true" />}
              {item.status === "failed" ? "Try logging again" : "Mark handed off, next"}
            </Button>
          </>
        ) : item?.status === "handed_off" ? null : (
          <Button type="button" variant="whatsapp" onClick={openChat} disabled={!item?.step.number || !item.draft.trim()}>
            <ExternalLinkIcon aria-hidden="true" />
            Open WhatsApp
          </Button>
        )}
      </div>
    </div>
  )

  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      size="lg"
      title={title}
      description={tally.total ? queueProgressLabel(state) : "Nothing to remind about."}
      dirty={tally.opened > 0}
      footer={
        tally.total ? (
          footer
        ) : (
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Close
            </Button>
          </div>
        )
      }
    >
      {preparing ? (
        <div className="flex items-center gap-2 py-10 text-base text-text-muted">
          <Spinner />
          Preparing the drafts…
        </div>
      ) : tally.total === 0 ? (
        <div className="flex flex-col gap-3 py-6">
          <p className="text-base text-text">No reminders to send for this list.</p>
          {skipped.length ? <SkippedList skipped={skipped} /> : <p className="text-sm text-text-muted">Nothing matched: no client in it is waiting on anything.</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <Progress value={progress} aria-label={`${progress}% done`} />
          {canRebuild ? (
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
              <label htmlFor={tplId} className="text-sm font-medium text-text">
                Message
              </label>
              <NativeSelect id={tplId} value={templateId} onChange={(e) => onTemplateChange?.(e.target.value)} className="w-full sm:w-80">
                <NativeSelectOption value="">Suggested message</NativeSelectOption>
                {templates!.map((t) => (
                  <NativeSelectOption key={t.id} value={t.id}>
                    {t.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          ) : null}

          {done ? (
            <div className="flex flex-col gap-3">
              <p className="text-base text-text">
                {formatNumber(tally.handedOff)} handed off{tally.skipped ? `, ${formatNumber(tally.skipped)} skipped` : ""}
                {tally.failed ? `, ${formatNumber(tally.failed)} not logged` : ""}. Each hand-off is on the client&apos;s Communication tab.
              </p>
              {tally.failed ? <p className="text-sm text-danger-text">Some hand-offs weren&apos;t logged. Open them from the list below and try again, or note them on the client&apos;s Communication tab.</p> : null}
            </div>
          ) : item ? (
            <div className="flex flex-col gap-3">
              <div>
                <p className="text-md leading-6 font-semibold text-text">{item.step.clientName}</p>
                <p className="text-sm text-text-muted">{item.step.label}</p>
              </div>
              <dl className="grid grid-cols-[4.5rem_1fr] gap-y-1 text-base">
                <dt className="text-sm text-text-muted">To</dt>
                <dd className="min-w-0 text-text">{item.step.contactName ?? item.step.clientName}</dd>
                <dt className="text-sm text-text-muted">Number</dt>
                <dd className={cn("num tabular-nums", item.step.number ? "text-text" : "text-danger-text")}>{item.step.number ? formatWhatsAppNumber(item.step.number) : NO_WHATSAPP_NUMBER_MESSAGE}</dd>
              </dl>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={draftId} className="text-sm font-medium text-text">
                  Draft
                </label>
                <Textarea id={draftId} value={item.draft} onChange={(e) => dispatch({ type: "edit", draft: e.target.value })} rows={8} className="min-h-40" disabled={item.status === "handed_off" || item.status === "logging"} />
                <p className="text-sm text-text-muted">
                  {item.status === "opened"
                    ? "WhatsApp is open with this draft. Press Send there, then mark it handed off here."
                    : item.status === "failed"
                      ? `The hand-off wasn't logged: ${item.error ?? "try again."}`
                      : item.status === "handed_off"
                        ? "Handed off and logged."
                        : "Nothing is sent until you press Send in WhatsApp."}
                </p>
              </div>
            </div>
          ) : null}

          <details className="group rounded-md border border-border">
            <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-text outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              Everyone in this queue
              <span className="num text-xs font-normal text-text-muted tabular-nums">
                {formatNumber(tally.remaining)} still to do
              </span>
            </summary>
            <ol className="max-h-64 overflow-y-auto border-t border-border">
              {state.items.map((it, i) => (
                <li key={it.step.key}>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "goto", index: i })}
                    aria-current={i === state.index ? "step" : undefined}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm outline-none hover:bg-surface-2 focus-visible:bg-surface-2",
                      i === state.index && "bg-primary-soft",
                    )}
                  >
                    <StatusIcon status={it.status} />
                    <span className="min-w-0 flex-1 truncate text-text">{it.step.clientName}</span>
                    <span className="min-w-0 truncate text-text-muted max-sm:hidden">{it.step.label}</span>
                    <span className="flex-none text-xs text-text-muted">{STATUS_LABEL[it.status]}</span>
                  </button>
                </li>
              ))}
            </ol>
          </details>
          {skipped.length ? <SkippedList skipped={skipped} /> : null}
          {truncated ? <p className="text-sm text-text-muted">More records matched than one queue holds. Work through these, then build the queue again for the rest.</p> : null}
        </div>
      )}
    </FormDialog>
  )
}

function SkippedList({ skipped }: { skipped: QueueSkip[] }) {
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-2">
      <p className="text-sm font-medium text-text">Left out ({formatNumber(skipped.length)})</p>
      <ul className="mt-1 flex flex-col gap-0.5 text-sm text-text-muted">
        {skipped.slice(0, 20).map((s, i) => (
          <li key={`${s.clientName}-${i}`}>
            {s.clientName} · {s.label}: {s.reason}
          </li>
        ))}
        {skipped.length > 20 ? <li>and {formatNumber(skipped.length - 20)} more</li> : null}
      </ul>
    </div>
  )
}
