"use client"

import * as React from "react"
import { SendIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { RetainerIssueDialog } from "@/components/collections/retainer-issue-dialog"

/** "Issue all" in the Retainer drafts header (§7.9.6): every draft waiting (in the run shown, when one is chosen). */
export function IssueAllButton({ count, role, runId }: { count: number; role: "partner" | "manager"; runId: string | null }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        <SendIcon aria-hidden="true" />
        Issue all {count > 200 ? "(200 at a time)" : count}
      </Button>
      {open ? <RetainerIssueDialog open onOpenChange={setOpen} all runId={runId} role={role} /> : null}
    </>
  )
}
