"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Building2Icon, ChevronDownIcon, Loader2Icon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Button } from "@/components/ui/button"
import { useDebouncedCallback } from "@/hooks/use-debounced-callback"
import { parseSearchResponse, type SearchResultItem } from "@/components/shell/search-contract"

/**
 * One client as a filter (`?client=<id>`): a chip that searches the clients the person can see (the
 * global search's client results, so RLS decides) and shows the chosen one with a clear button.
 * With 2,000 clients a fixed list would be too long, so it searches as you type.
 */
export function ClientFilter({ value, label }: { value: string | null; label: string | null }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [items, setItems] = React.useState<SearchResultItem[]>([])
  const [state, setState] = React.useState<"idle" | "loading" | "error">("idle")
  const [error, setError] = React.useState<string | null>(null)
  const [, startTransition] = React.useTransition()
  const latest = React.useRef(0)

  const apply = (id: string | null) => {
    const next = new URLSearchParams(searchParams.toString())
    next.delete("page")
    if (id) next.set("client", id)
    else next.delete("client")
    const qs = next.toString()
    setOpen(false)
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }))
  }

  const search = useDebouncedCallback(async (q: string) => {
    if (q.trim().length < 2) {
      latest.current++
      setItems([])
      setState("idle")
      return
    }
    setState("loading")
    const mine = ++latest.current
    try {
      const res = await fetch(`/api/search?${new URLSearchParams({ q: q.trim(), type: "client", limit: "10" }).toString()}`, { headers: { accept: "application/json" }, cache: "no-store" })
      const parsed = parseSearchResponse(await res.json().catch(() => null))
      if (mine !== latest.current) return
      if (!parsed.ok) {
        setState("error")
        setError(parsed.ref ? `${parsed.error} (Ref ${parsed.ref})` : parsed.error)
        return
      }
      setItems(parsed.data.groups.find((g) => g.type === "client")?.items ?? [])
      setState("idle")
    } catch {
      if (mine !== latest.current) return
      setState("error")
      setError("Search didn't respond. Check your connection and try again.")
    }
  }, 250)

  if (value) {
    return (
      <span className="inline-flex h-8 max-w-full flex-none items-center gap-1 rounded-md border border-primary/40 bg-primary-soft pr-1 pl-2.5 text-sm text-text pointer-coarse:h-10">
        <Building2Icon aria-hidden="true" className="size-4 flex-none text-text-muted" />
        <span className="text-text-muted">Client</span>
        <span className="max-w-[14rem] truncate font-medium">{label ?? "Chosen client"}</span>
        <button
          type="button"
          aria-label="Show every client"
          onClick={() => apply(null)}
          className="ml-0.5 inline-flex size-6 items-center justify-center rounded-full text-text-muted hover:bg-surface hover:text-text focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-9"
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </button>
      </span>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) {
          setQuery("")
          setItems([])
          setState("idle")
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="flex-none gap-1.5">
          <Building2Icon aria-hidden="true" className="text-text-muted" />
          Client
          <ChevronDownIcon aria-hidden="true" className="text-text-muted" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(20rem,calc(100vw-2rem))] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={(v) => {
              setQuery(v)
              search(v)
            }}
            placeholder="Name, code, PAN or GSTIN"
            aria-label="Search clients"
          />
          <CommandList>
            {state === "loading" ? (
              <div className="flex items-center gap-2 px-3 py-3 text-sm text-text-muted">
                <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
                Searching…
              </div>
            ) : state === "error" ? (
              <p role="alert" className="px-3 py-3 text-sm text-danger-text">
                {error}
              </p>
            ) : query.trim().length < 2 ? (
              <p className="px-3 py-3 text-sm text-text-muted">Type two letters of the client&apos;s name or code.</p>
            ) : (
              <>
                <CommandEmpty>No client matches “{query.trim()}”.</CommandEmpty>
                <CommandGroup>
                  {items.map((i) => (
                    <CommandItem key={i.id} value={i.id} onSelect={() => apply(i.id)} className={cn("flex flex-col items-start gap-0 py-2")}>
                      <span className="text-base text-text">{i.title}</span>
                      {i.subtitle ? <span className="text-xs text-text-muted">{i.subtitle}</span> : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
