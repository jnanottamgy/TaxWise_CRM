"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useController, type Control } from "react-hook-form"
import { BellIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextareaField } from "@/components/app/form/fields"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { useActionForm } from "@/hooks/use-action-form"
import { cn } from "@/lib/utils"
import { formatDateTime } from "@/lib/format"
import { INDEPENDENCE_QUESTIONS, IndependenceSchema, formAnswers, type IndependenceInput, type IndependenceKey } from "@/lib/schemas/quality"
import { remindIndependence, saveDeclaration } from "@/server/actions/independence"
import { toastResult } from "@/components/quality/feedback"
import type { IndependenceRow } from "@/lib/data/quality"

function YesNo({ control, name, question, index }: { control: Control<IndependenceInput>; name: `answers.${IndependenceKey}`; question: string; index: number }) {
  const { field, fieldState } = useController({ control, name })
  const id = `ind-${index}`
  return (
    <fieldset className="flex flex-col gap-2 py-3 md:flex-row md:items-start md:justify-between md:gap-6" aria-describedby={fieldState.error ? `${id}-err` : undefined}>
      <legend className="sr-only">{question}</legend>
      <p className="min-w-0 flex-1 text-base text-text" aria-hidden="true">
        <span className="num mr-1 text-text-muted">{index + 1}.</span>
        {question}
      </p>
      <div className="flex flex-none gap-1" role="radiogroup" aria-label={question}>
        {(["no", "yes"] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={field.value === v}
            onClick={() => {
              field.onChange(v)
              field.onBlur()
            }}
            className={cn(
              "h-8 min-w-14 rounded-md border px-3 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
              field.value === v ? (v === "yes" ? "border-warning/40 bg-warning-soft font-medium text-warning-text" : "border-primary/40 bg-primary-soft font-medium text-primary") : "border-border bg-surface text-text hover:bg-surface-2"
            )}
          >
            {v === "yes" ? "Yes" : "No"}
          </button>
        ))}
      </div>
      {fieldState.error ? (
        <p id={`${id}-err`} className="text-sm text-danger-text md:basis-full">
          {fieldState.error.message}
        </p>
      ) : null}
    </fieldset>
  )
}

/**
 * The signed-in person's annual independence declaration (§6.8, §7.15.4): eight yes/no questions,
 * with details and safeguards for any yes. Every member of staff declares for themselves (RLS 0039).
 */
export function OwnDeclaration({ fy, existing }: { fy: string; existing: { answers: unknown; details: string | null; declared_at: string; updated_at: string } | null }) {
  const router = useRouter()
  const prior = formAnswers(existing?.answers)
  const f = useActionForm(IndependenceSchema, saveDeclaration, {
    defaultValues: {
      financialYear: fy,
      answers: Object.fromEntries(INDEPENDENCE_QUESTIONS.map((q) => [q.key, prior[q.key]])) as IndependenceInput["answers"],
      details: existing?.details ?? "",
      updatedAt: existing?.updated_at ?? "",
    },
    successMessage: existing ? "Declaration updated" : "Declaration recorded",
    onSuccess: () => router.refresh(),
  })
  return (
    <section aria-labelledby="own-title" className="rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4 pb-1 md:px-5">
        <h2 id="own-title" className="text-md font-semibold text-text">
          Your declaration for FY {fy}
        </h2>
        {existing ? <span className="text-sm text-text-muted">Declared {formatDateTime(existing.declared_at)}</span> : <StatusChip label="Not declared yet" tone="warning" />}
      </div>
      <form noValidate onSubmit={f.onSubmit} className="px-4 pb-4 md:px-5">
        <p className="text-sm text-text-muted">Answer for yourself and your close family. A yes doesn&apos;t stop you working; the Partners check it against the engagement teams and record the safeguards.</p>
        <FormAlert state={f} className="mt-3" />
        <div className="mt-1 divide-y divide-border">
          {INDEPENDENCE_QUESTIONS.map((q, i) => (
            <YesNo key={q.key} control={f.control} name={`answers.${q.key}`} question={q.text} index={i} />
          ))}
        </div>
        <TextareaField control={f.control} name="details" label="Details and safeguards" rows={3} className="mt-3" helper="Required for each yes: which client, what the interest or relationship is, and what keeps it from affecting the work." />
        <div className="mt-4 flex justify-end">
          <Button type="submit" disabled={f.pending} aria-busy={f.pending}>
            {f.pending ? <Spinner /> : null}
            {existing ? "Update declaration" : "Declare"}
          </Button>
        </div>
      </form>
    </section>
  )
}

/**
 * The register (§7.15.4): every active member of staff and their declaration for the year, those
 * yet to declare first, exceptions marked. Partners can remind everyone who hasn't declared.
 */
export function IndependenceRegister({ fy, rows, years, canRemind }: { fy: string; rows: IndependenceRow[]; years: string[]; canRemind: boolean }) {
  const [pending, setPending] = React.useState(false)
  const [openRow, setOpenRow] = React.useState<string | null>(null)
  const pendingCount = rows.filter((r) => !r.declaration_id).length
  return (
    <section aria-labelledby="reg-title" className="rounded-lg border border-border bg-surface">
      <div className="flex flex-col gap-3 px-4 pt-4 pb-3 md:flex-row md:items-center md:justify-between md:px-5">
        <div>
          <h2 id="reg-title" className="text-md font-semibold text-text">
            Declarations for FY {fy}
          </h2>
          <p className="mt-0.5 text-sm text-text-muted">
            {rows.length - pendingCount} of {rows.length} declared{pendingCount ? `; ${pendingCount} to go` : ""}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label="Financial year" className="flex gap-1">
            {years.map((y) => (
              <Link
                key={y}
                href={`/quality?tab=independence&fy=${y}`}
                aria-current={y === fy ? "page" : undefined}
                className={cn("flex h-8 items-center rounded-md px-2.5 text-sm pointer-coarse:h-11", y === fy ? "bg-primary-soft font-medium text-primary" : "text-text-muted hover:bg-surface-2 hover:text-text")}
              >
                {y}
              </Link>
            ))}
          </nav>
          {canRemind && pendingCount > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={async () => {
                setPending(true)
                try {
                  const r = await remindIndependence({ financialYear: fy })
                  toastResult(r, r.ok ? (r.data.reminded ? `Reminded ${r.data.reminded} ${r.data.reminded === 1 ? "person" : "people"}` : "Everyone has declared") : undefined)
                } finally {
                  setPending(false)
                }
              }}
            >
              {pending ? <Spinner /> : <BellIcon aria-hidden="true" />}
              Remind {pendingCount} to declare
            </Button>
          ) : null}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="border-t border-border px-4 py-4 text-sm text-text-muted md:px-5">No active staff.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => {
            const answers = formAnswers(r.answers)
            const yes = INDEPENDENCE_QUESTIONS.filter((q) => answers[q.key] === "yes")
            const expanded = openRow === r.employee_id
            return (
              <li key={r.employee_id} className="px-4 py-2.5 md:px-5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base text-text">{r.full_name}</span>
                    <span className="block text-xs text-text-muted">{[r.designation, r.role ? r.role.charAt(0).toUpperCase() + r.role.slice(1) : null].filter(Boolean).join(" · ")}</span>
                  </span>
                  {!r.declaration_id ? (
                    <StatusChip label="Not declared" tone="warning" meaning={`No declaration for FY ${fy} yet.`} />
                  ) : r.has_exceptions ? (
                    <button type="button" className="cursor-pointer" aria-expanded={expanded} onClick={() => setOpenRow(expanded ? null : r.employee_id)}>
                      <StatusChip label={`${yes.length} ${yes.length === 1 ? "exception" : "exceptions"}`} tone="violet" variant="pill" />
                    </button>
                  ) : (
                    <StatusChip label="Independent" tone="success" meaning="Every question answered no." />
                  )}
                  <span className="num w-28 text-right text-sm text-text-muted">{r.declared_at ? <DateText date={r.declared_at} /> : "—"}</span>
                </div>
                {expanded ? (
                  <div className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-sm text-text">
                    <ul className="list-disc space-y-0.5 pl-4">
                      {yes.map((q) => (
                        <li key={q.key}>{q.text}</li>
                      ))}
                    </ul>
                    {r.details ? <p className="mt-2 whitespace-pre-line">{r.details}</p> : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
