"use client"

import * as React from "react"
import { CheckIcon, ChevronsUpDownIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Spinner } from "@/components/ui/spinner"
import { useDebouncedCallback } from "@/hooks/use-debounced-callback"

export interface ComboOption {
  value: string
  label: string
  /** Grey second line or suffix: a client code, a PAN, a designation. */
  description?: string
  disabled?: boolean
}

/**
 * A searchable select (client, assignee, service). Give it `options` to filter locally, or
 * `loadOptions` to search the server as the user types (debounced 250 ms; results replace the list).
 * `selectedLabel` names the current value when it isn't in the loaded options yet.
 *
 *   <Combobox id="client" value={clientId} onChange={setClientId}
 *     loadOptions={(q) => searchClients({ q })}  // → ComboOption[]
 *     selectedLabel="TW-C-0042 · Sharma Traders" placeholder="Choose a client" />
 */
export function Combobox({
  value,
  onChange,
  options,
  loadOptions,
  selectedLabel,
  placeholder = "Choose…",
  searchPlaceholder = "Search",
  emptyText = "No matches.",
  clearable = true,
  disabled,
  id,
  className,
  onBlur,
  ref,
  ...aria
}: {
  value: string | null | undefined
  onChange: (value: string | null, option?: ComboOption) => void
  ref?: React.Ref<HTMLButtonElement>
  options?: ComboOption[]
  loadOptions?: (query: string) => Promise<ComboOption[]>
  selectedLabel?: string
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  clearable?: boolean
  disabled?: boolean
  id?: string
  className?: string
  onBlur?: () => void
  "aria-describedby"?: string
  "aria-invalid"?: boolean
  "aria-required"?: boolean
  "aria-label"?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [remote, setRemote] = React.useState<ComboOption[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [picked, setPicked] = React.useState<ComboOption | null>(null)
  const requestId = React.useRef(0)
  const listboxId = React.useId()

  const list = loadOptions ? (remote ?? []) : (options ?? [])
  const current =
    (value && (list.find((o) => o.value === value) ?? (picked?.value === value ? picked : null) ?? options?.find((o) => o.value === value))) ||
    null
  const label = current?.label ?? (value ? selectedLabel : undefined)

  const search = useDebouncedCallback(async (q: string) => {
    if (!loadOptions) return
    const mine = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const res = await loadOptions(q)
      if (mine === requestId.current) setRemote(res)
    } catch {
      if (mine === requestId.current) setError("Couldn't search right now. Try again.")
    } finally {
      if (mine === requestId.current) setLoading(false)
    }
  }, 250)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o && loadOptions && remote === null) search("")
        if (!o) {
          setQuery("")
          onBlur?.()
        }
      }}
    >
      <div className={cn("relative w-full", className)}>
        <PopoverTrigger asChild>
          <button
            id={id}
            ref={ref}
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-haspopup="listbox"
            disabled={disabled}
            {...aria}
            className={cn(
              "flex h-9 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-text-muted/30 bg-surface pr-2 pl-3 text-left text-base transition-[border-color,box-shadow] duration-150 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-surface-2 aria-invalid:border-danger aria-invalid:ring-danger/20 pointer-coarse:h-11",
            )}
          >
            <span className={cn("truncate", label ? "text-text" : "text-text-muted", clearable && value && !disabled && "pr-7")}>
              {label ?? placeholder}
            </span>
            <ChevronsUpDownIcon aria-hidden="true" className="size-4 flex-none text-text-muted" />
          </button>
        </PopoverTrigger>
        {clearable && value && !disabled ? (
          <button
            type="button"
            aria-label="Clear selection"
            onClick={() => {
              setPicked(null)
              onChange(null)
            }}
            className="absolute top-1/2 right-8 inline-flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring"
          >
            <XIcon aria-hidden="true" className="size-3.5" />
          </button>
        ) : null}
      </div>
      <PopoverContent id={listboxId} align="start" className="w-(--radix-popover-trigger-width) min-w-64 p-0">
        <Command shouldFilter={!loadOptions}>
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={(q) => {
              setQuery(q)
              search(q)
            }}
          />
          <CommandList className="max-h-72">
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-3 text-sm text-text-muted" role="status">
                <Spinner className="size-3.5" /> Searching…
              </div>
            ) : error ? (
              <p className="px-3 py-3 text-sm text-danger-text">{error}</p>
            ) : (
              <CommandEmpty>{emptyText}</CommandEmpty>
            )}
            {!loading && !error ? (
              <CommandGroup>
                {list.map((o) => (
                  <CommandItem
                    key={o.value}
                    value={`${o.label} ${o.description ?? ""} ${o.value}`}
                    disabled={o.disabled}
                    onSelect={() => {
                      setPicked(o)
                      onChange(o.value, o)
                      setOpen(false)
                      setQuery("")
                    }}
                    className="min-h-8 pointer-coarse:min-h-11"
                  >
                    <CheckIcon aria-hidden="true" className={cn("size-4", value === o.value ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.description ? <span className="truncate text-xs text-text-muted">{o.description}</span> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
