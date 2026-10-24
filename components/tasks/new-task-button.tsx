"use client"

import * as React from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NewTaskDialog, type TaskFormOptions } from "@/components/tasks/task-form"

/**
 * "New task" (§7.6.2). Opens itself when the page is reached with `?new=1` (the shell's "+ New"
 * menu, §3.3; `&client=<id>` fills in the client), then takes the flag out of the address so a
 * reload doesn't reopen it.
 */
export function NewTaskButton({
  options,
  defaultFy,
  client,
  autoOpen = true,
  openParam = "new",
  variant = "default",
  size = "default",
  label = "New task",
}: {
  options: TaskFormOptions
  defaultFy: string
  client?: { id: string; label: string } | null
  autoOpen?: boolean
  /** The search param (value "1") that opens the dialog on arrival: `new` from "+ New", `apply_template` from Client 360's "Apply job template". */
  openParam?: string
  variant?: "default" | "outline"
  size?: "default" | "sm"
  label?: string
}) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const wantsNew = autoOpen && searchParams.get(openParam) === "1"
  const fromTemplate = openParam === "apply_template"
  const [open, setOpen] = React.useState(wantsNew)
  // The client the dialog opened with, kept by the open dialog whatever the address says later
  // (/work?new=1&client=<id>).
  const [openedWith, setOpenedWith] = React.useState(client ?? null)
  // Opened by "Apply job template": the dialog leads with the template picker (until reopened by hand).
  const [templateFirst, setTemplateFirst] = React.useState(fromTemplate && wantsNew)

  // Take `new=1` out of the address once the dialog is open, so a reload or Back doesn't reopen it.
  // history.replaceState syncs with the router without a server render (nothing on the page depends
  // on the param once the dialog has opened), and reads the address as it is now: /work may have
  // just written its landing view into it (LandingQuery), which must stay.
  React.useEffect(() => {
    if (!wantsNew) return
    const p = new URLSearchParams(window.location.search)
    if (!p.has(openParam)) return
    p.delete(openParam)
    const qs = p.toString().replace(/%2C/gi, ",")
    window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname)
  }, [wantsNew, openParam, pathname, searchParams])

  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={() => {
          setTemplateFirst(false)
          setOpenedWith(client ?? null)
          setOpen(true)
        }}
      >
        <PlusIcon aria-hidden="true" />
        {label}
      </Button>
      {open ? <NewTaskDialog open={open} onOpenChange={setOpen} options={options} defaultFy={defaultFy} client={openedWith} templateFirst={templateFirst} /> : null}
    </>
  )
}
