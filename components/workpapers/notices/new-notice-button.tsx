"use client"

import * as React from "react"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { NoticeFormInput } from "@/lib/schemas/notices"
import { NoticeFormDialog, type NoticeFormContext } from "@/components/workpapers/notices/notice-form-dialog"

/** "Log a notice" and its dialog (§7.8.4), on the register and on Client 360 (with the client fixed). */
export function NewNoticeButton({
  context,
  today,
  fixedClient,
  defaultAssignee,
  defaultOpen = false,
  variant = "default",
  label = "Log a notice",
}: {
  context: NoticeFormContext
  today: string
  fixedClient?: { id: string; label: string } | null
  /** The viewer's own employee id, preselected for an Employee. */
  defaultAssignee?: string | null
  defaultOpen?: boolean
  variant?: "default" | "outline"
  label?: string
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  const initial: NoticeFormInput = {
    id: null,
    updated_at: null,
    client_id: fixedClient?.id ?? "",
    type_choice: "",
    notice_type: "",
    tax_area: "",
    section: "",
    authority: "",
    reference_no: "",
    financial_year: "",
    notice_date: "",
    received_date: today,
    reply_due_date: "",
    hearing_date: "",
    hearing_time: "",
    demand_amount: "",
    description: "",
    assigned_employee_id: defaultAssignee ?? "",
    replied_on: "",
    status: "open",
  }
  return (
    <>
      <Button type="button" variant={variant} onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden="true" />
        {label}
      </Button>
      {open ? <NoticeFormDialog open onOpenChange={setOpen} initial={initial} fixedClient={fixedClient} context={context} /> : null}
    </>
  )
}
