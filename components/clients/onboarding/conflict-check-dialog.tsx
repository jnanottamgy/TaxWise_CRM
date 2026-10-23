"use client"

import * as React from "react"
import Link from "next/link"
import { ExternalLinkIcon, SearchCheckIcon, ShieldCheckIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { ACCEPTANCE_DECISION_LABELS, ACCEPTANCE_DECISIONS, rationaleProblem, type AcceptanceDecision, type ConflictHit } from "@/lib/domain/conflict"
import { INDEPENDENCE_QUESTIONS, independenceThreat, type IndependenceAnswers, type IndependenceKey } from "@/lib/schemas/onboarding"
import { decideAcceptance, runAcceptanceCheck } from "@/server/actions/acceptance"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TagInput } from "@/components/app/form/tag-input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { formatTime } from "@/lib/format"

export type AcceptanceResult = { acceptanceId: string; outcome: AcceptanceDecision; summary: string }

type Check = { acceptanceId: string; updatedAt: string; hits: ConflictHit[]; summary: string; checkedAt: string }

const STRENGTH: Record<ConflictHit["strength"], { label: string; tone: string }> = {
  exact: { label: "Exact match", tone: "border-danger/30 bg-danger-soft text-danger-text" },
  strong: { label: "Same name", tone: "border-warning/40 bg-warning-soft text-warning-text" },
  possible: { label: "Close name", tone: "border-border bg-surface-2 text-text-muted" },
}

function hitHref(h: ConflictHit): string | null {
  if (h.inRecycleBin) return "/recycle-bin"
  if (h.clientId) return `/clients/${h.clientId}`
  if (h.leadId) return `/leads/${h.leadId}`
  return null
}

/**
 * The conflict check and acceptance decision (§7.5.4, §6.8), from step 1 of the wizard. Runs
 * `client_acceptances` against existing clients, leads, contacts, directors and partners, earlier
 * related parties and client groups, lists the matches, and records Accept / Decline / Pending with
 * a rationale (required when declining or accepting despite a match). For audit work the
 * independence questions are answered before accepting. A recorded decision is frozen.
 */
export function ConflictCheckDialog({
  open,
  onOpenChange,
  prospectName,
  legalName,
  pan,
  gstin,
  leadId,
  attest,
  current,
  onDecided,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  prospectName: string
  legalName: string
  pan: string
  gstin: string
  leadId: string | null
  /** Audit work selected: independence questions before accepting (§6.8). */
  attest: boolean
  /** The check already linked to this wizard, if any. */
  current: { acceptanceId: string; outcome: string; summary: string } | null
  onDecided: (r: AcceptanceResult) => void
}) {
  const [related, setRelated] = React.useState<string[]>([])
  const [check, setCheck] = React.useState<Check | null>(null)
  const [running, setRunning] = React.useState(false)
  const [outcome, setOutcome] = React.useState<AcceptanceDecision | "">("")
  const [rationale, setRationale] = React.useState("")
  const [answers, setAnswers] = React.useState<Partial<Record<IndependenceKey, "yes" | "no">>>({})
  const [error, setError] = React.useState<{ message: string; ref?: string } | null>(null)
  const [fieldError, setFieldError] = React.useState<{ rationale?: string; independence?: string; outcome?: string }>({})
  const [pending, setPending] = React.useState(false)
  const relatedId = React.useId()
  const rationaleId = React.useId()

  const decided = current && current.outcome !== "pending" && current.outcome !== "" ? current : null
  const name = prospectName.trim() || legalName.trim()

  const run = async () => {
    setError(null)
    if (name.length < 2) {
      setError({ message: "Enter the display name in step 1 first." })
      return
    }
    setRunning(true)
    try {
      const extra = legalName.trim() && legalName.trim().toLowerCase() !== name.toLowerCase() ? [legalName.trim()] : []
      const reuse = check?.acceptanceId ?? (current && current.outcome === "pending" ? current.acceptanceId : null)
      const r = await runAcceptanceCheck({
        acceptanceId: reuse,
        prospectName: name,
        pan,
        gstin,
        relatedParties: [...related, ...extra],
        leadId,
      })
      if (!r.ok) {
        setError({ message: r.error, ref: r.ref })
        return
      }
      setCheck(r.data)
      onDecided({ acceptanceId: r.data.acceptanceId, outcome: "pending", summary: r.data.summary })
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setRunning(false)
    }
  }

  const independence: IndependenceAnswers | null =
    INDEPENDENCE_QUESTIONS.every((q) => answers[q.key]) ? (answers as IndependenceAnswers) : null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setFieldError({})
    if (!check) {
      setError({ message: "Run the check first." })
      return
    }
    if (!outcome) {
      setFieldError({ outcome: "Choose Accept, Decline or Pending." })
      return
    }
    if (attest && outcome === "accepted" && !independence) {
      setFieldError({ independence: "Answer each question before accepting audit work." })
      return
    }
    const problem =
      rationaleProblem(outcome, check.hits.length, rationale) ??
      (outcome === "accepted" && independenceThreat(independence) && !rationale.trim() ? "Explain how the independence threat is addressed." : null)
    if (problem) {
      setFieldError({ rationale: problem })
      return
    }
    setPending(true)
    try {
      const r = await decideAcceptance({
        acceptanceId: check.acceptanceId,
        outcome,
        rationale,
        independence: attest ? independence : null,
        attest,
        updatedAt: check.updatedAt,
      })
      if (!r.ok) {
        setError({ message: r.error, ref: r.ref })
        if (r.fieldErrors?.rationale) setFieldError({ rationale: r.fieldErrors.rationale[0] })
        if (r.fieldErrors?.independence) setFieldError({ independence: r.fieldErrors.independence[0] })
        return
      }
      onDecided({ acceptanceId: r.data.acceptanceId, outcome: r.data.outcome, summary: r.data.summary })
      if (r.data.outcome === "pending") {
        setCheck({ ...check, updatedAt: r.data.updatedAt, hits: r.data.hits, summary: r.data.summary })
      } else {
        setCheck(null)
        setOutcome("")
        setRationale("")
        setAnswers({})
      }
      onOpenChange(false)
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setPending(false)
    }
  }

  const startOver = () => {
    setCheck(null)
    setOutcome("")
    setRationale("")
    setAnswers({})
    void runFresh()
  }
  const runFresh = async () => {
    setError(null)
    setRunning(true)
    try {
      const extra = legalName.trim() && legalName.trim().toLowerCase() !== name.toLowerCase() ? [legalName.trim()] : []
      const r = await runAcceptanceCheck({ prospectName: name, pan, gstin, relatedParties: [...related, ...extra], leadId })
      if (!r.ok) {
        setError({ message: r.error, ref: r.ref })
        return
      }
      setCheck(r.data)
      onDecided({ acceptanceId: r.data.acceptanceId, outcome: "pending", summary: r.data.summary })
    } catch {
      setError({ message: "We couldn't reach the server. Check your connection and try again." })
    } finally {
      setRunning(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Conflict check"
      description="Checks existing clients, leads, contacts, directors and partners, earlier related parties and client groups for this prospect."
      onSubmit={submit}
      pending={pending}
      submitDisabled={!check || running}
      submitLabel="Record decision"
      cancelLabel="Close"
      dirty={!!outcome || !!rationale.trim()}
      footerStart={check ? <span className="num tabular-nums">Checked at {formatTime(check.checkedAt)}</span> : null}
    >
      <div className="flex flex-col gap-5">
        {error ? <FormAlert error={error} /> : null}

        {decided && !check ? (
          <div className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3">
            <ShieldCheckIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-muted" />
            <div className="min-w-0 flex-1">
              <p className="text-base text-text">
                Decision recorded: <span className="font-medium">{ACCEPTANCE_DECISION_LABELS[decided.outcome as AcceptanceDecision] ?? decided.outcome}</span>
              </p>
              <p className="text-sm text-text-muted">{decided.summary} A recorded decision can&apos;t be changed. If the details changed, run a new check.</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={startOver} disabled={running}>
              {running ? <Spinner /> : null}
              Run a new check
            </Button>
          </div>
        ) : null}

        <section aria-label="What is checked" className="flex flex-col gap-3">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-base sm:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-sm text-text-muted">Name</dt>
              <dd className="truncate text-text">{name || "—"}</dd>
            </div>
            <div>
              <dt className="text-sm text-text-muted">PAN</dt>
              <dd className="font-mono text-[13px] text-text">{pan || "—"}</dd>
            </div>
            <div>
              <dt className="text-sm text-text-muted">GSTIN</dt>
              <dd className="font-mono text-[13px] text-text">{gstin || "—"}</dd>
            </div>
          </dl>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={relatedId}>Related parties</Label>
            <TagInput
              id={relatedId}
              value={related}
              onChange={setRelated}
              placeholder="Directors, partners, promoters, group companies; PAN or DIN also works"
              maxTags={50}
              maxLength={120}
              aria-describedby={`${relatedId}-help`}
            />
            <p id={`${relatedId}-help`} className="text-sm text-text-muted">
              Press Enter after each name. The legal name is checked too.
            </p>
          </div>
          {!decided || check ? (
            <div>
              <Button type="button" variant={check ? "outline" : "default"} onClick={() => void run()} disabled={running || pending}>
                {running ? <Spinner /> : <SearchCheckIcon aria-hidden="true" />}
                {check ? "Run again" : "Run the check"}
              </Button>
            </div>
          ) : null}
        </section>

        {running && !check ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <span role="status" className="sr-only">
              Checking…
            </span>
          </div>
        ) : null}

        {check ? (
          <section aria-labelledby="conflict-results" className="flex flex-col gap-2">
            <h3 id="conflict-results" className="text-md font-semibold text-text">
              {check.summary}
            </h3>
            {check.hits.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {check.hits.map((h) => {
                  const href = hitHref(h)
                  const s = STRENGTH[h.strength]
                  return (
                    <li key={h.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-base text-text">{h.title}</p>
                        <p className="text-sm text-text-muted">{h.reasons.map((r) => r.text).join(" ")}</p>
                      </div>
                      <span className={cn("rounded-full border px-2 text-xs leading-5", s.tone)}>{s.label}</span>
                      {href ? (
                        <Link href={href} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline">
                          Open
                          <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                          <span className="sr-only">{h.title} in a new tab</span>
                        </Link>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="text-sm text-text-muted">Nothing matched in clients, leads, contacts, directors and partners, earlier checks or groups.</p>
            )}
          </section>
        ) : null}

        {check ? (
          <section aria-label="Decision" className="flex flex-col gap-4 border-t border-border pt-4">
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium text-text">
                Decision<span aria-hidden="true" className="ml-0.5 text-danger-text">*</span>
              </legend>
              <div role="radiogroup" aria-label="Decision" className="grid grid-cols-3 gap-2">
                {ACCEPTANCE_DECISIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={outcome === d}
                    onClick={() => setOutcome(d)}
                    className={cn(
                      "min-h-10 cursor-pointer rounded-md border px-3 text-base transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      outcome === d ? "border-primary bg-primary-soft text-text" : "border-border bg-surface hover:bg-surface-2",
                    )}
                  >
                    {ACCEPTANCE_DECISION_LABELS[d]}
                  </button>
                ))}
              </div>
              {fieldError.outcome ? <p className="text-sm text-danger-text">{fieldError.outcome}</p> : null}
              <p className="text-sm text-text-muted">
                {outcome === "declined"
                  ? "Declined: this prospect can't be onboarded."
                  : outcome === "pending"
                    ? "Pending: kept open. Audit work can't be onboarded until it's accepted."
                    : outcome === "accepted"
                      ? "Accepted: recorded with the matches above, and can't be changed later."
                      : "The decision is recorded with the matches as they stand now."}
              </p>
            </fieldset>

            {attest && outcome === "accepted" ? (
              <fieldset className="flex flex-col gap-3" aria-describedby={fieldError.independence ? "independence-err" : undefined}>
                <legend className="mb-1 text-sm font-medium text-text">
                  Independence (audit work)<span aria-hidden="true" className="ml-0.5 text-danger-text">*</span>
                </legend>
                {INDEPENDENCE_QUESTIONS.map((q) => (
                  <div key={q.key} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <p id={`indep-${q.key}`} className="text-base text-text">
                      {q.question}
                    </p>
                    <div role="radiogroup" aria-labelledby={`indep-${q.key}`} className="flex flex-none gap-1.5">
                      {(["no", "yes"] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          role="radio"
                          aria-checked={answers[q.key] === v}
                          onClick={() => setAnswers((a) => ({ ...a, [q.key]: v }))}
                          className={cn(
                            "min-h-9 min-w-14 cursor-pointer rounded-md border px-3 text-base transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11",
                            answers[q.key] === v ? "border-primary bg-primary-soft text-text" : "border-border bg-surface hover:bg-surface-2",
                          )}
                        >
                          {v === "yes" ? "Yes" : "No"}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {fieldError.independence ? (
                  <p id="independence-err" className="text-sm text-danger-text">
                    {fieldError.independence}
                  </p>
                ) : null}
                {independenceThreat(independence) ? (
                  <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning-text">
                    A Yes is a threat to independence. Explain the safeguard in the rationale, or decline.
                  </p>
                ) : null}
              </fieldset>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={rationaleId}>
                Rationale
                {outcome === "declined" || (outcome === "accepted" && check.hits.length > 0) ? <span aria-hidden="true" className="ml-0.5 text-danger-text">*</span> : null}
              </Label>
              <Textarea
                id={rationaleId}
                rows={3}
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                aria-invalid={fieldError.rationale ? true : undefined}
                aria-describedby={fieldError.rationale ? `${rationaleId}-err` : `${rationaleId}-help`}
                placeholder={check.hits.length ? "Why these matches are, or aren't, a conflict" : "Anything the file should record"}
              />
              {fieldError.rationale ? (
                <p id={`${rationaleId}-err`} className="text-sm text-danger-text">
                  {fieldError.rationale}
                </p>
              ) : (
                <p id={`${rationaleId}-help`} className="text-sm text-text-muted">
                  Required when declining, or when accepting despite a match.
                </p>
              )}
            </div>
          </section>
        ) : null}
      </div>
    </FormDialog>
  )
}
