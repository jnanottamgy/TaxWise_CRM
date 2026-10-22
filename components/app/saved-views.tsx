"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { BookmarkIcon, CheckIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import type { ActionResult } from "@/lib/result"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"

export interface SavedView {
  id: string
  name: string
  /** The view's query string, without "?" and without paging: "status=data_awaited&sort=due_date&dir=asc". */
  query: string
  /** Shared firm-wide by a Partner or Manager (§3.4). */
  shared?: boolean
}

/** Query string of a view with paging removed and keys sorted, for comparing views. */
export function normaliseViewQuery(qs: string): string {
  const p = new URLSearchParams(qs)
  p.delete("page")
  const entries = Array.from(p.entries()).sort(([a], [b]) => a.localeCompare(b))
  return new URLSearchParams(entries).toString()
}

/**
 * The saved-views menu for a list (§3.4, `saved_views` §5.11). Presentational: the feature passes
 * the user's views and the save/delete server actions. Choosing a view navigates to its query.
 *
 *   <SavedViewsMenu
 *     views={views}
 *     onSave={(name, shared) => saveView({ page: "work", name, shared, query })}
 *     onDelete={(id) => deleteView({ id })}
 *     canShare={can.manageTemplates(user.role)}
 *   />
 */
export function SavedViewsMenu({
  views,
  onSave,
  onDelete,
  canShare = false,
}: {
  views: SavedView[]
  /** Receives the current view's query string as the third argument. */
  onSave?: (name: string, shared: boolean, query: string) => Promise<ActionResult<unknown>>
  onDelete?: (id: string) => Promise<ActionResult<unknown>>
  canShare?: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const current = normaliseViewQuery(searchParams.toString())
  const active = views.find((v) => normaliseViewQuery(v.query) === current)
  const [dialogOpen, setDialogOpen] = React.useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label={active ? `Saved views: ${active.name}` : "Saved views"}>
            <BookmarkIcon aria-hidden="true" />
            <span className="max-w-40 truncate max-sm:sr-only">{active ? active.name : "Views"}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="text-xs font-medium text-text-muted">Saved views</DropdownMenuLabel>
          {views.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-text-muted">No saved views yet.</p>
          ) : (
            views.map((v) => (
              <DropdownMenuItem
                key={v.id}
                onSelect={() => router.push(v.query ? `${pathname}?${v.query}` : pathname, { scroll: false })}
                className="group/view"
              >
                <CheckIcon aria-hidden="true" className={active?.id === v.id ? "opacity-100" : "opacity-0"} />
                <span className="min-w-0 flex-1 truncate">{v.name}</span>
                {v.shared ? <span className="text-xs text-text-muted">Firm</span> : null}
                {onDelete ? (
                  <button
                    type="button"
                    aria-label={`Delete view ${v.name}`}
                    onClick={async (e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      const res = await onDelete(v.id)
                      if (res.ok) toast.success(`Deleted “${v.name}”`)
                      else toast.error(res.ref ? `${res.error} (Ref ${res.ref})` : res.error)
                    }}
                    className="inline-flex size-6 cursor-pointer items-center justify-center rounded-sm text-text-muted opacity-0 group-hover/view:opacity-100 group-focus/view:opacity-100 hover:text-danger-text focus-visible:opacity-100 pointer-coarse:opacity-100"
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                ) : null}
              </DropdownMenuItem>
            ))
          )}
          {onSave ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setDialogOpen(true)}>Save current view…</DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {onSave ? (
        <SaveViewDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          canShare={canShare}
          onSave={(name, shared) => onSave(name, shared, current)}
        />
      ) : null}
    </>
  )
}

function SaveViewDialog({
  open,
  onOpenChange,
  canShare,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  canShare: boolean
  onSave: (name: string, shared: boolean) => Promise<ActionResult<unknown>>
}) {
  const [name, setName] = React.useState("")
  const [shared, setShared] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()
  const nameId = React.useId()
  const errId = React.useId()

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setName("")
          setShared(false)
          setError(null)
        }
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) {
              setError("Give the view a name.")
              return
            }
            startTransition(async () => {
              const res = await onSave(name.trim(), shared)
              if (res.ok) {
                toast.success(`Saved view “${name.trim()}”`)
                onOpenChange(false)
                setName("")
                setShared(false)
                setError(null)
              } else {
                setError(res.fieldErrors?.name?.[0] ?? (res.ref ? `${res.error} (Ref ${res.ref})` : res.error))
              }
            })
          }}
        >
          <DialogHeader>
            <DialogTitle>Save this view</DialogTitle>
            <DialogDescription>Keeps the current search, filters and sort under a name.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <label htmlFor={nameId} className="text-sm font-medium text-text">
              Name <span className="text-danger-text">*</span>
            </label>
            <Input
              id={nameId}
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? errId : undefined}
              placeholder="GSTR-3B data awaited"
              autoFocus
            />
            {error ? (
              <p id={errId} className="text-sm text-danger-text">
                {error}
              </p>
            ) : null}
          </div>
          {canShare ? (
            <label className="flex cursor-pointer items-center justify-between gap-4 rounded-md border border-border px-3 py-2.5">
              <span>
                <span className="block text-sm font-medium text-text">Share with the firm</span>
                <span className="block text-sm text-text-muted">Everyone who can open this list sees the view.</span>
              </span>
              <Switch checked={shared} onCheckedChange={setShared} aria-label="Share with the firm" />
            </label>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner /> : null}
              Save view
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
