"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { PencilIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { SectionCard } from "@/components/app/section-card"
import { StatusChip } from "@/components/app/status-chip"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { SelectField, TextareaField } from "@/components/app/form/fields"
import { PercentInput } from "@/components/app/form/percent-input"
import { useActionForm } from "@/hooks/use-action-form"
import type { EntityType } from "@/lib/domain/enums"
import { incomeTaxStatute, isFinancialYear } from "@/lib/domain/fy"
import { TAX_AUDIT_DISCLAIMER, taxAuditIndication, type IncomeNature, type TaxAuditParams } from "@/lib/domain/scale"
import type { Paise } from "@/lib/domain/money"
import { formatDate } from "@/lib/format"
import { TAX_AUDIT_DECISIONS, TAX_AUDIT_DECISION_LABELS, TaxAuditDecisionSchema, type TaxAuditDecision } from "@/components/client360/logic/profile-schemas"
import { setTaxAuditDecision } from "@/server/actions/client-profile"

const NATURE_LABELS: Record<IncomeNature, string> = {
  business: "Business",
  profession: "Profession",
  presumptive_44ad: "Presumptive business (s.44AD)",
  presumptive_44ada: "Presumptive profession (s.44ADA)",
}

const INDICATION: Record<"yes" | "no" | "review", { label: string; tone: "warning" | "success" | "violet" }> = {
  yes: { label: "Audit indicated", tone: "warning" },
  no: { label: "No audit indicated", tone: "success" },
  review: { label: "Needs a closer look", tone: "violet" },
}

const DECISION_TONE: Record<TaxAuditDecision, "warning" | "muted" | "violet"> = { yes: "warning", no: "muted", review: "violet" }

/**
 * Tax-audit indication and the Partner's decision (§6.6, s.44AB / s.63): an indication from the
 * recorded turnover, which the Partner can refine with how the income is earned and the cash share
 * (nothing of that is stored), and the decision itself (yes / no / review, with a note), which only
 * a Partner records (the 0115 guard refuses anyone else).
 */
export function TaxAuditCard({
  clientId,
  updatedAt,
  canDecide,
  turnoverPaise,
  turnoverFy,
  entityType,
  params,
  decision,
  note,
  decidedBy,
  decidedAt,
}: {
  clientId: string
  updatedAt: string
  canDecide: boolean
  turnoverPaise: Paise | null
  turnoverFy: string | null
  entityType: EntityType | null
  params: TaxAuditParams
  decision: TaxAuditDecision | null
  note: string | null
  decidedBy: string | null
  decidedAt: string | null
}) {
  const [nature, setNature] = React.useState<IncomeNature>("business")
  const [cashReceipts, setCashReceipts] = React.useState("")
  const [cashPayments, setCashPayments] = React.useState("")
  const [declared, setDeclared] = React.useState("")
  const [aboveExemption, setAboveExemption] = React.useState<boolean | null>(null)
  const [editing, setEditing] = React.useState(false)
  const ids = { nature: React.useId(), cr: React.useId(), cp: React.useId(), dp: React.useId(), ex: React.useId() }

  const num = (v: string) => (v.trim() === "" ? null : Number(v))
  const result = taxAuditIndication(
    {
      nature,
      turnover: turnoverPaise,
      cashReceiptsPct: num(cashReceipts),
      cashPaymentsPct: num(cashPayments),
      declaredProfitPct: num(declared),
      incomeAboveBasicExemption: aboveExemption,
    },
    params,
  )
  const section = turnoverFy && isFinancialYear(turnoverFy) && incomeTaxStatute(turnoverFy) === "2025" ? "s.63, Income-tax Act, 2025" : "s.44AB, Income-tax Act, 1961"
  const presumptive = nature === "presumptive_44ad" || nature === "presumptive_44ada"
  const showCash = result.askCashRatio || nature === "presumptive_44ad"
  const showDeclared = presumptive || nature === "profession"
  const individualOrHuf = entityType === "individual" || entityType === "proprietorship" || entityType === "huf"

  return (
    <SectionCard
      id="tax-audit"
      title="Tax audit"
      description={`Indication under ${section}${turnoverFy ? ` for FY ${turnoverFy}` : ""}`}
      action={
        canDecide ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <PencilIcon aria-hidden="true" />
            {decision ? "Change decision" : "Record decision"}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-text-muted">Partner&apos;s decision</p>
          {decision ? (
            <div className="flex flex-col gap-1">
              <StatusChip label={TAX_AUDIT_DECISION_LABELS[decision]} tone={DECISION_TONE[decision]} variant="pill" className="self-start" />
              {note ? <p className="text-base whitespace-pre-line text-text">{note}</p> : null}
              {decidedBy || decidedAt ? (
                <p className="text-sm text-text-muted">
                  Recorded{decidedBy ? ` by ${decidedBy}` : ""}
                  {decidedAt ? ` on ${formatDate(decidedAt)}` : ""}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-base text-text-muted">{canDecide ? "Not decided yet. Review the indication and record your decision." : "Not decided yet. A Partner records it."}</p>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-3">
          {turnoverPaise === null ? (
            <p className="text-sm text-text-muted">
              No turnover is recorded, so there is no indication yet.{" "}
              <Link href={`/clients/${clientId}?tab=profile#master-data`} className="font-medium text-primary hover:underline">
                Add the turnover
              </Link>
              .
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <StatusChip label={INDICATION[result.indication].label} tone={INDICATION[result.indication].tone} />
                <div className="flex items-center gap-2">
                  <label htmlFor={ids.nature} className="text-sm text-text-muted">
                    Income from
                  </label>
                  <NativeSelect id={ids.nature} size="sm" value={nature} onChange={(e) => setNature(e.target.value as IncomeNature)}>
                    {(Object.keys(NATURE_LABELS) as IncomeNature[])
                      .filter((n) => individualOrHuf || n === "business" || n === "profession" || n === "presumptive_44ad")
                      .map((n) => (
                        <NativeSelectOption key={n} value={n}>
                          {NATURE_LABELS[n]}
                        </NativeSelectOption>
                      ))}
                  </NativeSelect>
                </div>
              </div>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-base text-text">
                {result.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
              {showCash || showDeclared ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {showCash ? (
                    <>
                      <PctField id={ids.cr} label="Cash receipts, % of total" value={cashReceipts} onChange={setCashReceipts} />
                      {nature === "business" ? <PctField id={ids.cp} label="Cash payments, % of total" value={cashPayments} onChange={setCashPayments} /> : null}
                    </>
                  ) : null}
                  {showDeclared ? (
                    <PctField id={ids.dp} label={nature === "presumptive_44ad" ? "Profit declared, % of turnover" : "Income declared, % of receipts"} value={declared} onChange={setDeclared} />
                  ) : null}
                  {presumptive ? (
                    <label htmlFor={ids.ex} className="flex items-center gap-2 text-sm text-text sm:col-span-2">
                      <Checkbox id={ids.ex} checked={aboveExemption === true} onCheckedChange={(v) => setAboveExemption(v === true ? true : v === false ? false : null)} />
                      Total income is above the basic exemption limit
                    </label>
                  ) : null}
                </div>
              ) : null}
              <p className="text-sm text-text-muted">{TAX_AUDIT_DISCLAIMER} The answers above are only for this check; they aren&apos;t saved.</p>
            </>
          )}
        </div>
      </div>
      {canDecide ? (
        <DecisionDialog open={editing} onOpenChange={setEditing} clientId={clientId} updatedAt={updatedAt} decision={decision} note={note} suggested={turnoverPaise === null ? null : result.indication} />
      ) : null}
    </SectionCard>
  )
}

function PctField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <PercentInput id={id} value={value} onChange={onChange} />
    </div>
  )
}

function DecisionDialog({
  open,
  onOpenChange,
  clientId,
  updatedAt,
  decision,
  note,
  suggested,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  clientId: string
  updatedAt: string
  decision: TaxAuditDecision | null
  note: string | null
  suggested: "yes" | "no" | "review" | null
}) {
  const router = useRouter()
  const defaults = { clientId, updatedAt, decision: decision ?? suggested ?? undefined, note: note ?? "" }
  const f = useActionForm(TaxAuditDecisionSchema, setTaxAuditDecision, {
    defaultValues: defaults,
    successMessage: "Tax-audit decision recorded.",
    onSuccess: () => {
      onOpenChange(false)
      router.refresh()
    },
  })
  React.useEffect(() => {
    if (open) f.form.reset(defaults)
    // Reset when the dialog opens with the latest values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, updatedAt])

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Tax-audit decision"
      description="Your decision on whether this client needs a tax audit. It is kept on the client and in its history."
      onSubmit={f.onSubmit}
      pending={f.pending}
      dirty={f.form.formState.isDirty}
      submitLabel="Record decision"
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <FormAlert state={f} />
        <SelectField
          control={f.control}
          name="decision"
          label="Decision"
          required
          options={TAX_AUDIT_DECISIONS.map((d) => ({ value: d, label: TAX_AUDIT_DECISION_LABELS[d] }))}
          helper={suggested ? `The indication says: ${INDICATION[suggested].label.toLowerCase()}.` : undefined}
        />
        <TextareaField control={f.control} name="note" label="Note" rows={4} maxLength={1000} helper="Required for Partner to review: say what still needs checking." />
      </div>
    </FormDialog>
  )
}
