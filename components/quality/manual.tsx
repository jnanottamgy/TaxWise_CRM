"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CheckIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { DateField, SelectField, TextField, TextareaField } from "@/components/app/form/fields"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { StatusChip } from "@/components/app/status-chip"
import { EmptyState } from "@/components/app/empty-state"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useActionForm } from "@/hooks/use-action-form"
import { addMonths } from "@/lib/domain/fy"
import { formatDate } from "@/lib/format"
import {
  ItemReviewedSchema,
  QUALITY_FRAMEWORK_LABELS,
  QualityItemSchema,
  SQC1_ELEMENTS,
  SQM1_COMPONENTS,
  qualityGroupLabel,
  qualityGroupOf,
  qualityItemReviewDue,
  type QualityElement,
  type QualityFramework,
} from "@/lib/schemas/quality"
import { deleteQualityItem, markItemReviewed, saveQualityItem, setQualityFramework } from "@/server/actions/quality"
import { toastResult } from "@/components/quality/feedback"
import { NoteDialog } from "@/components/audits/audit-dialogs"
import type { QualityItemRow } from "@/lib/data/quality"

type Staff = { value: string; label: string; description?: string }

function ItemDialog({ onClose, item, framework, staff, today }: { onClose: () => void; item: QualityItemRow | null; framework: QualityFramework; staff: Staff[]; today: string }) {
  const router = useRouter()
  const elements: readonly string[] = framework === "sqm1" ? SQM1_COMPONENTS : SQC1_ELEMENTS
  const f = useActionForm(QualityItemSchema, saveQualityItem, {
    defaultValues: {
      id: item?.id ?? "",
      updatedAt: item?.updated_at ?? "",
      element: ((item && elements.includes(qualityGroupOf({ element: item.element, sqm1Component: item.sqm1_component }, framework)) ? qualityGroupOf({ element: item.element, sqm1Component: item.sqm1_component }, framework) : elements[0]) as QualityElement),
      title: item?.title ?? "",
      ownerEmployeeId: item?.owner_employee_id ?? "",
      lastReviewedOn: item?.last_reviewed_on ?? "",
      reviewEveryMonths: String(item?.review_every_months ?? 12),
      notes: item?.notes ?? "",
      sqm1Component: (item?.sqm1_component as (typeof SQM1_COMPONENTS)[number] | null) ?? "",
      qualityObjective: item?.quality_objective ?? "",
      qualityRisk: item?.quality_risk ?? "",
      riskResponse: item?.risk_response ?? "",
    },
    successMessage: item ? "Item saved" : "Item added",
    onSuccess: () => {
      onClose()
      router.refresh()
    },
  })
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="md"
      title={item ? "Quality manual item" : "Add to the quality manual"}
      description={framework === "sqm1" ? "Under SQM 1: the quality objective, the risk to it and the firm's response." : "A policy or procedure under one of SQC 1's six elements, with who owns it and how often it is reviewed."}
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel={item ? "Save" : "Add item"}
    >
      <FormAlert state={f} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SelectField control={f.control} name="element" label={framework === "sqm1" ? "Component" : "Element"} required options={elements.map((e) => ({ value: e, label: qualityGroupLabel(e) }))} className="md:col-span-2" />
        <TextareaField control={f.control} name="title" label="What the firm does" required rows={2} className="md:col-span-2" placeholder="Every engagement partner confirms independence before accepting an audit." />
        <SelectField control={f.control} name="ownerEmployeeId" label="Owner" options={staff.map((s) => ({ value: s.value, label: s.label }))} placeholder="Nobody named" />
        <TextField control={f.control} name="reviewEveryMonths" label="Review every (months)" required inputMode="numeric" />
        <DateField control={f.control} name="lastReviewedOn" label="Last reviewed" max={today} />
        {framework === "sqm1" ? (
          <>
            <TextareaField control={f.control} name="qualityObjective" label="Quality objective" rows={2} className="md:col-span-2" />
            <TextareaField control={f.control} name="qualityRisk" label="Quality risk" rows={2} className="md:col-span-2" />
            <TextareaField control={f.control} name="riskResponse" label="Response" rows={2} className="md:col-span-2" />
          </>
        ) : null}
        <TextareaField control={f.control} name="notes" label="Notes" rows={3} className="md:col-span-2" />
      </div>
    </FormDialog>
  )
}

function FrameworkSwitch({ framework, updatedAt, canEdit }: { framework: QualityFramework; updatedAt: string | null; canEdit: boolean }) {
  const router = useRouter()
  const [confirm, setConfirm] = React.useState<QualityFramework | null>(null)
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3.5 md:flex-row md:items-center md:justify-between md:px-5">
      <div className="min-w-0">
        <p className="text-base font-medium text-text">Framework: {QUALITY_FRAMEWORK_LABELS[framework]}</p>
        <p className="mt-0.5 text-sm text-text-muted">
          SQC 1 continues to apply. ICAI deferred SQM 1 and SQM 2 on 31 March 2026 until further announcement; switch when the firm adopts SQM 1&apos;s risk-assessment approach.
        </p>
      </div>
      {canEdit && updatedAt ? (
        <label className="flex flex-none items-center gap-2 text-sm text-text">
          <span className="sr-only">Quality framework</span>
          <NativeSelect value={framework} onChange={(e) => setConfirm(e.target.value as QualityFramework)} className="w-56">
            <NativeSelectOption value="sqc1">{QUALITY_FRAMEWORK_LABELS.sqc1}</NativeSelectOption>
            <NativeSelectOption value="sqm1">{QUALITY_FRAMEWORK_LABELS.sqm1}</NativeSelectOption>
          </NativeSelect>
        </label>
      ) : null}
      {confirm && confirm !== framework && updatedAt ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => (!o ? setConfirm(null) : undefined)}
          title={`Switch to ${QUALITY_FRAMEWORK_LABELS[confirm]}?`}
          description={
            confirm === "sqm1"
              ? "Items are grouped by SQM 1's eight components, and each records a quality objective, the risk to it and the response. Nothing is deleted; you can switch back."
              : "Items are grouped by SQC 1's six elements again. The SQM 1 fields are kept."
          }
          confirmLabel="Switch framework"
          onConfirm={async () => {
            const r = await setQualityFramework({ framework: confirm, updatedAt })
            if (!toastResult(r, "Framework switched")) return false
            setConfirm(null)
            router.refresh()
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * The quality manual checklist (§7.15.4, §6.8): the firm's policies under SQC 1's six elements
 * (leadership, ethics and independence, acceptance and continuance, human resources, engagement
 * performance, monitoring), or SQM 1's components once switched, each with an owner and its last
 * review. Partners maintain it; Managers read it (RLS 0039).
 */
export function QualityManual({
  items,
  framework,
  settingsUpdatedAt,
  staff,
  canEdit,
  today,
}: {
  items: QualityItemRow[]
  framework: QualityFramework
  settingsUpdatedAt: string | null
  staff: Staff[]
  canEdit: boolean
  today: string
}) {
  const router = useRouter()
  const [editing, setEditing] = React.useState<QualityItemRow | "new" | null>(null)
  const [reviewing, setReviewing] = React.useState<QualityItemRow | null>(null)
  const [deleting, setDeleting] = React.useState<QualityItemRow | null>(null)
  const groups: readonly string[] = framework === "sqm1" ? SQM1_COMPONENTS : SQC1_ELEMENTS
  const byGroup = new Map<string, QualityItemRow[]>()
  for (const it of items) {
    const g = qualityGroupOf({ element: it.element, sqm1Component: it.sqm1_component }, framework)
    byGroup.set(g, [...(byGroup.get(g) ?? []), it])
  }

  return (
    <div className="flex flex-col gap-4">
      <FrameworkSwitch framework={framework} updatedAt={settingsUpdatedAt} canEdit={canEdit} />
      {canEdit ? (
        <div className="flex justify-end">
          <Button type="button" onClick={() => setEditing("new")}>
            <PlusIcon aria-hidden="true" />
            Add item
          </Button>
        </div>
      ) : null}
      {items.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState
            message={`The quality manual is empty. Record the firm's policies under each ${framework === "sqm1" ? "SQM 1 component" : "SQC 1 element"}, with an owner and a review cycle.`}
            action={
              canEdit ? (
                <Button type="button" onClick={() => setEditing("new")}>
                  <PlusIcon aria-hidden="true" />
                  Add the first item
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        groups.map((g) => {
          const rows = byGroup.get(g) ?? []
          return (
            <section key={g} aria-labelledby={`qm-${g}`} className="rounded-lg border border-border bg-surface">
              <div className="flex items-baseline justify-between gap-3 px-4 pt-4 pb-2 md:px-5">
                <h2 id={`qm-${g}`} className="text-md font-semibold text-text">
                  {qualityGroupLabel(g)}
                </h2>
                <span className="num text-sm text-text-muted">{rows.length}</span>
              </div>
              {rows.length === 0 ? (
                <p className="px-4 pb-4 text-sm text-text-muted md:px-5">Nothing recorded under this {framework === "sqm1" ? "component" : "element"} yet.</p>
              ) : (
                <ul className="divide-y divide-border border-t border-border">
                  {rows.map((it) => {
                    const due = qualityItemReviewDue(it.last_reviewed_on, it.review_every_months, today, addMonths)
                    const next = it.last_reviewed_on ? addMonths(it.last_reviewed_on, it.review_every_months) : null
                    return (
                      <li key={it.id} className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-start md:justify-between md:px-5">
                        <div className="min-w-0 flex-1">
                          <p className="text-base text-text">{it.title}</p>
                          <p className="mt-0.5 text-sm text-text-muted">
                            {it.owner_name ? `Owner ${it.owner_name}` : "No owner"} · every {it.review_every_months} {it.review_every_months === 1 ? "month" : "months"}
                            {it.last_reviewed_on ? ` · last reviewed ${formatDate(it.last_reviewed_on)}${it.last_reviewed_by_name ? ` by ${it.last_reviewed_by_name}` : ""}` : ""}
                          </p>
                          {framework === "sqm1" && (it.quality_objective || it.quality_risk || it.risk_response) ? (
                            <dl className="mt-2 grid grid-cols-1 gap-1 text-sm md:grid-cols-3 md:gap-4">
                              {[
                                ["Objective", it.quality_objective],
                                ["Risk", it.quality_risk],
                                ["Response", it.risk_response],
                              ].map(([t, v]) => (
                                <div key={t}>
                                  <dt className="text-xs text-text-muted">{t}</dt>
                                  <dd className="text-text">{v || "—"}</dd>
                                </div>
                              ))}
                            </dl>
                          ) : null}
                        </div>
                        <div className="flex flex-none items-center gap-2">
                          {due ? (
                            <StatusChip label={it.last_reviewed_on ? "Review due" : "Never reviewed"} tone="warning" meaning={next ? `Due for review since ${formatDate(next)}.` : "Not reviewed yet: review it and record the date."} />
                          ) : (
                            <StatusChip label="Reviewed" tone="success" meaning={next ? `Next review by ${formatDate(next)}.` : undefined} />
                          )}
                          {canEdit ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${it.title}`}>
                                  <MoreHorizontalIcon aria-hidden="true" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => setReviewing(it)}>
                                  <CheckIcon aria-hidden="true" />
                                  Mark reviewed today
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => setEditing(it)}>
                                  <PencilIcon aria-hidden="true" />
                                  Edit
                                </DropdownMenuItem>
                                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(it)}>
                                  <Trash2Icon aria-hidden="true" />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })
      )}
      {editing ? <ItemDialog onClose={() => setEditing(null)} item={editing === "new" ? null : editing} framework={framework} staff={staff} today={today} /> : null}
      {reviewing ? (
        <NoteDialog
          onClose={() => setReviewing(null)}
          title="Mark it reviewed today?"
          description={`"${reviewing.title}" gets today as its last review, with your name.`}
          label="What the review found"
          required={false}
          submitLabel="Mark reviewed"
          schema={ItemReviewedSchema}
          action={markItemReviewed}
          values={{ id: reviewing.id, updatedAt: reviewing.updated_at }}
          successMessage="Marked reviewed"
          onDone={() => router.refresh()}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => (!o ? setDeleting(null) : undefined)}
          title="Delete this item?"
          description={`"${deleting.title}" is removed from the quality manual. The deletion is kept in the audit log.`}
          confirmLabel="Delete item"
          destructive
          onConfirm={async () => {
            const r = await deleteQualityItem({ id: deleting.id })
            if (!toastResult(r, "Item deleted")) return false
            setDeleting(null)
            router.refresh()
          }}
        />
      ) : null}
    </div>
  )
}
