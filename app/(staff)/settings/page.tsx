import { redirect } from "next/navigation"
import { requireStaff } from "@/lib/auth/guards"

/** /settings: Partners land on Firm details; everyone else's settings are their profile (§4.2). */
export default async function SettingsIndexPage() {
  const { user } = await requireStaff()
  redirect(user.role === "partner" ? "/settings/firm" : "/profile")
}
