import Link from "next/link"
import { CircleCheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/app/empty-state"
import { SERVICE_TYPE_LABELS } from "@/lib/domain/enums"
import type { ClientGap, ClientGapsRow } from "@/server/compliance/coverage-gaps"
import { GenerateButton } from "@/components/compliance/generate-button"

/**
 * Coverage gaps (§7.7): active services with nothing planned ahead, each with its one-click fix
 * (plan the deadlines, fix the profile, or add the dates by hand). Server-safe; the buttons are
 * client islands.
 */

function FixAction({ clientId, gap, size = "xs" }: { clientId: string; gap: ClientGap; size?: "xs" | "sm" }) {
  if (gap.fixKind === "generate") return <GenerateButton clientIds={[clientId]} label="Plan deadlines" size={size} />
  if (gap.fixKind === "edit_profile")
    return (
      <Button asChild variant="outline" size={size}>
        <Link href={`/clients/${clientId}?tab=profile`}>Open the profile</Link>
      </Button>
    )
  return (
    <Button asChild variant="outline" size={size}>
      <Link href={`/clients/${clientId}?tab=compliance&new_deadline=1`}>Add a deadline</Link>
    </Button>
  )
}

function GapLine({ clientId, gap, size }: { clientId: string; gap: ClientGap; size?: "xs" | "sm" }) {
  return (
    <li className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 text-sm">
        <p className="text-text">
          <span className="font-medium">{SERVICE_TYPE_LABELS[gap.serviceType]}:</span> {gap.message.replace(/^.*? is active, but /, "active, but ")}
        </p>
        <p className="text-text-muted">
          {gap.fixKind === "generate"
            ? `Planning would add ${gap.wouldAdd > 0 ? `${gap.wouldAdd} ${gap.wouldAdd === 1 ? "deadline" : "deadlines"}` : "the missing deadlines"}.`
            : gap.reason}
        </p>
      </div>
      <div className="flex-none">
        <FixAction clientId={clientId} gap={gap} size={size} />
      </div>
    </li>
  )
}

/** One client's gaps (Client 360 → Compliance). */
export function ClientGapsList({ clientId, gaps }: { clientId: string; gaps: ClientGap[] }) {
  return (
    <ul className="divide-y divide-border">
      {gaps.map((g) => (
        <GapLine key={g.serviceType} clientId={clientId} gap={g} />
      ))}
    </ul>
  )
}

/** The firm-wide report (Filings → Coverage gaps). */
export function FirmGapsReport({ rows, canFix }: { rows: ClientGapsRow[]; canFix: boolean }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface">
        <EmptyState icon={<CircleCheckIcon />} message="Every active service has deadlines planned for the next six months." />
      </div>
    )
  }
  const plannable = rows.filter((r) => r.gaps.some((g) => g.fixKind === "generate")).map((r) => r.clientId)
  return (
    <section aria-labelledby="gaps-title" className="rounded-lg border border-border bg-surface">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between md:px-5">
        <div className="min-w-0">
          <h2 id="gaps-title" className="text-md font-semibold text-text">
            {rows.length} {rows.length === 1 ? "client has" : "clients have"} active services with nothing planned ahead
          </h2>
          <p className="text-sm text-text-muted">
            {plannable.length > 0
              ? `${plannable.length} can be fixed by planning their deadlines; the rest need the profile or a deadline added by hand.`
              : "None of these can be planned from the profile as it stands: fix the profile, or add the dates by hand."}
          </p>
        </div>
        {canFix && plannable.length > 1 ? <GenerateButton clientIds={plannable.slice(0, 200)} label={`Plan deadlines for ${plannable.length} clients`} variant="default" size="sm" /> : null}
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.clientId} className="px-4 py-3 md:px-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Link href={`/clients/${r.clientId}?tab=compliance`} className="text-base font-medium text-text hover:underline">
                {r.clientName}
              </Link>
              <span className="text-sm text-text-muted">
                {r.clientCode}
                {r.ownerName ? ` · ${r.ownerName}` : " · No owner"}
              </span>
            </div>
            <ul className="divide-y divide-border/70">
              {r.gaps.map((g) => (
                <GapLine key={g.serviceType} clientId={r.clientId} gap={g} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  )
}
