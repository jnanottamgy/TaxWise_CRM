import { Skeleton } from "@/components/ui/skeleton"
import { SkeletonPageHeader, SkeletonTable } from "@/components/app/skeletons"

/** Settings → Email while it loads: the cards at their real size, with their real titles. */
function CardFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-border bg-surface">
      <div className="border-b border-border px-4 py-3.5 md:px-5">
        <h2 className="text-md leading-6 font-semibold text-text">{title}</h2>
        <Skeleton className="mt-1.5 h-3.5 w-80 max-w-full" />
      </div>
      <div className="px-4 py-4 md:px-5 md:py-5">{children}</div>
    </section>
  )
}

export default function EmailSettingsLoading() {
  return (
    <div aria-busy="true" className="min-w-0">
      <SkeletonPageHeader withAction={false} />
      <div className="flex min-w-0 flex-col gap-4 md:gap-5">
        <CardFrame title="Sending domain">
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
              {["Add the domain to Resend", "Add the DNS records", "Verified by Resend"].map((s, i) => (
                <span key={s} className="flex items-center gap-2 text-sm text-text-muted">
                  <span className="inline-flex size-6 items-center justify-center rounded-full border border-border text-xs">{i + 1}</span>
                  {s}
                </span>
              ))}
            </div>
            <div className="flex items-center justify-between rounded-md border border-border bg-surface-2 px-4 py-3">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3.5 w-72 max-w-full" />
              </div>
              <Skeleton className="h-9 w-28" />
            </div>
          </div>
        </CardFrame>
        <CardFrame title="Sender">
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
            {["From name", "From address", "Reply-to address"].map((l) => (
              <div key={l} className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-text">{l}</span>
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
            <Skeleton className="h-20 w-full" />
          </div>
        </CardFrame>
        <CardFrame title="Test email">
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-4 w-72 max-w-full" />
            <Skeleton className="h-9 w-36" />
          </div>
        </CardFrame>
        <CardFrame title="Delivery log">
          <SkeletonTable headers={["Email", "To", "Status", "Sent"]} rows={6} />
        </CardFrame>
      </div>
      <span role="status" className="sr-only">
        Loading the email settings…
      </span>
    </div>
  )
}
