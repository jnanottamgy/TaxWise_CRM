"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TimeEntryDialog } from "@/components/timesheet/time-entry-dialog"

/**
 * "Log time" on the timesheet (§7.10 manual entry). `/timesheet?new=1` (the shell's timer sheet and
 * New menu) opens it straight away and then drops `new` from the address, so a reload doesn't
 * reopen it.
 */
export function TimesheetLogTime({ date, variant = "default" }: { date?: string; variant?: "default" | "outline" }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const wantsNew = params.get("new") === "1"
  const [open, setOpen] = React.useState(wantsNew)
  // Reached again with ?new=1 while already on the page (the timer sheet's "Log time").
  const [seenNew, setSeenNew] = React.useState(wantsNew)
  if (seenNew !== wantsNew) {
    setSeenNew(wantsNew)
    if (wantsNew) setOpen(true)
  }

  React.useEffect(() => {
    if (!wantsNew) return
    const next = new URLSearchParams(params.toString())
    next.delete("new")
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [wantsNew, params, pathname, router])

  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        Log time
      </Button>
      {open ? <TimeEntryDialog open={open} onOpenChange={setOpen} initial={date ? { date } : {}} /> : null}
    </>
  )
}
