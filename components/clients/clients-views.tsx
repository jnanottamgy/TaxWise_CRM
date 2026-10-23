"use client"

import { useRouter } from "next/navigation"
import { SavedViewsMenu, type SavedView } from "@/components/app/saved-views"
import { deleteClientView, saveClientView } from "@/server/actions/clients"

/** Saved views of the client list (§3.4): your own, plus those a Partner or Manager shared. */
export function ClientsViews({ views, canShare }: { views: Array<SavedView & { mine: boolean }>; canShare: boolean }) {
  const router = useRouter()
  return (
    <SavedViewsMenu
      views={views}
      canShare={canShare}
      onSave={async (name, shared, query) => {
        const r = await saveClientView({ name, shared, query })
        if (r.ok) router.refresh()
        return r
      }}
      onDelete={async (id) => {
        const r = await deleteClientView({ id })
        if (r.ok) router.refresh()
        return r
      }}
    />
  )
}
