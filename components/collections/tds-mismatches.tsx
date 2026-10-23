"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CheckCircle2Icon, FileSearchIcon } from "lucide-react"
import { formatDate } from "@/lib/format"
import { formatINR, type Paise } from "@/lib/domain/money"
import { gmailComposeUrl, waMeUrl } from "@/lib/domain/messaging"
import type { TdsMatchStatus } from "@/lib/domain/collections"
import type { StatementIssue } from "@/lib/data/tds-credits"
import type { FormError } from "@/hooks/use-action-form"
import { logHandoff } from "@/server/actions/messages"
import { setTdsEntryStatus } from "@/server/actions/tds-credits"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { MonoId } from "@/components/app/mono-id"
import { WhatsAppButton } from "@/components/app/messaging/whatsapp-button"
import { GmailButton } from "@/components/app/messaging/gmail-button"
import { TdsMatchChip } from "@/components/collections/ui"

/**
 * TDS mismatches (§7.9.9). Two lists:
 *
 *   Not showing in 26AS / AIS: credits still Expected although the deductor's statement for their
 *   quarter was due before the latest import, grouped by client, each with a WhatsApp and a Gmail
 *   draft asking the client to correct their TDS statement (logged as a hand-off).
 *   Statement lines that didn't match: the amount differs from our receipts, or the TAN isn't in our
 *   books. Set a line aside with a reason, or bring it back.
 */

export type CorrectionItem = {
  receiptId: string
  invoiceId: string
  invoiceNumber: string | null
  receiptNumber: string
  paymentDate: string
  quarter: string
  section: string | null
  tan: string | null
  tdsPaise: Paise
}

export type CorrectionGroup = {
  clientId: string
  clientName: string
  contactId: string | null
  contactName: string | null
  email: string | null
  whatsappNumber: string | null
  items: CorrectionItem[]
  totalPaise: Paise
  subject: string
  body: string
}

export function TdsCorrections({ groups, latestImport }: { groups: CorrectionGroup[]; latestImport: { label: string; on: string } | null }) {
  const total = groups.reduce((s, g) => s + g.totalPaise, 0)
  const count = groups.reduce((s, g) => s + g.items.length, 0)
  return (
    <SectionCard
      title="Not showing in 26AS / AIS"
      description={
        latestImport
          ? count
            ? `${count} ${count === 1 ? "credit" : "credits"} · ${formatINR(total)} should show by the ${latestImport.label} imported ${formatDate(latestImport.on)}, and don't.`
            : `Every credit due by the ${latestImport.label} imported ${formatDate(latestImport.on)} shows in it.`
          : "Import Form 26AS or the AIS to see which credits haven't reflected."
      }
      flush
    >
      {!latestImport ? (
        <EmptyState size="compact" icon={<FileSearchIcon />} message="No 26AS or AIS has been imported for this year yet. Import one and the credits that should show and don't are listed here." />
      ) : groups.length === 0 ? (
        <EmptyState size="compact" icon={<CheckCircle2Icon />} message="Nothing to chase: every credit whose quarter's TDS statement was due shows in the statement." />
      ) : (
        <ul className="flex flex-col divide-y divide-border" aria-label="Clients whose TDS isn't reflecting">
          {groups.map((g) => (
            <CorrectionRow key={g.clientId} group={g} />
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

function CorrectionRow({ group: g }: { group: CorrectionGroup }) {
  const router = useRouter()
  const related = { type: "tds_credit", id: g.items[0].receiptId }

  const handedOff = async (channel: "whatsapp_handoff" | "gmail_handoff", recipient: string, body: string, subject: string | null) => {
    try {
      const r = await logHandoff({ clientId: g.clientId, contactId: g.contactId, channel, recipient, subject, body, templateId: null, related })
      if (!r.ok) {
        toast.error(r.ref ? `The message opened, but it wasn't logged: ${r.error} (Ref ${r.ref})` : `The message opened, but it wasn't logged: ${r.error}`)
        return
      }
      toast.success(`Logged on ${g.clientName}'s communication history.`)
      router.refresh()
    } catch {
      toast.error("The message opened, but we couldn't reach the server to log it.")
    }
  }

  return (
    <li className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-start md:gap-6">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-base text-text">
          <Link href={`/clients/${g.clientId}?tab=billing`} className="rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            {g.clientName}
          </Link>
          <span className="num text-text-muted tabular-nums">{formatINR(g.totalPaise)}</span>
        </p>
        <ul className="mt-1 flex flex-col gap-0.5 text-sm text-text-muted">
          {g.items.map((i) => (
            <li key={i.receiptId}>
              <Link href={`/invoices/${i.invoiceId}`} className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                {i.invoiceNumber ?? `Receipt ${i.receiptNumber}`}
              </Link>
              {` · ${i.quarter} · paid ${formatDate(i.paymentDate)} · `}
              <span className="num tabular-nums">{formatINR(i.tdsPaise)}</span>
              {i.tan ? (
                <>
                  {" · "}
                  <MonoId value={i.tan} />
                </>
              ) : (
                <span className="text-warning-text"> · no TAN on the receipt</span>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-none flex-wrap items-center gap-2">
        <WhatsAppButton
          recipientName={g.contactName ? `${g.contactName} · ${g.clientName}` : g.clientName}
          number={g.whatsappNumber}
          draft={g.body}
          buildUrl={waMeUrl}
          variant="outline"
          onHandedOff={({ number, text }) => handedOff("whatsapp_handoff", number, text, null)}
        />
        <GmailButton
          to={g.email}
          subject={g.subject}
          body={g.body}
          buildUrl={(f) => gmailComposeUrl({ to: f.to, cc: f.cc, subject: f.subject, body: f.body })}
          onHandedOff={(f) => handedOff("gmail_handoff", f.to, f.body || f.subject, f.subject)}
        />
      </div>
    </li>
  )
}

const ISSUE_ORDER: TdsMatchStatus[] = ["amount_mismatch", "unmatched", "ignored"]

export function StatementIssues({ issues, showIgnored, ignoredHref }: { issues: StatementIssue[]; showIgnored: boolean; ignoredHref: string }) {
  const [aside, setAside] = React.useState<StatementIssue | null>(null)
  const sorted = [...issues].sort((a, b) => ISSUE_ORDER.indexOf(a.status) - ISSUE_ORDER.indexOf(b.status))
  const open = issues.filter((i) => i.status !== "ignored").length
  return (
    <SectionCard
      title="Statement lines that didn't match"
      description={open ? `${open} ${open === 1 ? "line" : "lines"} to look at: the amount differs from our receipts, or the TAN isn't in our books.` : "Every imported line matched a receipt, or was set aside."}
      action={
        <Link href={ignoredHref} className="rounded-sm text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
          {showIgnored ? "Hide set-aside lines" : "Show set-aside lines"}
        </Link>
      }
      flush
    >
      {sorted.length === 0 ? (
        <EmptyState size="compact" icon={<CheckCircle2Icon />} message="Nothing here. Lines from an imported 26AS or AIS that don't match a receipt are listed here." />
      ) : (
        <ul className="flex flex-col divide-y divide-border" aria-label="Unmatched statement lines">
          {sorted.map((i) => (
            <IssueRow key={i.id} issue={i} onSetAside={() => setAside(i)} />
          ))}
        </ul>
      )}
      {aside ? <SetAsideDialog issue={aside} onClose={() => setAside(null)} /> : null}
    </SectionCard>
  )
}

function IssueRow({ issue: i, onSetAside }: { issue: StatementIssue; onSetAside: () => void }) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const bringBack = async () => {
    if (pending) return
    setPending(true)
    try {
      const r = await setTdsEntryStatus({ entryId: i.id, status: "unmatched", note: null })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      toast.success("Brought back to the list.")
      router.refresh()
    } catch {
      toast.error("We couldn't reach the server. Check your connection and try again.")
    } finally {
      setPending(false)
    }
  }
  return (
    <li className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-start md:gap-6">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <TdsMatchChip status={i.status} />
          <span className="text-base text-text">
            {i.clientId && i.clientName ? (
              <Link href={`/clients/${i.clientId}?tab=billing`} className="rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                {i.clientName}
              </Link>
            ) : (
              (i.deductorName ?? "Deductor not named")
            )}
          </span>
          <span className="num text-text tabular-nums">{formatINR(i.tdsPaise)}</span>
        </div>
        <p className="mt-0.5 text-sm text-text-muted">
          <MonoId value={i.deductorTan} />
          {i.section ? ` · ${i.section}` : ""}
          {i.transactionDate ? ` · ${formatDate(i.transactionDate)}` : ""}
          {i.bookingStatus ? ` · booking status ${i.bookingStatus}` : ""}
          {` · imported ${formatDate(i.importedOn)}`}
        </p>
        {i.note ? <p className="mt-0.5 text-sm text-text">{i.status === "ignored" ? `Set aside: ${i.note}` : i.note}</p> : null}
        {i.status === "unmatched" && !i.clientId ? <p className="mt-0.5 text-sm text-text-muted">No client has this TAN. Add it to the client, or to the receipt, and import again.</p> : null}
      </div>
      <div className="flex flex-none items-center gap-2">
        {i.status === "ignored" ? (
          <Button type="button" size="sm" variant="ghost" onClick={bringBack} disabled={pending}>
            {pending ? "Bringing back…" : "Bring back"}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="ghost" onClick={onSetAside}>
            Set aside
          </Button>
        )}
      </div>
    </li>
  )
}

function SetAsideDialog({ issue, onClose }: { issue: StatementIssue; onClose: () => void }) {
  const router = useRouter()
  const [note, setNote] = React.useState("")
  const [error, setError] = React.useState<FormError | null>(null)
  const [fieldError, setFieldError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const id = React.useId()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    setFieldError(null)
    try {
      const r = await setTdsEntryStatus({ entryId: issue.id, status: "ignored", note })
      if (!r.ok) {
        if (r.fieldErrors?.note?.[0]) setFieldError(r.fieldErrors.note[0])
        else setError({ message: r.error, ref: r.ref })
        return
      }
      toast.success("Set aside. It stays out of the list until you bring it back.")
      onClose()
      router.refresh()
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="sm"
      title="Set this line aside?"
      description={`${issue.deductorName ?? issue.deductorTan} · ${formatINR(issue.tdsPaise)}`}
      onSubmit={submit}
      pending={pending}
      submitLabel="Set aside"
    >
      <div className="flex flex-col gap-4">
        <FormAlert error={error} />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-sm font-medium text-text">
            Why <span className="text-danger-text">*</span>
          </label>
          <Textarea
            id={id}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={500}
            required
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={`${id}-help`}
            placeholder="TDS on rent, not on our fees"
          />
          <p id={`${id}-help`} className={fieldError ? "text-sm text-danger-text" : "text-sm text-text-muted"}>
            {fieldError ?? "For example, TDS that isn't on our fees, or a line already sorted out with the client."}
          </p>
        </div>
      </div>
    </FormDialog>
  )
}
