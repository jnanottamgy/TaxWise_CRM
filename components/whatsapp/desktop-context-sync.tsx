"use client"

import * as React from "react"
import { refreshDesktopContext, useIsDesktopApp } from "@/components/shell/use-desktop"

/**
 * TaxWise Desktop only (docs/DESKTOP-API.md (c)): tells the app to reload its context when the staff
 * shell first mounts for a person, which is right after sign-in (and the two-step check), so the
 * WhatsApp panel's numbers and allowed groups belong to whoever just signed in rather than waiting
 * for the five-minute refresh. The shell layout persists across navigations, so this runs once per
 * sign-in or reload, and again only if a different person signs in. Renders nothing.
 */
export function DesktopContextSync({ userId }: { userId: string }) {
  const desktop = useIsDesktopApp()
  React.useEffect(() => {
    if (desktop) refreshDesktopContext()
  }, [desktop, userId])
  return null
}
