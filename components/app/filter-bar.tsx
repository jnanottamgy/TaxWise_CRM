"use client"

import * as React from "react"
import { CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Button } from "@/components/ui/button"
import { readParamList } from "@/components/app/data-table/params"
import { toneClasses, type Tone } from "@/components/app/tones"
import { useTableUrlState } from "@/hooks/use-table-url-state"
import { useDebouncedCallback } from "@/hooks/use-debounced-callback"

export interface FilterOption {
  value: string
  label: string
  /** Shows the status dot beside the option (pass lib/status statusOptions()). */
  tone?: Tone
}

export interface FilterDef {
  /** The search-param name: ?status=active,pending */
  id: string
  /** Sentence case: "Status", "Assigned to", "Service". */
  label: string
  options: FilterOption[]
  /** Several values at once (default true). */
  multi?: boolean
  /** Show a search box in the menu (default: more than 7 options). */
  searchable?: boolean
}

/**
 * The bar above a list (§3.3 page anatomy): debounced search synced to `?q=`, filter chips
 * (single or multi select) synced to their own params, Clear filters, and slots for saved views, the
 * column chooser and export. Every change resets the page to 1. Options are plain data, so a Server
 * Component page can render it directly.
 *
 *   <FilterBar
 *     searchLabel="Search clients"
 *     searchPlaceholder="Name, code, PAN, GSTIN or phone"
 *     filters={[
 *       { id: "status", label: "Status", options: statusOptions("client_status") },
 *       { id: "owner", label: "Assigned to", options: people.map((p) => ({ value: p.id, label: p.name })), multi: false },
 *     ]}
 *     savedViews={<SavedViewsMenu page="clients" views={views} onSave={saveView} />}
 *     columns={<ColumnChooser tableId="clients" columns={columnMeta} />}
 *     exportSlot={<ExportButton href="/api/export/clients" />}
 *   />
 */
export function FilterBar({
  searchLabel = "Search",
  searchPlaceholder = "Search",
  hideSearch = false,
  filters = [],
  maxInline = 4,
  savedViews,
  columns,
  exportSlot,
  actions,
  className,
}: {
  searchLabel?: string
  searchPlaceholder?: string
  hideSearch?: boolean
  filters?: FilterDef[]
  /**
   * Filters shown as chips before the rest move behind "More filters" (one row of controls above the
   * list, DESIGN.md §4). A filter in use, or one picked from "More filters", always shows as a chip.
   */
  maxInline?: number
  savedViews?: React.ReactNode
  columns?: React.ReactNode
  exportSlot?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  const filterIds = filters.map((f) => f.id)
  const url = useTableUrlState({ filters: filterIds })
  const anyActive = !!url.q || filterIds.some((fid) => readParamList(url.searchParams, fid).length > 0)
  const [pinned, setPinned] = React.useState<string[]>([])
  const [justPinned, setJustPinned] = React.useState<string | null>(null)

  // One row: the first few chips, then any filter in use or picked from "More filters".
  const limit = filters.length > maxInline + 1 ? maxInline : filters.length
  const inline = filters.filter(
    (f, i) => i < limit || pinned.includes(f.id) || readParamList(url.searchParams, f.id).length > 0
  )
  const more = filters.filter((f) => !inline.includes(f))

  return (
    <div
      role="search"
      aria-label={searchLabel}
      data-slot="filter-bar"
      className={cn("flex flex-col gap-2 pb-3 md:flex-row md:flex-wrap md:items-center", className)}
    >
      {hideSearch ? null : <SearchBox label={searchLabel} placeholder={searchPlaceholder} />}
      {filters.length > 0 || anyActive ? (
        <div className="-mx-4 flex min-w-0 items-center gap-2 overflow-x-auto px-4 pb-0.5 md:mx-0 md:flex-wrap md:overflow-visible md:px-0 md:pb-0">
          {inline.map((f) => (
            <FilterChip
              key={f.id}
              def={f}
              defaultOpen={justPinned === f.id}
              selected={readParamList(url.searchParams, f.id)}
              onChange={(values) => {
                // Once touched, a chip stays in the row for this visit, so clearing it doesn't whisk it
                // (and the focus inside its menu) back behind "More filters".
                setPinned((p) => (p.includes(f.id) ? p : [...p, f.id]))
                url.setFilter(f.id, values)
              }}
            />
          ))}
          {more.length > 0 ? (
            <MoreFilters
              defs={more}
              onPick={(id) => {
                setPinned((p) => (p.includes(id) ? p : [...p, id]))
                setJustPinned(id)
              }}
            />
          ) : null}
          {anyActive ? (
            <Button variant="ghost" size="sm" className="flex-none text-text-muted" onClick={() => url.clearFilters(filterIds)}>
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}
      {savedViews || columns || exportSlot || actions ? (
        <div className="flex flex-wrap items-center gap-2 md:ml-auto">
          {savedViews}
          {columns}
          {exportSlot}
          {actions}
        </div>
      ) : null}
    </div>
  )
}

function SearchBox({ label, placeholder }: { label: string; placeholder: string }) {
  const url = useTableUrlState()
  const urlQ = url.q
  const [value, setValue] = React.useState(urlQ)
  const [seenUrlQ, setSeenUrlQ] = React.useState(urlQ)
  const [pushedQ, setPushedQ] = React.useState(urlQ)

  // The URL changed from outside (Clear filters, back button, a saved view): show what it says.
  if (urlQ !== seenUrlQ) {
    setSeenUrlQ(urlQ)
    if (urlQ !== pushedQ) setValue(urlQ)
  }

  const push = useDebouncedCallback((q: string) => {
    setPushedQ(q.trim())
    url.setQuery(q)
  }, 300)

  const id = React.useId()
  return (
    <div className="relative w-full md:w-72">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted" />
      <input
        id={id}
        type="search"
        inputMode="search"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value)
          push(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            push.flush()
          } else if (e.key === "Escape" && value) {
            e.preventDefault()
            setValue("")
            push("")
            push.flush()
          }
        }}
        className="h-9 w-full rounded-md border border-text-muted/30 bg-surface pr-9 pl-9 text-base text-text outline-none placeholder:text-text-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 max-md:text-md pointer-coarse:h-11 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setValue("")
            push("")
            push.flush()
          }}
          className="absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-9"
        >
          <XIcon aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </div>
  )
}

/**
 * One filter chip with its menu. Controlled: `selected` comes from the URL, `onChange` writes it.
 * Also usable on its own outside the FilterBar.
 */
export function FilterChip({
  def,
  selected,
  onChange,
  defaultOpen = false,
}: {
  def: FilterDef
  selected: string[]
  onChange: (values: string[]) => void
  /** Open the menu on mount (a filter just picked from "More filters"). */
  defaultOpen?: boolean
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  const multi = def.multi !== false
  const searchable = def.searchable ?? def.options.length > 7
  const labels = selected.map((v) => def.options.find((o) => o.value === v)?.label ?? v)
  const active = selected.length > 0
  const summary = !active ? null : labels.length <= 2 ? labels.join(", ") : `${labels[0]} +${labels.length - 1}`

  const toggle = (value: string) => {
    if (!multi) {
      onChange(selected[0] === value ? [] : [value])
      setOpen(false)
      return
    }
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={active ? `${def.label}: ${labels.join(", ")}. Change filter` : `Filter by ${def.label.toLowerCase()}`}
          className={cn(
            "inline-flex h-8 max-w-64 flex-none cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11",
            active
              ? "border-primary/30 bg-primary-soft text-text"
              : "border-text-muted/30 bg-surface text-text-muted hover:border-text-muted/55 hover:text-text"
          )}
        >
          <span>{def.label}</span>
          {summary ? (
            <>
              <span aria-hidden="true" className="h-3.5 w-px bg-primary/30" />
              <span className="truncate font-medium">{summary}</span>
            </>
          ) : null}
          <ChevronDownIcon aria-hidden="true" className="size-3.5 flex-none text-text-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          {searchable ? <CommandInput placeholder={`Search ${def.label.toLowerCase()}`} /> : null}
          <CommandList className="max-h-72">
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup>
              {def.options.map((o) => {
                const on = selected.includes(o.value)
                return (
                  <CommandItem
                    key={o.value}
                    value={`${o.label} ${o.value}`}
                    onSelect={() => toggle(o.value)}
                    aria-checked={on}
                    className="min-h-8 pointer-coarse:min-h-11"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-4 flex-none items-center justify-center border",
                        multi ? "rounded-[4px]" : "rounded-full",
                        on ? "border-primary bg-primary text-primary-foreground" : "border-text-muted/50 bg-surface"
                      )}
                    >
                      {on ? <CheckIcon className="size-3 text-primary-foreground" /> : null}
                    </span>
                    {o.tone ? <span aria-hidden="true" className={cn("size-2 flex-none rounded-full", toneClasses(o.tone).dot)} /> : null}
                    <span className="truncate">{o.label}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
          {active ? (
            <div className="border-t border-border p-1">
              <button
                type="button"
                onClick={() => {
                  onChange([])
                  setOpen(false)
                }}
                className="flex h-8 w-full cursor-pointer items-center justify-center rounded-md text-sm text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:h-11"
              >
                Clear {def.label.toLowerCase()}
              </button>
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** "More filters": the filters past the first few. Picking one adds its chip to the row and opens it. */
function MoreFilters({ defs, onPick }: { defs: FilterDef[]; onPick: (id: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const picked = React.useRef(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 flex-none cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm whitespace-nowrap text-text-muted transition-colors duration-150 outline-none hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11"
        >
          <PlusIcon aria-hidden="true" className="size-3.5 flex-none" />
          More filters
          <span className="num text-text-muted">{defs.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-56 p-0"
        onCloseAutoFocus={(e) => {
          // The picked filter's own menu takes focus as it opens.
          if (picked.current) e.preventDefault()
          picked.current = false
        }}
      >
        <Command>
          {defs.length > 7 ? <CommandInput placeholder="Search filters" /> : null}
          <CommandList className="max-h-72">
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup>
              {defs.map((d) => (
                <CommandItem
                  key={d.id}
                  value={`${d.label} ${d.id}`}
                  onSelect={() => {
                    picked.current = true
                    setOpen(false)
                    onPick(d.id)
                  }}
                  className="min-h-8 pointer-coarse:min-h-11"
                >
                  <span className="truncate">{d.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
