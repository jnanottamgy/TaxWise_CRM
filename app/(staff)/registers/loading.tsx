import { SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"
import { Skeleton } from "@/components/ui/skeleton"

/** Registers while they load: the header, the five tabs, the filter bar and the register at its real size (§3.4). */
export default function RegistersLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader />
      <div className="mb-4 flex h-10 items-end gap-1 overflow-hidden border-b border-border">
        {["w-32", "w-24", "w-14", "w-14", "w-24"].map((w, i) => (
          <Skeleton key={i} className={`mb-2 h-4 flex-none ${w}`} />
        ))}
      </div>
      <div className="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
        <Skeleton className="h-9 w-full md:w-72" />
        <div className="flex gap-2 overflow-hidden">
          {["w-20", "w-24", "w-20"].map((w, i) => (
            <Skeleton key={i} className={`h-8 flex-none ${w}`} />
          ))}
        </div>
      </div>
      <SkeletonTable headers={["Client", "Portal", "Username", "Password", "Login page", "Last revealed"]} rows={10} />
    </div>
  )
}
