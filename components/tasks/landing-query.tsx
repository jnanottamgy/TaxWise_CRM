"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"

/**
 * A bare /work is rendered on the server with the viewer's landing view (open work, soonest due
 * first; an Employee's own). This writes that view's params into the address, so the filter bar,
 * the sort and Back show what the list is. history.replaceState syncs with the router without a
 * second server render; a redirect would load the page twice on every visit from the sidebar.
 * `new=1` (the "+ New task" button) is kept for the dialog that opens over the list.
 */
export function LandingQuery({ query }: { query: string }) {
  const searchParams = useSearchParams()
  React.useEffect(() => {
    if (!Array.from(searchParams.keys()).every((k) => k === "new")) return
    const p = new URLSearchParams(query)
    const opening = searchParams.get("new")
    if (opening) p.set("new", opening)
    window.history.replaceState(null, "", `${window.location.pathname}?${p.toString().replace(/%2C/gi, ",")}`)
  }, [searchParams, query])
  return null
}
