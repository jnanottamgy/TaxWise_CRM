import { SkeletonCard, SkeletonPageHeader } from "@/components/app/skeletons"

/** Settings → Data while it loads: the export, the notice editor and the versions at their size (§3.4). */
export default function DataSettingsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4 md:gap-5">
      <SkeletonPageHeader withAction={false} />
      <SkeletonCard title="Full export" rows={1} />
      <SkeletonCard title="Privacy notice" rows={8} />
      <SkeletonCard title="Versions" rows={3} />
    </div>
  )
}
