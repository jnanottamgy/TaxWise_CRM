"use client"

import * as React from "react"
import { useController } from "react-hook-form"
import { ChevronDownIcon, LockIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { SERVICE_FREQUENCIES, SERVICE_FREQUENCY_LABELS, type ServiceFrequency } from "@/lib/domain/enums"
import type { GstSchemeDecision } from "@/lib/domain/scale"
import { formatDate, formatMoney } from "@/lib/format"
import { paiseToDecimalString } from "@/lib/domain/money"
import { gstFrequencyLock, moneyToPaise, PRIORITY_OPTIONS, serviceName, type OnboardingValues } from "@/lib/schemas/onboarding"
import type { StaffOption } from "@/lib/data/clients"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Label } from "@/components/ui/label"
import { Combobox, type ComboOption } from "@/components/app/form/combobox"
import { ComboboxField, DateField, MoneyField, SelectField, SwitchField, TextField } from "@/components/app/form/fields"
import { fieldDomId } from "@/hooks/use-action-form"
import type { OnboardingControl } from "@/components/clients/onboarding/types"
import type { PreviewState } from "@/components/clients/onboarding/use-deadline-preview"

const FREQUENCY_OPTIONS = SERVICE_FREQUENCIES.map((f) => ({ value: f, label: SERVICE_FREQUENCY_LABELS[f] }))
const ROLE_WORD: Record<string, string> = { partner: "Partner", manager: "Manager", employee: "Employee" }

function staffOption(s: StaffOption): ComboOption {
  return { value: s.id, label: s.name, description: [ROLE_WORD[s.role] ?? s.role, s.designation].filter(Boolean).join(" · ") }
}

/**
 * Step 3, Configure services and team (§7.3.2): one collapsible panel per service with filing
 * frequency (GST locked to the scheme, with the reason), next due date (the statutory calendar's
 * date unless typed), the agreed fee per billing occurrence (Partners and Managers only), billing
 * frequency, automatic invoicing with its first billing date, and the SAC override. Then the owner,
 * the engagement team and the priority.
 */
export function StepConfigure({
  control,
  values,
  today,
  decision,
  preview,
  staff,
  sacByService,
  defaultSac,
  seesFees,
  errorPaths,
}: {
  control: OnboardingControl
  values: OnboardingValues
  today: string
  decision: GstSchemeDecision
  preview: PreviewState
  staff: StaffOption[]
  sacByService: Partial<Record<string, string>>
  defaultSac: string
  seesFees: boolean
  /** Field paths with errors (opens the panel that holds one). */
  errorPaths: string[]
}) {
  const services = values.services ?? []
  const [open, setOpen] = React.useState<Record<number, boolean>>({})
  const lock = gstFrequencyLock(decision)
  const everyone = React.useMemo(() => staff.map(staffOption), [staff])
  const partners = React.useMemo(() => staff.filter((s) => s.role === "partner").map(staffOption), [staff])
  const reviewers = React.useMemo(() => staff.filter((s) => s.role === "partner" || s.role === "manager").map(staffOption), [staff])

  return (
    <div className="flex flex-col gap-5">
      <ol className="flex flex-col gap-3" aria-label="Services">
        {services.map((s, i) => {
          const hasError = errorPaths.some((p) => p.startsWith(`services.${i}.`))
          const isOpen = open[i] ?? (i === 0 || hasError)
          const frequency = (s.service_type === "gst" ? lock.frequency : (s.frequency ?? "annual")) as ServiceFrequency
          const auto = preview.nextDue[s.service_type]
          const fee = moneyToPaise(s.agreed_fee)
          const summary = [
            SERVICE_FREQUENCY_LABELS[frequency],
            seesFees && fee !== null ? `${formatMoney(paiseToDecimalString(fee))} per bill` : null,
            s.auto_invoice ? "Invoiced automatically" : null,
          ]
            .filter(Boolean)
            .join(" · ")
          return (
            <li key={`${s.service_type}-${i}`}>
              <Collapsible open={isOpen} onOpenChange={(o) => setOpen((m) => ({ ...m, [i]: o }))} className="rounded-lg border border-border bg-surface">
                <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  <span className="min-w-0">
                    <span className="block text-md font-semibold text-text">{serviceName({ service_type: s.service_type, custom_name: s.custom_name ?? "" })}</span>
                    <span className="block truncate text-sm text-text-muted">
                      {summary}
                      {hasError ? <span className="text-danger-text"> · Needs attention</span> : null}
                    </span>
                  </span>
                  <ChevronDownIcon aria-hidden="true" className={cn("size-4 flex-none text-text-muted transition-transform duration-150", isOpen && "rotate-180")} />
                </CollapsibleTrigger>
                <CollapsibleContent className="border-t border-border px-4 py-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {s.service_type === "gst" ? (
                      <div className="flex flex-col gap-1.5">
                        <span className="text-sm leading-5 font-medium text-text">
                          Filing frequency<span aria-hidden="true" className="ml-0.5 text-danger-text">*</span>
                        </span>
                        <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-surface-2 px-3 text-base text-text">
                          <LockIcon aria-hidden="true" className="size-3.5 text-text-muted" />
                          {SERVICE_FREQUENCY_LABELS[lock.frequency]}
                        </div>
                        <p className="text-sm text-text-muted">{lock.explanation}</p>
                      </div>
                    ) : (
                      <SelectField control={control} name={`services.${i}.frequency`} label="Filing frequency" required options={FREQUENCY_OPTIONS} />
                    )}
                    <DateField
                      control={control}
                      name={`services.${i}.next_due_date`}
                      label="Next due date"
                      min={today}
                      helper={
                        s.next_due_date
                          ? auto
                            ? `Typed by hand. The statutory calendar says ${formatDate(auto)}.`
                            : "Typed by hand."
                          : auto
                            ? `From the statutory calendar: ${formatDate(auto)}. Type a date to change it.`
                            : preview.status === "loading" && !preview.events
                              ? "Working out the statutory date…"
                              : "No statutory date for this service. Set one if the work has a deadline."
                      }
                    />
                    {seesFees ? (
                      <>
                        <MoneyField control={control} name={`services.${i}.agreed_fee`} label="Agreed fee (₹, excl. GST)" placeholder="0.00" helper="Per billing occurrence." />
                        <SelectField
                          control={control}
                          name={`services.${i}.billing_frequency`}
                          label="Billing frequency"
                          options={FREQUENCY_OPTIONS}
                          placeholder={`Same as filing (${SERVICE_FREQUENCY_LABELS[frequency]})`}
                        />
                        <div className="flex flex-col gap-3 md:col-span-2">
                          <SwitchField
                            control={control}
                            name={`services.${i}.auto_invoice`}
                            label="Raise invoices automatically"
                            description={
                              frequency === "one_time"
                                ? "A one-time service is invoiced by hand."
                                : "A draft invoice is raised on each billing date for a Partner or Manager to issue. Paused while the client is on hold or inactive."
                            }
                            disabled={frequency === "one_time" && !s.auto_invoice}
                          />
                          {s.auto_invoice ? (
                            <DateField control={control} name={`services.${i}.first_billing_date`} label="First billing date" required min={today} className="md:max-w-xs" />
                          ) : null}
                        </div>
                      </>
                    ) : null}
                    <TextField
                      control={control}
                      name={`services.${i}.sac_code`}
                      label="SAC override"
                      inputMode="numeric"
                      maxLength={8}
                      placeholder={sacByService[s.service_type] ?? defaultSac}
                      helper={`Leave blank to use ${sacByService[s.service_type] ?? defaultSac} from Settings.`}
                      className="[&_input]:tabular-nums"
                    />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </li>
          )
        })}
      </ol>

      <section aria-labelledby="team-title" className="rounded-lg border border-border bg-surface px-4 py-4">
        <h3 id="team-title" className="text-md font-semibold text-text">
          Owner and team
        </h3>
        <p className="mt-0.5 text-sm text-text-muted">The owner leads the work and gets the first tasks. The team sees the client and its work.</p>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <ComboboxField control={control} name="owner_employee_id" label="Client owner" required options={everyone} placeholder="Choose a member of the team" searchPlaceholder="Search the team" />
          <SelectField control={control} name="priority" label="Priority" options={PRIORITY_OPTIONS.map((p) => ({ value: p.value, label: p.label }))} />
          <ComboboxField
            control={control}
            name="engagement_partner_id"
            label="Engagement partner"
            options={partners}
            placeholder="Choose a Partner"
            searchPlaceholder="Search Partners"
            emptyText="No Partners found."
            helper="Signs off the work. Gets the WhatsApp group to-do."
          />
          <ComboboxField control={control} name="review_manager_id" label="Review manager" options={reviewers} placeholder="Choose a reviewer" searchPlaceholder="Search Partners and Managers" />
          <PreparersField control={control} options={everyone} className="md:col-span-2" />
        </div>
      </section>
    </div>
  )
}

function PreparersField({ control, options, className }: { control: OnboardingControl; options: ComboOption[]; className?: string }) {
  const { field, fieldState } = useController({ control, name: "preparer_ids" })
  const value = (field.value as string[] | undefined) ?? []
  const id = fieldDomId(control, "preparer_ids")
  const available = options.filter((o) => !value.includes(o.value))
  const byId = new Map(options.map((o) => [o.value, o]))
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id}>Preparers</Label>
      <Combobox
        id={id}
        value={null}
        onChange={(v) => {
          if (v && !value.includes(v)) field.onChange([...value, v])
        }}
        options={available}
        placeholder={value.length ? "Add another preparer" : "Add a preparer"}
        searchPlaceholder="Search the team"
        clearable={false}
        disabled={value.length >= 10}
        aria-describedby={`${id}-help`}
        aria-invalid={fieldState.error ? true : undefined}
      />
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Preparers chosen">
          {value.map((v) => (
            <li key={v} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 py-0.5 pr-1 pl-2.5 text-sm text-text">
              {byId.get(v)?.label ?? "Former member"}
              <button
                type="button"
                onClick={() => field.onChange(value.filter((x) => x !== v))}
                aria-label={`Remove ${byId.get(v)?.label ?? "this preparer"}`}
                className="inline-flex size-5 cursor-pointer items-center justify-center rounded-full text-text-muted hover:bg-surface hover:text-text focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-8"
              >
                <XIcon aria-hidden="true" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p id={`${id}-help`} className={cn("text-sm", fieldState.error ? "text-danger-text" : "text-text-muted")}>
        {fieldState.error?.message ?? "Up to 10. They do the work; the review manager checks it."}
      </p>
    </div>
  )
}
