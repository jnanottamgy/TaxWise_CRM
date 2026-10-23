import { SkeletonCard, SkeletonPageHeader } from "@/components/app/skeletons"

/** Profile while it loads (§3.4): the header and the first sections at their real size. */
export default function ProfileLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <SkeletonPageHeader withAction={false} />
      <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4">
        <SkeletonCard title="Your details" rows={4} />
        <SkeletonCard title="Appearance" rows={2} />
        <SkeletonCard title="Notifications" rows={6} />
      </div>
    </div>
  )
}
