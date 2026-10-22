/**
 * Files downloaded in a WhatsApp panel (§7.25.6). Nothing goes to the Downloads folder by itself:
 * the file lands in a private temp folder and the app asks where it belongs.
 *
 * - Save to <client> documents: the client whose chat is open.
 * - Save to another client…
 * - Save to this PC: Partners and Managers only. Employees' files go to a client or nowhere.
 *
 * "Save to documents" hands the bytes to the CRM page (window.taxwiseDesktop.onDownload), which
 * opens the normal upload dialog. The temp file is deleted after the upload, or after 10 minutes.
 */

import type { DownloadItem } from "electron";
import { DOWNLOAD_TTL_MS, MAX_UPLOAD_BYTES } from "../shared/config";
import type { AppRole, DesktopDownloadPayload } from "../shared/types";

export type DownloadChoiceId = "client" | "other-client" | "pc" | "cancel";

export interface DownloadChoice {
  id: DownloadChoiceId;
  label: string;
}

export interface OpenClient {
  clientId: string;
  clientName: string;
}

export interface ChoiceInput {
  role: AppRole | null;
  openClient: OpenClient | null;
  size: number;
  /** The CRM page has registered onDownload (it is signed in and loaded). */
  crmReady: boolean;
}

export function mayKeepOnPc(role: AppRole | null): boolean {
  return role === "partner" || role === "manager";
}

export function downloadChoices(input: ChoiceInput): { choices: DownloadChoice[]; note: string | null } {
  const { role, openClient, size, crmReady } = input;
  if (role === null || role === "client") {
    return { choices: [{ id: "cancel", label: "Close" }], note: "Sign in to TaxWise to save files from WhatsApp." };
  }
  const choices: DownloadChoice[] = [];
  let note: string | null = null;
  if (size > MAX_UPLOAD_BYTES) {
    note = "This file is over 25 MB, the most TaxWise accepts for a client's documents.";
  } else if (!crmReady) {
    note = "TaxWise hasn't finished loading, so the file can't go to a client's documents yet.";
  } else {
    if (openClient) choices.push({ id: "client", label: `Save to ${openClient.clientName} documents` });
    choices.push({ id: "other-client", label: openClient ? "Save to another client…" : "Save to a client's documents…" });
  }
  if (mayKeepOnPc(role)) choices.push({ id: "pc", label: "Save to this PC" });
  choices.push({ id: "cancel", label: mayKeepOnPc(role) ? "Cancel" : "Don't save" });
  return { choices, note };
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * A safe local file name. Besides path and Windows-reserved characters, it drops Unicode direction
 * controls: "Invoice\u202Efdp.exe" would otherwise show as "Invoiceexe.pdf" in the save prompt.
 */
export function sanitizeFileName(name: string): string {
  let n = name
    .normalize("NFC")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c\ufeff]/g, "")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  if (n.length === 0 || WINDOWS_RESERVED.test(n)) n = `whatsapp-file${n ? `-${n}` : ""}`;
  if (n.length > 120) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 10 ? n.slice(dot) : "";
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

export function isExpired(createdAt: number, now: number, ttl = DOWNLOAD_TTL_MS): boolean {
  return now - createdAt >= ttl;
}

export interface DownloadFs {
  mkdirSync(path: string, opts: { recursive: true; mode: number }): unknown;
  readFileSync(path: string): Buffer;
  unlinkSync(path: string): void;
  copyFileSync(from: string, to: string): void;
  readdirSync(path: string): string[];
  statSync(path: string): { mtimeMs: number };
}

export interface DownloadDeps {
  tempDir: string;
  join(...parts: string[]): string;
  fs: DownloadFs;
  randomId(): string;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  role(): AppRole | null;
  crmReady(): boolean;
  ask(fileName: string, choices: DownloadChoice[], note: string | null): Promise<DownloadChoiceId>;
  askSavePath(fileName: string): Promise<string | null>;
  sendToCrm(payload: DesktopDownloadPayload): void;
  log(message: string, details?: Record<string, unknown>): void;
}

type Item = Pick<DownloadItem, "getFilename" | "getMimeType" | "getTotalBytes" | "setSavePath" | "once">;

interface Pending {
  path: string;
  timer: unknown;
}

export class DownloadManager {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: DownloadDeps) {}

  /**
   * Call from session.on("will-download") of a WhatsApp partition, synchronously.
   * `openClient` resolves the client whose chat is open in the panel that downloaded the file.
   */
  handle(item: Item, openClient: () => Promise<OpenClient | null>): void {
    const d = this.deps;
    const id = d.randomId();
    const fileName = sanitizeFileName(item.getFilename());
    d.fs.mkdirSync(d.tempDir, { recursive: true, mode: 0o700 });
    const path = d.join(d.tempDir, `${id}-${fileName}`);
    item.setSavePath(path);
    item.once("done", (_event, state) => {
      if (state !== "completed") {
        this.remove(path);
        return;
      }
      void this.offer(id, path, fileName, item.getMimeType() || "application/octet-stream", item.getTotalBytes(), openClient);
    });
  }

  private async offer(
    id: string,
    path: string,
    fileName: string,
    mimeType: string,
    size: number,
    resolveClient: () => Promise<OpenClient | null>,
  ): Promise<void> {
    const d = this.deps;
    try {
      const openClient = await resolveClient();
      const { choices, note } = downloadChoices({ role: d.role(), openClient, size, crmReady: d.crmReady() });
      const choice = await d.ask(fileName, choices, note);
      if (!choices.some((c) => c.id === choice)) {
        this.remove(path);
        return;
      }
      if (choice === "client" || choice === "other-client") {
        const bytes = new Uint8Array(d.fs.readFileSync(path));
        const target = choice === "client" ? openClient : null;
        const timer = d.setTimeout(() => this.complete(id), DOWNLOAD_TTL_MS);
        this.pending.set(id, { path, timer });
        d.sendToCrm({
          id,
          clientId: target?.clientId ?? null,
          clientName: target?.clientName ?? null,
          fileName,
          mimeType,
          size,
          bytes,
          source: "whatsapp",
        });
        return;
      }
      if (choice === "pc" && mayKeepOnPc(d.role())) {
        const dest = await d.askSavePath(fileName);
        if (dest) d.fs.copyFileSync(path, dest);
      }
      this.remove(path);
    } catch (err) {
      d.log("download: failed", { err: String(err) });
      this.remove(path);
    }
  }

  /** The CRM page finished (uploaded or cancelled), or 10 minutes passed. */
  complete(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.deps.clearTimeout(p.timer);
    this.pending.delete(id);
    this.remove(p.path);
  }

  /** At start-up: delete anything a crash left behind. */
  purgeStale(): void {
    const d = this.deps;
    let names: string[];
    try {
      names = d.fs.readdirSync(d.tempDir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = d.join(d.tempDir, name);
      try {
        if (isExpired(d.fs.statSync(path).mtimeMs, d.now())) d.fs.unlinkSync(path);
      } catch {
        // already gone
      }
    }
  }

  /** Sign-out or a removed PC: nothing waits for an upload any more. */
  discardAll(): void {
    for (const id of [...this.pending.keys()]) this.complete(id);
  }

  private remove(path: string): void {
    try {
      this.deps.fs.unlinkSync(path);
    } catch {
      // already gone
    }
  }
}
