/**
 * Links that open or close a deadline's sheet (`?event=<id>`, §7.7) on the current page, keeping
 * every other param. Pure and client-safe: server pages pass their awaited searchParams, client
 * components their URLSearchParams.
 */

type Params = URLSearchParams | Record<string, string | string[] | undefined>

function copy(sp: Params, skip: readonly string[]): URLSearchParams {
  const next = new URLSearchParams()
  if (sp instanceof URLSearchParams) {
    sp.forEach((v, k) => {
      if (!skip.includes(k)) next.append(k, v)
    })
  } else {
    for (const [k, v] of Object.entries(sp)) {
      if (skip.includes(k) || v === undefined) continue
      for (const one of Array.isArray(v) ? v : [v]) next.append(k, one)
    }
  }
  return next
}

/** The current URL without `event` (where closing the sheet goes). */
export function withoutEvent(pathname: string, sp: Params): string {
  const qs = copy(sp, ["event"]).toString()
  return qs ? `${pathname}?${qs}` : pathname
}

/** The current URL opening one deadline. */
export function withEvent(pathname: string, sp: Params, eventId: string): string {
  const next = copy(sp, ["event"])
  next.set("event", eventId)
  return `${pathname}?${next.toString()}`
}

/** The current URL with some params replaced (null removes one); the open deadline closes. */
export function withParams(pathname: string, sp: Params, patch: Record<string, string | null>, opts: { resetPage?: boolean } = {}): string {
  const next = copy(sp, ["event", ...(opts.resetPage ? ["page"] : [])])
  for (const [k, v] of Object.entries(patch)) {
    next.delete(k)
    if (v !== null && v !== "") next.set(k, v)
  }
  const qs = next.toString()
  return qs ? `${pathname}?${qs}` : pathname
}
