import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"
import { homePathFor } from "@/lib/auth/roles"
import { FirmTodayView } from "@/components/home/firm-today-view"
import { TeamTodayView } from "@/components/home/team-today-view"

export const metadata: Metadata = { title: "Dashboard" }

/**
 * The dashboard (§7.2), the landing page of Partners and Managers (§4.4): Partners get "Firm today",
 * Managers "Team today". An Employee who reaches it (an old link, a bookmark) is sent to My day: the
 * firm-wide figures here are never loaded for them (§4.1), and RLS would refuse them anyway.
 */
export default async function DashboardPage() {
  const { user, supabase } = await requireStaff()
  if (user.role === "employee") redirect(homePathFor("employee"))
  return user.role === "partner" ? <FirmTodayView user={user} supabase={supabase} /> : <TeamTodayView user={user} supabase={supabase} />
}
