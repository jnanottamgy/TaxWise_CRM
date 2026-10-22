/**
 * Menus (§7.25.3 security): no DevTools in production builds and no context menu that offers
 * "Inspect". Pure templates, so tests can check exactly what production shows.
 */

import type { ContextMenuParams, Input, MenuItemConstructorOptions } from "electron";

export interface MenuActions {
  toggleWhatsApp(): void;
  reloadCrm(): void;
  checkForUpdates(): void;
  showAbout(): void;
}

export interface MenuOptions {
  isMac: boolean;
  /** Unpackaged development build. Production builds never get DevTools. */
  isDev: boolean;
  appName: string;
}

export const TOGGLE_ACCELERATOR = "CmdOrCtrl+Shift+W";

export function applicationMenuTemplate(opts: MenuOptions, actions: MenuActions): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions[] = [
    { label: "Show or hide WhatsApp", accelerator: TOGGLE_ACCELERATOR, click: () => actions.toggleWhatsApp() },
    { type: "separator" },
    { label: "Reload TaxWise", accelerator: "CmdOrCtrl+R", click: () => actions.reloadCrm() },
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
  if (opts.isDev) view.push({ type: "separator" }, { role: "toggleDevTools" });

  const help: MenuItemConstructorOptions[] = [
    { label: "Check for updates", click: () => actions.checkForUpdates() },
    { label: `About ${opts.appName}`, click: () => actions.showAbout() },
  ];

  const template: MenuItemConstructorOptions[] = [];
  if (opts.isMac) {
    template.push({
      label: opts.appName,
      submenu: [
        { label: `About ${opts.appName}`, click: () => actions.showAbout() },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  } else {
    template.push({ label: "File", submenu: [{ role: "quit", label: "Exit" }] });
  }
  template.push(
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "selectAll" },
      ],
    },
    { label: "View", submenu: view },
    { role: "windowMenu" },
    { role: "help", submenu: help },
  );
  return template;
}

export type ContextParams = Pick<ContextMenuParams, "isEditable" | "selectionText" | "editFlags" | "misspelledWord" | "dictionarySuggestions">;

export interface ContextActions {
  replaceMisspelling(word: string): void;
  addToDictionary(word: string): void;
  inspect?(): void;
}

/** Edit commands and spelling only. "Inspect" appears in development builds alone. */
export function contextMenuTemplate(params: ContextParams, opts: { isDev: boolean }, actions: ContextActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  if (params.isEditable && params.misspelledWord) {
    for (const s of params.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => actions.replaceMisspelling(s) });
    items.push({ label: "Add to dictionary", click: () => actions.addToDictionary(params.misspelledWord) }, { type: "separator" });
  }
  if (params.isEditable) {
    items.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );
  } else if (params.selectionText.trim().length > 0) {
    items.push({ role: "copy" });
  }
  if (opts.isDev && actions.inspect) {
    if (items.length > 0) items.push({ type: "separator" });
    items.push({ label: "Inspect", click: () => actions.inspect?.() });
  }
  return items;
}

/** Ctrl+Shift+W (Cmd+Shift+W on a Mac) toggles the WhatsApp panel from any view. */
export function isToggleShortcut(input: Pick<Input, "type" | "key" | "control" | "meta" | "shift" | "alt">, isMac: boolean): boolean {
  if (input.type !== "keyDown" || !input.shift || input.alt) return false;
  if (input.key.toLowerCase() !== "w") return false;
  return input.control || (isMac && input.meta);
}
