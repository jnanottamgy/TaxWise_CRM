"use client";

import * as React from "react";

/**
 * TaxWise Desktop detection (§7.25.1). The desktop app's preload exposes `window.taxwiseDesktop`
 * (version · openClientChat · toggleWhatsApp · refreshContext · onDownload). Desktop-only buttons show
 * only when it is present; in a plain browser nothing changes.
 */

export interface TaxwiseDesktopBridge {
  version: string;
  openClientChat(clientId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  toggleWhatsApp(): Promise<{ visible: boolean }>;
  refreshContext(): Promise<void>;
  onDownload(callback: (file: unknown) => void): () => void;
}

/** The bridge, or null in a browser (and on the server). */
export function getDesktopBridge(): TaxwiseDesktopBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { taxwiseDesktop?: Partial<TaxwiseDesktopBridge> }).taxwiseDesktop;
  return bridge && typeof bridge.toggleWhatsApp === "function" ? (bridge as TaxwiseDesktopBridge) : null;
}

const subscribeNoop = () => () => {};

/** True inside TaxWise Desktop. False on the server and in the first client render (no hydration mismatch). */
export function useIsDesktopApp(): boolean {
  return React.useSyncExternalStore(
    subscribeNoop,
    () => getDesktopBridge() !== null,
    () => false,
  );
}
