import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { connection } from "next/server"
import { KitGallery } from "@/components/app/kit/kit-gallery"
import { queryKitClients } from "@/components/app/kit/sample-data"

export const metadata: Metadata = {
  title: "UI kit",
  robots: { index: false, follow: false },
}

/**
 * The UI kit gallery: every shared pattern in every state, light and dark, with sample content.
 * The integrator's visual QA target. It does not exist in production (APP_ENV=production → 404).
 */
export default async function KitPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // Decide per request, never at build time.
  await connection()
  if (process.env.APP_ENV === "production") notFound()

  const sp = await searchParams
  const t = queryKitClients(sp)

  return (
    <main className="min-h-dvh bg-bg">
      <KitGallery table={{ rows: t.rows, total: t.total, page: t.page, pageSize: t.pageSize, sort: t.sort, dir: t.dir }} />
    </main>
  )
}
