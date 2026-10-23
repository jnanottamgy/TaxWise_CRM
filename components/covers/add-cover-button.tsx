"use client"

import * as React from "react"
import { UsersRoundIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AppRole } from "@/lib/auth/roles"
import { CoverDialog, type CoverTarget } from "@/components/covers/cover-dialog"

/**
 * "Add cover" for one client (§4.7: Client 360 → Profile & contacts → Team → Add cover). The
 * dialog mounts only while open, so each opening starts From at now. Partners and Managers only;
 * the caller decides whether to render it.
 */
export function AddCoverButton({ target, actorRole, label = "Add cover", variant = "outline" }: { target: CoverTarget; actorRole: AppRole; label?: string; variant?: "outline" | "default" }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button type="button" size="sm" variant={variant} onClick={() => setOpen(true)}>
        <UsersRoundIcon aria-hidden="true" />
        {label}
      </Button>
      {open ? <CoverDialog target={target} actorRole={actorRole} open onOpenChange={setOpen} /> : null}
    </>
  )
}
