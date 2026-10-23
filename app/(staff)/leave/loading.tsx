import { SkeletonCard, SkeletonPageHeader } from "@/components/app/skeletons"

/** Leave while it loads: the header, the view tabs and the list at its real size (§3.4). */
export default function LeaveLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4">
      <SkeletonPageHeader className="pb-0 md:pb-0" />
      <div className="flex gap-4 border-b border-border pb-2.5">
        {["Waiting for you", "Who's away", "All leave", "My leave"].map((t) => (
          <span key={t} className="text-sm font-medium text-text-muted">
            {t}
          </span>
        ))}
      </div>
      <SkeletonCard title="Waiting for you" rows={5} />
    </div>
  )
}
