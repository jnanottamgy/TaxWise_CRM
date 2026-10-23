"use client"

import { CheckIcon, LockIcon, PlusIcon, ShieldAlertIcon, ShieldCheckIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { SERVICE_TYPES, type ServiceType } from "@/lib/domain/enums"
import {
  AUDIT_ACCEPTANCE_ITEMS,
  AUDIT_KIND_LABELS,
  AUDIT_KINDS,
  QUOTATION_SERVICES_LOCK,
  SERVICE_CARD_TITLES,
  SERVICE_DESCRIPTIONS,
  serviceName,
  type OnboardingValues,
} from "@/lib/schemas/onboarding"
import { Button } from "@/components/ui/button"
import { CheckboxGroupField, TextField } from "@/components/app/form/fields"
import type { OnboardingControl } from "@/components/clients/onboarding/types"

const AUDIT_OPTIONS = AUDIT_KINDS.map((k) => ({ value: k, label: AUDIT_KIND_LABELS[k] }))

/**
 * Step 2, Services (§7.3.2): one selectable card per service with a one-line description. Other
 * needs a name. Audit asks which audit and brings the KYC and previous-auditor steps into the
 * acceptance checklist; it also needs the conflict check accepted. From a quotation the services
 * are the accepted ones and can't be changed here.
 */
export function StepServices({
  control,
  values,
  locked,
  servicesError,
  onToggle,
  onAddOther,
  onRemoveAt,
  acceptanceOutcome,
  onOpenConflictCheck,
}: {
  control: OnboardingControl
  values: OnboardingValues
  locked: boolean
  servicesError: string | null
  onToggle: (service: ServiceType) => void
  onAddOther: () => void
  onRemoveAt: (index: number) => void
  acceptanceOutcome: string
  onOpenConflictCheck: () => void
}) {
  const services = values.services ?? []
  const selected = new Set(services.map((s) => s.service_type))
  const audit = selected.has("audit")
  const suggestIncorporation = values.is_incorporated === false && !selected.has("incorporation")

  return (
    <div className="flex flex-col gap-5">
      {locked ? (
        <p className="flex gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-base text-text">
          <LockIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-muted" />
          {QUOTATION_SERVICES_LOCK}
        </p>
      ) : null}
      {servicesError ? (
        <p role="alert" className="text-sm text-danger-text">
          {servicesError}
        </p>
      ) : null}

      <div role="group" aria-label="Services" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {SERVICE_TYPES.map((s) => {
          const on = selected.has(s)
          return (
            <button
              key={s}
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={locked}
              onClick={() => onToggle(s)}
              className={cn(
                "relative flex min-h-[5.25rem] cursor-pointer flex-col items-start gap-1 rounded-lg border px-4 py-3 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed",
                on ? "border-primary bg-primary-soft" : "border-border bg-surface hover:bg-surface-2",
                locked && !on && "opacity-60",
              )}
            >
              <span className="flex w-full items-start justify-between gap-2">
                <span className="text-base font-medium text-text">{SERVICE_CARD_TITLES[s]}</span>
                <span
                  aria-hidden="true"
                  className={cn("flex size-5 flex-none items-center justify-center rounded border", on ? "border-primary bg-primary text-primary-foreground" : "border-text-muted/40 bg-surface")}
                >
                  {on ? <CheckIcon className="size-3.5" /> : null}
                </span>
              </span>
              <span className="text-sm text-text-muted">{SERVICE_DESCRIPTIONS[s]}</span>
              {s === "incorporation" && suggestIncorporation ? (
                <span className="mt-0.5 rounded-full border border-info/40 bg-info-soft px-2 text-xs leading-5 text-info-text">Suggested: not yet incorporated</span>
              ) : null}
            </button>
          )
        })}
      </div>

      {selected.has("other") ? (
        <section aria-label="Other services" className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3">
          {services.map((sv, i) =>
            sv.service_type === "other" ? (
              <div key={`other-${i}`} className="flex items-end gap-2">
                <TextField control={control} name={`services.${i}.custom_name`} label="Name of the service" required placeholder="For example: FEMA filings" className="min-w-0 flex-1" disabled={locked} />
                {!locked ? (
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${serviceName({ service_type: "other", custom_name: sv.custom_name ?? "" })}`} onClick={() => onRemoveAt(i)}>
                    <XIcon aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            ) : null,
          )}
          {!locked ? (
            <div>
              <Button type="button" variant="ghost" size="sm" onClick={onAddOther}>
                <PlusIcon aria-hidden="true" />
                Add another service
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      {audit ? (
        <section aria-labelledby="audit-setup" className="flex flex-col gap-4 rounded-lg border border-border px-4 py-3">
          <h3 id="audit-setup" className="text-md font-semibold text-text">
            Audit
          </h3>
          <CheckboxGroupField control={control} name="audit_kinds" label="Which audit" required options={AUDIT_OPTIONS} columns={2} />
          <div className="text-sm text-text-muted">
            <p>Added to the client&apos;s acceptance checklist:</p>
            <ul className="mt-1 list-disc pl-4">
              {AUDIT_ACCEPTANCE_ITEMS.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
          <div
            className={cn(
              "flex flex-wrap items-center gap-3 rounded-md border px-3 py-2",
              acceptanceOutcome === "accepted" ? "border-success/40 bg-success-soft" : "border-warning/40 bg-warning-soft",
            )}
          >
            {acceptanceOutcome === "accepted" ? (
              <ShieldCheckIcon aria-hidden="true" className="size-4 flex-none text-success-text" />
            ) : (
              <ShieldAlertIcon aria-hidden="true" className="size-4 flex-none text-warning-text" />
            )}
            <p className={cn("min-w-0 flex-1 text-sm", acceptanceOutcome === "accepted" ? "text-success-text" : "text-warning-text")}>
              {acceptanceOutcome === "accepted"
                ? "The conflict check is accepted."
                : acceptanceOutcome === "declined"
                  ? "The conflict check was declined, so this client can't be onboarded for audit."
                  : acceptanceOutcome === "pending"
                    ? "The conflict check is waiting for a decision. Audit work needs Accept."
                    : "Audit work needs the conflict check, with the decision Accept, before you continue."}
            </p>
            {acceptanceOutcome !== "accepted" ? (
              <Button type="button" size="sm" variant="outline" onClick={onOpenConflictCheck}>
                {acceptanceOutcome === "" ? "Run conflict check" : "Open the check"}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  )
}
