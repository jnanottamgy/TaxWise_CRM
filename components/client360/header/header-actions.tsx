"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  CalendarClockIcon,
  ChevronDownIcon,
  ClipboardListIcon,
  EllipsisVerticalIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderInputIcon,
  PhoneCallIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/app/confirm-dialog"
import { can, type AppRole } from "@/lib/auth/roles"
import type { ClientStatus } from "@/lib/domain/enums"
import { deleteClient } from "@/server/actions/client-status"
import { generateDeadlinesForClient } from "@/server/actions/compliance"
import { LogCallDialog } from "@/components/client360/header/log-call-dialog"
import { StatusDialog } from "@/components/client360/header/status-dialog"

type Dialog = "call" | "status" | "delete" | "blocked" | null

export interface HeaderActionsProps {
  clientId: string
  clientName: string
  clientCode: string
  status: ClientStatus
  updatedAt: string
  role: AppRole
  contacts: Array<{ id: string; name: string; role: string | null; is_primary: boolean }>
  /** Partner only: unpaid issued invoices, which block Delete (§7.3.4). */
  unpaid: { count: number; outstanding: string } | null
}

/**
 * The Client 360 quick actions and header menu (§7.3.3, §7.3.4): New task · Apply job template ·
 * Request documents · New invoice* · New quotation* · Log a call/note · Generate deadlines, then
 * Change status* and Delete (Partner). Only what the viewer may do is offered (§4.1); the server
 * and RLS refuse the rest anyway. On phones everything folds into one Actions menu (taste §12).
 */
export function HeaderActions(p: HeaderActionsProps) {
  const router = useRouter()
  const [dialog, setDialog] = React.useState<Dialog>(null)
  const [generating, setGenerating] = React.useState(false)
  const close = (o: boolean) => !o && setDialog(null)

  const manager = can.createAndAssignTasks(p.role)
  const money = can.seeMoney(p.role)
  const partner = can.deleteClient(p.role)
  const base = `/clients/${p.clientId}`
  const links = {
    newTask: `/work?new=1&client=${p.clientId}`,
    applyTemplate: `${base}?tab=tasks&apply_template=1`,
    requestDocuments: `${base}?tab=documents&request=new`,
    newInvoice: `/invoices/new?client=${p.clientId}`,
    newQuotation: `/quotations/new?client=${p.clientId}`,
  }

  const generate = async () => {
    setGenerating(true)
    try {
      const r = await generateDeadlinesForClient({ clientId: p.clientId })
      if (!r.ok) {
        toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
        return
      }
      for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
      const parts: string[] = []
      if (r.data.created) parts.push(`${r.data.created} deadline${r.data.created === 1 ? "" : "s"} added`)
      if (r.data.updated) parts.push(`${r.data.updated} date${r.data.updated === 1 ? "" : "s"} updated`)
      if (r.data.retired) parts.push(`${r.data.retired} cancelled for ended services`)
      toast.success(parts.length ? `${parts.join(", ")}.` : "Deadlines are already up to date.")
      router.refresh()
    } catch {
      toast.error("We couldn't reach the server. Check your connection and try again.")
    } finally {
      setGenerating(false)
    }
  }

  const askDelete = () => setDialog(p.unpaid && p.unpaid.count > 0 ? "blocked" : "delete")

  const menuItems = (opts: { includeQuick: boolean }) => (
    <>
      {opts.includeQuick && manager ? (
        <DropdownMenuItem asChild>
          <Link href={links.newTask}>
            <PlusIcon aria-hidden="true" />
            New task
          </Link>
        </DropdownMenuItem>
      ) : null}
      {opts.includeQuick ? (
        <DropdownMenuItem onSelect={() => setDialog("call")}>
          <PhoneCallIcon aria-hidden="true" />
          Log a call or note
        </DropdownMenuItem>
      ) : null}
      {manager ? (
        <DropdownMenuItem asChild>
          <Link href={links.applyTemplate}>
            <ClipboardListIcon aria-hidden="true" />
            Apply job template
          </Link>
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem asChild>
        <Link href={links.requestDocuments}>
          <FolderInputIcon aria-hidden="true" />
          Request documents
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={generating}
        onSelect={(e) => {
          e.preventDefault()
          void generate()
        }}
      >
        {generating ? <Spinner /> : <CalendarClockIcon aria-hidden="true" />}
        Generate deadlines
      </DropdownMenuItem>
      {money ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href={links.newInvoice}>
              <FileTextIcon aria-hidden="true" />
              New invoice
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={links.newQuotation}>
              <FilePlusIcon aria-hidden="true" />
              New quotation
            </Link>
          </DropdownMenuItem>
        </>
      ) : null}
      {manager ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setDialog("status")}>
            <RefreshCwIcon aria-hidden="true" />
            Change status…
          </DropdownMenuItem>
        </>
      ) : null}
      {partner ? (
        <DropdownMenuItem onSelect={askDelete} className="text-danger-text focus:text-danger-text">
          <Trash2Icon aria-hidden="true" />
          Delete client…
        </DropdownMenuItem>
      ) : null}
    </>
  )

  return (
    <>
      {/* Desktop and tablet: the two commonest actions as buttons, the rest in More. */}
      <div className="hidden items-center gap-2 md:flex">
        {manager ? (
          <Button asChild>
            <Link href={links.newTask}>
              <PlusIcon aria-hidden="true" />
              New task
            </Link>
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={() => setDialog("call")}>
          <PhoneCallIcon aria-hidden="true" />
          Log a call
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline">
              More
              <ChevronDownIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="text-xs font-medium text-text-muted">
              {p.clientCode} · {p.clientName}
            </DropdownMenuLabel>
            {menuItems({ includeQuick: false })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Phones: one menu. */}
      <div className="md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" className="w-full justify-center">
              <EllipsisVerticalIcon aria-hidden="true" />
              Actions
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[min(18rem,calc(100vw-2rem))]">
            {menuItems({ includeQuick: true })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <LogCallDialog open={dialog === "call"} onOpenChange={close} clientId={p.clientId} clientName={p.clientName} contacts={p.contacts} />
      {manager ? <StatusDialog open={dialog === "status"} onOpenChange={close} clientId={p.clientId} clientName={p.clientName} current={p.status} updatedAt={p.updatedAt} /> : null}
      {partner ? (
        <>
          <ConfirmDialog
            open={dialog === "delete"}
            onOpenChange={close}
            title={`Delete ${p.clientName}?`}
            description={`${p.clientName} (${p.clientCode}) moves to the recycle bin with its tasks, documents and WhatsApp groups. Nobody sees it in lists any more; a Partner or Manager can restore everything from the recycle bin.`}
            confirmLabel="Move to recycle bin"
            destructive
            onConfirm={async () => {
              const r = await deleteClient({ clientId: p.clientId, updatedAt: p.updatedAt })
              if (!r.ok) {
                toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
                return false
              }
              for (const w of r.warnings ?? []) toast.warning(w, { duration: 12_000 })
              toast.success(`${r.data.displayName} is in the recycle bin.`)
              router.push(r.data.redirectTo)
            }}
          />
          <ConfirmDialog
            open={dialog === "blocked"}
            onOpenChange={close}
            title={`${p.clientName} can't be deleted yet`}
            description={`It has ${p.unpaid?.count ?? 0} unpaid invoice${p.unpaid?.count === 1 ? "" : "s"} (${p.unpaid?.outstanding ?? ""} outstanding). Record the payments or waive the invoices first, then delete the client.`}
            confirmLabel="Open billing"
            onConfirm={() => {
              router.push(`${base}?tab=billing`)
            }}
          />
        </>
      ) : null}
    </>
  )
}
