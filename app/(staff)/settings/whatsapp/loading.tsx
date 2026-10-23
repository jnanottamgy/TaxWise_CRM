import { Skeleton } from "@/components/ui/skeleton"
import { SkeletonPageHeader } from "@/components/app/skeletons"

/** Settings → WhatsApp while it loads: the cards at their real size, with their real titles. */
function CardFrame({ title, rows }: { title: string; rows: number }) {
  return (
    <section className="min-w-0 rounded-lg border border-border bg-surface">
      <div className="border-b border-border px-4 py-3.5 md:px-5">
        <h2 className="text-md leading-6 font-semibold text-text">{title}</h2>
        <Skeleton className="mt-1.5 h-3.5 w-80 max-w-full" />
      </div>
      <ul>
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="flex flex-col gap-2 border-t border-border/70 px-4 py-3 first:border-t-0 md:px-5">
            <div className="flex items-center justify-between gap-4">
              <Skeleton className="h-4 w-64 max-w-[70%]" />
              <Skeleton className="h-8 w-16" />
            </div>
            <Skeleton className="h-3.5 w-[85%]" />
            <Skeleton className="h-3.5 w-[55%]" />
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function WhatsAppSettingsLoading() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-4 md:gap-5">
      <SkeletonPageHeader withAction={false} />
      <CardFrame title="Firm WhatsApp numbers" rows={5} />
      <section className="min-w-0 rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-4 py-3.5 md:px-5">
          <h2 className="text-md leading-6 font-semibold text-text">Numbers and names</h2>
          <Skeleton className="mt-1.5 h-3.5 w-80 max-w-full" />
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 px-4 py-4 md:grid-cols-2 md:px-5 md:py-5">
          {["Default country code", "Group name format", "Signature format"].map((l) => (
            <div key={l} className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text">{l}</span>
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
          <Skeleton className="h-16 w-full" />
        </div>
      </section>
      <CardFrame title="Linked PCs" rows={3} />
      <span role="status" className="sr-only">
        Loading the WhatsApp settings…
      </span>
    </div>
  )
}
