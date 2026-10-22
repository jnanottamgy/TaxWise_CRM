/**
 * IPC registration. Every handler checks, before anything else, that the message came from the
 * main frame of the one view allowed on that channel, at the origin that view must be showing
 * (§7.25.3 "Every ipcMain handler checks the sender's frame URL"), then validates the payload.
 */

import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { PANEL_ORIGIN, WHATSAPP_ORIGIN } from "../shared/config";
import { originOf } from "../shared/url";
import {
  INVOKE,
  SEND,
  type InvokeChannel,
  type InvokePayload,
  type SendChannel,
  type SendPayload,
  type SenderKind,
} from "../shared/channels";

export interface SenderFacts {
  /** URL of the frame that sent the message; null if the frame is gone. */
  url: string | null;
  isMainFrame: boolean;
  webContentsId: number;
}

export interface SenderRules {
  appOrigin: string;
  /** True if this webContents is one of ours of that kind (the CRM view, a WhatsApp view, the panel header). */
  isKnownWebContents(kind: SenderKind, webContentsId: number): boolean;
}

export function expectedOrigin(kind: SenderKind, appOrigin: string): string {
  if (kind === "crm") return appOrigin;
  if (kind === "whatsapp") return WHATSAPP_ORIGIN;
  return PANEL_ORIGIN;
}

export function isAllowedSender(kind: SenderKind, facts: SenderFacts, rules: SenderRules): boolean {
  if (!facts.url || !facts.isMainFrame) return false;
  const origin = originOf(facts.url);
  if (origin === null || origin !== expectedOrigin(kind, rules.appOrigin)) return false;
  return rules.isKnownWebContents(kind, facts.webContentsId);
}

export function senderFacts(event: IpcMainEvent | IpcMainInvokeEvent): SenderFacts {
  const frame = event.senderFrame;
  return {
    url: frame ? frame.url : null,
    isMainFrame: frame ? frame.parent === null : false,
    webContentsId: event.sender.id,
  };
}

export type Logger = (message: string, details?: Record<string, unknown>) => void;

export function registerInvoke<C extends InvokeChannel>(
  ipcMain: Pick<IpcMain, "handle">,
  channel: C,
  rules: SenderRules,
  log: Logger,
  handler: (payload: InvokePayload<C>, event: IpcMainInvokeEvent) => unknown,
): void {
  const spec = INVOKE[channel];
  ipcMain.handle(channel, async (event, raw: unknown) => {
    const facts = senderFacts(event);
    if (!isAllowedSender(spec.sender, facts, rules)) {
      log("ipc: refused sender", { channel, url: facts.url });
      throw new Error("Not allowed");
    }
    let payload: InvokePayload<C>;
    try {
      payload = spec.parse(raw) as InvokePayload<C>;
    } catch {
      log("ipc: bad payload", { channel });
      throw new Error("Bad request");
    }
    return handler(payload, event);
  });
}

export function registerSend<C extends SendChannel>(
  ipcMain: Pick<IpcMain, "on">,
  channel: C,
  rules: SenderRules,
  log: Logger,
  handler: (payload: SendPayload<C>, event: IpcMainEvent) => void,
): void {
  const spec = SEND[channel];
  ipcMain.on(channel, (event, raw: unknown) => {
    const facts = senderFacts(event);
    if (!isAllowedSender(spec.sender, facts, rules)) {
      log("ipc: refused sender", { channel, url: facts.url });
      return;
    }
    let payload: SendPayload<C>;
    try {
      payload = spec.parse(raw) as SendPayload<C>;
    } catch {
      log("ipc: bad payload", { channel });
      return;
    }
    handler(payload, event);
  });
}
