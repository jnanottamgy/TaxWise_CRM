import Link from "next/link"
import { ChevronDownIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * The WhatsApp house rules (§7.25.10), shown to staff wherever they work with client groups. The
 * text is Settings → WhatsApp → House rules (editable by Partners), rendered as plain text with its
 * line breaks. Collapsed by default on the client tab; open on the settings page. Server-safe.
 */
export function HouseRulesText({ text, className }: { text: string; className?: string }) {
  return <div className={cn("max-w-[78ch] text-sm leading-6 whitespace-pre-line text-text", className)}>{text}</div>
}

export function HouseRulesDisclosure({ text, settingsHref = "/settings/whatsapp#house-rules" }: { text: string | null; settingsHref?: string }) {
  return (
    <details className="group rounded-lg border border-border bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-2.5 text-sm font-medium text-text hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:px-5 [&::-webkit-details-marker]:hidden">
        <span>WhatsApp house rules</span>
        <ChevronDownIcon aria-hidden="true" className="size-4 text-text-muted transition-transform duration-150 group-open:rotate-180" />
      </summary>
      <div className="border-t border-border px-4 py-4 md:px-5">
        {text ? (
          <HouseRulesText text={text} />
        ) : (
          <p className="text-sm text-text-muted">No house rules are written down yet. A Partner adds them in Settings → WhatsApp.</p>
        )}
        <p className="mt-3 text-sm">
          <Link href={settingsHref} className="font-medium text-primary hover:underline">
            Settings → WhatsApp
          </Link>
        </p>
      </div>
    </details>
  )
}
