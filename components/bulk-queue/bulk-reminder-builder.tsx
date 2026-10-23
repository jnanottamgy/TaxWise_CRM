"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ListChecksIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { FormDialog } from "@/components/app/form-dialog"
import { COMPLIANCE_TYPES, COMPLIANCE_TYPE_LABELS, SERVICE_TYPES, SERVICE_TYPE_LABELS, type ComplianceType, type ServiceType } from "@/lib/domain/enums"
import { BULK_SOURCE_KINDS, BULK_SOURCE_LABELS, COMPLIANCE_WINDOWS, type BulkSource, type BulkSourceKind, type QueueSkip, type QueueStep } from "@/lib/schemas/inbox"
import { prepareBulkQueue } from "@/server/actions/bulk-queue"
import { BulkWhatsAppQueue } from "@/components/bulk-queue/bulk-whatsapp-queue"
import { toastResult } from "@/components/comms/comms-ui"

/**
 * "Bulk reminders" (§7.13.2): pick a filtered list (all clients with data awaited, say, for GST),
 * pick the message, and the app builds a queue of personalised drafts to step through on WhatsApp.
 * Nothing is sent by the app. Employees build queues for their own clients only (RLS).
 */

export type BuilderTemplate = { id: string; name: string; type: string }

export function BulkReminderBuilder({ templates, canFilterMine }: { templates: BuilderTemplate[]; canFilterMine: boolean }) {
  const router = useRouter()
  const ids = React.useId()
  const [open, setOpen] = React.useState(false)
  const [kind, setKind] = React.useState<BulkSourceKind>("data_awaited")
  const [service, setService] = React.useState<ServiceType | "">("")
  const [complianceType, setComplianceType] = React.useState<ComplianceType | "">("")
  const [withinDays, setWithinDays] = React.useState<number>(7)
  const [mine, setMine] = React.useState(false)
  const [templateId, setTemplateId] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [queueOpen, setQueueOpen] = React.useState(false)
  const [queue, setQueue] = React.useState<{ steps: QueueStep[]; skipped: QueueSkip[]; truncated: boolean } | null>(null)

  const wanted = BULK_SOURCE_LABELS[kind].templateType
  const fitting = templates.filter((t) => t.type === wanted || t.type === "custom")

  const source = (): BulkSource =>
    kind === "data_awaited"
      ? { kind, service: service || null, mine }
      : kind === "compliance_due"
        ? { kind, withinDays, complianceType: complianceType || null, mine }
        : { kind, mine }

  const prepare = async (tpl: string): Promise<boolean> => {
    setPending(true)
    try {
      const r = await prepareBulkQueue({ source: source(), templateId: tpl || null })
      if (!toastResult(r)) return false
      setQueue({ steps: r.data.steps, skipped: r.data.skipped, truncated: r.data.truncated })
      return true
    } catch {
      toastResult({ ok: false, error: "We couldn't reach the server. Check your connection and try again." })
      return false
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <ListChecksIcon aria-hidden="true" />
        Bulk reminders
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="Bulk WhatsApp reminders"
        description="Choose who to remind. The app drafts a message for each client; you open WhatsApp and press Send for each one."
        onSubmit={async (e) => {
          e.preventDefault()
          if (await prepare(templateId)) {
            setOpen(false)
            setQueueOpen(true)
          }
        }}
        pending={pending}
        submitLabel="Prepare the drafts"
      >
        <div className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-text">Remind about</legend>
            {BULK_SOURCE_KINDS.map((k) => (
              <label
                key={k}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                  kind === k ? "border-primary/40 bg-primary-soft" : "border-border hover:bg-surface-2",
                )}
              >
                <input
                  type="radio"
                  name={`${ids}-kind`}
                  value={k}
                  checked={kind === k}
                  onChange={() => {
                    setKind(k)
                    setTemplateId("")
                  }}
                  className="mt-1 size-4 accent-[var(--primary)]"
                />
                <span>
                  <span className="block text-base font-medium text-text">{BULK_SOURCE_LABELS[k].label}</span>
                  <span className="block text-sm text-text-muted">{BULK_SOURCE_LABELS[k].hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {kind === "data_awaited" ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${ids}-service`} className="text-sm font-medium text-text">
                  Service
                </label>
                <NativeSelect id={`${ids}-service`} value={service} onChange={(e) => setService(e.target.value as ServiceType | "")} className="w-full">
                  <NativeSelectOption value="">Every service</NativeSelectOption>
                  {SERVICE_TYPES.map((s) => (
                    <NativeSelectOption key={s} value={s}>
                      {SERVICE_TYPE_LABELS[s]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
            {kind === "compliance_due" ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${ids}-type`} className="text-sm font-medium text-text">
                    Return
                  </label>
                  <NativeSelect id={`${ids}-type`} value={complianceType} onChange={(e) => setComplianceType(e.target.value as ComplianceType | "")} className="w-full">
                    <NativeSelectOption value="">Every return and filing</NativeSelectOption>
                    {COMPLIANCE_TYPES.map((c) => (
                      <NativeSelectOption key={c} value={c}>
                        {COMPLIANCE_TYPE_LABELS[c]}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${ids}-days`} className="text-sm font-medium text-text">
                    Due within
                  </label>
                  <NativeSelect id={`${ids}-days`} value={String(withinDays)} onChange={(e) => setWithinDays(Number(e.target.value))} className="w-full">
                    {COMPLIANCE_WINDOWS.map((d) => (
                      <NativeSelectOption key={d} value={String(d)}>
                        The next {d} days
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              </>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${ids}-tpl`} className="text-sm font-medium text-text">
                Message
              </label>
              <NativeSelect id={`${ids}-tpl`} value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="w-full">
                <NativeSelectOption value="">Suggested message</NativeSelectOption>
                {fitting.map((t) => (
                  <NativeSelectOption key={t.id} value={t.id}>
                    {t.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </div>

          {canFilterMine ? (
            <div className="flex items-start justify-between gap-4">
              <label htmlFor={`${ids}-mine`} className="min-w-0 cursor-pointer">
                <span className="block text-base font-medium text-text">{kind === "data_awaited" ? "Only tasks assigned to me" : "Only my clients"}</span>
                <span className="block text-sm text-text-muted">{kind === "data_awaited" ? "Leave off to include everyone's data-awaited tasks." : "Clients you own or are on the team of."}</span>
              </label>
              <Switch id={`${ids}-mine`} checked={mine} onCheckedChange={setMine} />
            </div>
          ) : (
            <p className="text-sm text-text-muted">Your own clients, and clients you are covering.</p>
          )}
          {pending ? (
            <p className="flex items-center gap-2 text-sm text-text-muted">
              <Spinner /> Preparing the drafts…
            </p>
          ) : null}
        </div>
      </FormDialog>

      {queue ? (
        <BulkWhatsAppQueue
          open={queueOpen}
          onOpenChange={setQueueOpen}
          title={`WhatsApp reminders: ${BULK_SOURCE_LABELS[kind].label.toLowerCase()}`}
          steps={queue.steps}
          skipped={queue.skipped}
          truncated={queue.truncated}
          preparing={pending}
          templates={fitting}
          templateId={templateId}
          onTemplateChange={(id) => {
            setTemplateId(id)
            void prepare(id)
          }}
          onFinished={() => router.refresh()}
        />
      ) : null}
    </>
  )
}
