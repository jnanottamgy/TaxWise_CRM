"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, SelectField, TextField, TextareaField } from "@/components/app/form/fields"
import { StatusChip } from "@/components/app/status-chip"
import { EmptyState } from "@/components/app/empty-state"
import { useActionForm } from "@/hooks/use-action-form"
import { formatDate } from "@/lib/format"
import { calendarQuarterBounds, calendarQuarterOf } from "@/lib/domain/dpdp"
import { RESTORE_OUTCOMES, RESTORE_OUTCOME_INFO, RestoreDrillSchema, type RestoreOutcome } from "@/lib/schemas/quality"
import { recordRestoreDrill } from "@/server/actions/quality"
import { Notice } from "@/components/quality/notice"
import type { RestoreDrillRow } from "@/lib/data/quality"

function DrillDialog({ onClose, today }: { onClose: () => void; today: string }) {
  const router = useRouter()
  const f = useActionForm(RestoreDrillSchema, recordRestoreDrill, {
    defaultValues: { performedOn: today, outcome: "passed", backupReference: "", restoredTo: "", durationMinutes: "", checks: "", issues: "", notes: "" },
    successMessage: "Restore drill recorded",
    onSuccess: () => {
      onClose()
      router.refresh()
    },
  })
  const outcome = f.form.watch("outcome")
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="md"
      title="Record a restore drill"
      description="A backup restored to a scratch database every quarter, to prove the backups work."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Record drill"
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DateField control={f.control} name="performedOn" label="Done on" required max={today} />
        <SelectField control={f.control} name="outcome" label="Outcome" required options={RESTORE_OUTCOMES.map((o) => ({ value: o, label: RESTORE_OUTCOME_INFO[o].label }))} />
        <TextField control={f.control} name="backupReference" label="Backup used" placeholder="Nightly pg_dump of 21 Oct 2026" autoComplete="off" />
        <TextField control={f.control} name="restoredTo" label="Restored to" placeholder="Scratch database on the staging project" autoComplete="off" />
        <TextField control={f.control} name="durationMinutes" label="Minutes taken" inputMode="numeric" />
        <div className="hidden md:block" />
        <TextareaField control={f.control} name="checks" label="What was checked" rows={2} className="md:col-span-2" helper="Row counts of clients, tasks, invoices and documents against production; a document opened from storage." />
        <TextareaField control={f.control} name="issues" label="Issues found" required={outcome !== "passed"} rows={2} className="md:col-span-2" />
        <TextareaField control={f.control} name="notes" label="Notes" rows={2} className="md:col-span-2" />
      </div>
    </FormDialog>
  )
}

/**
 * Restore drills (§12 "A restore drill every quarter, recorded in the quality module"; §6.10
 * backups): this quarter's state, then each drill with its backup, checks and outcome. Partners
 * record them (RLS 0039); a failed drill tells the Partners.
 */
export function RestoreDrills({ rows, today, canEdit }: { rows: RestoreDrillRow[]; today: string; canEdit: boolean }) {
  const [open, setOpen] = React.useState(false)
  const quarter = calendarQuarterOf(today)
  const { end } = calendarQuarterBounds(today)
  const thisQuarter = rows.find((r) => calendarQuarterOf(r.performed_on) === quarter) ?? null
  return (
    <div className="flex flex-col gap-4">
      {thisQuarter ? (
        <Notice tone={thisQuarter.outcome === "passed" ? "success" : "warning"} title={`${quarter.replace("-", " ")}: drill done on ${formatDate(thisQuarter.performed_on)}`}>
          {RESTORE_OUTCOME_INFO[thisQuarter.outcome as RestoreOutcome]?.meaning ?? ""}
        </Notice>
      ) : (
        <Notice tone="warning" title={`No restore drill recorded for ${quarter.replace("-", " ")}`}>
          Run one and record it by {formatDate(end)}.
        </Notice>
      )}
      <section aria-labelledby="drills-title" className="rounded-lg border border-border bg-surface">
        <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3 md:px-5">
          <h2 id="drills-title" className="font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text">
            Drills
          </h2>
          {canEdit ? (
            <Button type="button" size="sm" onClick={() => setOpen(true)}>
              <PlusIcon aria-hidden="true" />
              Record a drill
            </Button>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <div className="px-4 pb-4 md:px-5">
            <EmptyState size="compact" message="No restore drill recorded yet." />
          </div>
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {rows.map((r) => {
              const info = RESTORE_OUTCOME_INFO[r.outcome as RestoreOutcome]
              return (
                <li key={r.id} className="flex flex-col gap-1 px-4 py-3 md:flex-row md:items-start md:justify-between md:gap-6 md:px-5">
                  <div className="min-w-0 flex-1">
                    <p className="num text-base text-text">
                      {formatDate(r.performed_on)}
                      <span className="ml-2 text-sm text-text-muted">{calendarQuarterOf(r.performed_on).replace("-", " ")}</span>
                    </p>
                    <p className="mt-0.5 text-sm text-text-muted">
                      {[r.backup_reference, r.restored_to ? `to ${r.restored_to}` : null, r.duration_minutes ? `${r.duration_minutes} min` : null, r.performed_by_name ? `by ${r.performed_by_name}` : null].filter(Boolean).join(" · ") || "No details recorded"}
                    </p>
                    {r.checks ? <p className="mt-1 text-sm text-text">Checked: {r.checks}</p> : null}
                    {r.issues ? <p className="mt-1 text-sm text-warning-text">Issues: {r.issues}</p> : null}
                  </div>
                  {info ? <StatusChip label={info.label} tone={info.tone} meaning={info.meaning} /> : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
      {open ? <DrillDialog onClose={() => setOpen(false)} today={today} /> : null}
    </div>
  )
}
