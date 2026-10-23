import { SkeletonCard, SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"

/** One client group while it loads (§3.4): header, the four figures, the clients and the two lists. */
export default function ClientGroupLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-5">
      <SkeletonPageHeader />
      <SkeletonKpiStrip labels={["Clients", "Open tasks", "Next deadline", "Outstanding"]} />
      <SkeletonTable headers={["Client", "Code", "Status", "Owner", "Next deadline", "Open tasks", "Outstanding", "Actions"]} rows={6} />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <SkeletonCard title="Open tasks" />
        <SkeletonCard title="Upcoming deadlines" />
      </div>
    </div>
  )
}
