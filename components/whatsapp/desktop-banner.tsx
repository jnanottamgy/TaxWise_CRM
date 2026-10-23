"use client"

import { MonitorDownIcon } from "lucide-react"
import { useIsDesktopApp } from "@/components/shell/use-desktop"
import { useIsPhone } from "@/components/whatsapp/use-phone"

/**
 * The note that suggests TaxWise Desktop (§7.25.8 "A banner suggests TaxWise Desktop"). Shown only
 * in a plain browser, never inside the app. For an Employee whose browser button is off, it says
 * where client chats open instead. Quiet: one line, one link.
 */
export function DesktopBanner({ downloadUrl, browserAllowed }: { downloadUrl: string | null; browserAllowed: boolean }) {
  const desktop = useIsDesktopApp()
  const phone = useIsPhone()
  if (desktop) return null
  const message = !browserAllowed
    ? "Client chats open in TaxWise Desktop, where only the chat you open from the CRM shows. A Partner hasn't allowed WhatsApp in a browser window for Employees."
    : phone
      ? "On a phone, Open chat copies the group's name and opens WhatsApp: paste the name into its search."
      : "In a browser, Open chat opens WhatsApp Web in its own window beside this one, with the group's name copied for its search. TaxWise Desktop opens the group right beside the client's page."
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border bg-surface-2 px-4 py-2.5 text-sm text-text md:px-5">
      <p className="flex min-w-0 items-start gap-2">
        <MonitorDownIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-muted" />
        <span>{message}</span>
      </p>
      {downloadUrl && !phone ? (
        <a href={downloadUrl} className="flex-none font-medium text-primary hover:underline" rel="noopener noreferrer">
          Download TaxWise Desktop
        </a>
      ) : null}
    </div>
  )
}
