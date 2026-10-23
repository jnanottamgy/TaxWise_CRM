"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
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
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const wantsNew = autoOpen && searchParams.get(openParam) === "1"
  const fromTemplate = openParam === "apply_template"
  const [open, setOpen] = React.useState(wantsNew)
  // The client the dialog opened with. Taking `new=1` out of the address re-renders the page, which
  // may drop a client that only came from the address (/work?new=1&client=<id>); the open dialog
  // keeps it.
  const [openedWith, setOpenedWith] = React.useState(client ?? null)
  // Opened by "Apply job template": the dialog leads with the template picker (until reopened by hand).
  const [templateFirst, setTemplateFirst] = React.useState(fromTemplate && wantsNew)

  React.useEffect(() => {
    if (!wantsNew) return
    const p = new URLSearchParams(searchParams.toString())
    p.delete(openParam)
    const qs = p.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [wantsNew, openParam, pathname, router, searchParams])

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
