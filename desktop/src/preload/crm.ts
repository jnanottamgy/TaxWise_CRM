/**
 * Preload for the CRM view (sandboxed, context-isolated). Exposes window.taxwiseDesktop with
 * exactly these members and nothing else (§7.25.1):
 *   version · openClientChat(clientId) · toggleWhatsApp() · refreshContext() · onDownload(callback)
 * No ipcRenderer, no Node, no invite codes, no tokens ever reach the page.
 */

import { contextBridge, ipcRenderer } from "electron";
import { ARG, ID_PATTERN, PUSH, readArg } from "../shared/channels";
import type { DesktopDownloadPayload, OpenChatResult } from "../shared/types";

/** What a CRM page receives for each file saved from WhatsApp. */
export interface DesktopDownload extends Omit<DesktopDownloadPayload, "bytes"> {
  bytes: Uint8Array;
  /** Call once the upload finished (uploaded: true) or the user cancelled (false). The temp file is then deleted. */
  complete(result: { uploaded: boolean }): void;
}

type DownloadCallback = (file: DesktopDownload) => void;

const callbacks = new Set<DownloadCallback>();

function announceListeners(): void {
  ipcRenderer.send("crm:download-listeners", { count: callbacks.size });
}

ipcRenderer.on(PUSH.crmDownload, (_e, payload: DesktopDownloadPayload) => {
  let done = false;
  const complete = (result: { uploaded: boolean }) => {
    if (done) return;
    done = true;
    ipcRenderer.send("crm:download-complete", { id: payload.id, uploaded: result?.uploaded === true });
  };
  if (callbacks.size === 0) {
    complete({ uploaded: false });
    return;
  }
  const file: DesktopDownload = {
    id: payload.id,
    clientId: payload.clientId,
    clientName: payload.clientName,
    fileName: payload.fileName,
    mimeType: payload.mimeType,
    size: payload.size,
    bytes: payload.bytes,
    source: "whatsapp",
    complete,
  };
  for (const cb of callbacks) {
    try {
      cb(file);
    } catch {
      // A page bug must not keep the temp file: the 10-minute timer still deletes it.
    }
  }
});

const bridge = {
  version: readArg(process.argv, ARG.version) ?? "0.0.0",

  openClientChat(clientId: string): Promise<OpenChatResult> {
    if (typeof clientId !== "string" || !ID_PATTERN.test(clientId)) {
      return Promise.resolve({ ok: false, error: "That client id isn't valid." });
    }
    return ipcRenderer.invoke("crm:open-client-chat", { clientId }) as Promise<OpenChatResult>;
  },

  toggleWhatsApp(): Promise<{ visible: boolean }> {
    return ipcRenderer.invoke("crm:toggle-whatsapp") as Promise<{ visible: boolean }>;
  },

  refreshContext(): Promise<void> {
    return (ipcRenderer.invoke("crm:refresh-context") as Promise<unknown>).then(() => undefined);
  },

  /** Registers a callback; returns a function that unregisters it. */
  onDownload(callback: DownloadCallback): () => void {
    if (typeof callback !== "function") throw new TypeError("onDownload needs a function");
    callbacks.add(callback);
    announceListeners();
    return () => {
      if (callbacks.delete(callback)) announceListeners();
    };
  },
};

export type TaxwiseDesktopBridge = typeof bridge;

contextBridge.exposeInMainWorld("taxwiseDesktop", Object.freeze(bridge));

// A fresh page load has no listeners yet.
announceListeners();
