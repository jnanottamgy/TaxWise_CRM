import { SkeletonKpiStrip, SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"

/** Performance & attendance while it loads (§3.4). */
export default function PerformanceLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4">
      <SkeletonPageHeader className="pb-0 md:pb-0" />
      <SkeletonKpiStrip labels={["Present today", "Late login", "On leave", "Online now"]} />
      <SkeletonTable headers={["Person", "Present", "Late", "Absent", "On leave", "Active time", "Filed on time"]} rows={8} />
    </div>
  )
}
