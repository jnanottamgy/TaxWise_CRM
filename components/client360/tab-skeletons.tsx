import { SkeletonCard, SkeletonKpiStrip, SkeletonTable } from "@/components/app/skeletons"
import type { ClientTabId } from "@/components/client360/logic/tabs"
import { readParam, type SearchParamsInput } from "@/components/app/data-table/params"
import { VAULT_PARAM, resolveDocumentSubtab } from "@/lib/schemas/documents"
import { DocumentsTabSkeleton } from "@/components/documents/documents-tab-skeleton"
import { ClientComplianceSkeleton } from "@/components/compliance/client-compliance-skeleton"
import { CommunicationTabSkeleton } from "@/components/comms/thread-skeleton"

/**
 * What a Client 360 tab shows while it streams in (§3.4): its own shape at its real size, real
 * labels at once, flat bars for the values, no shimmer. The header and tab row are already on
 * screen. Server-safe.
 */
export function TabSkeleton({ tab, seesMoney, searchParams }: { tab: ClientTabId; seesMoney: boolean; searchParams?: SearchParamsInput }) {
  switch (tab) {
    case "compliance":
      return <ClientComplianceSkeleton />
    case "documents":
      return (
        <DocumentsTabSkeleton subtab={readParam(searchParams, VAULT_PARAM.request) === "new" ? "requests" : resolveDocumentSubtab(readParam(searchParams, VAULT_PARAM.subtab))} />
      )
    case "overview":
      return (
        <div className="flex flex-col gap-4">
          <SkeletonKpiStrip labels={seesMoney ? ["Open tasks", "Overdue", "Next deadline", "Outstanding", "Last contact"] : ["Open tasks", "Overdue", "Next deadline", "Last contact"]} />
          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
            <SkeletonCard title="Open work" rows={5} />
            <SkeletonCard title="Key facts" rows={6} />
            <SkeletonCard title="Latest messages" rows={4} />
            <SkeletonCard title="Portal access" rows={3} />
          </div>
        </div>
      )
    case "profile":
      return (
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
          <SkeletonCard title="Master data" rows={8} />
          <SkeletonCard title="Contacts" rows={4} />
          <SkeletonCard title="Team" rows={4} />
          <SkeletonCard title="KYC" rows={5} />
        </div>
      )
    case "services":
      return (
        <div className="flex flex-col gap-4">
          <SkeletonTable headers={["Service", "Frequency", "Next due", "Agreed fee", "Billing", "Next invoice"]} rows={4} />
          <SkeletonCard title="Fee history" rows={4} />
        </div>
      )
    case "communication":
      return <CommunicationTabSkeleton />
    case "billing":
      // Partners and Managers only (the tab isn't offered to anyone else).
      return (
        <div className="flex flex-col gap-4">
          <SkeletonKpiStrip labels={["Outstanding", "Overdue", "Invoiced", "Received"]} />
          <SkeletonTable headers={["Invoice", "Date", "Due", "Total", "Outstanding", "Status"]} rows={5} />
          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
            <SkeletonCard title="Receipts" rows={4} />
            <SkeletonCard title="TDS credits" rows={4} />
          </div>
        </div>
      )
    case "whatsapp":
      return (
        <div className="flex flex-col gap-4">
          <SkeletonCard title="WhatsApp group" rows={6} />
        </div>
      )
    case "timeline":
      return <SkeletonCard title="Timeline" rows={8} />
    default:
      return <SkeletonTable rows={6} />
  }
}
