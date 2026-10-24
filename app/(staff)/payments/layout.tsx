import { requirePartner } from "@/lib/auth/guards"

/**
 * Payments is for Partners only (§4.1, §7.9.5).
 *
 * The role check runs in this layout because it renders before the segment's loading.tsx: a
 * refusal throws forbidden() before anything streams, so it answers with a real 403. Checked only
 * inside the page, it would come after the loading skeleton had already sent a 200. The pages
 * check again, and RLS is the real control.
 */
export default async function PaymentsLayout({ children }: LayoutProps<"/payments">) {
  await requirePartner()
  return children
}
