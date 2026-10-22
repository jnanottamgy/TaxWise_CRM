"use client";

import * as React from "react";

/**
 * The shell's keyboard shortcuts (§3.4):
 *   ⌘K / Ctrl K   search and commands (works even while typing)
 *   N             the New menu
 *   G then C/T/I  go to Clients / Tasks / Invoices
 *   ?             the shortcut sheet
 *   Esc           closes dialogs, sheets and menus (Radix handles it)
 *
 * Single-key shortcuts never fire while typing in a field, with a modifier held, or while a dialog
 * or menu is open.
 */

export interface ShortcutHandlers {
  onPalette: () => void;
  onNew: () => void;
  onShortcutSheet: () => void;
  /** Called with the key pressed after G ("c", "t" or "i"). */
  onGo: (key: "c" | "t" | "i") => void;
}

const SEQUENCE_MS = 1200;

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  return el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox'], [role='combobox']") !== null;
}

function overlayOpen(): boolean {
  return document.querySelector("[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open'], [role='menu'][data-state='open']") !== null;
}

export function useShellShortcuts(handlers: ShortcutHandlers): void {
  const ref = React.useRef(handlers);
  React.useEffect(() => {
    ref.current = handlers;
  });

  React.useEffect(() => {
    let gPressedAt = 0;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const key = e.key.toLowerCase();

      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === "k") {
        e.preventDefault();
        ref.current.onPalette();
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (isTypingTarget(e.target) || overlayOpen()) {
        gPressedAt = 0;
        return;
      }

      if (gPressedAt && Date.now() - gPressedAt < SEQUENCE_MS) {
        gPressedAt = 0;
        if (key === "c" || key === "t" || key === "i") {
          e.preventDefault();
          ref.current.onGo(key);
        }
        return;
      }

      if (e.key === "?") {
        e.preventDefault();
        ref.current.onShortcutSheet();
        return;
      }
      if (e.shiftKey) return;
      if (key === "g") {
        gPressedAt = Date.now();
        return;
      }
      if (key === "n") {
        e.preventDefault();
        ref.current.onNew();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
