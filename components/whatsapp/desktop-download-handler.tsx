"use client"

import * as React from "react"
import { toast } from "sonner"
import { UploadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FormDialog } from "@/components/app/form-dialog"
import { FormAlert } from "@/components/app/form/form-alert"
import { Combobox, type ComboOption } from "@/components/app/form/combobox"
import { getDesktopBridge, useIsDesktopApp } from "@/components/shell/use-desktop"
import { UploadFileList, useDocumentUpload } from "@/components/documents/uploader"
import { financialYearOf, todayIST } from "@/lib/domain/fy"
import { titleFromFileName } from "@/lib/domain/files"
import { searchWhatsAppFileClients } from "@/server/actions/whatsapp-groups"

/**
 * Files from the WhatsApp panel into the client's documents (§7.25.6, docs/DESKTOP-API.md (d)):
 * mounted ONCE in the staff layout. Inside TaxWise Desktop it registers `onDownload`; each file the
 * app hands over ("Save to <client> documents" or "Save to another client…") opens the normal
 * upload dialog pre-filled: the client (or a client picker when the app has none), a title from the
 * file name, the category to choose, FY/period. It uploads through the usual signed-URL flow with
 * documents.source = 'whatsapp', then tells the app `complete({ uploaded: true })`, or
 * `{ uploaded: false }` on cancel. Files over 25 MB never arrive. Outside the app it renders nothing.
 */

interface DesktopFile {
  id: string
  clientId: string | null
  clientName: string | null
  fileName: string
  mimeType: string
  size: number
  bytes: Uint8Array
  source: "whatsapp"
  complete(r: { uploaded: boolean }): void
}

function isDesktopFile(v: unknown): v is DesktopFile {
  if (!v || typeof v !== "object") return false
  const f = v as Record<string, unknown>
  return typeof f.id === "string" && typeof f.fileName === "string" && typeof f.mimeType === "string" && f.bytes instanceof Uint8Array && typeof f.complete === "function"
}

export function DesktopDownloadHandler() {
  const desktop = useIsDesktopApp()
  const [queue, setQueue] = React.useState<DesktopFile[]>([])

  React.useEffect(() => {
    if (!desktop) return
    const bridge = getDesktopBridge()
    if (!bridge) return
    let unsubscribe: (() => void) | null = null
    try {
      unsubscribe = bridge.onDownload((file) => {
        if (isDesktopFile(file)) setQueue((q) => (q.some((x) => x.id === file.id) ? q : [...q, file]))
      })
    } catch {
      unsubscribe = null
    }
    return () => {
      try {
        unsubscribe?.()
      } catch {
        // The app is shutting the page down.
      }
    }
  }, [desktop])

  const current = queue[0] ?? null
  if (!current) return null
  const finish = (uploaded: boolean) => {
    try {
      current.complete({ uploaded })
    } catch {
      // The app already discarded the file (it does after 10 minutes).
    }
    setQueue((q) => q.slice(1))
  }
  return <SaveWhatsAppFile key={current.id} file={current} onDone={finish} />
}

function SaveWhatsAppFile({ file, onDone }: { file: DesktopFile; onDone: (uploaded: boolean) => void }) {
  const [client, setClient] = React.useState<{ id: string; name: string } | null>(file.clientId && file.clientName ? { id: file.clientId, name: file.clientName } : null)
  const [picked, setPicked] = React.useState<string | null>(null)
  const [pickedName, setPickedName] = React.useState<string | null>(null)

  if (!client) {
    return (
      <FormDialog
        open
        onOpenChange={(o) => !o && onDone(false)}
        title="Save to a client's documents"
        description={`Which client is ${file.fileName} for?`}
        footer={
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => onDone(false)}>
              Don&apos;t save
            </Button>
            <Button type="button" disabled={!picked} onClick={() => picked && setClient({ id: picked, name: pickedName ?? "the client" })}>
              Continue
            </Button>
          </div>
        }
        size="sm"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`pick-${file.id}`} className="text-sm font-medium text-text">
            Client
          </label>
          <Combobox
            id={`pick-${file.id}`}
            value={picked}
            onChange={(v, o) => {
              setPicked(v)
              setPickedName(o?.label ?? null)
            }}
            loadOptions={async (q): Promise<ComboOption[]> => {
              const r = await searchWhatsAppFileClients({ q })
              return r.ok ? r.data : []
            }}
            placeholder="Choose a client"
            searchPlaceholder="Client name or code"
            emptyText="No client of yours matches."
          />
        </div>
      </FormDialog>
    )
  }
  return <UploadStep file={file} clientId={client.id} clientName={client.name} onDone={onDone} />
}

function UploadStep({ file, clientId, clientName, onDone }: { file: DesktopFile; clientId: string; clientName: string; onDone: (uploaded: boolean) => void }) {
  const up = useDocumentUpload({
    clientId,
    purpose: "new_document",
    source: "whatsapp",
    single: true,
    defaults: { title: titleFromFileName(file.fileName), category: "other", financialYear: financialYearOf(todayIST()) },
  })
  const { addFiles } = up
  const added = React.useRef(false)
  React.useEffect(() => {
    if (added.current) return
    added.current = true
    addFiles([new File([file.bytes as BlobPart], file.fileName, { type: file.mimeType })])
  }, [addFiles, file])

  const done = up.counts.done > 0 && !up.busy
  const save = async () => {
    const saved = await up.start()
    if (saved.length > 0) {
      toast.success(`${file.fileName} saved to ${clientName}'s documents.`)
      onDone(true)
    }
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && !up.busy && onDone(done)}
      title={`Save to ${clientName}'s documents`}
      description="From the WhatsApp panel. Choose the category and the year; the file is kept with the client, not on this PC."
      pending={up.busy}
      size="lg"
      footer={
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="outline" onClick={() => onDone(done)} disabled={up.busy}>
            {done ? "Close" : "Don't save"}
          </Button>
          {done ? null : (
            <Button type="button" onClick={() => void save()} disabled={!up.canStart} aria-busy={up.busy}>
              {up.busy ? <Spinner /> : <UploadIcon aria-hidden="true" />}
              {up.busy ? "Saving" : "Save to documents"}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <FormAlert error={up.formError} className="mb-0" />
        <UploadFileList upload={up} fields="full" allowConfidential={false} />
      </div>
    </FormDialog>
  )
}
