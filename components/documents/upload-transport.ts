/**
 * The browser half of an upload (§2.3 "uploads via short-lived signed URLs", §7.14): read a file's
 * first bytes for the type check, hash the whole file for the duplicate warning, and PUT the bytes
 * to the signed upload URL with progress. Browser-only; holds no data between calls.
 *
 *   const head = await readHead(file)                     // first SNIFF_BYTES, for checkFile()
 *   const sha = await hashFile(file)                      // SHA-256 hex
 *   await putFile(slot.signedUrl, file, slot.mimeType, (f) => setProgress(f), abort.signal)
 */

import { SNIFF_BYTES, sha256Hex } from "@/lib/domain/files"

export async function readHead(file: Blob, bytes = SNIFF_BYTES): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, bytes).arrayBuffer())
}

export async function hashFile(file: Blob): Promise<string> {
  return sha256Hex(await file.arrayBuffer())
}

export class UploadTransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = "UploadTransportError"
  }
}

/**
 * PUTs the file to a Supabase Storage signed upload URL (it carries its own token; nothing else is
 * sent but the public API key). `onProgress` gets 0…1. Rejects with a plain sentence.
 */
export function putFile(signedUrl: string, file: Blob, contentType: string, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", signedUrl)
    xhr.setRequestHeader("content-type", contentType)
    xhr.setRequestHeader("x-upsert", "false")
    xhr.setRequestHeader("cache-control", "max-age=3600")
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (anon) xhr.setRequestHeader("apikey", anon)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.min(1, e.loaded / Math.max(1, e.total)))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1)
        resolve()
        return
      }
      let detail = ""
      try {
        const body = JSON.parse(xhr.responseText) as { message?: string; error?: string }
        detail = body.message ?? body.error ?? ""
      } catch {
        detail = ""
      }
      const message =
        xhr.status === 413 || /too large|exceeded/i.test(detail)
          ? "The file is larger than storage accepts (25 MB)."
          : xhr.status === 409 || /exists/i.test(detail)
            ? "This upload slot was already used. Upload the file again."
            : xhr.status === 400 && /expired|signature/i.test(detail)
              ? "The upload link expired. Upload the file again."
              : "The upload didn't finish. Check your connection and try again."
      reject(new UploadTransportError(message, xhr.status))
    }
    xhr.onerror = () => reject(new UploadTransportError("The upload didn't finish. Check your connection and try again.", null))
    xhr.onabort = () => reject(new UploadTransportError("The upload was cancelled.", null))
    if (signal) {
      if (signal.aborted) {
        reject(new UploadTransportError("The upload was cancelled.", null))
        return
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true })
    }
    xhr.send(file)
  })
}
