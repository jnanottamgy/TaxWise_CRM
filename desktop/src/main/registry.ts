/**
 * Which webContents is which of our views. IPC sender checks and the navigation guard look a
 * sender up here; a webContents we didn't create is never trusted.
 */

import type { ViewKind } from "./navigation";

export class ViewRegistry {
  private readonly kinds = new Map<number, ViewKind>();
  private readonly numbers = new Map<number, string>();

  add(kind: ViewKind, webContentsId: number, numberId?: string): void {
    this.kinds.set(webContentsId, kind);
    if (kind === "whatsapp" && numberId) this.numbers.set(webContentsId, numberId);
  }

  remove(webContentsId: number): void {
    this.kinds.delete(webContentsId);
    this.numbers.delete(webContentsId);
  }

  kindOf(webContentsId: number): ViewKind | null {
    return this.kinds.get(webContentsId) ?? null;
  }

  /** The firm number a WhatsApp view belongs to (never taken from the page). */
  numberOf(webContentsId: number): string | null {
    return this.numbers.get(webContentsId) ?? null;
  }

  isKnown(kind: ViewKind, webContentsId: number): boolean {
    return this.kinds.get(webContentsId) === kind;
  }
}
