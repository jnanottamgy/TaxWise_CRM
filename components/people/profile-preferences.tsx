"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import { toast } from "sonner"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { applyDensity } from "@/components/shell/user-menu"
import { saveTheme } from "@/server/actions/preferences"
import { saveMessagingPreferences } from "@/server/actions/profile"
import type { DensityPreference, ThemePreference } from "@/lib/preferences"
import { cn } from "@/lib/utils"
import { ProfileCard } from "@/components/people/profile-card"

// -------------------------------------------------------------------------------------------------
// Appearance: theme and density (§3.1, §3.2, §7.1)
// -------------------------------------------------------------------------------------------------

function ChoiceRow<T extends string>({
  legend,
  value,
  onChange,
  choices,
}: {
  legend: string
  value: T | null
  onChange: (v: T) => void
  choices: Array<{ value: T; label: string; description: string }>
}) {
  const id = React.useId()
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1.5 text-sm leading-5 font-medium text-text">{legend}</legend>
      <RadioGroup value={value ?? ""} onValueChange={(v) => onChange(v as T)} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {choices.map((c) => {
          const cid = `${id}-${c.value}`
          const selected = value === c.value
          return (
            <label
              key={c.value}
              htmlFor={cid}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors duration-150",
                selected ? "border-primary bg-primary-soft" : "border-border bg-surface hover:bg-surface-2",
              )}
            >
              <RadioGroupItem id={cid} value={c.value} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-base leading-5 font-medium text-text">{c.label}</span>
                <span className="block text-sm text-text-muted">{c.description}</span>
              </span>
            </label>
          )
        })}
      </RadioGroup>
    </fieldset>
  )
}

/** Theme and density, applied at once and kept with your profile for your other devices. */
export function AppearanceCard({ initialDensity }: { initialDensity: DensityPreference }) {
  const { theme, setTheme } = useTheme()
  const [density, setDensity] = React.useState<DensityPreference>(initialDensity)
  // next-themes knows the theme only in the browser; until then nothing is shown as chosen.
  const mounted = React.useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  )
  const current = mounted && (theme === "light" || theme === "dark" || theme === "system") ? (theme as ThemePreference) : null

  return (
    <ProfileCard id="appearance" title="Appearance" description="Applies straight away, here and on your other devices.">
      <div className="flex flex-col gap-5">
        <ChoiceRow<ThemePreference>
          legend="Theme"
          value={current}
          onChange={(t) => {
            setTheme(t)
            void saveTheme({ theme: t }).then(
              (r) => (r.ok ? undefined : toast.error("Your theme is set on this browser only. It couldn't be saved to your profile.")),
              () => toast.error("Your theme is set on this browser only. It couldn't be saved to your profile."),
            )
          }}
          choices={[
            { value: "light", label: "Light", description: "Dark text on white." },
            { value: "dark", label: "Dark", description: "Easier in a dim room." },
            { value: "system", label: "Match my device", description: "Follows your computer or phone." },
          ]}
        />
        <ChoiceRow<DensityPreference>
          legend="Density"
          value={density}
          onChange={(d) => {
            setDensity(d)
            applyDensity(d)
          }}
          choices={[
            { value: "comfortable", label: "Comfortable", description: "Roomier rows, easier to scan." },
            { value: "compact", label: "Compact", description: "More rows on screen." },
          ]}
        />
      </div>
    </ProfileCard>
  )
}

// -------------------------------------------------------------------------------------------------
// WhatsApp drafts (§7.13.2, §7.25.10)
// -------------------------------------------------------------------------------------------------

/** "Add my signature to WhatsApp drafts": saved as soon as it is switched. */
export function MessagingCard({ whatsappSignature, example }: { whatsappSignature: boolean; example: string }) {
  const [on, setOn] = React.useState(whatsappSignature)
  const [pending, startTransition] = React.useTransition()
  const id = React.useId()
  const toggle = (next: boolean) => {
    setOn(next)
    startTransition(async () => {
      try {
        const r = await saveMessagingPreferences({ whatsapp_signature: next })
        if (!r.ok) {
          setOn(!next)
          toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
          return
        }
        toast.success(next ? "Your WhatsApp drafts will end with your signature." : "Your WhatsApp drafts won't add a signature.")
      } catch {
        setOn(!next)
        toast.error("We couldn't reach TaxWise to save that. Check your connection and try again.")
      }
    })
  }
  return (
    <ProfileCard id="messaging" title="WhatsApp drafts">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor={id} className="block cursor-pointer text-base leading-5 font-medium text-text">
            Add my signature to WhatsApp drafts
          </label>
          <p className="mt-0.5 text-sm text-text-muted">
            Clients see who wrote a message sent from a shared office number. Drafts end with <span className="font-medium text-text">{example}</span>.
          </p>
        </div>
        <span className="flex flex-none items-center gap-2">
          {pending ? <Spinner className="size-3.5 text-text-muted" /> : null}
          <Switch id={id} checked={on} onCheckedChange={toggle} disabled={pending} />
        </span>
      </div>
    </ProfileCard>
  )
}
