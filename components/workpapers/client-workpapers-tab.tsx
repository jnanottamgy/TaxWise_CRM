import type { ClientTabProps } from "@/components/client360/types"
import { ClientReconList } from "@/components/workpapers/recon/client-recon-list"
import { ClientFsList } from "@/components/workpapers/fs/client-fs-list"
import { ClientItrList } from "@/components/workpapers/itr/client-itr-list"
import { ClientNoticesList } from "@/components/workpapers/notices/client-notices-list"

/**
 * Client 360 → Workpapers (§7.3.3 tab 7): this client's GST reconciliation runs, ITR computations,
 * financial statements and notices, each in its own card with its latest rows and the action that
 * starts the next one. Every card loads under the viewer's RLS (Employees: their own clients, §4.1)
 * and catches its own failure, so one failing card never blanks the tab. No fee data.
 */
export default async function ClientWorkpapersTab({ clientId, user, supabase }: ClientTabProps) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2 xl:gap-6">
      <ClientReconList clientId={clientId} user={user} supabase={supabase} />
      <ClientItrList clientId={clientId} user={user} supabase={supabase} />
      <ClientFsList clientId={clientId} user={user} supabase={supabase} />
      <ClientNoticesList clientId={clientId} user={user} supabase={supabase} />
    </div>
  )
}
