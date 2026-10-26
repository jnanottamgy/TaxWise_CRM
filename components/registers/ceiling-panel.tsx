"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PencilIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SectionCard } from "@/components/app/section-card"
import { EmptyState } from "@/components/app/empty-state"
import { DateText } from "@/components/app/date-text"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { TextField, TextareaField } from "@/components/app/form/fields"
import { useActionForm } from "@/hooks/use-action-form"
import { cn } from "@/lib/utils"
import { ExternalCountSchema } from "@/lib/schemas/registers"
import type { CeilingPanel as CeilingPanelData, CeilingRow, MissingUdinRow } from "@/lib/data/registers"
import { saveExternalCount } from "@/server/actions/udin"
import { UdinDialog, type SigningMember, type UdinPrefill } from "@/components/registers/udin-dialog"

function ExternalCountDialog({ open, onOpenChange, row, fy }: { open: boolean; onOpenChange: (open: boolean) => void; row: CeilingRow; fy: string }) {
  const router = useRouter()
  const f = useActionForm(ExternalCountSchema, saveExternalCount, {
    defaultValues: { memberId: row.memberId, financialYear: fy, auditsSignedElsewhere: row.signedElsewhere, notes: row.elsewhereNotes ?? "" },
    successMessage: (d) => `Saved. ${row.name} now has ${d.total} tax audits counted for FY ${fy}.`,
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={`Audits ${row.name} signed elsewhere`}
      description={`FY ${fy}: tax audits signed in individual capacity or for other firms, which count towards the same ceiling.`}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Save"
    >
      <FormAlert state={f} />
      <TextField control={f.control} name="auditsSignedElsewhere" label="Tax audit reports signed elsewhere" required type="number" inputMode="numeric" min={0} max={500} />
      <TextareaField control={f.control} name="notes" label="Notes" className="mt-4" rows={2} helper="Which firms, as on the UDIN portal." />
    </FormDialog>
  )
}

/** A bar at the true ratio, both ends labelled, with ticks at the warning counts (taste §11 "Limits and usage"). */
function UsageBar({ value, max, marks, tone, label }: { value: number; max: number; marks: readonly number[]; tone: "ok" | "warn" | "danger"; label: string }) {
  const pct = Math.min(100, max > 0 ? (value / max) * 100 : 0)
  return (
    <div className="flex items-center gap-2">
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="relative h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div className={cn("absolute inset-y-0 left-0 rounded-full", tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warning" : "bg-primary")} style={{ width: `${pct}%` }} />
        {marks.map((m) => (
          <span key={m} aria-hidden="true" className="absolute inset-y-0 w-px bg-border" style={{ left: `${Math.min(100, (m / max) * 100)}%` }} />
        ))}
      </div>
      <span className="num w-16 flex-none text-right text-sm text-text tabular-nums">
        {value} <span className="text-text-muted">/{max}</span>
      </span>
    </div>
  )
}

function standing(r: CeilingRow): { text: string; tone: "ok" | "warn" | "danger" } {
  if (r.warning === "over") return { text: `Over by ${r.total - r.ceiling}`, tone: "danger" }
  if (r.warning === "at_ceiling") return { text: "At the ceiling", tone: "danger" }
  if (r.warning === "near") return { text: `${r.remaining} left`, tone: "warn" }
  return { text: `${r.remaining} left`, tone: "ok" }
}

/**
 * The per-partner tax-audit ceiling (§6.8, §7.15.1, §18.3 Partner 7): for the FY, each Partner's
 * tax audit reports counted (signed here, by the date signed; head office and branch once; revised
 * never) plus the audits signed elsewhere they enter, against the ICAI ceiling of 60, warned at 50
 * and 58; and their company audits as engaging partner against the limit of 20, warned from the 18th.
 */
export function CeilingPanel({ data, canEdit, footer }: { data: CeilingPanelData; canEdit: boolean; /** A one-line note under the rows (the UDIN check when nothing is missing). */ footer?: React.ReactNode }) {
  const [editing, setEditing] = React.useState<CeilingRow | null>(null)
  const ceiling = data.rows[0]?.ceiling ?? 60
  const warnAt = data.rows[0]?.warnAt ?? [50, 58]
  return (
    <SectionCard
      title="Tax-audit ceiling"
      description={`${ceiling} reports per member in FY ${data.fy}, counted by the date signed and including audits signed elsewhere. Warned at ${warnAt.join(" and ")}.`}
      action={<span className="text-sm text-text-muted">FY {data.fy}</span>}
      footer={footer}
    >
      {data.unverified.length ? <p className="mb-3 text-sm text-text-muted">Some limits used here are marked [verify] in Settings → Law and should be checked against the latest ICAI guidance.</p> : null}
      {data.rows.length === 0 ? (
        <EmptyState size="compact" message="No active Partners to count tax audits for." />
      ) : (
        <ul className="flex flex-col">
          {data.rows.map((r) => {
            const s = standing(r)
            return (
              <li key={r.memberId} className="grid grid-cols-1 gap-x-6 gap-y-2 border-t border-border/70 py-3 first:border-t-0 first:pt-0 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,13rem)] md:items-center">
                <div className="min-w-0">
                  <p className="truncate text-base font-medium text-text">{r.name}</p>
                  <p className="text-sm text-text-muted">{r.membershipNo ? `M. No. ${r.membershipNo}` : <span className="text-warning-text">Membership no. not set</span>}</p>
                </div>
                <div className="min-w-0">
                  <UsageBar value={r.total} max={r.ceiling} marks={r.warnAt} tone={s.tone} label={`Tax audits of ${r.name}`} />
                  <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm text-text-muted">
                    <span>
                      <span className="num">{r.signedInFirm}</span> signed here
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      <span className="num">{r.signedElsewhere}</span> elsewhere
                    </span>
                    {canEdit ? (
                      <Button variant="link" size="xs" className="h-auto text-sm" onClick={() => setEditing(r)}>
                        <PencilIcon aria-hidden="true" className="size-3" />
                        Edit
                      </Button>
                    ) : null}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-4 md:flex-col md:items-end md:gap-0.5">
                  <span className={cn("text-sm font-medium", s.tone === "danger" ? "text-danger-text" : s.tone === "warn" ? "text-warning-text" : "text-text")}>{s.text}</span>
                  <span className={cn("text-sm", r.companyLevel === "block" ? "text-danger-text" : r.companyLevel === "warn" ? "text-warning-text" : "text-text-muted")} title="Company audits as engaging partner (Companies Act s.141(3)(g)); OPCs, small, dormant and private companies under ₹100 crore paid-up don't count.">
                    Company audits <span className="num">{r.companyAudits}</span>/{r.companyLimit}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {editing ? <ExternalCountDialog key={editing.memberId} open onOpenChange={(o) => !o && setEditing(null)} row={editing} fy={data.fy} /> : null}
    </SectionCard>
  )
}

const AUDIT_DOC: Record<string, { label: string; doc: UdinPrefill["documentType"] }> = {
  statutory_companies_act: { label: "Statutory audit report", doc: "Statutory Audit Report" },
  tax_audit: { label: "Tax audit report", doc: "Tax Audit Report" },
  gst_audit: { label: "GST audit report", doc: "GST Audit" },
  internal: { label: "Internal audit report", doc: "Other" },
  bank_branch: { label: "Bank branch audit report", doc: "Statutory Audit Report" },
  stock: { label: "Stock audit report", doc: "Other" },
  certification: { label: "Certificate", doc: "Certificate" },
  other: { label: "Audit report", doc: "Other" },
}

/**
 * Signed reports with no UDIN yet (§6.8 "the dashboard lists signed documents with no UDIN, with the
 * days left"): audit engagements with a report date and no UDIN. Each opens "Log UDIN" prefilled.
 */
export function MissingUdinList({ rows, total, members, isPartner }: { rows: MissingUdinRow[]; total: number; members: SigningMember[]; isPartner: boolean }) {
  const [prefill, setPrefill] = React.useState<UdinPrefill | null>(null)
  return (
    <SectionCard title="Signed reports without a UDIN" description="Generate each within 60 days of signing, as ICAI requires." action={total > rows.length ? <span className="text-sm text-text-muted">{rows.length} of {total}</span> : undefined}>
      {rows.length === 0 ? (
        <EmptyState size="compact" message="Every signed audit report has its UDIN." />
      ) : (
        <ul className="flex flex-col">
          {rows.map((r) => {
            const doc = AUDIT_DOC[r.audit_type] ?? AUDIT_DOC.other
            return (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border/70 py-2.5 first:border-t-0 first:pt-0">
                <div className="min-w-0">
                  <p className="truncate text-base text-text">{r.client_name}</p>
                  <p className="text-sm text-text-muted">
                    {doc.label} · signed <DateText date={r.report_date} />
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={cn("num text-sm tabular-nums", r.daysLate !== null && r.daysLate > 0 ? "text-danger-text" : r.daysLeft !== null && r.daysLeft <= 7 ? "text-warning-text" : "text-text-muted")}>
                    {r.daysLate !== null && r.daysLate > 0 ? `${r.daysLate} ${r.daysLate === 1 ? "day" : "days"} late` : r.daysLeft !== null ? (r.daysLeft === 0 ? "Due today" : `${r.daysLeft} ${r.daysLeft === 1 ? "day" : "days"} left`) : ""}
                  </span>
                  {members.length ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setPrefill({
                          clientId: r.client_id,
                          clientName: r.client_name,
                          auditEngagementId: r.id,
                          signedOn: r.report_date,
                          documentType: doc.doc,
                          financialYear: r.financial_year,
                          signingPartnerId: r.signing_partner_id,
                        })
                      }
                    >
                      Log UDIN
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {prefill ? <UdinDialog key={prefill.auditEngagementId} open onOpenChange={(o) => !o && setPrefill(null)} prefill={prefill} members={members} isPartner={isPartner} /> : null}
    </SectionCard>
  )
}
