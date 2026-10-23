import { Suspense } from "react"
import { unstable_rethrow } from "next/navigation"
import { Trash2Icon } from "lucide-react"
import type { ClientTabProps } from "@/components/client360/types"
import { ErrorBlock } from "@/components/app/error-block"
import { isManagerOrPartner, isPartner } from "@/lib/auth/roles"
import { env } from "@/lib/env"
import { logUnexpected } from "@/lib/log"
import { todayIST } from "@/lib/domain/fy"
import { getSelectedFy } from "@/lib/fy-context"
import { readParam } from "@/components/app/data-table/params"
import { VAULT_PARAM, fyChoices, resolveDocumentSubtab, type DocumentSubtab } from "@/lib/schemas/documents"
import {
  getDocumentDetail,
  getVaultClient,
  getVaultFolders,
  listChecklist,
  listDocumentOptions,
  listVault,
  parseVaultParams,
  type ChecklistRow,
  type DocumentDetail,
  type DocumentOption,
  type VaultClient,
  type VaultFolders as VaultFoldersData,
} from "@/lib/data/documents"
import { getRequestContext, listDocumentRequests } from "@/lib/data/document-requests"
import { getMessagingContext } from "@/lib/data/clients"
import { getEmailReadiness } from "@/server/email/readiness"
import { DocumentsSubnav, type SubnavCounts } from "@/components/documents/documents-subnav"
import { DocumentsTabSkeleton } from "@/components/documents/documents-tab-skeleton"
import { VaultActionsProvider, UploadButton } from "@/components/documents/vault/vault-actions"
import { VaultFolders } from "@/components/documents/vault/vault-folders"
import { VaultGrid, VaultTable, VaultToolbar } from "@/components/documents/vault/vault-list"
import { DocumentSheet } from "@/components/documents/vault/document-sheet"
import { RequestsView } from "@/components/documents/requests/requests-view"
import { ChecklistView } from "@/components/documents/checklist/checklist-view"

/**
 * Client 360 → Documents (§7.3.3 tab 6, §7.14): "What do we hold for this client, and what are we
 * still waiting for?"
 *
 *   Vault      folders by category and FY, list or grid, search by title, tag or text; upload
 *              (drag-drop, several files, each described), versions, preview of PDFs and images,
 *              the confidential badge; the recycle bin for Partners and Managers.
 *   Requests   PBC lists: items, the client's uploads to accept or send back, reminders and hand-offs.
 *   Checklist  the onboarding checklist: tick collected, link to the vault, add/remove items.
 *
 * Everything reads under the viewer's RLS (an Employee sees this tab only for a client they own,
 * are on the team of, or cover). Each view loads in its own Suspense boundary and catches its own
 * failures (ErrorBlock with the Ref), so the tab never throws.
 */
export default async function ClientDocumentsTab({ clientId, user, supabase, searchParams }: ClientTabProps) {
  // `?request=new` (Client 360's "Request documents") opens Requests with the new-request dialog.
  const newRequest = readParam(searchParams, VAULT_PARAM.request) === "new"
  const subtab = newRequest ? "requests" : resolveDocumentSubtab(searchParams[VAULT_PARAM.subtab])
  let client: VaultClient | null = null
  let counts: SubnavCounts = { documents: null, openRequests: null, toReview: null, checklist: null }
  let selectedFy: string | null = null
  let ref: string | null = null
  try {
    ;[client, counts, selectedFy] = await Promise.all([getVaultClient(supabase, clientId), subnavCounts(supabase, clientId), getSelectedFy()])
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "tab:documents", userId: user.id, role: user.role, clientId })
  }
  if (ref || !client) {
    return (
      <div className="rounded-lg border border-border bg-surface">
        <ErrorBlock message={client || ref ? "Couldn't load this client's documents." : "This client's documents aren't available to you."} errorRef={ref} />
      </div>
    )
  }

  const vaultParams = parseVaultParams(searchParams, { canSeeBin: isManagerOrPartner(user.role) })
  return (
    <VaultActionsProvider clientId={client.id} clientName={client.display_name} allowConfidential defaultCategory={vaultParams.category} defaultFy={vaultParams.fy && vaultParams.fy !== "none" ? vaultParams.fy : selectedFy}>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <DocumentsSubnav clientId={client.id} active={subtab} counts={counts} />
          {subtab === "vault" && !vaultParams.bin ? <UploadButton /> : null}
        </div>
        <Suspense key={subtab} fallback={<DocumentsTabSkeleton subtab={subtab} />}>
          {subtab === "vault" ? <VaultSection {...{ clientId: client.id, user, supabase, searchParams }} /> : null}
          {subtab === "requests" ? <RequestsSection client={client} user={user} supabase={supabase} searchParams={searchParams} /> : null}
          {subtab === "checklist" ? <ChecklistSection client={client} user={user} supabase={supabase} /> : null}
        </Suspense>
      </div>
    </VaultActionsProvider>
  )
}

async function subnavCounts(supabase: ClientTabProps["supabase"], clientId: string): Promise<SubnavCounts> {
  const [docs, requests, checklist] = await Promise.all([
    supabase.from("documents").select("id", { count: "exact", head: true }).eq("client_id", clientId).is("deleted_at", null),
    supabase.from("document_requests").select("id, document_request_items(status)").eq("client_id", clientId).eq("status", "open").limit(200),
    supabase.from("client_document_checklist_items").select("collected").eq("client_id", clientId).limit(500),
  ])
  if (docs.error) throw docs.error
  if (requests.error) throw requests.error
  if (checklist.error) throw checklist.error
  const open = requests.data ?? []
  const toReview = open.reduce((n, r) => n + ((r.document_request_items as Array<{ status: string }> | null) ?? []).filter((i) => i.status === "uploaded").length, 0)
  const rows = checklist.data ?? []
  return {
    documents: docs.count ?? 0,
    openRequests: open.length,
    toReview,
    checklist: { collected: rows.filter((r) => r.collected).length, total: rows.length },
  }
}

function SectionError({ message, errorRef }: { message: string; errorRef: string | null }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <ErrorBlock message={message} errorRef={errorRef} />
    </div>
  )
}

async function VaultSection({ clientId, user, supabase, searchParams }: ClientTabProps) {
  const canManage = isManagerOrPartner(user.role)
  const today = todayIST()
  const params = parseVaultParams(searchParams, { canSeeBin: canManage })
  const docId = readParam(searchParams, VAULT_PARAM.document)
  let loaded: [VaultFoldersData, Awaited<ReturnType<typeof listVault>>, DocumentDetail | null] | null = null
  let ref: string | null = null
  try {
    loaded = await Promise.all([
      getVaultFolders(supabase, user, clientId, today),
      listVault(supabase, clientId, params),
      docId && /^[0-9a-f-]{36}$/i.test(docId) ? getDocumentDetail(supabase, clientId, docId, { includeDeleted: canManage }) : Promise.resolve(null),
    ])
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "tab:documents:vault", userId: user.id, role: user.role, clientId })
  }
  if (!loaded) return <SectionError message="Couldn't load the document vault." errorRef={ref} />

  const [folders, list, detail] = loaded
  const fyOptions = Array.from(new Set([...fyChoices(today), ...folders.years.map((y) => y.fy).filter((y): y is string => !!y)])).sort().reverse()
  const listProps = {
    clientId,
    rows: list.rows,
    total: list.total,
    page: params.page,
    pageSize: params.pageSize,
    sort: params.sort,
    dir: params.dir,
    layout: params.layout,
    bin: params.bin,
    filtered: Boolean(params.q || params.category || params.fy || params.expiring),
    canUpload: true,
    fyOptions,
    category: params.category,
    fy: params.fy,
  }
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
      <VaultFolders clientId={clientId} folders={folders} params={params} searchParams={searchParams} canSeeBin={canManage} className="hidden lg:flex" />
      <div className="flex min-w-0 flex-col gap-3">
        {params.bin ? (
          <p role="note" className="flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text">
            <Trash2Icon aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-muted" />
            The recycle bin: these documents are hidden from the vault and the portal. Open one to restore it. They can be purged only after their retention date
            {isPartner(user.role) ? ", from the recycle bin page." : ", by a Partner."}
          </p>
        ) : null}
        <VaultToolbar clientId={clientId} layout={params.layout} fyOptions={fyOptions} category={params.category} fy={params.fy} />
        {params.layout === "grid" ? <VaultGrid {...listProps} /> : <VaultTable {...listProps} />}
      </div>
      {detail ? <DocumentSheet key={`${detail.document.id}:${detail.document.updated_at}`} clientId={clientId} detail={detail} canManage={canManage} canEdit fyOptions={fyOptions} today={today} /> : null}
    </div>
  )
}

type RequestsData = [
  Awaited<ReturnType<typeof listDocumentRequests>>,
  Awaited<ReturnType<typeof getRequestContext>>,
  DocumentOption[],
  Awaited<ReturnType<typeof getMessagingContext>>,
  { ready: boolean; reason: string | null },
]

async function RequestsSection({ client, user, supabase, searchParams }: { client: VaultClient; user: ClientTabProps["user"]; supabase: ClientTabProps["supabase"]; searchParams: ClientTabProps["searchParams"] }) {
  let loaded: RequestsData | null = null
  let ref: string | null = null
  try {
    loaded = await Promise.all([
      listDocumentRequests(supabase, client.id, { status: "all" }),
      getRequestContext(supabase, client.id),
      listDocumentOptions(supabase, client.id),
      getMessagingContext(supabase, user),
      getEmailReadiness(supabase),
    ])
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "tab:documents:requests", userId: user.id, role: user.role, clientId: client.id })
  }
  if (!loaded) return <SectionError message="Couldn't load the document requests." errorRef={ref} />
  const [list, context, documents, messaging, email] = loaded
  if (!context) return <SectionError message="This client's requests aren't available to you." errorRef={null} />
  const focus = readParam(searchParams, VAULT_PARAM.request)
  return (
    <RequestsView
      rows={list.rows}
      counts={list.counts}
      context={context}
      documents={documents}
      messaging={{
        firmName: messaging.firmName,
        firmPhone: messaging.firmPhone,
        countryCode: messaging.countryCode,
        signatureFormat: messaging.signatureFormat,
        addSignature: messaging.addSignature,
        senderName: messaging.senderName,
        templates: messaging.templates.filter((t) => t.type === "document_reminder").map((t) => ({ id: t.id, name: t.name, body: t.body, channel: t.channel, subject: t.subject })),
      }}
      portalBase={env.appUrl().replace(/\/+$/, "")}
      emailReady={email.ready}
      canManage={isManagerOrPartner(user.role)}
      canSetUpEmail={isPartner(user.role)}
      today={todayIST()}
      focusRequestId={focus && /^[0-9a-f-]{36}$/i.test(focus) ? focus : null}
      openCreate={focus === "new"}
    />
  )
}

async function ChecklistSection({ client, user, supabase }: { client: VaultClient; user: ClientTabProps["user"]; supabase: ClientTabProps["supabase"] }) {
  let loaded: [ChecklistRow[], DocumentOption[]] | null = null
  let ref: string | null = null
  try {
    loaded = await Promise.all([listChecklist(supabase, client.id), listDocumentOptions(supabase, client.id)])
  } catch (err) {
    unstable_rethrow(err)
    ref = logUnexpected(err, { source: "tab:documents:checklist", userId: user.id, role: user.role, clientId: client.id })
  }
  if (!loaded) return <SectionError message="Couldn't load the document checklist." errorRef={ref} />
  const [rows, documents] = loaded
  return <ChecklistView clientId={client.id} clientName={client.display_name} rows={rows} documents={documents} canManage={isManagerOrPartner(user.role)} />
}

export type { DocumentSubtab }
