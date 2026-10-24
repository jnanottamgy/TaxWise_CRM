"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { BookmarkIcon, CheckIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { normaliseViewQuery } from "@/components/app/saved-views"
import type { WorkViewOption } from "@/lib/data/tasks"
import { deleteWorkView, saveWorkView } from "@/server/actions/tasks"

/**
 * Views of the work tracker (§7.6.1 "Saved views", §3.4): the six shipped views first, then the
 * person's own and those a Partner or Manager shared firm-wide. "Save current view" keeps the
 * search, filters and sort under a name. Shipped views can't be deleted.
 */
export function WorkViewsMenu({ views, canShare }: { views: WorkViewOption[]; canShare: boolean }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const current = normaliseViewQuery(withoutView(searchParams.toString()))
  const active = views.find((v) => normaliseViewQuery(v.query) === current)
  const [saving, setSaving] = React.useState(false)
  const builtIn = views.filter((v) => v.builtIn)
  const saved = views.filter((v) => !v.builtIn)
  const viewParam = searchParams.get("view")

  const go = (query: string) => {
    const p = new URLSearchParams(query)
    if (viewParam && viewParam !== "review") p.set("view", viewParam)
    const qs = p.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* Phones stack it under the view tabs: its own width with its label, not a full-width icon-only bar. */}
          <Button variant="outline" size="sm" className="max-md:self-start" aria-label={active ? `Views: ${active.name}` : "Views"}>
            <BookmarkIcon aria-hidden="true" />
            <span className="max-w-40 truncate">{active ? active.name : "Views"}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="text-xs font-medium text-text-muted">Views</DropdownMenuLabel>
          {builtIn.map((v) => (
            <DropdownMenuItem key={v.id} onSelect={() => go(v.query)}>
              <CheckIcon aria-hidden="true" className={active?.id === v.id ? "opacity-100" : "opacity-0"} />
              <span className="flex-1 truncate">{v.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-medium text-text-muted">Saved</DropdownMenuLabel>
          {saved.length === 0 ? <p className="px-2 py-1.5 text-sm text-text-muted">No saved views yet.</p> : null}
          {saved.map((v) => (
            <DropdownMenuItem key={v.id} onSelect={() => go(v.query)} className="group/view">
              <CheckIcon aria-hidden="true" className={active?.id === v.id ? "opacity-100" : "opacity-0"} />
              <span className="min-w-0 flex-1 truncate">{v.name}</span>
              {v.shared ? <span className="text-xs text-text-muted">Firm</span> : null}
              {v.mine ? (
                <button
                  type="button"
                  aria-label={`Delete view ${v.name}`}
                  onClick={async (e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const r = await deleteWorkView({ id: v.id })
                    if (r.ok) {
                      toast.success(`Deleted “${v.name}”`)
                      router.refresh()
                    } else toast.error(r.ref ? `${r.error} (Ref ${r.ref})` : r.error)
                  }}
                  className="inline-flex size-6 cursor-pointer items-center justify-center rounded-sm text-text-muted opacity-0 group-hover/view:opacity-100 group-focus/view:opacity-100 hover:text-danger-text focus-visible:opacity-100 pointer-coarse:opacity-100"
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              ) : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSaving(true)}>Save current view…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {saving ? (
        <SaveDialog
          canShare={canShare}
          query={current}
          onClose={() => setSaving(false)}
          onSaved={() => {
            setSaving(false)
            router.refresh()
          }}
        />
      ) : null}
    </>
  )
}

function withoutView(qs: string): string {
  const p = new URLSearchParams(qs)
  p.delete("view")
  p.delete("month")
  return p.toString()
}

function SaveDialog({ canShare, query, onClose, onSaved }: { canShare: boolean; query: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = React.useState("")
  const [shared, setShared] = React.useState(false)
  const [error, setError] = React.useState<{ message: string; ref?: string } | null>(null)
  const [pending, setPending] = React.useState(false)
  const id = React.useId()
  return (
    <FormDialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      size="sm"
      title="Save this view"
      description="Keeps the current search, filters and sort under a name."
      pending={pending}
      dirty={name.trim().length > 0}
      submitLabel="Save view"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!name.trim()) {
          setError({ message: "Give the view a name." })
          return
        }
        setPending(true)
        try {
          const r = await saveWorkView({ name: name.trim(), shared, query })
          if (!r.ok) {
            setError({ message: r.fieldErrors?.name?.[0] ?? r.error, ref: r.ref })
            return
          }
          toast.success(`Saved view “${name.trim()}”`)
          onSaved()
        } finally {
          setPending(false)
        }
      }}
    >
      <FormAlert error={error} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium text-text">
          Name <span className="text-danger-text">*</span>
        </label>
        <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="GST returns awaiting data" autoFocus />
      </div>
      {canShare ? (
        <label className="mt-4 flex cursor-pointer items-center justify-between gap-4 rounded-md border border-border px-3 py-2.5">
          <span>
            <span className="block text-sm font-medium text-text">Share with the firm</span>
            <span className="block text-sm text-text-muted">Everyone who opens the work tracker sees this view.</span>
          </span>
          <Switch checked={shared} onCheckedChange={setShared} aria-label="Share with the firm" />
        </label>
      ) : null}
    </FormDialog>
  )
}
