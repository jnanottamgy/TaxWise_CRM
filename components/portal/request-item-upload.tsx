"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { RotateCcwIcon, UploadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FormAlert } from "@/components/app/form/form-alert"
import { UploadFileList, useDocumentUpload } from "@/components/documents/uploader"
import { PortalDropzone } from "@/components/portal/portal-dropzone"

/**
 * Uploading the file for one requested item (§7.14, §7.22 Documents): drop it, choose it, or take a
 * photo on a phone, then Upload. The documents module does the rest (useDocumentUpload →
 * requestUploadSlots with purpose "request_item" → PUT → confirmUpload): the file is checked over
 * its whole length, filed in the client's vault as a portal upload, and the item becomes Uploaded for
 * the firm to accept or reject; the client's team is told (§9). A rejected item, or one not yet
 * reviewed, can be uploaded again.
 */
export function RequestItemUpload({
  clientId,
  itemId,
  itemTitle,
  replacing,
  itemState,
}: {
  clientId: string
  itemId: string
  itemTitle: string
  /** The item already has a file (uploaded or rejected): the button reads "Upload again". */
  replacing: boolean
  /** The item's status and upload time from the server, so a fresh upload folds the form away. */
  itemState: string
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(!replacing)
  const up = useDocumentUpload({
    clientId,
    purpose: "request_item",
    requestItemId: itemId,
    single: true,
    defaults: { title: itemTitle.slice(0, 200), category: "other" },
    onUploaded: () => router.refresh(),
  })

  // After an upload the page refreshes with the item's new state: fold back to "Upload again".
  const { reset } = up
  const doneCount = up.counts.done
  const seen = React.useRef(itemState)
  React.useEffect(() => {
    if (itemState !== seen.current && doneCount > 0) {
      reset()
      setOpen(false)
    }
    seen.current = itemState
  }, [itemState, doneCount, reset])

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setOpen(true)}>
        <RotateCcwIcon aria-hidden="true" />
        Upload again
        <span className="sr-only">: {itemTitle}</span>
      </Button>
    )
  }

  const done = up.counts.done > 0
  return (
    <div className="flex flex-col gap-2">
      <FormAlert error={up.formError} className="mb-0" />
      {up.rows.length === 0 ? <PortalDropzone onFiles={up.addFiles} disabled={up.busy} compact label={`Add the file for "${itemTitle}".`} /> : null}
      <UploadFileList upload={up} fields="none" />
      {up.rows.length > 0 && !done ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!up.busy ? (
            <Button type="button" variant="ghost" size="sm" onClick={up.reset}>
              Choose another file
            </Button>
          ) : null}
          <Button type="button" size="sm" onClick={() => void up.start()} disabled={!up.canStart} aria-busy={up.busy}>
            {up.busy ? <Spinner /> : <UploadIcon aria-hidden="true" />}
            {up.busy ? "Uploading" : up.counts.failed ? "Try again" : "Upload"}
            <span className="sr-only">: {itemTitle}</span>
          </Button>
        </div>
      ) : null}
      {replacing && up.rows.length === 0 ? (
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  )
}
