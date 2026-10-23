import Link from "next/link"
import { PhoneOffIcon } from "lucide-react"
import { UNREACHABLE_HREF, unreachableBanner } from "@/lib/schemas/clients"

/**
 * "N clients can't be reached: no email or phone" (§7.3.1), opening that filter. A quiet notice,
 * not a ground: it sits above the list and disappears when the count is zero or the filter is on.
 */
export function UnreachableBanner({ count, active }: { count: number; active: boolean }) {
  const text = unreachableBanner(count)
  if (!text || active) return null
  return (
    <div role="status" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning-text">
      <PhoneOffIcon aria-hidden="true" className="size-4 flex-none" />
      <span className="min-w-0 flex-1">{text}.</span>
      <Link href={UNREACHABLE_HREF} className="font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        Show them
      </Link>
    </div>
  )
}
