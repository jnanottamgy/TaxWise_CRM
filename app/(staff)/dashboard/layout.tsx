import { redirect } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { homePathFor } from "@/lib/auth/roles"

/**
 * The firm dashboard is the Partner's and Manager's home (§4.2); an Employee's home is My day.
 *
 * The redirect runs in this layout because it renders before the segment's loading.tsx, so an
 * Employee gets a real 307 to /my-day instead of a loading skeleton followed by a client-side
 * redirect. The page checks again.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireStaff()
  if (user.role === "employee") redirect(homePathFor("employee"))
  return children
}
