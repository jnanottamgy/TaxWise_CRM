/**
 * The one place WebContentsView preferences are built. Every view gets Electron's security
 * checklist (§7.25.3, §12): context isolation, sandbox, no Node, web security on, no insecure
 * content, no experimental features, no <webview>, DevTools only in development builds.
 */

import type { WebPreferences } from "electron";

export interface ViewPreferenceOptions {
  partition: string;
  preload: string;
  devTools: boolean;
  additionalArguments?: string[];
  /** WhatsApp panels keep running while hidden, so client mode keeps watching. */
  backgroundThrottling?: boolean;
  spellcheck?: boolean;
}

export function secureWebPreferences(o: ViewPreferenceOptions): WebPreferences {
  return {
    partition: o.partition,
    preload: o.preload,
    additionalArguments: o.additionalArguments ?? [],
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    devTools: o.devTools,
    spellcheck: o.spellcheck ?? false,
    backgroundThrottling: o.backgroundThrottling ?? true,
    enableWebSQL: false,
  };
}
