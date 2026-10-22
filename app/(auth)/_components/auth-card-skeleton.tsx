import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Loading state for an auth card: the real title shows at once, the form is grey bars at the
 * size of the real fields (no shimmer, no layout shift).
 */
export function AuthCardSkeleton({ title, fields = 2, size = "sm" }: { title: string; fields?: number; size?: "sm" | "md" | "lg" }) {
  const width = size === "lg" ? "max-w-[720px]" : size === "md" ? "max-w-[520px]" : "max-w-[400px]";
  return (
    <div aria-busy="true" className={cn("flex w-full flex-col gap-5", width)}>
      <section className="rounded-lg border border-border bg-surface p-6 sm:p-8">
        <header className="mb-6 flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold text-text">{title}</h1>
          <Skeleton className="h-4 w-3/4" />
        </header>
        <div className="flex flex-col gap-4">
          {Array.from({ length: fields }, (_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
          <Skeleton className="h-10 w-full" />
        </div>
      </section>
      <span role="status" className="sr-only">
        Loading…
      </span>
    </div>
  );
}
