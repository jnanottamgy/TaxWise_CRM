"use client"

import * as React from "react"
import { Columns3Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useLocalStorageJSON } from "@/hooks/use-local-storage"
import type { DataTableColumn } from "@/components/app/data-table/types"

type ColumnLike = Pick<DataTableColumn<unknown>, "id" | "header" | "hideable" | "defaultHidden">

export function columnStorageKey(tableId: string): string {
  return `tw:table:${tableId}:hidden`
}

/**
 * Which columns the user has hidden for a table, remembered in this browser (localStorage, keyed by
 * table id; storage failures fall back to the defaults). Shared by DataTable and ColumnChooser, so
 * the chooser can live in the FilterBar.
 */
export function useColumnVisibility(tableId: string, columns: readonly ColumnLike[]) {
  const [stored, setStored] = useLocalStorageJSON<string[] | null>(columnStorageKey(tableId), null)

  const hidden = React.useMemo(() => {
    const ids = new Set(columns.map((c) => c.id))
    const base = Array.isArray(stored) ? stored : columns.filter((c) => c.defaultHidden).map((c) => c.id)
    // Never hide a column that can't be hidden, and ignore ids that no longer exist.
    const locked = new Set(columns.filter((c) => c.hideable === false).map((c) => c.id))
    return new Set(base.filter((id) => ids.has(id) && !locked.has(id)))
  }, [stored, columns])

  const setHidden = React.useCallback((next: Set<string>) => setStored(Array.from(next)), [setStored])

  return {
    hidden,
    isVisible: (id: string) => !hidden.has(id),
    toggle: (id: string, visible: boolean) => {
      const next = new Set(hidden)
      if (visible) next.delete(id)
      else next.add(id)
      setHidden(next)
    },
    reset: () => setStored(null),
    isCustomised: Array.isArray(stored),
  }
}

/**
 * The column chooser menu (§3.4). Place it in the DataTable bar (`columnChooser` prop) or in the
 * FilterBar's `columns` slot; both read the same remembered state.
 *
 *   <ColumnChooser tableId="clients" columns={columns} />
 */
export function ColumnChooser({
  tableId,
  columns,
  size = "sm",
}: {
  tableId: string
  columns: readonly ColumnLike[]
  size?: "sm" | "default"
}) {
  const vis = useColumnVisibility(tableId, columns)
  const hideable = columns.filter((c) => c.hideable !== false)
  if (hideable.length === 0) return null
  const hiddenCount = hideable.filter((c) => !vis.isVisible(c.id)).length

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size={size} aria-label={hiddenCount ? `Columns, ${hiddenCount} hidden` : "Columns"}>
          <Columns3Icon aria-hidden="true" />
          <span className="max-sm:sr-only">Columns</span>
          {hiddenCount ? <span className="num text-xs text-text-muted">{hiddenCount} hidden</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs font-medium text-text-muted">Show columns</DropdownMenuLabel>
        {hideable.map((c) => (
          <DropdownMenuCheckboxItem
            key={c.id}
            checked={vis.isVisible(c.id)}
            onCheckedChange={(v) => vis.toggle(c.id, v === true)}
            onSelect={(e) => e.preventDefault()}
          >
            {c.header}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!vis.isCustomised} onSelect={() => vis.reset()}>
          Reset to default columns
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
