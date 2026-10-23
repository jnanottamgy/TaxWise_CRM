"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EventForm } from "@/components/compliance/event-form"
import { withEvent } from "@/components/compliance/logic/urls"

/**
 * "New deadline" (§7.7 event form) for Partners and Managers: on the calendar (any client, or
 * firm-level) and on Client 360 → Compliance (that client). After saving, the new deadline opens.
 * `defaultOpen` opens it straight away (the coverage-gaps "Add a deadline" link).
 */
export function NewDeadlineButton({
  clients,
  fixedClient,
  fyOptions,
  defaultFy,
  reminderDays,
  defaultDue,
  defaultOpen = false,
  variant = "default",
}: {
  clients?: Array<{ id: string; name: string; code: string }>
  fixedClient?: { id: string; name: string; code: string } | null
  fyOptions: string[]
  defaultFy: string
  reminderDays: number
  /** The day the calendar is showing, when one is chosen. */
  defaultDue?: string
  defaultOpen?: boolean
  variant?: "default" | "outline"
}) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [open, setOpen] = React.useState(defaultOpen)
  return (
    <>
      <Button variant={variant} size="sm" onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        New deadline
      </Button>
      {open ? (
        <EventForm
          open
          onOpenChange={(next) => {
            setOpen(next)
            if (!next && sp.has("new_deadline")) {
              const rest = new URLSearchParams(sp.toString())
              rest.delete("new_deadline")
              const qs = rest.toString()
              router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
            }
          }}
          event={null}
          clients={clients}
          fixedClient={fixedClient}
          fyOptions={fyOptions}
          defaultFy={defaultFy}
          reminderDays={reminderDays}
          defaultDue={defaultDue}
          onSaved={(id) => {
            const next = new URLSearchParams(sp.toString())
            next.delete("new_deadline")
            router.replace(withEvent(pathname, next, id), { scroll: false })
          }}
        />
      ) : null}
    </>
  )
}
