import type { Control, UseFormReturn } from "react-hook-form"
import type { OnboardingData, OnboardingValues } from "@/lib/schemas/onboarding"
import type { StaffOption } from "@/lib/data/clients"
import type { ServiceType } from "@/lib/domain/enums"
import type { ScaleContext, NotifyChannel } from "@/lib/schemas/onboarding"

/** The wizard's react-hook-form instance and control (input values in, parsed values out). */
export type OnboardingForm = UseFormReturn<OnboardingValues, unknown, OnboardingData>
export type OnboardingControl = Control<OnboardingValues, unknown, OnboardingData>

/** What the page hands the wizard (serialisable). */
export type WizardSetup = {
  today: string
  clientCode: string
  reminderDays: number
  notifyChannels: NotifyChannel[]
  staff: StaffOption[]
  scale: ScaleContext
  sacByService: Partial<Record<ServiceType, string>>
  defaultSac: string
  viewer: { role: "partner" | "manager"; employeeId: string | null }
}

/** Where the wizard was opened from (§7.3.2 "From a quotation", §7.5.1 "Convert to client"). */
export type WizardSource =
  | { kind: "new" }
  | { kind: "quotation"; id: string; number: string; leadId: string | null }
  | { kind: "lead"; id: string; number: string | null }

/** A file picked for a checklist item in step 4, uploaded once the client exists. */
export type QueuedFile = { itemKey: string; file: File }

/**
 * The wizard draft's key on this device: per person (§0.1 rule 15: nothing saved for one user is
 * offered to another who signs in on the same browser; the draft holds fees and the client's
 * details).
 */
export function draftKeyFor(source: WizardSource, viewerId: string | null): string {
  const who = viewerId ?? "anyone"
  return source.kind === "new" ? `client-wizard:${who}:new` : `client-wizard:${who}:${source.kind}:${source.id}`
}
