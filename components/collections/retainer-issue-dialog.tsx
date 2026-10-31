"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { CheckCircle2Icon, CircleAlertIcon, TriangleAlertIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatINR } from "@/lib/domain/money"
import type { IssueTarget } from "@/lib/data/collections"
import { prepareRetainerIssue } from "@/server/actions/retainer"
import { issueInvoice } from "@/server/actions/invoices"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import type { FormError } from "@/hooks/use-action-form"

/**
 * "Issue selected" / "Issue all" for retainer drafts (§7.9.6). Shows what will happen first: how
 * many, for how much; a Manager's drafts held for a Partner stay in the queue. Then each draft is
 * issued through the invoices module's issueInvoice, one at a time (each takes its number from the
 * locked series), and the result of every one is listed, with a link to its invoice, where Send on
 * WhatsApp has the message and the PDF ready.
 */

type Outcome = { invoiceId: string; clientName: string; periodLabel: string; status: "issued" | "failed" | "held"; number?: string; message: string }

export function RetainerIssueDialog({
  open,
  onOpenChange,
  invoiceIds,
  all = false,
  runId = null,
  role,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoiceIds?: string[]
  all?: boolean
  runId?: string | null
  role: "partner" | "manager"
}) {
  const router = useRouter()
  const [plan, setPlan] = React.useState<{ targets: IssueTarget[] } | null>(null)
  const [error, setError] = React.useState<FormError | null>(null)
  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState(0)
  const [outcomes, setOutcomes] = React.useState<Outcome[] | null>(null)
  const idsKey = (invoiceIds ?? []).join(",")

  React.useEffect(() => {
    if (!open) return
    // Mounted fresh each time it opens (the callers render it only while open), so the state
    // starts empty; this loads the plan once.
    let cancelled = false
    prepareRetainerIssue({ invoiceIds: idsKey ? idsKey.split(",") : [], all, runId })
      .then((r) => {
        if (cancelled) return
        if (!r.ok) {
          setError({ message: r.error, ref: r.ref })
          return
        }
        setPlan({ targets: r.data.targets })
      })
      .catch(() => {
        if (!cancelled) setError({ message: "We couldn't reach the server. Check your connection and try again." })
      })
    return () => {
      cancelled = true
    }
  }, [open, idsKey, all, runId])

  const issuable = plan ? plan.targets.filter((t) => role === "partner" || !t.held) : []
  const held = plan ? plan.targets.filter((t) => role !== "partner" && t.held) : []
  const total = issuable.reduce((s, t) => s + t.totalPaise, 0)

  const run = async () => {
    if (!plan || running) return
    setRunning(true)
    const out: Outcome[] = held.map((t) => ({ invoiceId: t.invoiceId, clientName: t.clientName, periodLabel: t.periodLabel, status: "held", message: "Held for a Partner's approval: send it for approval from the queue." }))
    let i = 0
    for (const t of issuable) {
      i++
      setProgress(i)
      try {
        const r = await issueInvoice({ invoiceId: t.invoiceId, updatedAt: t.updatedAt, channel: "whatsapp" })
        if (!r.ok) {
          out.push({ invoiceId: t.invoiceId, clientName: t.clientName, periodLabel: t.periodLabel, status: "failed", message: r.ref ? `${r.error} (Ref ${r.ref})` : r.error })
        } else {
          out.push({ invoiceId: t.invoiceId, clientName: t.clientName, periodLabel: t.periodLabel, status: "issued", number: r.data.invoiceNumber, message: `Issued as ${r.data.invoiceNumber}. Send it on WhatsApp from the invoice.` })
        }
      } catch {
        out.push({ invoiceId: t.invoiceId, clientName: t.clientName, periodLabel: t.periodLabel, status: "failed", message: "We couldn't reach the server for this one. It is still a draft; try again." })
      }
    }
    setOutcomes(out)
    setRunning(false)
    router.refresh()
  }

  const close = () => {
    if (running) return
    onOpenChange(false)
  }

  if (outcomes) {
    const issued = outcomes.filter((o) => o.status === "issued").length
    const failed = outcomes.filter((o) => o.status === "failed").length
    return (
      <FormDialog
        open={open}
        onOpenChange={(o) => (!o ? close() : undefined)}
        size="md"
        title={failed ? `${issued} issued, ${failed} not` : `${issued} issued`}
        description="Send each one on WhatsApp from its invoice: the message and the PDF are ready there."
        footer={
          <div className="ml-auto">
            <Button type="button" onClick={close}>
              Done
            </Button>
          </div>
        }
      >
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border" aria-label="What happened to each draft">
          {outcomes.map((o) => {
            const Icon = o.status === "issued" ? CheckCircle2Icon : o.status === "failed" ? CircleAlertIcon : TriangleAlertIcon
            return (
              <li key={o.invoiceId} className="flex items-start gap-2.5 px-3 py-2.5">
                <Icon aria-hidden="true" className={cn("mt-0.5 size-4 flex-none", o.status === "issued" ? "text-success-text" : o.status === "failed" ? "text-danger-text" : "text-warning-text")} />
                <div className="min-w-0 flex-1 text-sm">
                  <p className="text-base text-text">
                    {o.clientName} <span className="text-text-muted">· {o.periodLabel}</span>
                  </p>
                  <p className="text-text-muted">{o.message}</p>
                </div>
                <Link href={`/invoices/${o.invoiceId}`} className="flex-none rounded-sm text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                  Open
                </Link>
              </li>
            )
          })}
        </ul>
      </FormDialog>
    )
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => (!o ? close() : undefined)}
      size="md"
      title={plan ? (issuable.length === 1 ? "Issue 1 retainer invoice?" : `Issue ${issuable.length} retainer invoices?`) : "Issue retainer invoices"}
      description="Each takes its invoice number now and is marked Sent. Issued invoices can't be edited."
      pending={running}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {running ? (
            <span className="mr-auto text-sm text-text-muted" role="status">
              Issuing {progress} of {issuable.length}…
            </span>
          ) : null}
          <Button type="button" variant="outline" onClick={close} disabled={running}>
            Cancel
          </Button>
          <Button type="button" onClick={run} disabled={!plan || running || issuable.length === 0}>
            {running ? "Issuing…" : issuable.length === 1 ? "Issue 1 invoice" : `Issue ${issuable.length} invoices`}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <FormAlert error={error} />
        {!plan && !error ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ) : null}
        {plan ? (
          <>
            <p className="text-base text-text">
              {issuable.length} {issuable.length === 1 ? "draft" : "drafts"} for <span className="num font-medium">{formatINR(total)}</span> in all, incl. GST.
            </p>
            <p className="text-sm text-text-muted">They are issued now; then send each one on WhatsApp from its invoice, with the PDF.</p>
            {held.length ? (
              <p className="text-sm text-warning-text">
                {held.length} {held.length === 1 ? "draft is" : "drafts are"} over the invoice approval limit and {held.length === 1 ? "stays" : "stay"} in the queue for a Partner.
              </p>
            ) : null}
            <ul className="flex max-h-60 flex-col divide-y divide-border overflow-y-auto rounded-md border border-border" aria-label="Drafts to issue">
              {issuable.map((t) => (
                <li key={t.invoiceId} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate text-base text-text">{t.clientName}</span>
                    <span className="block truncate text-text-muted">{t.periodLabel}</span>
                  </span>
                  <span className="num flex-none text-text tabular-nums">{formatINR(t.totalPaise)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </FormDialog>
  )
}
