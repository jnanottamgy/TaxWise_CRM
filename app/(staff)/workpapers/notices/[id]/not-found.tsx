import Link from "next/link"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/app/empty-state"

/** A notice that doesn't exist, was deleted, or belongs to a client the viewer can't see. */
export default function NoticeNotFound() {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <EmptyState
        message="This notice doesn't exist, was deleted, or is for a client who isn't one of yours."
        action={
          <Button asChild variant="outline">
            <Link href="/workpapers/notices">All notices</Link>
          </Button>
        }
      />
    </div>
  )
}
