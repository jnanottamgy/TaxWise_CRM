"use client"

import { RouteError } from "@/components/shell/route-error"

/**
 * Client 360's own boundary (§0.1 rule 3): if the page itself fails (each tab already has its own
 * boundary), the staff shell stays and this offers Try again, the Ref, and the way back to the list.
 */
export default function ClientError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError error={error} retry={retry} source="boundary:/clients/[id]" homeHref="/clients" homeLabel="Back to clients" />
}
