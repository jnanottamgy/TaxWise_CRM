import { SkeletonCard, SkeletonPageHeader } from "@/components/app/skeletons"

/** The letter form while it loads: the header and its four sections at their real size (§3.4). */
export default function NewLetterLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4">
      <SkeletonPageHeader withAction={false} />
      <SkeletonCard title="Client and year" rows={3} />
      <SkeletonCard title="Scope" rows={2} />
      <SkeletonCard title="Fees" rows={3} />
      <SkeletonCard title="Signing and validity" rows={2} />
    </div>
  )
}
