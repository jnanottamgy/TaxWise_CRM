/**
 * Preload for the panel header (our own bundled page, sandboxed, context-isolated). Exposes
 * window.taxwisePanel: the header's buttons and its state. Nothing else.
 */

import { contextBridge, ipcRenderer } from "electron";
import { PUSH } from "../shared/channels";
import type { PanelViewState } from "../shared/types";

const listeners = new Set<(state: PanelViewState) => void>();
let last: PanelViewState | null = null;

ipcRenderer.on(PUSH.panelState, (_e, state: PanelViewState) => {
  last = state;
  for (const l of listeners) l(state);
});

const panel = {
  onState(callback: (state: PanelViewState) => void): void {
    listeners.add(callback);
    if (last) callback(last);
    else void (ipcRenderer.invoke("panel:ready") as Promise<PanelViewState>).then((s) => {
      last = s;
      callback(s);
    });
  },
  switchNumber: (numberId: string) => ipcRenderer.send("panel:switch-number", { numberId }),
  linkNumber: (numberId: string) => ipcRenderer.send("panel:link-number", { numberId }),
  popOut: () => ipcRenderer.send("panel:pop-out"),
  dock: () => ipcRenderer.send("panel:dock"),
  close: () => ipcRenderer.send("panel:close"),
  retry: () => ipcRenderer.send("panel:retry"),
  dismissNotice: () => ipcRenderer.send("panel:dismiss-notice"),
  drag: (phase: "start" | "move" | "end", screenX: number) => ipcRenderer.send("panel:drag", { phase, screenX }),
  setWidth: (width: number) => ipcRenderer.send("panel:set-width", { width }),
};

export type TaxwisePanelBridge = typeof panel;

contextBridge.exposeInMainWorld("taxwisePanel", Object.freeze(panel));
