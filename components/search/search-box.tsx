"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Loader2Icon, SearchIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useDebouncedCallback } from "@/hooks/use-debounced-callback"
import { SEARCH_MAX_LENGTH, SEARCH_MIN_LENGTH, normaliseQuery } from "@/lib/schemas/search"
import { rememberSearch } from "@/server/actions/search-history"

/**
 * The results page's search box (§7.18): what is typed lands in `?q=` after a short pause (replace,
 * so typing doesn't fill the history), resetting the page; Enter searches at once and keeps the
 * query in the person's recent searches. The type filter (`?type=`) stays.
 */
export function SearchBox({ placeholder }: { placeholder: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlQ = searchParams.get("q") ?? ""
  const [value, setValue] = React.useState(urlQ)
  const [seen, setSeen] = React.useState(urlQ)
  const [pending, startTransition] = React.useTransition()
  const id = React.useId()

  // The URL changed from outside (a recent search, the back button): show what it says.
  if (urlQ !== seen) {
    setSeen(urlQ)
    setValue(urlQ)
  }

  const go = React.useCallback(
    (q: string, mode: "push" | "replace") => {
      const next = new URLSearchParams(searchParams.toString())
      const clean = normaliseQuery(q)
      if (clean) next.set("q", clean)
      else next.delete("q")
      next.delete("page")
      const qs = next.toString()
      setSeen(clean)
      startTransition(() => {
        const href = qs ? `${pathname}?${qs}` : pathname
        if (mode === "push") router.push(href, { scroll: false })
        else router.replace(href, { scroll: false })
      })
    },
    [pathname, router, searchParams]
  )

  const debounced = useDebouncedCallback((q: string) => go(q, "replace"), 350)

  return (
    <form
      role="search"
      aria-label="Search the firm's records"
      onSubmit={(e) => {
        e.preventDefault()
        debounced.cancel()
        const q = normaliseQuery(value)
        go(q, "push")
        if (q.length >= SEARCH_MIN_LENGTH) void rememberSearch({ query: q }).catch(() => undefined)
      }}
      className="relative w-full md:max-w-xl"
    >
      <label htmlFor={id} className="sr-only">
        Search
      </label>
      {pending ? (
        <Loader2Icon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 animate-spin text-text-muted" />
      ) : (
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted" />
      )}
      <input
        id={id}
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        autoFocus={!urlQ}
        maxLength={SEARCH_MAX_LENGTH}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value)
          debounced(e.target.value)
        }}
        className={cn(
          "h-10 w-full rounded-md border border-border bg-surface pr-10 pl-9 text-base text-text outline-none placeholder:text-text-muted",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:h-11 [&::-webkit-search-cancel-button]:hidden"
        )}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear the search"
          onClick={() => {
            debounced.cancel()
            setValue("")
            go("", "push")
          }}
          className="absolute top-1/2 right-1.5 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-ring"
        >
          <XIcon aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </form>
  )
}
