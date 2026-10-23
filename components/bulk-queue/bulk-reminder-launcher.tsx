"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { MessageCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Explain } from "@/components/app/explain"
import type { BulkSource, QueueSkip, QueueStep } from "@/lib/schemas/inbox"
import { prepareBulkQueue } from "@/server/actions/bulk-queue"
import { BulkWhatsAppQueue } from "@/components/bulk-queue/bulk-whatsapp-queue"
import { toastResult } from "@/components/comms/comms-ui"

/**
 * The launcher other screens use for bulk WhatsApp reminders (§7.13.2): give it the filtered list
 * (task ids from a Data awaited list, compliance event ids, document request ids, or one of the
 * built-in filters) and it builds the personalised drafts on the server (under the person's RLS)
 * and opens the queue. Nothing is sent by the app; each hand-off is logged as the person marks it.
 *
 *   <BulkReminderLauncher source={{ kind: "tasks", ids: dataAwaitedTaskIds }} label="Remind all on WhatsApp" />
 *   <BulkReminderLauncher source={{ kind: "compliance_events", ids }} templates={whatsappTemplates} />
 */
export function BulkReminderLauncher({
  source,
  label = "Remind on WhatsApp",
  templates,
  title,
  size = "sm",
  variant = "outline",
  disabled = false,
  disabledReason = "Nothing in this list to remind about.",
  className,
}: {
  source: BulkSource
  label?: string
  /** WhatsApp templates the person may switch the drafts to (non-money). */
  templates?: Array<{ id: string; name: string }>
  title?: string
  size?: "sm" | "default"
  variant?: "outline" | "default" | "whatsapp"
  disabled?: boolean
  disabledReason?: string
  className?: string
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [preparing, setPreparing] = React.useState(false)
  const [templateId, setTemplateId] = React.useState("")
  const [queue, setQueue] = React.useState<{ steps: QueueStep[]; skipped: QueueSkip[]; truncated: boolean }>({ steps: [], skipped: [], truncated: false })

  const prepare = async (tpl: string) => {
    setPreparing(true)
    try {
      const r = await prepareBulkQueue({ source, templateId: tpl || null })
      if (toastResult(r)) setQueue({ steps: r.data.steps, skipped: r.data.skipped, truncated: r.data.truncated })
      else setOpen(false)
    } catch {
      toastResult({ ok: false, error: "We couldn't reach the server. Check your connection and try again." })
      setOpen(false)
    } finally {
      setPreparing(false)
    }
  }

  const button = (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (disabled) return
        setOpen(true)
        void prepare(templateId)
      }}
    >
      <MessageCircleIcon aria-hidden="true" className={variant === "outline" ? "text-success-text" : undefined} />
      {label}
    </Button>
  )

  return (
    <>
      {disabled ? <Explain content={<p>{disabledReason}</p>}>{button}</Explain> : button}
      {open ? (
        <BulkWhatsAppQueue
          open={open}
          onOpenChange={setOpen}
          title={title}
          steps={queue.steps}
          skipped={queue.skipped}
          truncated={queue.truncated}
          preparing={preparing}
          templates={templates}
          templateId={templateId}
          onTemplateChange={
            templates?.length
              ? (id) => {
                  setTemplateId(id)
                  void prepare(id)
                }
              : undefined
          }
          onFinished={() => router.refresh()}
        />
      ) : null}
    </>
  )
}
