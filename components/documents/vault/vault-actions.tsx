"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { UploadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { DocumentCategory } from "@/lib/domain/enums"
import { UploadDialog } from "@/components/documents/uploader"

/**
 * The vault's upload dialogs, shared by everything on the Documents tab: the header's Upload button,
 * the empty state's action, a document's "Upload new version", a checklist item's "Upload". One
 * dialog at a time; after saving, the page re-renders on the server with the new files.
 */

interface VersionTarget {
  id: string
  title: string
}

interface VaultActions {
  openUpload: (defaults?: { category?: DocumentCategory; financialYear?: string; title?: string; onUploaded?: (documentIds: string[]) => void }) => void
  openVersion: (doc: VersionTarget) => void
}

const Ctx = React.createContext<VaultActions | null>(null)

export function useVaultActions(): VaultActions {
  const v = React.useContext(Ctx)
  if (!v) throw new Error("useVaultActions must be used inside <VaultActionsProvider>")
  return v
}

type UploadState = { kind: "new"; category?: DocumentCategory; financialYear?: string; title?: string; onUploaded?: (ids: string[]) => void } | { kind: "version"; doc: VersionTarget } | null

export function VaultActionsProvider({
  clientId,
  clientName,
  allowConfidential,
  defaultCategory,
  defaultFy,
  children,
}: {
  clientId: string
  clientName: string
  /** Staff on the client's team may mark uploads confidential (RLS 0037). */
  allowConfidential: boolean
  defaultCategory?: DocumentCategory | null
  defaultFy?: string | null
  children: React.ReactNode
}) {
  const router = useRouter()
  const [state, setState] = React.useState<UploadState>(null)
  const actions = React.useMemo<VaultActions>(
    () => ({
      openUpload: (d) => setState({ kind: "new", category: d?.category, financialYear: d?.financialYear, title: d?.title, onUploaded: d?.onUploaded }),
      openVersion: (doc) => setState({ kind: "version", doc }),
    }),
    []
  )
  const close = (open: boolean) => {
    if (!open) setState(null)
  }
  return (
    <Ctx.Provider value={actions}>
      {children}
      {state?.kind === "new" ? (
        <UploadDialog
          key="new"
          open
          onOpenChange={close}
          clientId={clientId}
          clientName={clientName}
          purpose="new_document"
          allowConfidential={allowConfidential}
          defaults={{ category: state.category ?? defaultCategory ?? "other", financialYear: state.financialYear ?? defaultFy ?? "", title: state.title }}
          onUploaded={(done) => {
            toast.success(done.length === 1 ? `Saved ${done[0].title}.` : `Saved ${done.length} documents.`)
            state.onUploaded?.(done.map((d) => d.documentId))
            router.refresh()
          }}
        />
      ) : null}
      {state?.kind === "version" ? (
        <UploadDialog
          key={`version-${state.doc.id}`}
          open
          onOpenChange={close}
          clientId={clientId}
          clientName={clientName}
          purpose="new_version"
          documentId={state.doc.id}
          single
          fields="version"
          allowConfidential={false}
          title={`New version of ${state.doc.title}`}
          description="The current file stays in the history as the earlier version."
          onUploaded={(done) => {
            toast.success(`Version ${done[0]?.version ?? ""} of ${state.doc.title} saved.`)
            router.refresh()
          }}
        />
      ) : null}
    </Ctx.Provider>
  )
}

/** The Documents tab's primary action: Upload files. */
export function UploadButton({ label = "Upload files", variant = "default", category, financialYear }: { label?: string; variant?: "default" | "outline"; category?: DocumentCategory; financialYear?: string }) {
  const { openUpload } = useVaultActions()
  return (
    <Button type="button" variant={variant} size="sm" onClick={() => openUpload({ category, financialYear })}>
      <UploadIcon aria-hidden="true" />
      {label}
    </Button>
  )
}
