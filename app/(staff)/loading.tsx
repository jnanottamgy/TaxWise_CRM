import { SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons";

/**
 * Shown inside the shell while a staff page loads (§3.4): the usual page anatomy (header, then a
 * list) at its real size, so nothing shifts when the data lands. Pages with a different shape
 * provide their own loading.tsx.
 */
export default function StaffLoading() {
  return (
    <div>
      <SkeletonPageHeader />
      <SkeletonTable rows={10} />
    </div>
  );
}
