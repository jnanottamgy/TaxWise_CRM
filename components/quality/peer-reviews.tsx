"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, SelectField, TextField, TextareaField } from "@/components/app/form/fields"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { StatusChip } from "@/components/app/status-chip"
import { DateText } from "@/components/app/date-text"
import { EmptyState } from "@/components/app/empty-state"
import { useActionForm } from "@/hooks/use-action-form"
import { EMPTY, formatDate } from "@/lib/format"
import { peerReviewStatus, type CeilingParams } from "@/lib/domain/ceiling"
import { PEER_REVIEW_STATUSES, PEER_REVIEW_STATUS_INFO, PeerReviewSchema } from "@/lib/schemas/quality"
import { deletePeerReview, savePeerReview } from "@/server/actions/peer-reviews"
import { toastResult } from "@/components/quality/feedback"
import { Notice } from "@/components/quality/notice"
import type { PeerReviewRow } from "@/lib/data/quality"

function PeerReviewDialog({ onClose, row, today }: { onClose: () => void; row: PeerReviewRow | null; today: string }) {
  const router = useRouter()
  const f = useActionForm(PeerReviewSchema, savePeerReview, {
    defaultValues: {
      id: row?.id ?? "",
      updatedAt: row?.updated_at ?? "",
      periodFrom: row?.period_from ?? "",
      periodTo: row?.period_to ?? "",
      reviewerName: row?.reviewer_name ?? "",
      reviewerFrn: row?.reviewer_frn ?? "",
      status: (row?.status as (typeof PEER_REVIEW_STATUSES)[number]) ?? "scheduled",
      reviewedOn: row?.reviewed_on ?? "",
      certificateNo: row?.certificate_no ?? "",
      validUntil: row?.valid_until ?? "",
      observations: row?.observations ?? "",
      notes: row?.notes ?? "",
    },
    successMessage: row ? "Peer review saved" : "Peer review recorded",
    onSuccess: () => {
      onClose()
      router.refresh()
    },
  })
  const status = f.form.watch("status")
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="md"
      title={row ? "Peer review" : "Record a peer review"}
      description="Peer Review Guidelines 2022: the period reviewed, the reviewer, and the certificate with its validity."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={row ? "Save" : "Record review"}
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DateField control={f.control} name="periodFrom" label="Period reviewed from" required />
        <DateField control={f.control} name="periodTo" label="Period reviewed to" required />
        <TextField control={f.control} name="reviewerName" label="Reviewer" required autoComplete="off" />
        <TextField control={f.control} name="reviewerFrn" label="Reviewer's FRN or membership no." autoCapitalize="characters" autoComplete="off" />
        <SelectField control={f.control} name="status" label="Status" required options={PEER_REVIEW_STATUSES.map((s) => ({ value: s, label: PEER_REVIEW_STATUS_INFO[s].label }))} />
        <DateField control={f.control} name="reviewedOn" label="Review date" required={status === "completed"} max={today} />
        <TextField control={f.control} name="certificateNo" label="Certificate number" required={status === "completed"} autoComplete="off" />
        <DateField control={f.control} name="validUntil" label="Valid until" required={status === "completed"} helper="As printed on the certificate." />
        <TextareaField control={f.control} name="observations" label="Reviewer's observations" rows={3} className="md:col-span-2" />
        <TextareaField control={f.control} name="notes" label="Notes" rows={2} className="md:col-span-2" />
      </div>
    </FormDialog>
  )
}

/**
 * Peer review records (§6.8, §7.15.4): each review's period, reviewer, certificate and validity,
 * the firm's current certificate at the top with its 90-day warning. The certificate valid on the
 * acceptance date opens audits that need a peer-reviewed auditor (0196). Partners keep the records;
 * Managers read them (§4.1 "peer review read-only").
 */
export function PeerReviews({ rows, today, ceiling, canEdit }: { rows: PeerReviewRow[]; today: string; ceiling: CeilingParams; canEdit: boolean }) {
  const router = useRouter()
  const [editing, setEditing] = React.useState<PeerReviewRow | "new" | null>(null)
  const [deleting, setDeleting] = React.useState<PeerReviewRow | null>(null)
  const current = rows.filter((r) => r.status === "completed" && r.valid_until).sort((a, b) => (a.valid_until! < b.valid_until! ? 1 : -1))[0] ?? null
  const st = peerReviewStatus(current?.valid_until ?? null, today, ceiling)

  return (
    <div className="flex flex-col gap-4">
      {st.state === "missing" ? (
        <Notice tone="danger" title="No peer review certificate is recorded">
          Audits of entities that need a peer-reviewed auditor can&apos;t be accepted until one is.
        </Notice>
      ) : st.state === "expired" ? (
        <Notice tone="danger" title={`The certificate expired on ${formatDate(current!.valid_until)}`}>
          Audits that need a peer-reviewed auditor can&apos;t move past Acceptance until a new certificate is recorded.
        </Notice>
      ) : st.state === "expiring" ? (
        <Notice tone="warning" title={`The certificate expires on ${formatDate(current!.valid_until)}, in ${st.daysLeft} ${st.daysLeft === 1 ? "day" : "days"}`}>
          Plan the next review now; the Partners are reminded {ceiling.peerReviewWarningDays} days before expiry.
        </Notice>
      ) : (
        <Notice tone="success" title={`Certificate ${current!.certificate_no ?? ""} valid until ${formatDate(current!.valid_until)}`.replace("  ", " ")}>
          {st.daysLeft} days left. Reviewed by {current!.reviewer_name}
          {current!.reviewed_on ? ` on ${formatDate(current!.reviewed_on)}` : ""}.
        </Notice>
      )}

      <section aria-labelledby="pr-title" className="rounded-lg border border-border bg-surface">
        <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3 md:px-5">
          <h2 id="pr-title" className="font-serif text-[19px] leading-7 font-medium tracking-[-0.005em] text-text">
            Reviews
          </h2>
          {canEdit ? (
            <Button type="button" size="sm" onClick={() => setEditing("new")}>
              <PlusIcon aria-hidden="true" />
              Record a review
            </Button>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <div className="px-4 pb-4 md:px-5">
            <EmptyState size="compact" message="No peer reviews recorded yet." />
          </div>
        ) : (
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full min-w-[44rem] text-sm">
              <caption className="sr-only">Peer reviews</caption>
              <thead>
                <tr className="text-left text-xs text-text-muted">
                  <th scope="col" className="px-4 py-2 font-normal md:px-5">Period reviewed</th>
                  <th scope="col" className="px-3 py-2 font-normal">Reviewer</th>
                  <th scope="col" className="px-3 py-2 font-normal">Status</th>
                  <th scope="col" className="px-3 py-2 font-normal">Certificate</th>
                  <th scope="col" className="px-3 py-2 text-right font-normal">Valid until</th>
                  {canEdit ? <th scope="col" className="px-4 py-2 md:px-5"><span className="sr-only">Actions</span></th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-border border-t border-border">
                {rows.map((r) => {
                  const info = PEER_REVIEW_STATUS_INFO[r.status as (typeof PEER_REVIEW_STATUSES)[number]]
                  return (
                    <tr key={r.id} className="align-top">
                      <td className="num px-4 py-2.5 md:px-5">
                        {formatDate(r.period_from)} to {formatDate(r.period_to)}
                        {r.observations ? <span className="mt-0.5 block max-w-md text-xs text-text-muted">{r.observations}</span> : null}
                      </td>
                      <td className="px-3 py-2.5">
                        {r.reviewer_name}
                        {r.reviewer_frn ? <span className="block text-xs text-text-muted">{r.reviewer_frn}</span> : null}
                      </td>
                      <td className="px-3 py-2.5">{info ? <StatusChip label={info.label} tone={info.tone} meaning={info.meaning} /> : r.status}</td>
                      <td className="px-3 py-2.5">{r.certificate_no ?? <span className="text-text-muted">{EMPTY}</span>}</td>
                      <td className="px-3 py-2.5 text-right">{r.valid_until ? <DateText date={r.valid_until} withRelative={r.id === current?.id} today={today} stacked /> : <span className="text-text-muted">{EMPTY}</span>}</td>
                      {canEdit ? (
                        <td className="px-4 py-2 text-right whitespace-nowrap md:px-5">
                          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(r)}>
                            Edit
                          </Button>
                          <Button type="button" variant="ghost" size="sm" onClick={() => setDeleting(r)}>
                            Delete
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editing ? <PeerReviewDialog onClose={() => setEditing(null)} row={editing === "new" ? null : editing} today={today} /> : null}
      {deleting ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => (!o ? setDeleting(null) : undefined)}
          title="Delete this peer review?"
          description={`The review by ${deleting.reviewer_name}${deleting.certificate_no ? ` (certificate ${deleting.certificate_no})` : ""} is removed. If it holds the current certificate, audits needing a peer-reviewed auditor stop at Acceptance.`}
          confirmLabel="Delete review"
          destructive
          onConfirm={async () => {
            const r = await deletePeerReview({ id: deleting.id })
            if (!toastResult(r, "Peer review deleted")) return false
            setDeleting(null)
            router.refresh()
          }}
        />
      ) : null}
    </div>
  )
}
