"use client"

import * as React from "react"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AuditFormDialog, type StaffChoice } from "@/components/audits/audit-form-dialog"

/** "New audit engagement": the button and its dialog (the audit list, Client 360 → Engagement). */
export function NewAuditButton({
  partners,
  reviewers,
  fyOptions,
  defaultFy,
  defaultPartnerId,
  client,
  variant = "default",
  size = "default",
  label = "New audit engagement",
}: {
  partners: StaffChoice[]
  reviewers: StaffChoice[]
  fyOptions: string[]
  defaultFy: string
  defaultPartnerId?: string | null
  client?: { id: string; label: string } | null
  variant?: "default" | "outline"
  size?: "default" | "sm"
  label?: string
}) {
  const [open, setOpen] = React.useState(false)
  const noPartner = partners.length === 0
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={() => setOpen(true)}
        disabled={noPartner}
        title={noPartner ? "Add an active Partner first: every audit has a Partner as its engagement partner." : undefined}
      >
        <PlusIcon aria-hidden="true" />
        {label}
      </Button>
      {open ? (
        <AuditFormDialog
          mode="create"
          open={open}
          onOpenChange={setOpen}
          partners={partners}
          reviewers={reviewers}
          fyOptions={fyOptions}
          defaultFy={defaultFy}
          defaultPartnerId={defaultPartnerId}
          client={client}
          canChangePartner
        />
      ) : null}
    </>
  )
}
