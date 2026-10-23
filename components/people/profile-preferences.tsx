"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import { toast } from "sonner"
import { Controller, useWatch } from "react-hook-form"
import { CheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { FormAlert } from "@/components/app/form/form-alert"
import { UnsavedChangesGuard } from "@/components/app/unsaved-changes"
import { useActionForm } from "@/hooks/use-action-form"
import { applyDensity } from "@/components/shell/user-menu"
import { saveTheme } from "@/server/actions/preferences"
import { saveMessagingPreferences, saveNotificationPreferences } from "@/server/actions/profile"
import type { AppRole } from "@/lib/auth/roles"
import type { DensityPreference, ThemePreference } from "@/lib/preferences"
import { NotificationPrefsSchema, notificationEventsFor, type NotificationEvent } from "@/lib/schemas/profile"
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
// Notifications (§7.1, §7.17): in-app always on; email per event
// -------------------------------------------------------------------------------------------------

/**
 * Per event and channel: In-app is always on (the Inbox and the bell); Email can be turned on or off
 * for each event this role receives. Money events show only to Partners and Managers (§4.1).
 */
export function NotificationsCard({ role, email, digest = false }: { role: AppRole; email: Record<string, boolean>; digest?: boolean }) {
  const events = React.useMemo(() => notificationEventsFor(role), [role])
  const groups = React.useMemo(() => {
    const out: Array<{ group: NotificationEvent["group"]; events: NotificationEvent[] }> = []
    for (const e of events) {
      const g = out.find((x) => x.group === e.group)
      if (g) g.events.push(e)
      else out.push({ group: e.group, events: [e] })
    }
    return out
  }, [events])

  const f = useActionForm(NotificationPrefsSchema, saveNotificationPreferences, {
    defaultValues: role === "partner" ? { email, digest } : { email },
    successMessage: "Notification choices saved.",
  })
  const values = useWatch({ control: f.control, name: "email" }) as Record<string, boolean | undefined> | undefined
  const onCount = events.filter((e) => values?.[e.type]).length
  const dirty = f.form.formState.isDirty

  const setAll = (on: boolean) => {
    for (const e of events) f.form.setValue(`email.${e.type}`, on, { shouldDirty: true })
  }

  return (
    <ProfileCard
      id="notifications"
      title="Notifications"
      description="Everything reaches your Inbox. Choose what also comes by email."
      action={<span className="num text-sm text-text-muted">{onCount === 0 ? "No emails" : `${onCount} of ${events.length} by email`}</span>}
    >
      <form noValidate onSubmit={f.onSubmit} className="flex flex-col gap-4">
        <UnsavedChangesGuard when={dirty && !f.pending} />
        <FormAlert state={f} />
        <div className="-mx-4 overflow-x-auto md:-mx-5">
          <table className="w-full min-w-[22rem] border-separate border-spacing-0 text-base">
            <caption className="sr-only">Notification channels for each event</caption>
            <thead>
              <tr>
                <th scope="col" className="h-9 border-b border-border px-4 text-left text-xs font-medium text-text-muted md:px-5">
                  Event
                </th>
                <th scope="col" className="h-9 w-20 border-b border-border px-2 text-center text-xs font-medium text-text-muted">
                  In-app
                </th>
                <th scope="col" className="h-9 w-20 border-b border-border px-4 text-center text-xs font-medium text-text-muted md:px-5">
                  Email
                </th>
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.group}>
                <tr>
                  <th scope="rowgroup" colSpan={3} className="border-b border-border/70 bg-surface-2/60 px-4 py-1.5 text-left text-sm font-medium text-text md:px-5">
                    {g.group}
                  </th>
                </tr>
                {g.events.map((e) => {
                  const id = `notify-email-${e.type}`
                  return (
                    <tr key={e.type}>
                      <th scope="row" className="border-b border-border/70 px-4 py-2 text-left font-normal text-text md:px-5">
                        <label htmlFor={id} className="cursor-pointer">
                          {e.label}
                        </label>
                      </th>
                      <td className="border-b border-border/70 px-2 py-2 text-center">
                        <span className="inline-flex items-center justify-center text-text-muted" title="Always on: every notification reaches your Inbox.">
                          <CheckIcon aria-hidden="true" className="size-4" />
                          <span className="sr-only">Always on</span>
                        </span>
                      </td>
                      <td className="border-b border-border/70 px-4 py-2 text-center md:px-5">
                        <Controller
                          control={f.control}
                          name={`email.${e.type}`}
                          render={({ field }) => (
                            <Switch
                              id={id}
                              checked={!!field.value}
                              onCheckedChange={(v) => field.onChange(v)}
                              onBlur={field.onBlur}
                              aria-label={`Email: ${e.label}`}
                            />
                          )}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            ))}
            {role === "partner" ? (
              <tbody>
                <tr>
                  <th scope="rowgroup" colSpan={3} className="border-b border-border/70 bg-surface-2/60 px-4 py-1.5 text-left text-sm font-medium text-text md:px-5">
                    Daily digest
                  </th>
                </tr>
                <tr>
                  <th scope="row" className="border-b border-border/70 px-4 py-2 text-left font-normal text-text md:px-5">
                    <label htmlFor="notify-email-digest" className="cursor-pointer">
                      The 08:00 digest: today&apos;s deadlines, approvals waiting, overdue receivables and unassigned work
                    </label>
                  </th>
                  <td className="border-b border-border/70 px-2 py-2 text-center">
                    <span className="text-text-muted" title="The digest is an email only.">
                      <span aria-hidden="true">–</span>
                      <span className="sr-only">Email only</span>
                    </span>
                  </td>
                  <td className="border-b border-border/70 px-4 py-2 text-center md:px-5">
                    <Controller
                      control={f.control}
                      name="digest"
                      render={({ field }) => (
                        <Switch id="notify-email-digest" checked={!!field.value} onCheckedChange={(v) => field.onChange(v)} onBlur={field.onBlur} aria-label="Email: the daily digest" />
                      )}
                    />
                  </td>
                </tr>
              </tbody>
            ) : null}
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setAll(true)} disabled={f.pending}>
              Email me everything
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAll(false)} disabled={f.pending}>
              No emails
            </Button>
          </div>
          <div className="flex items-center gap-2">
            {dirty ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => f.form.reset()} disabled={f.pending}>
                Discard
              </Button>
            ) : null}
            <Button type="submit" size="sm" disabled={!dirty || f.pending}>
              {f.pending ? <Spinner /> : null}
              Save choices
            </Button>
          </div>
        </div>
      </form>
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
