"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { SearchCheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { FormDialog } from "@/components/app/form-dialog"
import { FieldShell } from "@/components/app/form/field-shell"
import { ConflictCheckDialog } from "@/components/clients/onboarding/conflict-check-dialog"
import { validateGstin, validatePan } from "@/lib/domain/india-validators"

type Prospect = { name: string; pan: string; gstin: string; attest: boolean }

/**
 * A conflict check for a prospect who isn't a lead yet (§7.5.4 inputs: prospect name*, PAN, GSTIN;
 * the related parties are added in the check itself). Opens the same check and decision the
 * onboarding wizard and the lead page use; the result lands in the register.
 */
export function NewConflictCheckButton({ size = "default" }: { size?: "sm" | "default" }) {
  const router = useRouter()
  const [step, setStep] = React.useState<null | "details" | "check">(null)
  const [p, setP] = React.useState<Prospect>({ name: "", pan: "", gstin: "", attest: false })
  const [errors, setErrors] = React.useState<{ name?: string; pan?: string; gstin?: string }>({})

  const validate = (): boolean => {
    const next: typeof errors = {}
    const name = p.name.trim()
    if (name.length < 2) next.name = "Enter the prospect's name."
    const pan = p.pan.trim().toUpperCase()
    if (pan && !validatePan(pan).ok) next.pan = "That PAN isn't valid: 5 letters, 4 digits, 1 letter."
    const gstin = p.gstin.trim().toUpperCase()
    if (gstin && !validateGstin(gstin).ok) next.gstin = "That GSTIN isn't valid: check the 15 characters."
    if (pan && gstin && validateGstin(gstin).ok && gstin.slice(2, 12) !== pan) next.gstin = "The GSTIN doesn't contain this PAN (characters 3 to 12)."
    setErrors(next)
    return Object.keys(next).length === 0
  }

  return (
    <>
      <Button
        size={size}
        onClick={() => {
          setP({ name: "", pan: "", gstin: "", attest: false })
          setErrors({})
          setStep("details")
        }}
      >
        <SearchCheckIcon aria-hidden="true" />
        New conflict check
      </Button>
      <FormDialog
        open={step === "details"}
        onOpenChange={(o) => !o && setStep(null)}
        size="sm"
        title="New conflict check"
        description="Who is the prospect? The check searches clients, leads, contacts, directors, partners and related parties."
        submitLabel="Continue to the check"
        dirty={Boolean(p.name || p.pan || p.gstin)}
        onSubmit={(e) => {
          e.preventDefault()
          if (validate()) setStep("check")
        }}
      >
        <div className="flex flex-col gap-4">
          <FieldShell id="ncc-name" label="Prospect name" required error={errors.name ?? null} helper="The business or person, as they'd be onboarded.">
            {(aria) => <Input {...aria} value={p.name} onChange={(e) => setP((x) => ({ ...x, name: e.target.value }))} maxLength={200} autoComplete="off" />}
          </FieldShell>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FieldShell id="ncc-pan" label="PAN" error={errors.pan ?? null}>
              {(aria) => (
                <Input {...aria} value={p.pan} onChange={(e) => setP((x) => ({ ...x, pan: e.target.value.toUpperCase() }))} maxLength={10} autoComplete="off" autoCapitalize="characters" spellCheck={false} className="font-mono" />
              )}
            </FieldShell>
            <FieldShell id="ncc-gstin" label="GSTIN" error={errors.gstin ?? null}>
              {(aria) => (
                <Input {...aria} value={p.gstin} onChange={(e) => setP((x) => ({ ...x, gstin: e.target.value.toUpperCase() }))} maxLength={15} autoComplete="off" autoCapitalize="characters" spellCheck={false} className="font-mono" />
              )}
            </FieldShell>
          </div>
          <label className="flex min-h-9 cursor-pointer items-start gap-2.5 text-base text-text">
            <Checkbox checked={p.attest} onCheckedChange={(v) => setP((x) => ({ ...x, attest: v === true }))} className="mt-0.5" />
            <span>
              For audit (attest) work
              <span className="block text-sm text-text-muted">The independence questions are answered before accepting.</span>
            </span>
          </label>
        </div>
      </FormDialog>
      <ConflictCheckDialog
        open={step === "check"}
        onOpenChange={(o) => !o && setStep(null)}
        prospectName={p.name.trim()}
        legalName=""
        pan={p.pan.trim().toUpperCase()}
        gstin={p.gstin.trim().toUpperCase()}
        leadId={null}
        attest={p.attest}
        current={null}
        onDecided={(r) => {
          if (r.outcome !== "pending") {
            toast.success(`Conflict check recorded: ${r.outcome === "accepted" ? "Accept" : "Decline"}.`)
          }
          router.refresh()
        }}
      />
    </>
  )
}
