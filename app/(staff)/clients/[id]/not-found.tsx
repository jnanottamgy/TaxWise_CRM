import Link from "next/link"
import { UserXIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getCurrentUser } from "@/lib/auth/current-user"

/**
 * A client the viewer can't open (§4.1, §18.3 Partner 12): for an Employee, "Not one of your
 * clients" (owner, engagement team or a cover in force decides, RLS), without saying whether the
 * client exists; for a Partner or Manager, the client is gone or the link is wrong. The shell stays.
 */
export default async function ClientNotFound() {
  let employee = true
  try {
    const user = await getCurrentUser()
    employee = !user || user.role === "employee"
  } catch {
    employee = true
  }
  const title = employee ? "Not one of your clients" : "Client not found"
  const message = employee
    ? "This client isn't assigned to you, isn't covered by you right now, or no longer exists. If you need to work on it, ask a Manager to add you to its team or give you cover."
    : "This client doesn't exist, or it has been moved to the recycle bin. Check the link, or find the client in the list."

  return (
    <div className="flex justify-center py-6 md:py-12">
      <section className="w-full max-w-lg rounded-lg border border-border bg-surface px-5 py-6 sm:px-6">
        <div className="flex items-start gap-3">
          <UserXIcon aria-hidden="true" className="mt-1 size-4 flex-none text-text-muted" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-text">{title}</h1>
            <p className="mt-1 text-base text-text-muted">{message}</p>
          </div>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button asChild>
            <Link href="/clients">{employee ? "My clients" : "Back to clients"}</Link>
          </Button>
        </div>
      </section>
    </div>
  )
}
