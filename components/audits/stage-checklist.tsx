"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { FileTextIcon, PaperclipIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { StatusChip } from "@/components/app/status-chip"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { cn } from "@/lib/utils"
import { formatDate, formatDateTime } from "@/lib/format"
import { stepState, type StepSignoff, type SystemCheck } from "@/lib/domain/audit-stages"
import { toneClasses } from "@/components/app/tones"
import { detachEvidence, signoffStep } from "@/server/actions/audits"
import { toastResult } from "@/components/quality/feedback"
import { fileHref } from "@/components/documents/doc-urls"
import type { EvidenceRow } from "@/lib/data/audits"
import { stepChip } from "@/components/audits/audit-ui"
import type { StepFact } from "@/components/audits/facts"
import { useAuditWorkspace } from "@/components/audits/audit-workspace"

export type ChecklistStep = {
  key: string
  title: string
  sa: readonly string[]
  guidance: string
  evidenceRequired: boolean
  allowNa: boolean
  system?: SystemCheck
}

function FactLine({ fact }: { fact: StepFact }) {
  const { open } = useAuditWorkspace()
  const t = toneClasses(fact.tone)
  return (
    <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <span className="inline-flex min-w-0 items-baseline gap-1.5">
        <span aria-hidden="true" className={cn("relative top-[-1px] inline-block size-2 flex-none rounded-full", t.dot)} />
        <span className={fact.tone === "danger" || fact.tone === "warning" || fact.tone === "success" ? t.text : "text-text-muted"}>{fact.text}</span>
      </span>
      {fact.link ? (
        <Link href={fact.link.href} className="font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring">
          {fact.link.label}
        </Link>
      ) : null}
      {fact.action ? (
        <button type="button" onClick={() => open({ kind: fact.action!.kind } as never)} className="cursor-pointer font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring">
          {fact.action.label}
        </button>
      ) : null}
    </p>
  )
}

function Signatures({ s, names }: { s: StepSignoff | undefined; names: Record<string, string> }) {
  if (!s || (!s.preparedAt && !s.notApplicable)) return null
  const who = (id: string | null) => (id ? (names[id] ?? "Someone") : "Someone")
  return (
    <p className="mt-1.5 text-xs text-text-muted">
      {s.notApplicable ? `Marked not applicable by ${who(s.preparedBy)}` : `Prepared by ${who(s.preparedBy)}`}
      {s.preparedAt ? `, ${formatDateTime(s.preparedAt)}` : ""}
      {s.reviewedAt ? ` · Reviewed by ${who(s.reviewedBy)}, ${formatDateTime(s.reviewedAt)}` : ""}
      {s.notApplicable && s.naReason ? <span className="block text-text">Reason: {s.naReason}</span> : s.note ? <span className="block text-text">Note: {s.note}</span> : null}
    </p>
  )
}

function EvidenceList({ rows, canRemove, onRemoved }: { rows: EvidenceRow[]; canRemove: boolean; onRemoved: () => void }) {
  const [removing, setRemoving] = React.useState<EvidenceRow | null>(null)
  if (!rows.length) return null
  return (
    <>
      <ul className="mt-2 flex flex-col gap-1" aria-label="Working papers">
        {rows.map((r) => (
          <li key={r.id} className="flex min-w-0 items-center gap-2 text-sm">
            <FileTextIcon aria-hidden="true" className="size-3.5 flex-none text-text-muted" />
            {r.deleted ? (
              <span className="min-w-0 truncate text-text-muted line-through" title="Deleted from the vault">
                {r.title}
              </span>
            ) : (
              <a href={fileHref(r.document_id)} className="min-w-0 truncate text-primary hover:underline" title={r.file_name}>
                {r.title}
              </a>
            )}
            <span className="hidden flex-none text-xs text-text-muted sm:inline">
              {r.added_by_name ? `${r.added_by_name}, ` : ""}
              {formatDate(r.added_at)}
            </span>
            {r.is_amendment ? <StatusChip label="Amendment" tone="violet" meaning={`Added after archive: ${r.amendment_note ?? ""}`} variant="pill" /> : null}
            {canRemove && !r.is_amendment ? (
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${r.title} from this step`} onClick={() => setRemoving(r)}>
                <XIcon aria-hidden="true" />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {removing ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => (!o ? setRemoving(null) : undefined)}
          title="Remove this working paper from the step?"
          description={`"${removing.title}" stays in the client's vault; it is no longer tagged to this step.`}
          confirmLabel="Remove from step"
          onConfirm={async () => {
            const r = await detachEvidence({ linkId: removing.id })
            if (!toastResult(r, "Removed from the step")) return false
            setRemoving(null)
            onRemoved()
          }}
        />
      ) : null}
    </>
  )
}

function StepRow({
  step,
  signoff,
  evidence,
  names,
  fact,
  actorId,
  signable,
  archived,
}: {
  step: ChecklistStep
  signoff: StepSignoff | undefined
  evidence: EvidenceRow[]
  names: Record<string, string>
  fact: StepFact | undefined
  actorId: string
  signable: boolean
  archived: boolean
}) {
  const router = useRouter()
  const { open, data } = useAuditWorkspace()
  const [pending, setPending] = React.useState<string | null>(null)
  const state = stepState(signoff)
  const chip = stepChip(state)
  const ownWork = Boolean(signoff?.preparedBy && signoff.preparedBy === actorId)
  const needsPaper = step.evidenceRequired && evidence.length === 0

  const act = async (action: "prepare" | "review" | "reopen") => {
    setPending(action)
    try {
      const r = await signoffStep({ id: data.id, step: step.key, action, note: null })
      const words = action === "prepare" ? "Signed as prepared" : action === "review" ? "Reviewed" : "Reopened"
      if (toastResult(r, words)) router.refresh()
    } finally {
      setPending(null)
    }
  }

  return (
    <li className="px-4 py-4 md:px-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="text-base font-medium text-text">{step.title}</h3>
            <StatusChip label={chip.label} tone={chip.tone} meaning={chip.meaning} />
          </div>
          <p className="mt-0.5 text-xs text-text-muted">
            {step.sa.join(" · ")}
            {step.evidenceRequired ? " · Working paper needed" : ""}
            {step.allowNa ? " · May not apply" : ""}
          </p>
          <p className="mt-1.5 text-sm text-text-muted">{step.guidance}</p>
          {fact ? <FactLine fact={fact} /> : null}
          <Signatures s={signoff} names={names} />
          <EvidenceList rows={evidence} canRemove={signable && state !== "reviewed"} onRemoved={() => router.refresh()} />
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2 md:justify-end">
          {archived ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => open({ kind: "evidence", step: { key: step.key, title: step.title } })}>
              <PaperclipIcon aria-hidden="true" />
              Add amendment
            </Button>
          ) : signable ? (
            <>
              {state !== "reviewed" ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => open({ kind: "evidence", step: { key: step.key, title: step.title } })}>
                  <PaperclipIcon aria-hidden="true" />
                  Working paper
                </Button>
              ) : null}
              {state === "not_started" ? (
                <>
                  {step.allowNa ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => open({ kind: "na", step: { key: step.key, title: step.title } })}>
                      Not applicable
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={needsPaper || pending !== null}
                    title={needsPaper ? "Attach the working paper for this step first." : undefined}
                    onClick={() => void act("prepare")}
                  >
                    {pending === "prepare" ? <Spinner /> : null}
                    Mark prepared
                  </Button>
                </>
              ) : null}
              {state === "prepared" || state === "not_applicable" ? (
                <>
                  <Button type="button" variant="ghost" size="sm" disabled={pending !== null} onClick={() => void act("reopen")}>
                    {pending === "reopen" ? <Spinner /> : null}
                    Reopen
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={ownWork || pending !== null}
                    title={ownWork ? "You prepared this step, so someone else reviews it." : undefined}
                    onClick={() => void act("review")}
                  >
                    {pending === "review" ? <Spinner /> : null}
                    Review
                  </Button>
                </>
              ) : null}
              {state === "reviewed" ? (
                <Button type="button" variant="ghost" size="sm" disabled={pending !== null} onClick={() => void act("reopen")}>
                  {pending === "reopen" ? <Spinner /> : null}
                  Reopen
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </li>
  )
}

/**
 * One stage's checklist (§6.9, §7.15.5): each step with its SA references, what to do and file,
 * the live fact the app checks beside it, the preparer's and reviewer's sign-offs, and its working
 * papers. Steps are signed only at the stage the engagement is at (the Archive steps while at
 * Reporting); nobody reviews their own work; a step needing a working paper can't be signed as
 * prepared without one. The database enforces each of these (audit_step_signoff, 0196).
 */
export function StageChecklist({
  steps,
  signoffs,
  evidence,
  names,
  facts,
  actorId,
  signable,
  archived,
  emptyText,
}: {
  steps: ChecklistStep[]
  signoffs: Record<string, StepSignoff>
  evidence: EvidenceRow[]
  names: Record<string, string>
  facts: Partial<Record<SystemCheck, StepFact>>
  actorId: string
  signable: boolean
  archived: boolean
  emptyText: string
}) {
  if (!steps.length) return <p className="px-4 py-4 text-sm text-text-muted md:px-5">{emptyText}</p>
  return (
    <ul className="divide-y divide-border">
      {steps.map((s) => (
        <StepRow
          key={s.key}
          step={s}
          signoff={signoffs[s.key]}
          evidence={evidence.filter((e) => e.step_key === s.key)}
          names={names}
          fact={s.system ? facts[s.system] : undefined}
          actorId={actorId}
          signable={signable}
          archived={archived}
        />
      ))}
    </ul>
  )
}
