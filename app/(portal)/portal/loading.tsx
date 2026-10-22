import { SkeletonCard, SkeletonPageHeader } from "@/components/app/skeletons";

/** Shown inside the portal shell while a page loads (§3.4): a title and two cards, at their real size. */
export default function PortalLoading() {
  return (
    <div>
      <SkeletonPageHeader withAction={false} />
      <div className="grid gap-4 md:grid-cols-2 md:items-start">
        <SkeletonCard rows={4} />
        <SkeletonCard rows={4} />
      </div>
    </div>
  );
}
