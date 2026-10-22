"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  applyTablePatch,
  hasActiveFilters,
  parseTableParams,
  type SortDir,
  type TableParamsOptions,
  type TableStatePatch,
} from "@/components/app/data-table/params"

/*
 * Navigation-pending flags shared by every table control on the page (FilterBar, DataTable,
 * pagination), so the table can dim while any of them is waiting for the server. Browser-only UI
 * state; it holds no data.
 */
const pendingById = new Map<string, boolean>()
const pendingListeners = new Set<() => void>()
function setPendingFlag(id: string, value: boolean) {
  if ((pendingById.get(id) ?? false) === value) return
  if (value) pendingById.set(id, true)
  else pendingById.delete(id)
  pendingListeners.forEach((l) => l())
}
function subscribePending(l: () => void) {
  pendingListeners.add(l)
  return () => {
    pendingListeners.delete(l)
  }
}

/** True while any table control on the page is waiting for its navigation to finish. */
export function useTableNavigationPending(): boolean {
  return React.useSyncExternalStore(
    subscribePending,
    () => pendingById.size > 0,
    () => false
  )
}

/**
 * Client-side view of the table state held in the URL (§2.3). Every setter navigates
 * (router.push, or replace for typing in search) inside a transition, so `isPending` is true while
 * the server re-renders the page with the new rows; DataTable dims its rows while pending.
 *
 *   const t = useTableUrlState({ sortable: ["name"], defaultSort: "name", filters: ["status"] })
 *   t.setFilter("status", ["active"])   // ?status=active (page resets to 1)
 *   t.setQuery("sharma")                // ?q=sharma (replace, no history entry)
 *   t.setPage(2)
 *
 * Components that call it must sit under a <Suspense> boundary if the page can be prerendered
 * (useSearchParams), which staff pages are not (they read the session).
 */
export function useTableUrlState<S extends string = string, F extends string = string>(
  opts: TableParamsOptions<S, F> = {}
) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = React.useTransition()
  const id = React.useId()
  React.useEffect(() => {
    setPendingFlag(id, isPending)
    return () => setPendingFlag(id, false)
  }, [id, isPending])

  const optsKey = JSON.stringify(opts)
  // Options are usually literals; key them by value so the parsed state is stable between renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableOpts = React.useMemo(() => opts, [optsKey])
  const params = React.useMemo(() => parseTableParams<S, F>(searchParams, stableOpts), [searchParams, stableOpts])

  const navigate = React.useCallback(
    (patch: TableStatePatch, mode: "push" | "replace" = "push") => {
      const qs = applyTablePatch(new URLSearchParams(searchParams.toString()), patch)
      const href = qs ? `${pathname}?${qs}` : pathname
      startTransition(() => {
        if (mode === "replace") router.replace(href, { scroll: false })
        else router.push(href, { scroll: false })
      })
    },
    [pathname, router, searchParams]
  )

  const filterNames = React.useMemo(() => {
    const f = stableOpts.filters
    if (!f) return [] as string[]
    return Array.isArray(f) ? [...(f as readonly string[])] : Object.keys(f)
  }, [stableOpts])

  return {
    ...params,
    isPending,
    searchParams,
    pathname,
    /** True when search or any declared filter is active. */
    isFiltered: hasActiveFilters(searchParams, filterNames),
    navigate,
    setPage: (page: number) => navigate({ page }),
    setPageSize: (pageSize: number) => navigate({ pageSize }),
    setSort: (sort: string | null, dir: SortDir = "asc") => navigate({ sort, dir }),
    setQuery: (q: string) => navigate({ q }, "replace"),
    setFilter: (name: F | string, values: readonly string[] | null) => navigate({ filters: { [name]: values } }),
    /** Clears search and every declared filter (or the names given), keeping sort, tab and view. */
    clearFilters: (names?: readonly string[]) => {
      const list = names ?? filterNames
      navigate({ q: null, filters: Object.fromEntries(list.map((n) => [n, null])) })
    },
  }
}

export type TableUrlState = ReturnType<typeof useTableUrlState>
